# Work Orders: IntoTheClouds (HackRPI 24-Hour Build)

**Goal:** a firefighter wears a Raspberry Pi 4. It works out their position from Wi-Fi signal strength plus step counting, and a laptop shows them live on a 3D dashboard.

**Hardware we have:** Raspberry Pi 4 (no motion sensor yet), 3 laptops acting as Wi-Fi anchors (hotspots), and one server laptop (it can also be an anchor).

---

## How to use this file (read first)

1. Find a task below whose **Depends on** items are all done.
2. **Claim it** before you touch any file (this is how we avoid two people editing the same thing):
   ```bash
   python3 scripts/agent_claim.py claim --agent "<your name>" --task "HW-04" --files "project/pi_client/*"
   ```
3. Work on a branch named `agent/<role>/<TASK-ID>-<short-name>`, for example `agent/pi/HW-04-production-scanner`.
4. Check the task's **Done when** list. Backend work: `cd project/backend && PYTHONPATH=. .venv/bin/pytest tests/`. Frontend work: `cd project/frontend && npm run build`. Both must pass.
5. Release your claim (`python3 scripts/agent_claim.py release --agent "<your name>"`), tick the box below, and add one line to the log in `PROGRESS.md`.
6. Commit format: `feat(pi): [HW-04] short description`.

Stay inside your own folders (see **Owners**). If a task changes a shared file (`project/backend/app/models.py` or `project/frontend/src/types.ts`), tell the other side first. Full rules are in `AGENTS.md`.

**Owners**

| Role | Folders you may edit |
| :-- | :-- |
| **Pi / Hardware** (Member B) | `project/pi_client/**` |
| **Backend** (Member A) | `project/backend/app/**`, `project/backend/tests/**` |
| **Frontend** (Member C) | `project/frontend/src/**` |
| **Demo / Voice** (Member D) | `project/DEMO_GUIDE.md`, `project/PITCH_OUTLINE.md`, `project/frontend/src/components/IncidentCommandHUD.tsx` |

Times (T+Nh) are hours from kickoff, as targets rather than promises.

---

## The board

Tick a box when the task's **Done when** list is fully met.

### Priority 1: must have (this is the demo)

| ✓ | ID | Task | Owner | Est. | Depends on | Phase |
| :-: | :-- | :-- | :-- | :-- | :-- | :-- |
| [ ] | HW-00 | Pi bring-up | Pi | 1 h | none | 0 |
| [ ] | HW-01 | Wired link Pi to laptop | Pi | 1-2 h | HW-00 | 0 |
| [ ] | HW-02a | Get a motion sensor (IMU) | Pi | 1 h | none | 0 |
| [ ] | HW-05 | Set up the 3 laptop anchors | Pi | 1.5 h | none | 1 |
| [~] | HW-03 | Scan-rate test (script written, **must be run on the Pi**) | Pi | 1 h | HW-00, HW-05 | 1 |
| [ ] | HW-02 | Step detection and heading | Pi | 3-4 h | HW-00, HW-02a | 1 |
| [ ] | HW-04 | Production scanner | Pi | 2-3 h | HW-03 | 1 |
| [ ] | BE-04 | Validate incoming telemetry | Backend | 1.5 h | none | 1 |
| [ ] | BE-05 | Read settings from `.env`, harden the filter | Backend | 2 h | none | 2 |
| [ ] | HW-06 | Calibration | Pi | 2 h | HW-04, HW-05, BE-05 | 2 |
| [ ] | IN-01 | Walking test, end to end | Demo | 1-2 h | HW-02, HW-04, HW-06 | 2 |
| [ ] | IN-03 | Fallback replay mode | Demo | 2 h | none | 4 |
| [ ] | IN-02 | Demo script and checklist | Demo | 2 h | none | 4 |
| [ ] | IN-04 | Two full rehearsals | Everyone | 2 h | all of the above | 4 |

### Priority 2: should have

