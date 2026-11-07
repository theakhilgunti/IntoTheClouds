from typing import List, Optional
from pydantic import BaseModel, Field


class WifiScan(BaseModel):
    bssid: str
    rssi_dbm: float


class PDRData(BaseModel):
    step_detected: bool = False
    step_length_m: float = 0.75
    heading_deg: float = 0.0


class TelemetryPayload(BaseModel):
    device_id: str = "FF_Pi_Rig_1"
    timestamp: float
    pdr: PDRData
    wifi_scans: List[WifiScan] = Field(default_factory=list)


class BeaconAnchor(BaseModel):
    id: str
    bssid: str
    x: float
    y: float
    z: float = 1.5
    p0: float = -40.0  # Reference RSSI at 1 meter


class FirefighterState(BaseModel):
    device_id: str
    x: float
    y: float
    z: float
    heading_deg: float
    step_count: int = 0
    last_update: float


class HazardPin(BaseModel):
    id: str
    label: str
    hazard_type: str  # "fire", "collapse", "victim", "blocked"
    x: float
    y: float
    z: float = 1.0
    note: Optional[str] = None
    timestamp: float

