import asyncio
import json
import logging
import time
from typing import Dict, List, Optional, Set
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .models import BeaconAnchor, FirefighterState, HazardPin, TelemetryPayload
import numpy as np
from .fusion.math_engine import ParticleFilterLocalizer
from .fusion.rf_map import RFMap
from .explored_session import build_exploration_payload, persist_exploration
from .pro import ProSetup, ProState, build_state, local_to_site, sim_position, sim_scans

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
localizer = ParticleFilterLocalizer(num_particles=600, room_bounds=(-2.0, -2.0, 12.0, 12.0))
# BE-08: per-anchor RSSI heatmap over the same bounds (a signal map, not a floor plan).
rf_map = RFMap(-2.0, -2.0, 12.0, 12.0, cell_m=0.5)
current_state: FirefighterState = localizer.get_state("FF_Pi_Rig_1", 0.0, time.time())
session_started_at: float = time.time()

# CloudScan Pro: the 3-point setup sent from the website (None until linked).
pro_state: Optional[ProState] = None
sim_task: Optional[asyncio.Task] = None
SIM_HZ = 5.0

# Active dashboard WebSockets
dashboard_clients: Set[WebSocket] = set()


def current_bounds() -> tuple:
    b = pro_state.bounds if pro_state else [-2.0, -2.0, 12.0, 12.0]
    return (b[0], b[1], b[2], b[3])


def site_position(x: float, y: float) -> Optional[dict]:
    """Scanner-frame metres -> the website's site frame (only once a Pro setup is linked)."""
    if pro_state is None:
        return None
    sx, sy = local_to_site(pro_state.frame, x, y)
    return {"x": round(sx, 3), "y": round(sy, 3)}


def pro_status() -> dict:
    return {
        "linked": pro_state is not None,
        "simulating": sim_task is not None and not sim_task.done(),
        "setup": pro_state.model_dump() if pro_state else None,
        "state": current_state.model_dump(),
        "site": site_position(current_state.x, current_state.y),
    }


async def stop_simulation() -> None:
    global sim_task
    if sim_task is not None and not sim_task.done():
        sim_task.cancel()
        try:
            await sim_task
        except asyncio.CancelledError:
            pass
    sim_task = None


async def _simulate() -> None:
    t0 = time.time()
    while pro_state is not None:
        t = time.time() - t0
        lx, ly = pro_state.frame.length_x_m, pro_state.frame.length_y_m
        px, py = sim_position(t, lx, ly)
        await ingest_telemetry({
            "device_id": "FF_SIM",
            "timestamp": time.time(),
            "pdr": {"step_detected": False},
            "wifi_scans": sim_scans(pro_state.anchors, px, py),
        })
        await asyncio.sleep(1.0 / SIM_HZ)


@app.post("/api/pro/setup")
async def pro_setup(setup: ProSetup):
    """Website -> backend: three typed points with device IPs. Rebuilds the scanner frame."""
    global pro_state, localizer, rf_map, current_state, session_started_at
    try:
        state = build_state(setup)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    await stop_simulation()
    pro_state = state
    anchors.clear()
    for a in state.anchors:
        register_anchor(a)
    localizer = ParticleFilterLocalizer(num_particles=600, room_bounds=current_bounds())
    rf_map = RFMap(*state.bounds, cell_m=0.5)
    breadcrumbs.clear()
    session_started_at = time.time()
    current_state = localizer.get_state("FF_Pi_Rig_1", 0.0, session_started_at)
    await broadcast_to_dashboards({"type": "pro_setup", "setup": state.model_dump()})
    return pro_status()


@app.get("/api/pro/status")
async def get_pro_status():
    return pro_status()


@app.post("/api/pro/simulate")
async def pro_simulate(body: dict):
    """{"on": true} starts a simulated walk through the 3-point area; {"on": false} stops it."""
    global sim_task
    if body.get("on"):
        if pro_state is None:
            raise HTTPException(status_code=409, detail="Link the 3 points first")
        if sim_task is None or sim_task.done():
            sim_task = asyncio.create_task(_simulate())
    else:
        await stop_simulation()
    return pro_status()


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
    localizer = ParticleFilterLocalizer(num_particles=600, room_bounds=current_bounds())
    breadcrumbs.clear()
    hazards.clear()
    rf_map.reset()
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


async def ingest_telemetry(payload: dict) -> None:
    """One telemetry sample (real scanner or the simulator) -> filter -> dashboards."""
    global current_state
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
    if wifi_scans and not pdr.get("step_detected", False):
        localizer.diffuse()
    localizer.update_rssi(wifi_scans, anchors)

    # Get updated state
    current_state = localizer.get_state(
        device_id=device_id,
        heading_deg=pdr.get("heading_deg", 0.0),
        timestamp=timestamp,
    )

    # BE-08: record each anchor reading at the estimated position.
    for scan in wifi_scans:
        anchor = anchors.get(str(scan.get("bssid") or "").lower())
        if anchor is not None and scan.get("rssi_dbm") is not None:
            rf_map.add(anchor.id, current_state.x, current_state.y, scan["rssi_dbm"])

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
        "site": site_position(current_state.x, current_state.y),
    })


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
                await ingest_telemetry(payload)
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
        "pro": pro_status(),
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
