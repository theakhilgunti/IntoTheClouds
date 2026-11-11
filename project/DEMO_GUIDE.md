# 🏆 Live Judging Demo Guide (24-Hour Build)

> **Goal**: Show the judges in 3 minutes that Wi-Fi and Bluetooth signals from 3 laptop beacons can give an **approximate position** and an **RF obstacle hints coverage map** with no camera, GPS or internet.
>
> **Be honest**: position is meter-level at best, and the map is a signal coverage map with obstacle hints. It is not a precise floor plan.

---

## 🧰 Setup (about 10 minutes, before the judges arrive)

You need 3 laptops (beacons), 1 Windows laptop (the walker carries it), 1 iPhone (heading and steps) and a tape measure. No router or cable is needed. Full steps: `project/laptop_client/LAPTOP_ANCHORS.md`.

1. **Beacon laptops:** turn on Windows Mobile hotspot on each and name it `ITC-A1`, `ITC-A2`, `ITC-A3`. Keep each plugged in with sleep disabled.
2. **Place them** about 1 m high, then do not touch them:
   - `ITC-A1` Corner A, $(0, 0)$
   - `ITC-A2` Corner B, $(10, 0)$
   - `ITC-A3` Opposite wall, $(5, 10)$
3. **Laptop:** turn on Bluetooth and Windows Location services. Start the backend (`./scripts/run-backend.sh`) and dashboard (`./scripts/run-frontend.sh`). Open `http://localhost:5173`.
4. **Register anchors** with the backend by BSSID or Bluetooth name (see `project/README.md`, "Rig Setup").
5. **Start the laptop scanner** (`project/laptop_client/`, task LC-02). The 3 amber beacons should appear on the dashboard and the marker should settle.

### ✅ Pre-flight checklist
- [ ] All 3 beacon laptops: hotspot on, plugged in, sleep off, not moved
- [ ] iPhone `/walker` page connected (HTTPS), +X aligned, start position set
- [ ] Anchor BSSIDs / Bluetooth names match what the backend has (`GET /api/anchors`)
- [ ] Laptop sees all 3 anchors; marker settles when standing still
- [ ] Laptop charged or plugged in; Bluetooth and Location services on
- [ ] Fallback replay ready (task IN-03) in case the venue's radio noise is bad

**iPhone:** it streams compass heading and steps to improve the track. If it fails, the backend falls back to the random-walk motion model and position comes from signal strength alone.

---

## ⚡ 4-Step Interactive Judging Demo

### 1. Anchor Placement (30s)
- Point out the 3 beacon laptops around the perimeter.
- Show the 3 amber beacons on the Three.js dashboard.

### 2. The Zero-Visibility Test (60s)
- Hand a teammate the **laptop** (they carry it open, scanner running).
- **Teammate puts on a blindfold** (demonstrating zero-visibility in thick smoke).
- Teammate walks a search path across the room.
- Judges watch the cyan marker follow their **approximate** position (meter-level, so say "approximate").

### 3. Obstacle & Hazard Radio Pinning (45s)
- Teammate says: *"Incident Command, heavy smoke and fire in northeast sector!"*
- The Web Speech API listener captures the voice command and drops a red **`FIRE`** hazard pin on the 3D map at their estimated position.

### 4. RF Coverage Map and Obstacle Hints (45s)
- Show the RF signal map on the floor (where each beacon's signal was strong or weak) as the walker covers the room. Mention that this is staged: signal heatmap first, then obstacle hints, then rough 2.5D blocks, depending on what is built.
- Say clearly: this is **not a precise floor plan**. Wi-Fi/Bluetooth signal strength cannot do that.
- Emphasize: **no cameras, no GPS, no internet, everything runs locally on one laptop.**
