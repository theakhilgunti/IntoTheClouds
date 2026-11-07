# IntoTheClouds: Smoke-Resistant 3D Indoor Tactical Mapping

> **HackRPI 24-Hour Hackathon Project**  
> Real-time 3D indoor spatial reconstruction & firefighter localization in zero-visibility environments without optical line-of-sight.

---

## 🎯 Architecture Overview

```
[ 3 Phone Anchors: ITC-A1, ITC-A2, ITC-A3 ]
     - Personal Hotspot (Wi-Fi) and/or BLE beacon app, same names
           │ (Wi-Fi / Bluetooth signal strength, RSSI)
           ▼
[ Windows Laptop, carried by the walker ]  (everything runs on localhost)
     - Scanner: Wi-Fi (netsh) + Bluetooth (bleak) ──▶ [ FastAPI Fusion Engine ]
                                                        • Log-Distance Path Loss
                                                        • Particle Filter Localizer
                                                        • Random-walk motion model (no motion sensor)
                                                        • RF signal heatmap (obstacle hints later)
                                                            │
                                                            └─▶ [ Three.js 3D Tactical HUD ]
                                                                  • Approximate 3D position
                                                                  • Breadcrumbs trajectory
                                                                  • RF coverage map
                                                                  • Voice radio hazard pinning

[ Optional 4th phone ] ── steps + heading over Wi-Fi ──▶ backend (improves position, not required)
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

## 📡 Rig Setup (3 phones + 1 Windows laptop)

You need: 3 phones (anchors), 1 Windows laptop (the walker carries it), a tape measure. No router, internet, cable or extra hardware is needed for the demo. Optional: a 4th phone for steps and heading.

1. **Phones:** on each phone turn on Personal Hotspot named `ITC-A1`, `ITC-A2`, `ITC-A3`. Optionally also run a Bluetooth beacon app advertising the same name. Keep each phone plugged in, screen on, and on the hotspot screen (iPhones can hide the hotspot otherwise). Place them about 1 m high and do not move them.
2. **Positions:** measure each phone's `(x, y)` from a room corner in metres. Default layout: `ITC-A1` at `(0,0)`, `ITC-A2` at `(10,0)`, `ITC-A3` at `(5,10)`.
3. **Laptop:** on Windows turn on Location services (needed to see Wi-Fi networks) and Bluetooth. Run the backend and dashboard (Quick Start steps 1 and 2 above).
4. **Anchors:** register the anchors with the backend by BSSID (Wi-Fi) or Bluetooth name (`GET/POST /api/anchors`). Read the real BSSIDs from a scan on the laptop, not from the phone's settings screen.
5. **Scanner:** run the laptop scanner from `project/laptop_client/` (the Windows scan scripts are on branch `agent/laptop/LC-01-windows-scan-spike`, and the scanner itself is task LC-02, not merged yet). Until then use the simulator above.

With no motion sensor, the backend moves the position estimate with a **random-walk motion model** (task BE-06, on branch `agent/backend/BE-06-random-walk-motion`, not merged yet). The position then comes from signal strength alone and is coarse.

**Optional 4th phone:** it can stream steps and heading to the backend (tasks HW-02a and HW-02). The base demo works without it.

---

## 📁 Repository Structure

```
IntoTheClouds/
├── project/
│   ├── backend/                 # FastAPI server, particle filter & math engine
│   ├── frontend/                # React + Three.js 3D tactical HUD
│   ├── pi_client/               # legacy: walk simulator (simulate_walk.py); the Pi scanner is retired
│   ├── laptop_client/           # Windows Wi-Fi + Bluetooth scanner (LC-01/LC-02, on a branch until merged)
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
