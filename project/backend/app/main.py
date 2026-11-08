import asyncio
import json
import logging
import math
import time
from typing import Dict, List, Set
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from fastapi.middleware.cors import CORSMiddleware

from .models import BeaconAnchor, FirefighterState, HazardPin, TelemetryPayload
import numpy as np
from .fusion.math_engine import ParticleFilterLocalizer
from .fusion.rf_map import RFMap
from .fusion.tomography import VoxelGrid
from .fusion.geo import clean_sensors
from .fusion.heading import compass_to_map_heading, offset_from_plus_x, valid_angle
from fastapi.responses import FileResponse
import os
from .explored_session import build_exploration_payload, persist_exploration

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("IntoTheClouds")

app = FastAPI(title="IntoTheClouds 3D Tactical Mapping Server", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Default anchors. Easy to edit; POST /api/anchors overrides/extends them
# (BE-05 will move these to .env). `bssid` may be any id string; `ble_name`
# is the Bluetooth advertised name (iPhones rotate BLE addresses).
DEFAULT_ANCHORS: List[BeaconAnchor] = [
    BeaconAnchor(id="A1", bssid="aa:bb:cc:11:22:33", ble_name="ITC-A1", x=0.0, y=0.0, z=1.5, p0=-40.0),
    BeaconAnchor(id="A2", bssid="aa:bb:cc:44:55:66", ble_name="ITC-A2", x=10.0, y=0.0, z=1.5, p0=-40.0),
    BeaconAnchor(id="A3", bssid="aa:bb:cc:77:88:99", ble_name="ITC-A3", x=5.0, y=10.0, z=1.5, p0=-40.0),
]

# Lookup table: lowercase bssid AND lowercase ble_name -> anchor (one anchor may
# appear under two keys; use unique_anchors() when listing).
anchors: Dict[str, BeaconAnchor] = {}


def register_anchor(anchor: BeaconAnchor) -> None:
    """Register an anchor under its bssid and ble_name; replaces any anchor with the same id."""
    for key in [k for k, a in anchors.items() if a.id == anchor.id]:
        del anchors[key]
    anchors[anchor.bssid.lower()] = anchor
    if anchor.ble_name:
        anchors[anchor.ble_name.lower()] = anchor


def unique_anchors() -> List[BeaconAnchor]:
    """Each anchor once, in registration order (dedupe by object identity)."""
    seen = set()
    result = []
    for a in anchors.values():
        if id(a) not in seen:
            seen.add(id(a))
            result.append(a)
    return result


for _a in DEFAULT_ANCHORS:
    register_anchor(_a)

hazards: List[HazardPin] = []
breadcrumbs: List[Dict[str, float]] = []
# BE-14: room size is user-set (GET/POST /api/room). Map x runs 0..width_m, y runs 0..length_m; the
# grids extend margin_m beyond that so beacons or walkers just outside the room still fit.
ROOM = {"width_m": 10.0, "length_m": 10.0, "height_m": 3.0, "margin_m": 2.0, "voxel_m": 0.25, "rf_cell_m": 0.5}
MAX_VOXELS = 4_000_000


class RoomConfig(BaseModel):
    width_m: float = Field(10.0, gt=0, le=100)
    length_m: float = Field(10.0, gt=0, le=100)
    height_m: float = Field(3.0, gt=0, le=10)
    margin_m: float = Field(2.0, ge=0, le=10)
    voxel_m: float = Field(0.25, ge=0.05, le=2.0)
    rf_cell_m: float = Field(0.5, ge=0.1, le=5.0)


def room_bounds_2d(room=None):
    r = room or ROOM
    m = r["margin_m"]
    return (-m, -m, r["width_m"] + m, r["length_m"] + m)


def build_room(room):
    """-> (localizer, rf_map, voxel_grid) sized for `room`. Raises ValueError if too large."""
    x0, y0, x1, y1 = room_bounds_2d(room)
    v = room["voxel_m"]
    n = math.ceil((x1 - x0) / v) * math.ceil((y1 - y0) / v) * math.ceil(room["height_m"] / v)
    if n > MAX_VOXELS:
        raise ValueError(f"grid would have {n:,} voxels (max {MAX_VOXELS:,}); raise voxel_m or shrink the room")
    return (ParticleFilterLocalizer(num_particles=600, room_bounds=(x0, y0, x1, y1)),
            RFMap(x0, y0, x1, y1, cell_m=room["rf_cell_m"]),
            VoxelGrid(bounds=(x0, y0, 0.0, x1, y1, room["height_m"]), voxel_m=v))


localizer, rf_map, voxel_grid = build_room(ROOM)
# BE-01/02: RF obstacle-hint voxel grid (built above with the room). PATH_LOSS_N matches the particle filter's model.
PATH_LOSS_N = 2.5
current_state: FirefighterState = localizer.get_state("FF_Pi_Rig_1", 0.0, time.time())
session_started_at: float = time.time()

# BE-10: phone compass + step feed (GET /walker, ws /ws/pdr). `offset` = compass bearing of map +y.
pdr_state = {"offset": 0.0, "map_heading": 0.0, "last": 0.0, "aligned": False}
PDR_FRESH_S = 3.0

# BE-12: iPhone motion sensors only (3D orientation / compass, gyro, accelerometer). No location data is
# accepted, stored or served: clean_sensors() drops everything outside its allow-list.
phone_state = {"latest": {}, "t": 0.0}
phone_log: list = []
PHONE_LOG_MAX = 20000


def record_phone_sensors(raw) -> None:
    s = clean_sensors(raw)
    if not s:
        return
    now = time.time()
    phone_state["latest"].update(s)
    phone_state["t"] = now
    phone_log.append({"t": round(now, 3), "map_heading": round(pdr_state["map_heading"], 1), **s})
    if len(phone_log) > PHONE_LOG_MAX:
        del phone_log[: PHONE_LOG_MAX // 10]


def pdr_fresh() -> bool:
    return (time.time() - pdr_state["last"]) < PDR_FRESH_S


# Active dashboard WebSockets
dashboard_clients: Set[WebSocket] = set()


@app.get("/api/health")
async def health_check():
    return {
        "status": "healthy",
        "service": "IntoTheClouds Tactical Mapping",
        "timestamp": time.time(),
        "active_dashboards": len(dashboard_clients),
    }


@app.get("/api/anchors", response_model=List[BeaconAnchor])
async def get_anchors():
    return unique_anchors()


@app.post("/api/anchors")
async def set_anchor(anchor: BeaconAnchor):
    register_anchor(anchor)
    return {"message": "Anchor updated", "anchor": anchor}


@app.get("/api/room")
async def get_room():
    """Current room size and the grid bounds derived from it (metres)."""
    x0, y0, x1, y1 = room_bounds_2d()
    return {**ROOM, "bounds": {"min_x": x0, "min_y": y0, "max_x": x1, "max_y": y1},
            "voxel_shape": list(voxel_grid.shape)}


@app.post("/api/room")
async def set_room(cfg: RoomConfig):
    """Set the room size. Rebuilds the localizer, signal map and obstacle grid and clears the current
    walk (breadcrumbs, map, obstacles). Anchors, hazards and the phone alignment are kept. Not saved to the
    database; use POST /api/reset first if you want the current walk saved."""
    global localizer, rf_map, voxel_grid, current_state, session_started_at
    new = cfg.model_dump()
    try:
        localizer, rf_map, voxel_grid = build_room(new)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    ROOM.update(new)
    breadcrumbs.clear()
    session_started_at = time.time()
    current_state = localizer.get_state("FF_Pi_Rig_1", pdr_state["map_heading"], session_started_at)
    await broadcast_to_dashboards({"type": "session_reset"})
    return await get_room()


@app.get("/api/hazards", response_model=List[HazardPin])
async def get_hazards():
    return hazards


@app.post("/api/hazards")
async def add_hazard(hazard: HazardPin):
    hazards.append(hazard)
    # Broadcast hazard pin to all dashboards
    await broadcast_to_dashboards({
        "type": "hazard_pinned",
        "hazard": hazard.model_dump(),
    })
    return {"message": "Hazard pinned", "hazard": hazard}


@app.get("/api/map")
async def get_rf_map():
    """RSSI signal heatmap per anchor id (a signal-coverage map, NOT a floor plan).

    `cells[anchor_id]` is a list of rows; row index follows y (row 0 = y at
    `bounds.min_y`), column index follows x (column 0 = `bounds.min_x`), so
    `cells[id][j][i]` covers x in [min_x+i*cell_m, +cell_m), y likewise.
    Values are mean RSSI in dBm rounded to 1 decimal; unmeasured cells are null.
    """
    cells = {}
    for aid in rf_map.anchor_ids:
        g = rf_map.grid(aid)
        cells[aid] = [[None if np.isnan(v) else round(float(v), 1) for v in row] for row in g]
    return {
        "cell_m": rf_map.cell_m,
        "bounds": {"min_x": rf_map.min_x, "min_y": rf_map.min_y, "max_x": rf_map.max_x, "max_y": rf_map.max_y},
        "width": rf_map.nx,
        "height": rf_map.ny,
        "cells": cells,
    }


@app.get("/walker")
async def walker_page():
    """Phone page: streams compass heading + steps to /ws/pdr. iOS needs HTTPS for motion sensors."""
    return FileResponse(os.path.join(os.path.dirname(__file__), "static", "walker.html"))


@app.websocket("/ws/pdr")
async def pdr_endpoint(websocket: WebSocket):
    """Phone sensor feed. Messages (JSON):
    {"compass_deg": 123.4}                      heading, degrees clockwise from north
    {"compass_deg": 123.4, "step": true, "step_length_m": 0.7}
    {"type": "align", "compass_deg": 123.4}     phone is pointing along the map's +x axis
    {"type": "start", "x": 2.0, "y": 1.0}       known start position (metres)
    """
    global current_state
    await websocket.accept()
    logger.info("Phone PDR client connected")
    last_heading_push = 0.0
    try:
        while True:
            try:
                msg = json.loads(await websocket.receive_text())
            except json.JSONDecodeError:
                continue
            if not isinstance(msg, dict):
                continue
            record_phone_sensors(msg.get("sensors"))
            compass = msg.get("compass_deg")
            if msg.get("type") == "align" and valid_angle(compass):
                pdr_state["offset"] = offset_from_plus_x(float(compass))
                pdr_state["aligned"] = True
            elif msg.get("type") == "start" and valid_angle(msg.get("x")) and valid_angle(msg.get("y")):
                localizer.set_start(float(msg["x"]), float(msg["y"]))
                current_state = localizer.get_state(current_state.device_id, pdr_state["map_heading"], time.time())
                breadcrumbs.append({"x": current_state.x, "y": current_state.y, "z": current_state.z})
                await broadcast_to_dashboards({"type": "telemetry_update", "state": current_state.model_dump(),
                                               "breadcrumb": breadcrumbs[-1]})
            if valid_angle(compass):
                pdr_state["map_heading"] = compass_to_map_heading(float(compass), pdr_state["offset"])
                pdr_state["last"] = time.time()
            if msg.get("step") is True:
                if valid_angle(msg.get("peak")):
                    phone_log.append({"t": round(time.time(), 3), "step": True, "peak": round(float(msg["peak"]), 2),
                                      "threshold": msg.get("threshold") if valid_angle(msg.get("threshold")) else None})
                length = msg.get("step_length_m", 0.7)
                length = min(max(float(length), 0.3), 1.2) if valid_angle(length) else 0.7
                localizer.predict(True, length, pdr_state["map_heading"])
                current_state = localizer.get_state(current_state.device_id, pdr_state["map_heading"], time.time())
                breadcrumbs.append({"x": current_state.x, "y": current_state.y, "z": current_state.z})
                if len(breadcrumbs) > 500:
                    breadcrumbs.pop(0)
                await broadcast_to_dashboards({"type": "telemetry_update", "state": current_state.model_dump(),
                                               "breadcrumb": breadcrumbs[-1]})
            elif valid_angle(compass) and time.time() - last_heading_push > 0.2:
                last_heading_push = time.time()
                current_state = current_state.model_copy(update={"heading_deg": round(pdr_state["map_heading"], 1)})
                await broadcast_to_dashboards({"type": "telemetry_update", "state": current_state.model_dump()})
    except WebSocketDisconnect:
        logger.info("Phone PDR client disconnected")


@app.get("/api/phone")
async def get_phone_sensors():
    """Latest iPhone motion-sensor packet (orientation, gyro, accelerometer) and its age."""
    return {"latest": phone_state["latest"], "age_s": round(time.time() - phone_state["t"], 2) if phone_state["t"] else None,
            "samples": len(phone_log)}


@app.get("/api/phone/log")
async def get_phone_log(last: int = 1000):
    """Recorded sensor samples (newest `last`, max 20000) for offline analysis."""
    return phone_log[-max(1, min(last, PHONE_LOG_MAX)):]


# REC-01: data-collection session driven from the phone's /walker page. The phone is HTTPS and the mapper is plain
# HTTP, so the phone cannot call the mapper directly; the mapper polls GET /api/record instead and records its own
# sensor/beacon streams while a session is active. Only labels and times are kept here (no location data).
RECORD_START_LABEL, RECORD_CORNER_LABEL, RECORD_END_LABEL = "A2", "A1", "A3"
record_state: dict = {"active": False, "id": None, "rounds": 3, "route": [], "idx": 0, "phase": "at",
                      "marks": [], "started_t": None, "stopped_t": None}


def build_route(rounds: int) -> List[str]:
    """L-shaped walk A2 -> A1 -> A3, repeated `rounds` times, always ending at A3:
    rounds=1: A2 A1 A3; rounds=2: A2 A1 A3 A1 A2 A1 A3; ..."""
    route = [RECORD_START_LABEL, RECORD_CORNER_LABEL, RECORD_END_LABEL]
    for _ in range(rounds - 1):
        route += [RECORD_CORNER_LABEL, RECORD_START_LABEL, RECORD_CORNER_LABEL, RECORD_END_LABEL]
    return route


def record_view() -> dict:
    st = record_state
    route, idx = st["route"], st["idx"]
    done = bool(st["active"]) and idx >= len(route) - 1 and st["phase"] == "at"
    if not st["active"]:
        prompt = "Not collecting"
    elif done:
        prompt = f"Route complete at {route[-1]}. Press Stop."
    elif st["phase"] == "at":
        prompt = f"At {route[idx]}. Press when you start walking to {route[idx + 1]}"
    else:
        prompt = f"Walking to {route[idx + 1]}. Press when you arrive"
    now = time.time()
    return {**st, "done": done, "prompt": prompt, "n_marks": len(st["marks"]),
            "elapsed_s": round((st["stopped_t"] or now) - st["started_t"], 1) if st["started_t"] else 0.0,
            "next_label": None if not st["active"] or done else (route[idx] if st["phase"] == "walking" else route[idx + 1]),
            "button": "" if not st["active"] or done else (f"Leaving {route[idx]}" if st["phase"] == "at" else f"Arrived at {route[idx + 1]}")}


class RecordCmd(BaseModel):
    action: str
    rounds: int = Field(default=3, ge=1, le=10)


@app.get("/api/record")
async def get_record():
    return record_view()


@app.post("/api/record")
async def post_record(cmd: RecordCmd):
    """start {rounds} | mark | undo | stop. `mark` alternates leaving (at a beacon) and arriving (at the next one)."""
    st = record_state
    now = time.time()
    if cmd.action == "start":
        route = build_route(cmd.rounds)
        st.update(active=True, id=int(now), rounds=cmd.rounds, route=route, idx=0, phase="at", started_t=now,
                  stopped_t=None, marks=[{"type": "arrive", "label": route[0], "t": round(now, 3)}])
    elif not st["active"]:
        raise HTTPException(status_code=409, detail="not collecting: press Start first")
    elif cmd.action == "mark":
        route, idx = st["route"], st["idx"]
        if idx >= len(route) - 1 and st["phase"] == "at":
            raise HTTPException(status_code=409, detail="route complete: press Stop")
        if st["phase"] == "at":
            st["marks"].append({"type": "depart", "label": route[idx], "t": round(now, 3)})
            st["phase"] = "walking"
        else:
            st["idx"] = idx + 1
            st["marks"].append({"type": "arrive", "label": route[idx + 1], "t": round(now, 3)})
            st["phase"] = "at"
    elif cmd.action == "undo":
        if len(st["marks"]) <= 1:
            raise HTTPException(status_code=409, detail="nothing to undo")
        last = st["marks"].pop()
        if last["type"] == "arrive":
            st["idx"] -= 1
            st["phase"] = "walking"
        else:
            st["phase"] = "at"
    elif cmd.action == "stop":
        st["active"] = False
        st["stopped_t"] = now
    else:
        raise HTTPException(status_code=422, detail="action must be start, mark, undo or stop")
    return record_view()


@app.get("/api/mesh")
async def get_obstacle_mesh(extrude: bool = True, wall_height_m: float = 2.5):
    """Rough RF obstacle-hint mesh (BE-03): triangles around voxels where most
    anchor->walker rays were weaker than the path-loss model predicts. A hint,
    NOT a floor plan. `vertices` are [x, y, z] metres, `faces` index into them."""
    return {**voxel_grid.to_mesh(extrude=extrude, wall_height_m=wall_height_m), **voxel_grid.stats()}


@app.post("/api/reset")
async def reset_session():
    global localizer, breadcrumbs, hazards, current_state, session_started_at
    payload = build_exploration_payload(
        list(breadcrumbs),
        [hazard.model_dump() for hazard in hazards],
        current_state.device_id,
        session_started_at,
        time.time(),
    )
    localizer = ParticleFilterLocalizer(num_particles=600, room_bounds=room_bounds_2d())
    breadcrumbs.clear()
    hazards.clear()
    rf_map.reset()
    voxel_grid.reset()
    session_started_at = time.time()
    current_state = localizer.get_state("FF_Pi_Rig_1", 0.0, session_started_at)
    await broadcast_to_dashboards({
        "type": "session_reset",
    })
    saved = await persist_exploration(payload)
    return {"message": "Session reset successful", "saved": saved}


async def broadcast_to_dashboards(message: dict):
    if not dashboard_clients:
        return
    disconnected = set()
    payload = json.dumps(message)
    for ws in dashboard_clients:
        try:
            await ws.send_text(payload)
        except Exception:
            disconnected.add(ws)
    for ws in disconnected:
        dashboard_clients.discard(ws)


@app.websocket("/ws/telemetry")
async def telemetry_endpoint(websocket: WebSocket):
    """Receives nmcli Wi-Fi scans and IMU/PDR vectors from Raspberry Pi."""
    global current_state
    await websocket.accept()
    logger.info("Telemetry client connected (Raspberry Pi / Simulator)")
    try:
        while True:
            data = await websocket.receive_text()
            try:
                payload = json.loads(data)
                pdr = payload.get("pdr", {})
                wifi_scans = payload.get("wifi_scans", [])
                device_id = payload.get("device_id", "FF_Pi_Rig_1")
                timestamp = payload.get("timestamp", time.time())

                # Particle filter prediction & update
                localizer.predict(
                    step_detected=pdr.get("step_detected", False),
                    step_length_m=pdr.get("step_length_m", 0.75),
                    heading_deg=pdr.get("heading_deg", 0.0),
                )
                # No step => no motion sensor (or standing still): spread particles slightly so
                # the filter keeps tracking from signal readings alone (BE-06).
                if wifi_scans and not pdr.get("step_detected", False) and not pdr_fresh():
                    localizer.diffuse()
                localizer.update_rssi(wifi_scans, anchors)

                # Get updated state
                current_state = localizer.get_state(
                    device_id=device_id,
                    heading_deg=pdr_state["map_heading"] if pdr_fresh() else pdr.get("heading_deg", 0.0),
                    timestamp=timestamp,
                )

                # BE-08: record each anchor reading at the estimated position.
                for scan in wifi_scans:
                    anchor = anchors.get(str(scan.get("bssid") or "").lower())
                    if anchor is not None and scan.get("rssi_dbm") is not None:
                        rf_map.add(anchor.id, current_state.x, current_state.y, scan["rssi_dbm"])
                        voxel_grid.add_ray((anchor.x, anchor.y, anchor.z),
                                           (current_state.x, current_state.y, current_state.z),
                                           scan["rssi_dbm"], anchor.p0, PATH_LOSS_N)

                # Record breadcrumbs
                if pdr.get("step_detected", False) or len(breadcrumbs) == 0:
                    breadcrumbs.append({"x": current_state.x, "y": current_state.y, "z": current_state.z})
                    if len(breadcrumbs) > 500:
                        breadcrumbs.pop(0)

                # Broadcast to 3D Three.js dashboards
                await broadcast_to_dashboards({
                    "type": "telemetry_update",
                    "state": current_state.model_dump(),
                    "raw_scans": wifi_scans,
                    "breadcrumb": {"x": current_state.x, "y": current_state.y, "z": current_state.z},
                })
            except json.JSONDecodeError:
                logger.warning("Invalid JSON received from telemetry client")
    except WebSocketDisconnect:
        logger.info("Telemetry client disconnected")
        payload = build_exploration_payload(
            list(breadcrumbs),
            [hazard.model_dump() for hazard in hazards],
            current_state.device_id,
            session_started_at,
            time.time(),
        )
        await persist_exploration(payload)


@app.websocket("/ws/dashboard")
async def dashboard_endpoint(websocket: WebSocket):
    """Streams live state, anchors, and hazards to Three.js dashboard."""
    await websocket.accept()
    dashboard_clients.add(websocket)
    logger.info(f"Dashboard client connected. Total clients: {len(dashboard_clients)}")
    
    # Send initial state
    await websocket.send_text(json.dumps({
        "type": "init_state",
        "anchors": [a.model_dump() for a in unique_anchors()],
        "state": current_state.model_dump(),
        "breadcrumbs": breadcrumbs,
        "hazards": [h.model_dump() for h in hazards],
    }))
    
    try:
        while True:
            # Keep connection open and accept any UI control events
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
                if msg.get("type") == "ping":
                    await websocket.send_text(json.dumps({"type": "pong"}))
            except Exception:
                pass
    except WebSocketDisconnect:
        dashboard_clients.discard(websocket)
        logger.info(f"Dashboard client disconnected. Remaining: {len(dashboard_clients)}")
