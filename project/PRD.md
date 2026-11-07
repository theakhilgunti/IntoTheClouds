# Smoke-Resistant 3D Indoor Tactical Mapping
**Product Requirement Document (PRD) — 24-Hour Build**  
*HackRPI Hackathon: "Into The Clouds"*

| Target Users | Primary Hardware | Data Link | Output Engine |
| :--- | :--- | :--- | :--- |
| Incident Command & SAR | Raspberry Pi Wearable | USB Tether (`g_ether`) / Local Hotspot | Three.js 3D Mesh |

---

## 1. Executive Summary & System Overview

During interior structural fires, optical cameras and thermal imagers suffer severe degradation from aerosol backscatter in dense smoke, while standard GPS signals fail entirely indoors. This system provides real-time 3D indoor spatial reconstruction and firefighter localization in zero-visibility environments without optical line-of-sight. 

A wearable Raspberry Pi carried by the firefighter executes unthrottled sub-second Wi-Fi scans against static beacon anchors placed outside or around the perimeter. The central server fuses Path-Loss Attenuation (RSSI) signals with Pedestrian Dead Reckoning (PDR) via a Particle Filter to generate a live 3D wall boundary mesh and track firefighter coordinates on an Incident Command dashboard.

---

## 2. System Architecture & Network Topology

```
[ Static Beacon Anchors ]
(3–4 Hotspots / Routers / ESP32s)
          │ (RF RSSI Signals)
          ▼
[ Firefighter Wearable Rig ] (Raspberry Pi)
          │
          │ (USB Gadget Tethering: `g_ether` / 169.254.x.x)
          ▼
[ Central Laptop Server (FastAPI) ]
          │ (WebSockets)
          ▼
[ Three.js Tactical Dashboard ]
```

**Zero-Router Hardware Topology:**
The system operates over USB Gadget Tethering (`g_ether`). Plugging the Raspberry Pi into the central laptop via USB creates a local virtual Ethernet connection (`169.254.x.x`), leaving the Pi's onboard Wi-Fi (`wlan0`) 100% dedicated to active sub-second background BSSID scanning without network drops.

---

## 3. Mathematical Core & Sensor Fusion

### Trilateration & Log-Distance Path Loss
Signal distance estimation model:
$$d = 10^{\frac{P_0 - \text{RSSI}}{10 \cdot n}}$$

- $P_0$: Reference power at 1m (typically $-40\text{ dBm}$)
- $\text{RSSI}$: Measured signal strength in dBm
- $n \approx 2.5$: Indoor path-loss exponent

### Particle Filter Fusion
Combines IMU step vectors from the firefighter's wearable device with spherical RSSI distance estimations to update particle weights and maintain a drift-free coordinate $(X_{FF}, Y_{FF}, Z_{FF})$.

### RF Attenuation Tomography
Ray paths where $\text{RSSI}_{\text{measured}} \ll \text{RSSI}_{\text{expected}}$ are flagged as dense structural walls or obstacles.

### 3D Mesh Generation
Marching Cubes algorithm processes a $0.25\text{m}^3$ 3D voxel density grid to generate structural wall wireframes in Three.js.

---

## 4. Software Modules & Data Formats

### Module 1: Raspberry Pi Telemetry Scanner (`pi_client/pi_scanner.py`)
Scans surrounding Wi-Fi beacons via Linux `nmcli` in a 500ms loop and relays telemetry to `ws://<HOST>:8000/ws/telemetry`:
```json
{
  "device_id": "FF_Pi_Rig_1",
  "timestamp": 1718000521.12,
  "pdr": {
    "step_detected": true,
    "step_length_m": 0.75,
    "heading_deg": 84.5
  },
  "wifi_scans": [
    { "bssid": "aa:bb:cc:11:22:33", "rssi_dbm": -52 },
    { "bssid": "aa:bb:cc:44:55:66", "rssi_dbm": -68 }
  ]
}
```

---

## 5. Team Role Allocation Matrix

| Role / Member | Primary Ownership | Deliverables |
| :--- | :--- | :--- |
| **Member A (Backend Lead)** | FastAPI, WebSockets, Particle Filter | Python WebSocket server, sensor fusion math, RF tomography, voxel density grid. |
| **Member B (Pi & Hardware)** | Raspberry Pi OS, USB Tethering, Scanners | `g_ether` USB setup, `pi_scanner.py` script, static beacon anchor setup. |
| **Member C (Frontend Lead)** | React, Three.js 3D Canvas, WebGL | Real-time 3D viewport, voxel mesh renderer, avatar trajectory visualization. |
| **Member D (Voice & Pitch)** | Network Routing, Voice AI, Live Demo | Web Speech API radio pinning, integration testing, slide deck & live demo rig. |

---

## 6. Hackathon Live Demo Setup

1. Place 3 static Wi-Fi beacons (phone hotspots / routers) around the judging room.
2. Connect the Raspberry Pi to the main laptop via USB cable and power it on.
3. Have a teammate walk through the room blindfolded while holding the Pi rig.
4. Show judges the live Three.js screen updating the firefighter's position, carving out cleared space, and generating a 3D structural outline in real time.