| ✓ | ID | Task | Owner | Est. | Depends on | Phase |
| :-: | :-- | :-- | :-- | :-- | :-- | :-- |
| [ ] | FE-03 | Particle cloud view | Frontend | 2 h | none | 2 |
| [ ] | FE-04 | Rig health panel | Frontend | 1.5 h | BE-04 | 2 |
| [ ] | FE-02 | Room outline and floorplan | Frontend | 2 h | none | 3 |
| [ ] | HW-07 | Start on boot, run unattended | Pi | 1.5 h | HW-04 | 4 |
| [ ] | HW-08 | Wearable packaging | Pi | 1 h | HW-02 | 4 |
| [ ] | VO-01 | Radio sound effects | Demo | 1 h | none | 4 |
| [ ] | VO-02 | Hazard export (JSON/PDF) | Demo | 2 h | none | 4 |

### Priority 3: stretch (skip if behind)

| ✓ | ID | Task | Owner | Est. | Depends on | Phase |
| :-: | :-- | :-- | :-- | :-- | :-- | :-- |
| [ ] | BE-01 | RF attenuation tomography | Backend | 3 h | BE-05 | 3 |
| [ ] | BE-02 | 3D voxel grid | Backend | 2 h | BE-01 | 3 |
| [ ] | BE-03 | Mesh API (marching cubes) | Backend | 2 h | BE-02 | 3 |
| [ ] | FE-01 | Mesh renderer | Frontend | 3 h | BE-03 | 3 |

**Critical path:** HW-01 → HW-03 → HW-04 → HW-06 → IN-01. If any of these slips, tell the team right away.

### Phases

| Phase | Hours | Goal |
| :-- | :-- | :-- |
| 0. Setup | T+0 to T+2 | Pi boots, is reachable, IMU is sourced |
| 1. Real signals | T+2 to T+8 | Real signal strength and real steps reach the backend |
| 2. Position works | T+8 to T+14 | Walk with the rig and see a believable track |
| 3. Mapping (stretch) | T+10 to T+19 | Walls appear in 3D |
| 4. Demo hardening | T+19 to T+24 | Reliable, rehearsed, with a fallback |

---

## Known risks (read before you start)

| # | Risk | What to do |
| :-- | :-- | :-- |
| R1 | **`nmcli` can't scan every 500 ms.** NetworkManager rate-limits rescans and a sweep takes 1-3 s. The PRD's "500 ms" claim is probably wrong. | HW-03 measures the real rate. Plan on 1-2 Hz and rely on step counting between scans. |
| R2 | `nmcli` gives a 0-100 quality value, not dBm. | Use `iw` for real dBm if HW-03 shows it is better (needs `sudo`). |
| R3 | **The Pi 4 has no motion sensor.** Without one the "walk" is fake. MPU-6050 has no compass, so its heading drifts. BNO055 is best. | HW-02a: get one in the first hour. Fallback by about T+4h: a phone strapped to the rig as the sensor. |
| R4 | **Laptop anchors:** the BSSID in the OS settings may not match what the Pi sees, TX power can't be set, and signal changes with lid angle. The venue's Wi-Fi will be crowded. | Read BSSIDs from the **Pi's** scan. Use SSIDs `ITC-A1`..`A3` on a fixed channel. Keep each laptop plugged in, awake, lid open, and in the same spot. |
| R5 | **Pi 4 USB-C is power and data.** A laptop port may not supply enough current to power the Pi. | Use the **Ethernet cable** to the server laptop (a USB-C Ethernet dongle if it has no port), static IPs, and power the Pi from a power bank. |
| R6 | Indoor signal strength is noisy (several dB). | Median-filter on the Pi (HW-04), tune the filter (BE-05), keep the replay fallback (IN-03). |

**Still to confirm with the team or organizers:**
- Can we add our own access points at the venue? Which channels are crowded?
- Does the server laptop have an Ethernet port, or do we need a dongle?
- What OS does each anchor laptop run? (This decides how its hotspot is set up.)
- Is there a hardware or loaner table at HackRPI for an IMU?

---

# Task cards

