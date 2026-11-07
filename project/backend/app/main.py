import asyncio
import json
import logging
import time
from typing import Dict, List, Set
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .models import BeaconAnchor, FirefighterState, HazardPin, TelemetryPayload
from .fusion.math_engine import ParticleFilterLocalizer
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
localizer = ParticleFilterLocalizer(num_particles=600, room_bounds=(-2.0, -2.0, 12.0, 12.0))
current_state: FirefighterState = localizer.get_state("FF_Pi_Rig_1", 0.0, time.time())
session_started_at: float = time.time()

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
    localizer = ParticleFilterLocalizer(num_particles=600, room_bounds=(-2.0, -2.0, 12.0, 12.0))
    breadcrumbs.clear()
    hazards.clear()
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
                if wifi_scans and not pdr.get("step_detected", False):
                    localizer.diffuse()
                localizer.update_rssi(wifi_scans, anchors)

                # Get updated state
                current_state = localizer.get_state(
                    device_id=device_id,
                    heading_deg=pdr.get("heading_deg", 0.0),
                    timestamp=timestamp,
                )

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
