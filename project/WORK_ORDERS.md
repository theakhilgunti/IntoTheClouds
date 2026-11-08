# Work Orders: IntoTheClouds (HackRPI 24-Hour Build)

**Goal:** a walker carries a Windows laptop. The laptop listens to the Wi-Fi and Bluetooth signal of 3 phones placed around the room, works out an **approximate position** (meter-level at best), and shows it live on a 3D dashboard. From the same signals we build a staged **RF coverage map with obstacle hints**. It is not a precise floor plan.

**Hardware we have:** 3 phones acting as anchors (each runs a Personal Hotspot named `ITC-A1`..`ITC-A3` and/or a Bluetooth beacon app advertising the same name), and 1 Windows laptop that the walker carries. The laptop runs the scanner, the FastAPI backend and the dashboard on `localhost`. An optional 4th phone can stream steps and heading. The laptop has no motion sensor.

**How the position works with no motion sensor:** by default the backend uses a **random-walk motion model** (BE-06), so the position comes from signal strength alone. The optional phone motion stream (HW-02a, HW-02) improves it, but the demo must work without it.

---

## How to use this file (read first)

1. Find a task below whose **Depends on** items are all done.
2. **Claim it** before you touch any file (this is how we avoid two people editing the same thing):
   ```bash
   python3 scripts/agent_claim.py claim --agent "<your name>" --task "LC-02" --files "project/laptop_client/*"
   ```
3. Work on a branch named `agent/<role>/<TASK-ID>-<short-name>`, for example `agent/laptop/LC-02-laptop-scanner`.
4. Check the task's **Done when** list. Backend work: `cd project/backend && PYTHONPATH=. .venv/bin/pytest tests/`. Frontend work: `cd project/frontend && npm run build`. Both must pass.
5. Release your claim (`python3 scripts/agent_claim.py release --agent "<your name>"`), tick the box below, and add one line to the log in `PROGRESS.md`.
6. Commit format: `feat(laptop): [LC-02] short description`.

Stay inside your own folders (see **Owners**). If a task changes a shared file (`project/backend/app/models.py` or `project/frontend/src/types.ts`), tell the other side first. Full rules are in `AGENTS.md`.

**Owners**

| Role | Folders you may edit |
| :-- | :-- |
| **Laptop / Anchors** (Member B) | `project/laptop_client/**` |
| **Backend** (Member A) | `project/backend/app/**`, `project/backend/tests/**` |
| **Frontend** (Member C) | `project/frontend/src/**` |
| **Demo / Voice** (Member D) | `project/DEMO_GUIDE.md`, `project/PITCH_OUTLINE.md`, `project/frontend/src/components/IncidentCommandHUD.tsx` |

The old `project/pi_client/` folder stays in the repo for now (its `simulate_walk.py` still drives the dashboard with fake data), but no new work goes there.

Times (T+Nh) are hours from kickoff, as targets rather than promises. Task IDs keep their old numbers, so the GitHub issue titles still match.

---

## Plan change: the Raspberry Pi is retired