Each card says what to build (**Steps**) and how to know it's finished (**Done when**).

## Pi / Hardware (Member B, `project/pi_client/**`)

### HW-00: Pi bring-up
**Est.** 1 h · **Depends on** none
**Steps**
1. Flash Raspberry Pi OS Lite, enable SSH, set the hostname and Wi-Fi country (the country setting is needed to see 5 GHz).
2. Clone the repo onto the Pi. Install Python dependencies (`websockets`, plus `smbus2` or the IMU library once HW-02a is done).
3. Confirm `nmcli` and `iw` exist.

**Done when**
- You can `ssh` into the Pi.
- `python3 pi_scanner.py --mock --server ws://<server-laptop-ip>:8000/ws/telemetry` makes the dashboard move.

### HW-01: Wired link, Pi to laptop
**Est.** 1-2 h · **Depends on** HW-00
**Steps**
1. Connect the Pi's Ethernet port to the server laptop (USB-C Ethernet dongle if needed).
2. Set static IPs: Pi `10.55.0.2`, laptop `10.55.0.1`.
3. Point the scanner at `ws://10.55.0.1:8000/ws/telemetry`. Power the Pi from a power bank.
4. *Optional, only if you want a single USB-C cable:* USB gadget mode (`g_ether`). Add `dtoverlay=dwc2` and `modules-load=dwc2,g_ether`, and write `project/pi_client/setup_gadget.sh`. This is a common time sink, so do the Ethernet version first.

**Done when**
- `ping` works both ways with no router.
- `wlan0` is still free for scanning.
- `--mock` mode drives the dashboard over the cable.

### HW-02a: Get a motion sensor (IMU)
**Est.** 1 h (sourcing) or 3 h (phone fallback) · **Depends on** none
**Steps**
1. Ask the HackRPI hardware table or sponsors. In order of preference: BNO055 (I2C `0x28`, fused heading), ICM-20948 or MPU-9250 (has a compass), Raspberry Pi Sense HAT (plugs onto the Pi), MPU-6050 (I2C `0x68`, no compass). Also get 4+ female-to-female jumper wires.
2. Enable I2C on the Pi (`sudo raspi-config`).
3. **Fallback by about T+4h:** use a phone. A small web page sends the phone's motion and orientation to the backend. Phones need HTTPS for these sensors, so allow time for a self-signed certificate. Strap the phone to the rig in a fixed orientation.

**Done when**
- `i2cdetect -y 1` shows the sensor, **or** the phone page shows live readings reaching the backend.

### HW-03: Scan-rate test *(script is written; needs a run on the Pi)*
**Est.** 1 h · **Depends on** HW-00, HW-05 · **Files** `project/pi_client/scan_benchmark.py`, `project/pi_client/README.md`
**Steps**
1. With the anchors on, run on the Pi: `sudo iw dev wlan0 scan | grep -E "^BSS|freq:|signal:|SSID:"`. Note each anchor's BSSID and channel frequency.
2. Run: `sudo python3 scan_benchmark.py --ssid-prefix ITC- --freq <MHz ...> --duration 30 --json hw03_results.json`
3. Fill in the results table and the "Decision for HW-04" line in `project/pi_client/README.md`.

**Done when**
- The results table is filled in with real numbers, and a scan method is chosen.
- If the fresh rate is below 1 Hz, tell the whole team so the pitch and backend expectations change.

### HW-04: Production scanner
**Est.** 2-3 h · **Depends on** HW-03
**Steps**
1. Update `pi_scanner.py` to use the method chosen in HW-03 and report real dBm if available.
2. Keep only the anchor BSSIDs (a list, or fetched from `GET /api/anchors`).
3. Median-filter the last few readings per BSSID. Add a timestamp per scan.
4. Make sure a slow scan never blocks the send loop.

**Done when**
- A stationary rig gives stable distances on the dashboard (jitter under about 1 m).

