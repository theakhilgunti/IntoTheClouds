# 🏆 Live Judging Demo Guide (24-Hour Build)

> **Goal**: Convince the judges in 3 minutes that we solved structural SAR navigation through thick smoke without optical cameras.

---

## ⚡ 4-Step Interactive Judging Demo

### 1. Anchor Placement (30s)
- Place 3 Wi-Fi beacons around the judging perimeter:
  - Anchor 1 (Corner A, $(0, 0)$)
  - Anchor 2 (Corner B, $(10, 0)$)
  - Anchor 3 (Opposite wall, $(5, 10)$)
- Show the 3 amber beacons lighting up on the Three.js dashboard.

### 2. The Zero-Visibility Test (60s)
- Hand teammate the Raspberry Pi rig.
- **Teammate puts on a blindfold** (demonstrating zero-visibility in thick smoke).
- Teammate navigates a search path across the room.
- Judges watch the screen in real-time as the cyan avatar tracks their exact trajectory via fused PDR + RSSI.

### 3. Obstacle & Hazard Radio Pinning (45s)
- Teammate shouts: *"Incident Command, heavy smoke and fire in northeast sector!"*
- The Web Speech API listener captures the voice command and drops a red **`FIRE`** hazard pin directly on the 3D map at their exact coordinates.

### 4. 3D Structural Outline Carving (45s)
- Show the Marching Cubes / Voxel grid outlining the cleared perimeter.
- Emphasize the key innovation: **No optical cameras, no GPS, zero cloud latency, runs 100% locally over USB tethering.**

