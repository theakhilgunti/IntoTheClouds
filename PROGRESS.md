# 📋 Multi-Agent & Team Progress Board

> **Project**: IntoTheClouds (Tactical 3D SAR Mapping)  
> **Rule for AI Agents**: Read this file before modifying code. Never modify files claimed by another agent or team member.

---

## 🔒 Active File & Task Locks (Claims)

| Task ID | Claimed Files / Directories | Owner / Agent | Branch | Status | Timestamp (UTC) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| *None* | *(No active locks — all modules available)* | — | — | ⚪ Open | — |

---

## 🧭 Domain Ownership Boundaries

To avoid collision, each member and agent has a defined territory based on the hackathon PRD:

| Role / Member | Primary Scope | Permitted File Boundaries | Prohibited (Unless Coordinated) |
| :--- | :--- | :--- | :--- |
| **Member A (Backend)** | FastAPI, Math, Fusion | `project/backend/app/**`, `project/backend/tests/**` | `project/frontend/**`, `project/pi_client/**` |
| **Member B (Hardware/Pi)** | nmcli Scanner, Pi Setup | `project/pi_client/**`, `project/PRD.md` | `project/frontend/**`, `project/backend/app/fusion/**` |
| **Member C (Frontend)** | Three.js, React, UI HUD | `project/frontend/src/**`, `project/frontend/public/**` | `project/backend/**`, `project/pi_client/**` |
| **Member D (Voice & Demo)**| Voice Radio, Pitch, Docs | `project/frontend/src/components/IncidentCommandHUD.tsx`, `project/DEMO_GUIDE.md` | Core Math & Backend endpoints |

---

## 🚦 Task Backlog & Execution Pipeline

### 1. 🟡 In Progress (Claimed)
*(None currently claimed. Ready to pick up next tasks!)*

---

### 2. ⚪ Ready to Claim (Backlog)

#### 🔹 Backend & Fusion Math (`Member A / Backend Agent`)
- [ ] **`BE-01` RF Attenuation Tomography**: Ray tracing path attenuation between anchors and firefighter to identify dense walls ($RSSI_{\text{measured}} \ll RSSI_{\text{expected}}$).
- [ ] **`BE-02` 3D Voxel Density Grid**: Maintain a $0.25\text{m}^3$ voxel space representing occupied obstacles vs. cleared space.
- [ ] **`BE-03` Marching Cubes API**: Generate structural wall wireframe mesh payload for Three.js.

#### 🔹 Frontend & 3D Visualization (`Member C / Frontend Agent`)
- [ ] **`FE-01` Marching Cubes Mesh Renderer**: Render 3D wireframe walls in Three.js from the backend voxel payload.
- [ ] **`FE-02` Tactical Room Bounds & Floorplan**: Add customizable room dimensions and wall outlines to the 3D canvas.
- [ ] **`FE-03` Particle Cloud Visualization**: Render the real-time cloud of 600 particles showing localization confidence spread.

#### 🔹 Hardware & Pi Client (`Member B / Pi Agent`)
- [ ] **`HW-01` USB Gadget Mode (`g_ether`) Config Script**: Script to set up Raspberry Pi Zero/4 as a USB ethernet gadget (`169.254.x.x`).
- [ ] **`HW-02` Hardware IMU Integration**: Hook up real MPU-6050 / BNO055 I2C accelerometer/gyro step detection to `pi_scanner.py`.

#### 🔹 Voice & Integration (`Member D / Voice & Pitch Agent`)
- [ ] **`VO-01` Radio Sound Effects**: Add tactical radio beep and sound feedback on voice commands.
- [ ] **`VO-02` Hazard Export**: Export pinned hazard markers with timestamps to JSON / PDF report for incident debrief.

---

## 📜 Activity & Completion Log