### HW-02: Step detection and heading
**Est.** 3-4 h · **Depends on** HW-00, HW-02a
**Steps**
1. Write `project/pi_client/imu.py` to read the sensor at 50-100 Hz.
2. Detect steps from acceleration peaks with a refractory period of about 300 ms.
3. Get heading from the sensor (BNO055 fused) or a calibrated gyro integral.
4. In `pi_scanner.py`, replace the fake `step_detected=True` and rotating heading with the real values. Keep `--mock`.

**Done when**
- 20 steps in a line reports 20 ± 2.
- A 90° turn reports 90° ± 15°.
- A stationary rig reports no steps.

### HW-05: Set up the 3 laptop anchors
**Est.** 1.5 h · **Depends on** the laptops
**Steps**
1. On each anchor laptop, start a hotspot (Windows Mobile Hotspot, macOS Internet Sharing, or Linux `hostapd`/`create_ap`). SSIDs `ITC-A1`, `ITC-A2`, `ITC-A3`, one fixed channel each (try 5 GHz if 2.4 GHz is crowded). Some systems need an upstream connection before a hotspot will start, so test early.
2. Put laptops on tables or stands (about 1 m or higher), lid open, plugged in, sleep disabled.
3. Read each BSSID **from the Pi's scan**, not the laptop's settings.
4. Measure each anchor's position (x, y, z) in metres with a tape measure. Enter them with `POST /api/anchors` (or `.env` after BE-05).

**Done when**
- `GET /api/anchors` matches the physical layout.
- The Pi sees all three anchors from the middle of the room.

### HW-06: Calibration
**Est.** 2 h · **Depends on** HW-04, HW-05, BE-05
**Steps**
1. Write a script that has you stand the rig at 4 or more known points and records signal strength per anchor.
2. Fit `P0` and the path-loss exponent `n` per anchor (least squares on `RSSI = P0 - 10·n·log10(d)`).
3. Send the results via `POST /api/anchors` and record them in `.env`.

**Done when**
- Distance error at the test points is under about 2 m.
- The final `P0` and `n` values are written down.

### HW-07: Start on boot, run unattended
**Est.** 1.5 h · **Depends on** HW-04
**Steps**
1. Write a `systemd` unit that starts the scanner at boot and restarts it on failure.
2. Buffer data briefly so a short link drop doesn't lose it.
3. Choose a power bank that can handle the Pi 4's peak current, and strain-relieve the cable.

**Done when**
- After a power cycle, the dashboard shows the rig live within about 60 s with nothing typed.

### HW-08: Wearable packaging
**Est.** 1 h · **Depends on** HW-02
**Steps**
1. Mount the Pi, IMU and battery in one case that straps to the torso or belt.
2. Mark an arrow for "forward". Fix the IMU rigidly.

**Done when**
- The IMU doesn't shift during a walk, and the orientation is the same every run.

---

## Backend (Member A, `project/backend/**`)

### BE-04: Validate incoming telemetry
**Est.** 1.5 h · **Depends on** none · ⚠️ **Shared file:** changes `models.py`, so tell the Pi and Frontend owners first.
**Steps**
1. In the `/ws/telemetry` handler, validate each message with the `TelemetryPayload` model.
2. On a bad message, log it and ignore it. Don't drop the connection.
3. Optionally accept `imu_ok`, `scan_rate_hz` and `anchors_seen` for the health panel (FE-04).
4. Add tests.

**Done when**
- A malformed payload is logged and the socket stays open.
- The format in `PRD.md` still works unchanged.
- `pytest` passes.

### BE-05: Read settings from `.env`, harden the filter
**Est.** 2 h · **Depends on** none
**Steps**
1. Read anchors, particle count, path-loss exponent, room bounds and filter sigma from `.env`. `.env.example` already defines most of these, but the code ignores them.
2. Add an outlier gate for signal strength.
3. If there is no recent scan, skip the update instead of letting the weights collapse.

**Done when**
- Changing `.env` changes behavior with no code edits.
- `pytest` passes.

