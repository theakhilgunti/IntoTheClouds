# IntoTheClouds: Smoke-Resistant 3D Indoor Tactical Mapping

> **HackRPI 24-Hour Hackathon Project**  
> Real-time 3D indoor spatial reconstruction & firefighter localization in zero-visibility environments without optical line-of-sight.

---

## 🎯 Architecture Overview

```
[ Static Wi-Fi Anchors (3+) ] 
           │ (RSSI Attenuation)
           ▼
[ Firefighter Wearable Rig (Raspberry Pi) ] ──(USB Tether / WebSockets)──▶ [ Central Laptop ]
     - Sub-second Wi-Fi scans (nmcli)                                           │
     - Pedestrian Dead Reckoning (IMU / Step)                                   ├─▶ [ FastAPI Fusion Engine ]
                                                                                │     • Log-Distance Path Loss
                                                                                │     • Particle Filter Localizer
                                                                                │     • RF Attenuation Tomography
                                                                                │
                                                                                └─▶ [ Three.js 3D Tactical HUD ]
                                                                                      • Real-time 3D position
                                                                                      • Breadcrumbs trajectory
                                                                                      • Voice radio hazard pinning
```

---

## 🚀 Quick Start (Local Development)

### Prerequisites
- Python 3.9+
- Node.js 18+ (tested on Node 26)

### 1. Start the Central FastAPI Backend
```bash
./scripts/run-backend.sh
```
*API running at `http://localhost:8000` (`/docs` for Swagger UI).*

### 2. Start the Three.js Tactical Dashboard
In a new terminal:
```bash
./scripts/run-frontend.sh
```
*Dashboard accessible at `http://localhost:5173`.*

### 3. Run the Firefighter Walk Simulator (Hardware-free testing)
In a third terminal:
```bash
./scripts/simulate-walk.sh
```
*You will immediately see the firefighter position and breadcrumb trail updating in 3D on the dashboard in real-time!*

---

## 📡 Hardware / Raspberry Pi Deployment

On the Raspberry Pi wearable rig:
```bash
# Connect to central server via USB gadget ethernet or Wi-Fi
python3 pi_client/pi_scanner.py --server ws://<LAPTOP_IP>:8000/ws/telemetry --interval 0.5
```
For testing on non-Linux systems without `nmcli`, use `--mock`:
```bash
python3 pi_client/pi_scanner.py --mock
```

---

## 📁 Repository Structure

```
IntoTheClouds/
├── project/
│   ├── backend/                 # FastAPI server, particle filter & math engine
│   ├── frontend/                # React + Three.js 3D tactical HUD
│   ├── pi_client/               # nmcli telemetry scanner & walk simulator
│   ├── scripts/                 # Core execution scripts
│   ├── PRD.md                   # Full 24-hr Hackathon PRD & technical specs
│   ├── DEMO_GUIDE.md            # Live judging 4-step walkthrough guide
│   └── PITCH_OUTLINE.md         # Pitch deck slides & talking points
├── scripts/                     # Root convenience runners (delegates to project/scripts)
├── AGENTS.md                    # Multi-agent collision prevention guardrails
├── PROGRESS.md                  # Active task locks & team progress board
├── .env.example                 # Configuration template
└── README.md
```
