# IntoTheClouds: Smoke-Resistant 3D Indoor Tactical Mapping

> **HackRPI 24-Hour Hackathon Project**  
> Real-time 3D indoor spatial reconstruction & firefighter localization in zero-visibility environments without optical line-of-sight.

---

## 🎯 Architecture Overview

```
[ 3 Laptop Beacons: ITC-A1, ITC-A2, ITC-A3 ]
     - Windows Mobile Hotspot (Wi-Fi), stationary, named ITC-A1..A3
           │ (Wi-Fi signal strength, RSSI)
           ▼
[ Windows Laptop, carried by the walker ]  (everything runs on localhost)
     - Scanner: Wi-Fi (netsh) ──▶ [ FastAPI Fusion Engine ]
                                                        • Log-Distance Path Loss
                                                        • Particle Filter Localizer
                                                        • Phone heading + steps (iPhone), random-walk fallback
                                                        • RF signal heatmap (obstacle hints later)
                                                            │
                                                            └─▶ [ Three.js 3D Tactical HUD ]
                                                                  • Approximate 3D position
                                                                  • Breadcrumbs trajectory
                                                                  • RF coverage map
                                                                  • Voice radio hazard pinning

[ iPhone carried with the walker ] ── compass/gyro heading + steps (HTTPS, /walker) ──▶ backend
     (joins the walker laptop via the iPhone's Personal Hotspot; improves position)
```

**What to expect (honest numbers):** position is **meter-level at best** (earlier distance tests were off by 3-5 m), so we call it an "approximate position". The map is an **RF obstacle hints coverage map**, built in stages: 2D signal heatmap, then obstacle hints, then a rough 2.5D extrusion. It is **not a precise floor plan**: Wi-Fi/Bluetooth signal strength cannot give that, and true Wi-Fi sensing needs CSI, which phones and Windows laptops do not expose.

> **Plan change:** we dropped the Raspberry Pi. See `project/WORK_ORDERS.md` for the retired tasks.

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

### 3. Run the Walk Simulator (Hardware-free testing)
In a third terminal:
```bash
./scripts/simulate-walk.sh
```
*You will immediately see the firefighter position and breadcrumb trail updating in 3D on the dashboard in real-time!*

---

## 📡 Rig Setup (3 laptop beacons + 1 walker laptop + iPhone)

You need: 3 laptops (beacons), 1 Windows laptop (the walker carries it), 1 iPhone (heading and steps), a tape measure. No router or cable is needed. **Full steps and known risks: `project/laptop_client/LAPTOP_ANCHORS.md` (not yet tested on hardware).**

1. **Beacon laptops:** on each, turn on Windows Mobile hotspot named `ITC-A1`, `ITC-A2`, `ITC-A3`. Keep each plugged in with sleep disabled. Place them about 1 m high and do not move them. Windows may refuse to start a hotspot with no connection to share; see `LAPTOP_ANCHORS.md`.
2. **Positions:** measure each beacon laptop's `(x, y)` from a room corner in metres. Default layout: `ITC-A1` at `(0,0)`, `ITC-A2` at `(10,0)`, `ITC-A3` at `(5,10)`.
3. **Laptop:** on Windows turn on Location services (needed to see Wi-Fi networks) and Bluetooth. Run the backend and dashboard (Quick Start steps 1 and 2 above).
4. **Anchors:** register the anchors with the backend by BSSID (Wi-Fi) or Bluetooth name (`GET/POST /api/anchors`). Read the real BSSIDs from a scan on the walker laptop, not from the beacon laptop's settings.
5. **Scanner:** run the laptop scanner from `project/laptop_client/` (the Windows scan test scripts from LC-01 are there now; the scanner itself is task LC-02 and is not written yet). Until then use the simulator above.

With no motion sensor, the backend moves the position estimate with a **random-walk motion model** (task BE-06, merged). The position then comes from signal strength alone and is coarse.

**iPhone (heading and steps):** join the walker laptop to the iPhone's Personal Hotspot, run the backend over HTTPS and open `https://<laptop-ip>:8000/walker` on the iPhone (iOS needs HTTPS for motion sensors). Details in `LAPTOP_ANCHORS.md`. Without the phone the backend falls back to the random-walk model.

---

## 📁 Repository Structure

```
IntoTheClouds/
├── project/
│   ├── backend/                 # FastAPI server, particle filter & math engine
│   ├── frontend/                # React + Three.js 3D tactical HUD
│   ├── pi_client/               # legacy: walk simulator (simulate_walk.py); the Pi scanner is retired
│   ├── laptop_client/           # Windows Wi-Fi + Bluetooth scanner (LC-01 scan test scripts; LC-02 scanner to come)
│   ├── scripts/                 # Core execution scripts
│   ├── PRD.md                   # Full 24-hr Hackathon PRD & technical specs
│   ├── DEMO_GUIDE.md            # Live judging 4-step walkthrough and setup guide
│   └── PITCH_OUTLINE.md         # Pitch deck slides & talking points
├── scripts/                     # Root convenience runners (delegates to project/scripts)
├── AGENTS.md                    # Multi-agent collision prevention guardrails
├── PROGRESS.md                  # Active task locks & team progress board
├── .env.example                 # Configuration template
└── README.md
```