### BE-01 / BE-02 / BE-03: Wall mapping *(stretch)*
**Est.** 3 h + 2 h + 2 h · **Depends on** BE-05
**Steps**
1. **BE-01:** compare measured and expected signal along each anchor-to-walker path. A large drop flags an obstacle.
2. **BE-02:** accumulate that into a 0.25 m voxel grid.
3. **BE-03:** serve a marching-cubes mesh from an API endpoint.

**Done when**
- A simulated wall between an anchor and the walker produces occupied voxels, and the endpoint returns a mesh the frontend can draw. Each step has tests.
- With 3 anchors this is coarse. Present it as "obstacle hints".

---

## Frontend (Member C, `project/frontend/src/**`)

### FE-03: Particle cloud view
**Est.** 2 h · **Depends on** none
Show the filter's 600 particles in the 3D view so the spread shows localization confidence. This is good live proof that the filter works.
**Done when:** the cloud appears and tightens when the rig is stationary, and `npm run build` has 0 errors.

### FE-04: Rig health panel
**Est.** 1.5 h · **Depends on** BE-04
Show link up/down, age of last update, scan rate, anchors seen and sensor status.
**Done when:** unplugging the Pi turns the panel red within about 3 s.

### FE-02: Room outline and floorplan
**Est.** 2 h · **Depends on** none
Add configurable room dimensions and wall outlines to the 3D canvas.
**Done when:** the outline matches the real room size, and the build passes.

### FE-01: Mesh renderer *(stretch)*
**Est.** 3 h · **Depends on** BE-03
Draw the wall wireframe from the backend's mesh data.
**Done when:** a simulated wall shows up in 3D, and the build passes.

---

## Demo and voice (Member D)

### VO-01: Radio sound effects
**Est.** 1 h · **Depends on** none · Add a radio beep when a voice command is accepted.
**Done when:** a pinned hazard by voice plays the sound.

### VO-02: Hazard export
**Est.** 2 h · **Depends on** none · Export pinned hazards with timestamps as JSON (PDF if time allows).
**Done when:** one button downloads a file listing every pinned hazard with its time.

### IN-01: Walking test, end to end
**Est.** 1-2 h · **Depends on** HW-02, HW-04, HW-06
**Steps:** run the full chain (Pi → Ethernet → backend → dashboard). One person walks a known path, for example a 5 m × 5 m square. Record how far off the track is. Screen-record it.
**Done when:** the track returns to within about 2 m of the start after one loop, and there is a recording.

### IN-02: Demo script and checklist
**Est.** 2 h · **Depends on** none · **File** `project/DEMO_GUIDE.md`
Write setup steps with times, an anchor placement diagram, a pre-flight checklist (BSSIDs, channels, cable, battery) and a "what to say" outline that matches `PITCH_OUTLINE.md`.
**Done when:** a teammate who did not build it can set it up in under 10 minutes.

### IN-03: Fallback replay mode
**Est.** 2 h · **Depends on** none
Record a good telemetry session (JSON lines) and add a replay option to `simulate_walk.py`.
**Done when:** one command replays a good run and the dashboard looks like the live version. **Tell the judges when you are showing a replay.**

### IN-04: Two full rehearsals (T+22h)
**Depends on** everything in Priority 1
Run the whole demo twice from a cold start, including the blindfolded walk in `PRD.md` section 6. Log each failure and fix or document it.
**Done when:** two clean runs in a row.

---

## Honesty notes for the pitch

- Wi-Fi signal localization is **meter-level at best**. Say "approximate position" and "obstacle hints", not "precise map".
- The 3D wall mesh from 3 anchors is a **proof of concept**. The position tracking is the reliable part.
- Real fireground use would need testing in smoke and heat. Don't claim field readiness.

## Suggested first tasks per person

| Person | Start with |
| :-- | :-- |
| Pi (Member B) | HW-00 → HW-01 → HW-05 → HW-03 (HW-02a in parallel) |
| Backend (Member A) | BE-04 → BE-05 → BE-01 |
| Frontend (Member C) | FE-03 → FE-04 → FE-02 |
| Demo (Member D) | IN-03 → IN-02 → VO-01 |