We dropped the Raspberry Pi. These tasks are **retired** (issues closed): HW-00 bring-up (#2), HW-01 wired link (#3), HW-04 production scanner (#6), HW-06 calibration (#9), HW-07 start on boot (#10), HW-08 wearable packaging (#11). Nobody needs to set up a Pi, a USB gadget, a cable link, a power bank, or laptop anchors.

Re-scoped tasks (issues stay open, with a new meaning):

| Old task | Now |
| :-- | :-- |
| HW-03 Scan-rate test (#5) | Replaced by **LC-01** (#28): run the Windows Wi-Fi + Bluetooth scan spike on the laptop |
| HW-05 Anchors (#8) | **HW-05**: set up the 3 **phone** anchors (see also NET-01, #27) |
| HW-02a, HW-02 Motion (#4, #7) | **Optional**: a 4th phone streams steps and heading. Not needed for the base demo |

---

## The board

Tick a box when the task's **Done when** list is fully met.

### Priority 1: must have (this is the demo)

| ✓ | ID | Task | Owner | Est. | Depends on | Phase |
| :-: | :-- | :-- | :-- | :-- | :-- | :-- |
| [ ] | HW-05 | Set up the 3 phone anchors | Laptop | 1 h | none | 0 |
| [ ] | LC-01 | Run the Windows Wi-Fi + Bluetooth scan spike (scripts are in `project/laptop_client/`; needs a run on the Windows laptop) | Laptop | 1 h | none | 1 |
| [ ] | LC-02 | Laptop scanner (Wi-Fi + Bluetooth) posting to the backend | Laptop | 3 h | LC-01, BE-07 | 1 |
| [x] | BE-07 | Identify anchors by BSSID or Bluetooth name (merged) | Backend | done | none | 1 |
| [x] | BE-06 | Random-walk motion model when there are no steps (merged) | Backend | 1.5 h | none | 1 |
| [ ] | BE-04 | Validate incoming telemetry | Backend | 1.5 h | none | 1 |
| [ ] | BE-05 | Read settings from `.env`, harden the filter | Backend | 2 h | none | 2 |
| [ ] | IN-01 | Walking test, end to end | Demo | 1-2 h | LC-02, BE-06 | 2 |
| [ ] | IN-03 | Fallback replay mode | Demo | 2 h | none | 4 |
| [ ] | IN-02 | Demo script and checklist | Demo | 2 h | none | 4 |
| [ ] | IN-04 | Two full rehearsals | Everyone | 2 h | all of the above | 4 |

### Priority 2: should have

| ✓ | ID | Task | Owner | Est. | Depends on | Phase |
| :-: | :-- | :-- | :-- | :-- | :-- | :-- |
| [ ] | BE-08 | RF signal heatmap (`GET /api/map`), step 1 of the reconstruction | Backend | 3 h | BE-07 | 3 |
| [ ] | FE-05 | Show the RF signal map on the 3D floor | Frontend | 2.5 h | BE-08 | 3 |
| [ ] | FE-03 | Particle cloud view | Frontend | 2 h | small backend change (particles in telemetry_update) | 2 |
| [ ] | FE-04 | Rig health panel | Frontend | 1.5 h | BE-04 | 2 |
| [ ] | FE-02 | Room outline and floorplan | Frontend | 2 h | none | 3 |
| [ ] | VO-01 | Radio sound effects | Demo | 1 h | none | 4 |
| [ ] | VO-02 | Hazard export (JSON/PDF) | Demo | 2 h | none | 4 |

### Priority 3: stretch and optional (skip if behind)

| ✓ | ID | Task | Owner | Est. | Depends on | Phase |
| :-: | :-- | :-- | :-- | :-- | :-- | :-- |
| [ ] | HW-02a | Optional: phone as motion sensor (stream setup) | Laptop | 1.5-3 h | none | 2 |
| [ ] | HW-02 | Optional: step detection and heading from the phone | Laptop | 3 h | HW-02a | 2 |
| [ ] | BE-01 | RF attenuation tomography (obstacle hints) | Backend | 3 h | BE-05, BE-08 | 3 |
| [ ] | BE-02 | 3D voxel grid | Backend | 2 h | BE-01 | 3 |
| [ ] | BE-03 | Mesh API (2.5D extrusion) | Backend | 2 h | BE-02 | 3 |
| [ ] | FE-01 | Mesh renderer | Frontend | 3 h | BE-03 | 3 |

**Critical path:** LC-01 → LC-02 → IN-01. BE-06 must land before IN-01, or the position filter can lock up with no steps. If any of these slips, tell the team right away.

### Reconstruction stages

We build the map in stages and stop whenever time runs out:

1. **2D signal heatmap** (BE-08, FE-05): how strong each phone's signal was at each spot the walker visited.
2. **Obstacle hints** (BE-01): where the signal was weaker than expected for the distance, which may mean a wall or a dense object.
3. **2.5D extrusion** (BE-02, BE-03, FE-01): turn those hints into rough blocks on the 3D floor.

This is **not a precise floor plan**. Wi-Fi and Bluetooth signal strength (RSSI) cannot give that. True Wi-Fi sensing needs channel state information (CSI), which phones and Windows laptops do not expose.

### Phases

| Phase | Hours | Goal |
| :-- | :-- | :-- |
| 0. Setup | T+0 to T+2 | 3 phone anchors are on, named, placed and measured |
| 1. Real signals | T+2 to T+8 | The laptop scanner sends real Wi-Fi/Bluetooth readings to the backend |
| 2. Position works | T+8 to T+14 | Walk with the laptop and see a believable approximate track |
| 3. Mapping (stretch) | T+10 to T+19 | Signal heatmap, then obstacle hints, then 2.5D blocks |
| 4. Demo hardening | T+19 to T+24 | Reliable, rehearsed, with a fallback |

---

## Known risks (read before you start)

| # | Risk | What to do |
| :-- | :-- | :-- |
| R1 | **We do not yet know how well a Windows laptop hears the phones.** Earlier distance tests were off by 3-5 m. A `netsh` Wi-Fi scan can be slow and return cached values. Bluetooth signal strength is also noisy. | LC-01 measures rate, stability and noise for both. Then decide: Wi-Fi, Bluetooth, both, or zones only. |
| R2 | **No motion sensor on the laptop.** Without steps the particle filter can pile onto a few spots and lock up. | BE-06 adds a random-walk motion model. The position is then signal-only and coarse. The optional 4th phone (HW-02a, HW-02) improves it. |
| R3 | **Phone anchors:** a hotspot's BSSID may change, the hotspot may switch off or sleep, and signal varies with how the phone is held. An iPhone hotspot may not be visible unless its Personal Hotspot screen stays open. | Keep each phone plugged in, screen on, in the same spot. Use names `ITC-A1`..`A3`. The backend matches by BSSID or by Bluetooth name (BE-07). |
| R4 | **Venue Wi-Fi and Bluetooth are crowded.** Signal strength is noisy (several dB). | Median-filter in the scanner (LC-02), tune the filter (BE-05), keep the replay fallback (IN-03). |
| R5 | **Reconstruction overreach.** Signal strength cannot draw a precise floor plan. | Show the stages above. Use the words "approximate position" and "RF obstacle hints coverage map". |

**Still to confirm with the team or organizers:**
- Are phone hotspots and Bluetooth beacons allowed at the venue? Which channels are crowded?
- Are the 3 phones iPhone, Android, or mixed? (This decides how each hotspot and beacon is set up.)
- Does the Windows laptop allow Wi-Fi and Bluetooth scanning (Location services on)?
- Is a 4th phone available for the optional motion stream?

---

# Task cards

Each card says what to build (**Steps**) and how to know it's finished (**Done when**).

> **Retired Pi tasks:** HW-00, HW-01, HW-03 (replaced by LC-01), HW-04, HW-06, HW-07 and HW-08 have no task cards any more. See "Plan change" above.

## Laptop / Anchors (Member B, `project/laptop_client/**`)

### HW-05: Set up the 3 phone anchors
**Est.** 1 h · **Depends on** none · See also NET-01 (#27)
**Steps**
1. On each phone, turn on Personal Hotspot and name it `ITC-A1`, `ITC-A2`, `ITC-A3`. Optionally also run a Bluetooth beacon app advertising the same name. Keep the phone plugged in with the screen on.
2. Place each phone about 1 m high (table or stand) and then do not move it.
3. On the laptop, run a scan and read each anchor's real **BSSID** (see `project/laptop_client/README.md` once LC-01 is merged). Do not trust the phone's settings screen.
4. Measure each phone's `(x, y)` from a room corner in metres with a tape (z about 1.0). Default layout: 10 m x 10 m room, anchors at `(0,0)`, `(10,0)`, `(5,10)`.
5. Register the anchors with the backend (`POST /api/anchors`, with the BSSID and/or `ble_name`, see BE-07).

**Done when**
- `GET /api/anchors` matches the physical layout.
- The laptop sees all three anchors from the middle of the room.

### LC-01: Run the Windows Wi-Fi + Bluetooth scan spike *(done)*
**Est.** 1 h · **Depends on** none · GitHub issue #28 · Benchmark data and hybrid decision committed to `project/laptop_client/README.md`.

### LC-02: Laptop scanner (Wi-Fi + Bluetooth) *(done)*
**Est.** 3 h · **Depends on** LC-01, BE-07 · GitHub issue #29 · **File** `project/laptop_client/scanner.py`
**Implemented:**
- Decoupled `asyncio` workers: native `netsh` Wi-Fi scanning in thread and `bleak` Bluetooth LE ingestion.
- 5-sample rolling median filter (`--window 5`) per anchor.
- Anchor resolution via `GET /api/anchors` supporting both Wi-Fi BSSID and Bluetooth advertised names (`ITC-A1..A3`).
- Auto-reconnecting WebSocket client streaming to `ws://localhost:8000/ws/telemetry`.
- Realistic synthetic walk / path loss `--mock` mode with unit and integration tests in `project/laptop_client/tests/`.

### HW-02a: Optional, phone as motion sensor (stream setup)
**Est.** 1.5-3 h · **Depends on** none · GitHub issue #4 · Not needed for the base demo
A 4th phone runs a small web page that streams its motion sensors to the laptop. See issue #4 for the HTTPS and WebSocket proxy steps. Files: `project/frontend/public/phone.html` and `project/frontend/vite.config.ts` (Frontend owner's folder, so claim them first).
**Done when:** live phone data reaches the backend.

### HW-02: Optional, step detection and heading from the phone
**Est.** 3 h · **Depends on** HW-02a · GitHub issue #7 · Not needed for the base demo
Turn the phone readings into a step event and a heading (backend heading: 0 = +x, counter-clockwise). See issue #7 for the conversion details.
**Done when:** 20 steps in a line reports 20 plus or minus 2, and a 90 degree turn reports 90 plus or minus 15 degrees.

---

## Backend (Member A, `project/backend/**`)

### BE-06: Random-walk motion model when there are no steps
**Est.** 1.5 h · **Depends on** none · GitHub issue #30 · **Done and merged** (`diffuse()` in `project/backend/app/fusion/math_engine.py`)
With no steps or heading (the laptop has no motion sensor), the particles never move and the filter can lock up. Add a `diffuse(sigma_m=0.3)` method in `math_engine.py` and call it in `/ws/telemetry` when `step_detected` is false.
**Done when:** particles keep spreading slightly with no steps, the estimate converges near a fixed true position in a test, and `pytest` passes.

### BE-07: Identify anchors by BSSID or Bluetooth name *(done, merged)*
GitHub issue #31. Anchors resolve by lowercase BSSID or by Bluetooth name (`BeaconAnchor.ble_name`), so Wi-Fi and Bluetooth readings both work.

### BE-08: RF signal heatmap (2D map endpoint)
**Est.** 3 h · **Depends on** BE-07 · GitHub issue #32
First step of the reconstruction. New `project/backend/app/fusion/rf_map.py` (`RFMap`): at each estimated position, record how strong each anchor was, average per cell, and serve it as `GET /api/map`. Empty cells are `null`. Reset clears it. It is a coverage map, not a floor plan.
**Done when:** `/api/map` returns per-anchor grids that get stronger toward each anchor in a simulated walk, reset clears the map, tests pass, and the response shape is posted for FE-05.

### BE-04: Validate incoming telemetry
**Est.** 1.5 h · **Depends on** none · ⚠️ **Shared file:** changes `models.py`, so tell the Laptop and Frontend owners first.
**Steps**
1. In the `/ws/telemetry` handler, validate each message with the `TelemetryPayload` model.
2. On a bad message, log it and ignore it. Don't drop the connection.
3. Optionally accept `scan_rate_hz`, `anchors_seen` and a `motion_ok` flag for the health panel (FE-04).
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

### BE-01 / BE-02 / BE-03: Obstacle hints and 2.5D extrusion *(stretch)*
**Est.** 3 h + 2 h + 2 h · **Depends on** BE-05, BE-08
**Steps**
1. **BE-01:** compare measured and expected signal along each anchor-to-walker path. A large drop flags an obstacle.
2. **BE-02:** accumulate that into a 0.25 m voxel grid.
3. **BE-03:** serve a rough 2.5D extruded mesh (for example marching cubes) from an API endpoint.

**Done when**
- A simulated wall between an anchor and the walker produces occupied voxels, and the endpoint returns a mesh the frontend can draw. Each step has tests.
- With 3 anchors this is coarse. Present it as "RF obstacle hints" on a coverage map, not as walls or a floor plan.

---

## Frontend (Member C, `project/frontend/src/**`)

### FE-03: Particle cloud view
**Est.** 2 h · **Depends on** a small backend change (see below)
Show the filter's 600 particles in the 3D view so the spread shows localization confidence. This is good live proof that the filter works.
⚠️ **The backend does not send particles to the dashboard yet.** The `telemetry_update` message has no particle data. Ask the Backend owner to add a downsampled `particles` list (`[[x, y], ...]`) to `telemetry_update` and `init_state` in `project/backend/app/main.py` before the frontend can draw it. Details are in GitHub issue #17.
**Done when:** the cloud appears and tightens when the rig is stationary, and `npm run build` has 0 errors.

### FE-05: Show the RF signal map on the 3D floor
**Est.** 2.5 h · **Depends on** BE-08 · GitHub issue #33
Fetch `GET /api/map` every 2-3 seconds and draw one flat tile per cell on the 3D floor, warm for strong signal and cool for weak, with a legend and an anchor selector in the HUD.
**Done when:** the map appears behind the marker and grows as the walker covers the room, the selector works, and `npm run build` passes.

### FE-04: Rig health panel
**Est.** 1.5 h · **Depends on** BE-04
Show link up/down, age of last update, scan rate, anchors seen and motion-sensor status (if the optional phone stream is on).
**Done when:** stopping the laptop scanner turns the panel red within about 3 s.

### FE-02: Room outline and floorplan
**Est.** 2 h · **Depends on** none
Add configurable room dimensions and wall outlines to the 3D canvas.
**Done when:** the outline matches the real room size, and the build passes.

### FE-01: Mesh renderer *(stretch)*
**Est.** 3 h · **Depends on** BE-03
Draw the rough 2.5D obstacle blocks from the backend's mesh data.
**Done when:** a simulated obstacle shows up in 3D, and the build passes.

---

## Demo and voice (Member D)

### VO-01: Radio sound effects
**Est.** 1 h · **Depends on** none · Add a radio beep when a voice command is accepted.
**Done when:** a pinned hazard by voice plays the sound.

### VO-02: Hazard export
**Est.** 2 h · **Depends on** none · Export pinned hazards with timestamps as JSON (PDF if time allows).
**Done when:** one button downloads a file listing every pinned hazard with its time.

### IN-01: Walking test, end to end
**Est.** 1-2 h · **Depends on** LC-02, BE-06
**Steps:** run the full chain (3 phone anchors → laptop scanner → backend → dashboard, all on the carried laptop). One person walks a known path, for example a 5 m × 5 m square. Record how far off the track is. Screen-record it.
**Done when:** the track returns to within about 2 m of the start after one loop, and there is a recording.

### IN-02: Demo script and checklist
**Est.** 2 h · **Depends on** none · **File** `project/DEMO_GUIDE.md`
Write setup steps with times, an anchor placement diagram, a pre-flight checklist (BSSIDs and Bluetooth names, hotspots on, phone and laptop battery) and a "what to say" outline that matches `PITCH_OUTLINE.md`.
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

- Wi-Fi and Bluetooth signal localization is **meter-level at best** (earlier distance tests were off by 3-5 m). Say "approximate position" and "RF obstacle hints coverage map", not "precise map" or "floor plan".
- Wi-Fi/Bluetooth signal strength cannot give a precise floor plan. True Wi-Fi sensing needs CSI, which phones and Windows laptops do not expose.
- The 3D obstacle blocks from 3 anchors are a **proof of concept**. The signal coverage map is the more reliable part.
- Real fireground use would need testing in smoke and heat. Don't claim field readiness.

## Suggested first tasks per person

| Person | Start with |
| :-- | :-- |
| Laptop / Anchors (Member B) | HW-05 → LC-01 → LC-02 (HW-02a in parallel, optional) |
| Backend (Member A) | BE-06 → BE-04 → BE-05 → BE-08 |
| Frontend (Member C) | FE-03 → FE-04 → FE-05 → FE-02 |
| Demo (Member D) | IN-03 → IN-02 → VO-01 |