| Time | Agent / Member | Action / Commit | Summary |
| :--- | :--- | :--- | :--- |
| 17:50 | Antigravity | Scaffolding | Initialized FastAPI backend, React+Three.js frontend, mock simulator, and test suite. |
| 17:52 | Backend-Agent | BE-01 | Tested claim CLI |
| 18:12 | Claude Code | DOC-01 | Removed broken duplicate project/scripts/agent_claim.py; fixed AGENTS.md claim example path to project/backend/... |
| 18:14 | Claude Code | DOC-02 | Added project/WORK_ORDERS.md: Pi-focused work orders with risks, phases and acceptance criteria |
| 18:22 | Claude Code | DOC-03 | Updated WORK_ORDERS.md for Pi 4, no IMU, laptop anchors: added HW-02a, Ethernet-first link, revised R3-R5 and HW-05 |
| 18:24 | Claude Code | HW-03 | Added pi_client/scan_benchmark.py (nmcli vs iw scan rate/noise/freshness) and pi_client/README.md; parsers tested on sample data, not yet run on a Pi |
| 18:34 | Claude Code | DOC-04 | Rewrote WORK_ORDERS.md: usage steps, priority boards, uniform task cards |
| 18:43 | Claude Code | DOC-05 | Excluded project/ from root tsconfig and eslint so the CloudScan (Vercel) build ignores the Pi/Vite project |
| 19:03 | Claude Code | DOC-06 | FE-03 now lists the missing backend dependency (particles are not sent to the dashboard); GitHub issues 2-26 expanded with detailed steps |
| 20:35 | BE-07 subagent | BE-07 | Anchors now resolve by lowercase bssid or ble_name (new optional BeaconAnchor.ble_name); deduped listing; editable DEFAULT_ANCHORS; 4 new tests |
| 20:40 | DOC-07 subagent | DOC-07 | Docs updated for 3 phone anchors + carried Windows laptop (no Pi): WORK_ORDERS (retired Pi tasks, new LC/BE/FE cards, risks, phases), README, DEMO_GUIDE, PITCH_OUTLINE; honest meter-level / RF obstacle hints wording |
| 20:33 | Claude Code | BE-06 | Added ParticleFilterLocalizer.diffuse() random-walk model, used when scans arrive with no step; 3 new tests (8 pass) |
| 20:30 | Claude Code | LC-01 | Added project/laptop_client/ Windows Wi-Fi (netsh) and BLE (bleak) scan benchmarks + README; parsers tested on sample data, not yet run on Windows |
| 19:32 | Cursor | ST-01 | Saved houses and finished walks in MongoDB via /api/models and /api/explorations. |
| 20:40 | Cursor | ST-02 | Scanner walks are the only houses written to the buildings collection. |
| 20:45 | Cursor | FE-04 | Replaced 3D HTML labels that crashed React when a scanner house loaded. |
| 21:03 | Claude Code | DOC-08 | Removed stale 'not merged' wording for LC-01/BE-06 in project/README.md and WORK_ORDERS.md; ticked BE-06 |
| 21:15 | Cursor | UI-01 | Address match uses the house number, not the closest outline; typical interiors are drawn; the model page no longer covers the house. |
| 21:29 | BE-08 subagent | BE-08 | RFMap per-anchor RSSI heatmap (rf_map.py), recorded on telemetry, GET /api/map, cleared on reset; signal map not floor plan |
| 21:42 | FE-05 subagent | FE-05 | [FE-05] RF signal heatmap (InstancedMesh) on 3D floor from GET /api/map polled every 2.5s; HUD anchor selector, show toggle, legend |
| 21:55 | Cursor | UI-02 | Draws the city lot and mapped garage around the house, and shows the room name when a room is hovered. |
| 22:10 | Cursor | UI-03 | Checked the lot against the map, drew Simonson Avenue and the driveway to the garage, and sized rooms from how many windows fit. |
| 22:25 | Cursor | UI-04 | Cut the walls, floors, and roof to the yellow mapped outline instead of the bounding rectangle. |
| 22:31 | Claude-design | DS-01 | Finished task |
| 23:40 | Antigravity | LC-02 | Completed LC-02: Implemented production laptop scanner with decoupled Wi-Fi/BLE, rolling median filter, dynamic anchor mapping, auto-reconnecting WS, and tests |
| 01:25 | Antigravity | MAP-01 | Created 2D 30mx30m Wi-Fi hotspot grid mapper with native wlanapi sub-second scanning, 3-anchor trilateration HUD, and calibration |
| 07:01 | Claude Code | MAP-02 | Finished task |
| 10:20 | Claude Code | MAP-02 | wifi_2d_grid_mapper.py runs on macOS: CoreWLAN Wi-Fi driver (MacWlanDriver), iPhone compass heading polled from the backend /api/phone with a Set +X button (POST /api/align), ThreadingHTTPServer so the live stream no longer blocks other requests; not committed; beacons not visible at test time |
| 07:09 | Claude Code | MAP-03 | Finished task |
| 10:50 | Claude Code | MAP-03 | Mac Wi-Fi signals keyed by SSID (not SSID+channel) so laptop hotspots that hop channel keep their anchor assignment; strongest AP per SSID; not committed |
| 07:13 | Claude Code | MAP-04 | Finished task |
| 11:30 | Claude Code | MAP-04 | Mapper calibration panel: live median/sd/sample count, capture point at any distance with least-squares A+n fit, set-A-only, refit, clear, manual A/n/x/y, n for all, reset one/all, known-spot check (per-anchor true vs estimated distance, A that fits, position error); POST /api/calib, GET /api/calib_status; points saved in anchors_config.json; 7 tests (test_wifi_2d_grid_mapper_calib.py) |
| 02:57 | Claude Code | MAP-05 | Mapper accuracy: drop cached duplicate scans (fingerprint), anchors go stale after 6 s (30 s on Mac, real CoreWLAN scan takes ~8 s), median+EMA smoothing, one-click 'Calibrate here' at known spots fits A/n per anchor (n clamped 1.6-4.0), solver weights by fit RMSE and HDOP from geometric ranges; beacon positions unchanged; 12 tests |
| 03:10 | Claude Code | MAP-06 | Phone compass & gyro panel in mapper dashboard: live compass/tilt/gyro + heading dial, align facing any axis, multi-axis capture fit with interference spread error, nudge/manual offset, hold-still gyro bias/noise + compass jitter (sets turn threshold), gyro-gated compass smoothing, heading source auto/phone/motion, fresh timeout, check, reset; saved in anchors_config.json; GPS ignored; GET /api/phone_status, POST /api/phone_calib; 21 tests |
| 03:31 | Claude Code | MAP-07 | Step dead reckoning in mapper: polls /walker step events (iPhone accelerometer) from backend /api/phone/log, moves dot stride x phone heading between Wi-Fi fixes, Wi-Fi fixes correct drift (Mahalanobis gated); Kalman now re-measures only on new Wi-Fi data (was re-applying stale Mac fixes 5x/s); dashboard step panel with enable, stride, stride calibration walk; 27 tests |
| 04:05 | Claude Code | MAP-08 | Accelerometer in mapper dashboard: ACCELEROMETER & STEPS panel with live 8 s motion chart + step markers (dashboard vs phone page), step detector that runs in the dashboard (gravity-removed |a|, tau-based so it works at the ~10 Hz stream; replay vs phone-page steps: 36/47 matched at 1.4), tunable threshold/min gap/smoothing, step source switch (dashboard|phone page, never both), walk calibration (record N steps -> fit threshold), hold-still gravity/noise check; settings persisted; GET /api/accel_status; 36 tests |
| 07:57 | Claude Code | MAP-05 | Finished task |
| 08:10 | Claude Code | MAP-06 | Finished task |
| 08:31 | Claude Code | MAP-07 | Finished task |
| 09:05 | Claude Code | MAP-08 | Finished task |
| 04:33 | Claude Code | MAP-10 | Fixed dashboard: the accelerometer chart canvas inherited the global full-screen canvas CSS and covered the map, blocking zoom/pan and showing as a stray signal trace; scoped that rule to the map canvas and pinned the chart in the sidebar; verified in headless Chrome (wheel + zoom buttons work, 0 JS errors) |
| 09:33 | Claude Code | MAP-10 | Finished task |
| 04:56 | Claude Code | MAP-12 | Walk recorder + offline analyzer: mapper follows the /walker collection session (REC-01) and writes recordings/walk_<id>.jsonl (beacon scans, compass/gyro, accel, steps, filter output, your arrive/leave taps as ground truth); dashboard recorder status panel; project/laptop_client/analyze_walk.py fits per-beacon A/n on true distances, stride per leg, heading offset + drift, live vs replay error, recommends settings (--apply sends to the local mapper); recordings/ git-ignored; 39 mapper + 9 analyzer tests |
| 09:56 | Claude Code | MAP-12 | Finished task |
| 00:38 | Claude Code | BE-01b | Finished task |
| 00:51 | Claude-Anchors | LC-02 | Finished task |
| 22:00 | Claude-Anchors | LC-02 | Added laptop_client/IPHONE_ANCHORS.md, anchors.example.json and offline test_radar_bridge.py (7 tests pass); match_devices verified for BLE name/stale/rotated keys |
| 00:59 | Claude Code | FE-01 | Finished task |
| 02:24 | Claude Code | BE-09 | Finished task |
| 03:41 | Claude Code | BE-09b | Finished task |
| 04:08 | Claude Code | BE-10 | Finished task |
| 04:21 | Claude Code | BE-11 | Finished task |
| 05:10 | Claude Code | BE-11 | Baseline-differential RSSI: SpotMap2D.add(baseline_rssi=) and spot_survey.py map --baseline empty.json (shortfall = baseline - now, model fallback); 3 new tests |
| 04:36 | Claude Code | DOC-09 | Finished task |
| 05:40 | Claude Code | DOC-09 | Docs for 3 laptop beacons + walker laptop + iPhone heading: new laptop_client/LAPTOP_ANCHORS.md (untested on hardware), updated README, DEMO_GUIDE, PITCH_OUTLINE, laptop_client/README; IPHONE_ANCHORS.md marked alternative |
| 06:05 | Claude Code | LC-03 | spot_survey.py collect: --wifi netsh (default on Windows, matches laptop hotspot SSID/BSSID), --wifi radar, --bluetooth now opt-in; 2 new tests (13 pass); not run on Windows hardware |
| 04:42 | Claude Code | LC-03 | Finished task |
| 04:58 | Claude Code | LC-04 | Finished task |
| 06:40 | Claude Code | LC-04 | Mac walker Wi-Fi: laptop_client/mac_wifi_radar.py + mac_wifi_scan.swift (CoreWLAN, real dBm) serving radar /api/telemetry format for spot_survey --wifi radar and radar_bridge; 3 tests (16 pass). Needs Location permission; untested against ITC- hotspots; not committed |
| 05:27 | Claude Code | LC-05 | Finished task |
| 05:32 | Claude Code | BE-12 | Finished task |
| 07:30 | Claude Code | BE-12 | iPhone telemetry: /walker now streams GPS (+accuracy), 3D orientation, gyro rate, accel via /ws/pdr; backend records them (fusion/geo.py), GET /api/phone and /api/phone/log, GPS->local metres gated on accuracy <= 15 m; 5 new tests (38 pass); not fused into position; untested on a real iPhone |
| 06:01 | Claude Code | BE-13 | Finished task |
| 08:10 | Claude Code | BE-13 | Step detector: low-pass + peak-only counting, 0.4 s gap, on-page sensitivity box (default 1.6), step events with peak logged to /api/phone/log; 1 new test (39 pass); not yet retested on iPhone |
| 06:21 | Claude Code | BE-14b | Finished task |
| 08:45 | Claude Code | BE-14 | User-set room size: GET/POST /api/room (width, length, height, margin, voxel, rf cell) resizes localizer, signal map and voxel grid, clears walk, reset keeps size; /walker page gets room inputs and a live top-down map (beacons, trail, heading arrow); 3 new tests (42 pass); frontend 3D view not updated; not yet tested on iPhone |
| 06:36 | Claude Code | LC-06 | Finished task |
| 09:30 | Claude Code | LC-06 | radar_bridge.py --insecure: accepts the self-signed https backend (wss + https POST); 16 tests pass; not yet run against live beacons |
| 04:16 | Claude Code | PRIV-01 | Removed phone GPS end to end: /walker no longer requests or shows location, backend /api/phone and /api/phone/log no longer carry gps/gps_usable/gps_origin/gps_local, clean_sensors allow-lists compass/gyro/accel only (location keys from old clients are dropped), latlon_to_local removed; tests prove GPS is rejected; 41 backend tests |
| 09:16 | Claude Code | PRIV-01 | Finished task |
| 04:48 | Claude Code | REC-01 | /walker data-collection card: Start/Stop collecting, big Leaving/Arrived tap button, Undo; backend GET/POST /api/record keeps the L-walk session (A2>A1>A3 x rounds, ends at A3) with timed taps; the mapper polls it; no location data; 47 backend tests |
| 09:48 | Claude Code | REC-01 | Finished task |
