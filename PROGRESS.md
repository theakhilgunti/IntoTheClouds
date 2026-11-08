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

| *None* | *(No active locks — all modules available)* | — | — | ⚪ Open | — |

---

## 🚦 Task Backlog & Execution Pipeline

### 1. 🟡 In Progress (Claimed)
- None

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
| 05:25 | Cursor | UI-119 | Demo house: electrical panels + gas meter meshes and service-line run. |
| 05:20 | Cursor | UI-118 | Neighbor/obstacle disc scales with plot size (tighter small lots, fewer shells), compound-v55. |
| 05:15 | Cursor | UI-117 | Jagged near-square pads (28 Bache) → one hip instead of torn multi-wing roofs; roof-v4. |
| 05:10 | Cursor | UI-116 | Scale outdoor radius ~80% (160–340 m) for DEM/roads/neighbors/grid, compound-v54. |
| 05:05 | Cursor | UI-115 | Large/ledge neighbor shells rigid-sit (damped DEM warp) — stops Burdett-scale float + wall shear. |
| 05:00 | Cursor | UI-114 | Soft roadDeckHeight + along-rail height blur so DEM cell edges stop spiking streets. |
| 04:55 | Cursor | UI-113 | Hill roads: DEM-draped strips via roadDeckHeight (cell ceiling) + 24 m chunks, compound-v53. |
| 04:45 | Cursor | UI-112 | Neighbor shells vertex-warp to DEM again so hillside houses slant with the ground. |
| 04:40 | Cursor | UI-111 | Restore last-push DEM (raw 18 m cells) + road reach/ribbons; drop pad flatten / strip draping, compound-v52. |
| 04:55 | Cursor | UI-110 | Roads use full siteReach + higher ribbon caps; DEM despike-only (terrain-v3), compound-v51. |
| 04:50 | Cursor | UI-109 | Halve outdoor radii (100–210 m); small houses get less reach than campuses, compound-v50. |
| 04:45 | Cursor | UI-108 | Neighbor caps: campus keeps 16; smaller houses scale down (10/12/14), compound-v49. |
| 04:40 | Cursor | UI-107 | Restore party-wall check: no side windows on mid-terrace shared edges (keep front/back). |
| 04:35 | Cursor | UI-106 | DEM fidelity: finer ~11 m cells + adaptive edge-aware terrain-v2 (keeps complex relief). |
| 04:30 | Cursor | UI-105 | Smooth DEM: despike + blur + slope limit so hills aren't jagged cliffs. |
| 04:25 | Cursor | UI-104 | Map grid rides same DEM+pad surface as site elevation mesh (denser warp). |
| 04:20 | Cursor | UI-103 | Harder DEM pads under footprints; angular neighbor pick + house-centered framing, compound-v48. |
| 04:15 | Cursor | UI-102 | Roads: keep curve vertices; DEM strip + cell-ceiling (20 m chunks), compound-v47. |
| 04:05 | Cursor | UI-101 | Home + floor-plan uploads accept HEIC/HEIF (browser convert via heic2any). |
| 04:00 | Cursor | UI-100 | Terrain: flatten DEM under pads + rigid neighbor sit; invert neighborShellCap (more for small, ≤16 for large), compound-v46. |
| 09:55 | Cursor | UI-90 | Outdoor street/grid/DEM radius from capped neighbor cloud (compound-v45). |
| 09:45 | Cursor | UI-89 | Home scan progress: Cancel aborts in-flight house lookup. |
| 09:35 | Cursor | UI-88 | Wrong-house neighbor switch reframes compound/DEM locally (no full rescan). |
| 09:20 | Cursor | UI-87 | Wrong-house overlay progress bar tracks real scan steps. |
| 09:15 | Cursor | UI-86 | Wrong-house load overlay: Cancel (stay) + Go home buttons. |
| 09:05 | Cursor | UI-85 | Streets + map grid/DEM share neighborReach + neighborShellCap (compound-v44). |
| 08:55 | Cursor | UI-84 | Raise floor caps (≤12), widen neighbor reach/fetch (compound-v43), stronger large-footprint wall rectify. |
| 08:40 | Cursor | UI-83 | Maps-style address autocomplete dropdown (Nominatim suggest API + LocateForm listbox). |
| 08:25 | Cursor | UI-82 | Size-scaled siteReach (≤320 m); tighter neighbor/road discs + lower shell caps for lag (compound-v42). |
| 08:15 | Cursor | UI-81 | Chunk long street ribbons; rigid DEM lift for roads/driveways; keep streets in basement view (compound-v41). |
| 07:50 | Cursor | UI-80 | Split long corridor walls per neighbor; carve nested bath/stair from halls (compound-v40). |
| 07:35 | Cursor | UI-79 | CubiCasa5K priors for estimated house plans + CubiCasa SVG verified import (compound-v39). |
| 07:10 | Cursor | UI-78 | Stop synth pillar walls — openings punch existing outline walls only (compound-v38). |
| 07:00 | Cursor | UI-77 | Kill pillar stubs: safe edge snap, collinear wall union, absorb door remnants / drop synth crumbs (compound-v37). |
| 06:50 | Cursor | UI-76 | Curb-offset stops/signals; nearby-house loading overlay + abort on home; neighbor address hover (compound-v36). |
| 06:40 | Cursor | UI-75 | Vision VGSI assessor footprints/parcels + style/story/room cues when town is covered (compound-v35). |
| 06:25 | Cursor | UI-74 | Ban false outdoor arches (both-sides probe); straighten walls + boundary-only synth doors (compound-v34). |
| 06:15 | Cursor | UI-73 | Split university/library from school; campus atrium/lecture + library stack planners (compound-v33). |
| 06:05 | Cursor | UI-72 | Ban outdoor open arches: shell openings are hinged exit doors only; sync wall patches (compound-v32). |
| 05:55 | Cursor | UI-71 | Wider garage/shed accessory reach; OSM stop signs + traffic signals along loaded roads (compound-v31). |
| 05:45 | Cursor | UI-70 | Home example address → Burdett Avenue Residence Hall, Troy, NY. |
| 05:40 | Cursor | UI-69 | One siteReach (~200–240 m) for grid, DEM, neighbors, roads, hydrants, fences, trees (compound-v30). |
| 05:32 | Cursor | UI-68 | Fix missing streets: road ribbons allow length up to ~keepR×2.2 after wider road reach. |
| 05:25 | Cursor | UI-67 | Wider site load: OSM ~550 m, neighbors ~140–280 m, roads ~180–360 m, hydrants ~500 m; higher caps for shells/roads/trees/signals (compound-v29). |
| 05:15 | Cursor | UI-66 | Realistic openings: no bedroom↔bedroom / bathroom↔living illicit doors; living/kitchen/dining get wide open arches (compound-v28). |
| 05:05 | Cursor | UI-65 | Illicit openings through every shared interior wall (+ near-miss shell walls) so rooms stay enterable (compound-v27). |
| 05:00 | Cursor | UI-64 | Stronger openings: unique room zones, snap near edges, multi-probe walls, synthesize doors into sealed rooms (compound-v26). |
| 04:50 | Cursor | UI-63 | Door connectivity rescue so rooms are not sealed after footprint clip; rebuild openings after OSM indoor (compound-v25). |
| 04:40 | Cursor | UI-62 | Wider neighbor (~90–180 m) and road (~120–240 m) reach with max caps; OSM fetch 350 m (compound-v24). |
| 04:35 | Cursor | UI-61 | Streets render above driveways/parking (layer Y + polygonOffset + renderOrder). |
| 04:25 | Cursor | UI-60 | Per-level programs: hotel/hospital/dorm/apt ground ≠ upper floors; school upper classrooms only (compound-v23). |
| 04:15 | Cursor | UI-59 | Assumed dorm/apt/hotel/hospital/warehouse layouts; OSM indoor overlay + typology soft-check (compound-v22). |
| 04:00 | Cursor | UI-58 | Raise public floor cap to 6; bidirectional stair links between levels (compound-v21). |
| 03:55 | Cursor | UI-57 | Street View front door t + window count nudge bays / exit doors (compound-v20). |
| 03:45 | Cursor | UI-56 | Denser backyard fences/obstacles: OSM barriers, aerial fence cues, parcel soft edges (compound-v19). |
| 03:35 | Cursor | UI-55 | Street View facade cross-check (stories/garage/entry/porch) via Gemini (compound-v18). |
| 03:28 | Cursor | UI-54 | Drop solid house building pad; warped grid/DEM convey ground. |
| 03:25 | Cursor | UI-53 | Flat house pad (no DEM twist) + ground grid warped to lot grade/DEM. |
| 03:20 | Cursor | UI-52 | Real outdoor DEM (OpenTopo/EPQS) + heightfield mesh; house slab stays at 0 (compound-v17). |
| 03:00 | Cursor | UI-51 | Radius terrain disc + school/office/church layouts from OSM building=* (compound-v16). |
| 02:55 | Cursor | UI-50 | Graded terrain pads under house + neighbors and connecting apron (compound-v15). |
| 02:50 | Cursor | UI-49 | Neighbor shells within ~60–100 m radius of the house (compound-v14). |
| 02:40 | Cursor | UI-48 | Lot tilt (~3.5% street downhill) + exterior entry stairs (compound-v13). |
| 02:30 | Cursor | UI-47 | Neighbors: ring-gap detect + neighbor fences/trees/pools/backyard fill (compound-v12). |
| 02:25 | Cursor | UI-46 | Backyard fences/trees: OSM trees + inferred rear fence/trees (compound-v11). |
| 02:23 | Cursor | UI-45 | Hide outside lot/yard pad and base ground disc only. |
| 02:22 | Cursor | UI-44 | Larger compounds can zoom out farther (orbit cap + ground disc/grid). |
| 00:40 | Cursor | UI-28 | Rotate 0° uses front-door outward normal (not road centroid). |
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
| 22:35 | Cursor | UI-05 | Roof eaves follow the mapped outline; shape and ridge use OSM tags and the aerial photo when available. |
| 22:45 | Cursor | UI-06 | Rebuilt roofs as a fan over the eaves outline so stepped and L-shaped houses no longer tear. |
| 22:55 | Cursor | UI-07 | Infer roof plans from OSM, Esri aerial, and footprint class; mesh ridge lines and multi-wing roofs instead of a center peak. |
| 23:00 | Cursor | UI-08 | Widened OSM/aerial reach and site filters so larger buildings keep the lot, outbuildings, parking, and street. |
| 23:10 | Cursor | UI-09 | Layered ground to stop z-fighting, gave garages/sheds walls and roofs, and rebuilt gable meshes from ridge lines. |
| 23:55 | Cursor | UI-10 | Game/FS-style roofs: inward-offset loft on convex hips, distance-to-eaves field on complex/L footprints, outbuildings use hip loft. |
| 00:10 | Cursor | UI-11 | Sealed roofs: triangulated height-field + eaves deck, fixed hip pitch, opaque flatShading materials to kill gaps/see-through. |
| 00:25 | Cursor | UI-12 | Bloxburg-style edge/vertex roof pieces; capped zoom + smaller ground; top zoom buttons and rotate/tilt sliders. |
| 00:45 | Cursor | UI-13 | Pulled blueprint UI; kept camera HUD; roofs use edge-matched hip/gable with preserved vertex insets; fog no longer whites out zoom. |
| 00:50 | Cursor | UI-14 | Fixed inverted +/- zoom; raised OrbitControls rotateSpeed for faster drag orbit. |
| 01:05 | Cursor | UI-15 | Wider 360 ground; long roads + connectors + traffic lights; L roofs with tall wing through / short T-join. |
| 01:20 | Cursor | UI-16 | Faster orbit (no damping); OSM site features cross-checked with Esri JPEG + Gemini + optional Google Static sat. |
| 01:30 | Cursor | UI-17 | Softer rotateSpeed; rotate 0° = house front; tilt max = top-down. |
| 01:35 | Cursor | UI-18 | Rotate 0° aligns to street-facing front (from roads / front door). |
| 23:15 | Cursor | UI-14 | Finished task |
| 23:17 | Claude | UI-hotbar | Finished task |
| 23:24 | Cursor | UI-15 | Finished task |
| 23:28 | Cursor | UI-16 | Finished task |
| 23:29 | Cursor | UI-17 | Finished task |
| 23:32 | Cursor | UI-18 | Finished task |
| 23:38 | Cursor | UI-19 | OSM nearest fire hydrants in compound + red 3D hydrant markers. |
| 23:46 | Cursor | UI-20 | Irregular roofs: decompose into main trunk + rectangular wings, matched pitch, no apex cones. |
| 23:49 | Cursor | UI-21 | Roof rewrite: sealed OBB gable/hip prisms; no twisted T-join ridges or AABB snaps. |
| 23:55 | Cursor | UI-22 | Basement clears ground cover; stable outlines; gable edge-to-ridge mesh. |
| 00:04 | Cursor | UI-23 | Hydrants: keep radius 250 m+, Overpass supplement, larger markers. |
| 00:12 | Cursor | UI-24 | Large sites: single floor deck, lighter ground, orbit drag no longer fights HUD. |
| 00:28 | Cursor | UI-25 | Flat roofs: ear-clip + split concave pads so lids stay on the building. |
| 00:35 | Cursor | UI-26 | Nearest hydrant: tall red sky beacon POI with View toggle. |
| 00:40 | Cursor | UI-27 | Hydrant beacons on the 3 nearest hydrants (tallest = closest). |
| 00:42 | Cursor | UI-28 | Rotate 0° faces the front door (not road centroid). |
| 01:05 | Cursor | UI-29 | Finished task |
| 01:17 | Cursor | UI-30 | Finished task |
| 01:51 | Cursor | UI-31 | Finished task |
| 01:51 | Cursor | UI-31 | Finished task |
| 01:58 | Cursor | UI-32 | Finished task |
| 02:01 | Cursor | UI-33 | Finished task |
| 02:04 | Cursor | UI-34 | Finished task |
| 02:06 | Cursor | UI-35 | Finished task |
| 02:10 | Cursor | UI-36 | Finished task |
| 02:11 | Cursor | UI-37 | Finished task |
| 02:13 | Cursor | UI-38 | Finished task |
| 02:14 | Cursor | UI-39 | Finished task |
| 02:14 | Cursor | UI-40 | Finished task |
| 02:16 | Cursor | UI-41 | Finished task |
| 02:17 | Cursor | UI-42 | Finished task |
| 02:18 | Cursor | UI-43 | Finished task |
| 03:19 | Cursor | UI-53 | Finished task |
| 03:22 | Cursor | UI-54 | Finished task |
| 03:31 | Cursor | UI-55 | Finished task |
| 03:39 | Cursor | UI-56 | Finished task |
| 03:44 | Cursor | UI-57 | Finished task |
| 03:51 | Cursor | UI-58 | Finished task |
| 04:15 | Cursor | UI-59 | Finished task |
| 04:25 | Cursor | UI-60 | Finished task |
| 04:35 | Cursor | UI-61 | Finished task |
| 04:40 | Cursor | UI-62 | Finished task |
| 04:50 | Cursor | UI-63 | Finished task |
| 05:00 | Cursor | UI-64 | Finished task |
| 05:05 | Cursor | UI-65 | Finished task |
| 06:34 | Cursor | UI-79 | Finished task |
| 07:02 | Cursor | UI-80 | Finished task |
| 07:14 | Cursor | UI-81 | Finished task |
| 07:22 | Cursor | UI-82 | Finished task |
| 07:37 | Cursor | UI-83 | Finished task |
| 07:43 | Cursor | UI-84 | Finished task |
| 07:47 | Cursor | UI-85 | Finished task |
| 07:48 | Cursor | UI-86 | Finished task |
| 07:48 | Cursor | UI-87 | Finished task |
| 07:54 | Cursor | UI-88 | Finished task |
| 07:56 | Cursor | UI-89 | Finished task |
| 08:00 | Cursor | UI-90 | Finished task |
| 08:55 | Cursor | UI-100 | Finished task |
| 08:57 | Cursor | UI-101 | Finished task |
| 09:01 | Cursor | UI-102 | Finished task |
| 09:01 | Cursor | UI-102 | Finished task |
| 09:06 | Cursor | UI-103 | Finished task |
| 09:10 | Cursor | UI-104 | Finished task |
| 09:12 | Cursor | UI-105 | Finished task |
| 09:16 | Cursor | UI-106 | Finished task |
| 09:19 | Cursor | UI-107 | Finished task |
| 09:26 | Cursor | UI-108 | Finished task |
| 09:28 | Cursor | UI-109 | Finished task |
| 09:28 | Cursor | UI-109 | Finished task |
| 09:33 | Cursor | UI-110 | Finished task |
| 09:33 | Cursor | UI-110 | Finished task |
| 09:40 | Cursor | UI-111 | Finished task |
| 09:43 | Cursor | UI-112 | Finished task |
| 09:51 | Cursor | UI-113 | Finished task |
| 09:53 | Cursor | UI-114 | Finished task |
| 09:56 | Cursor | UI-115 | Finished task |
| 09:58 | Cursor | UI-116 | Finished task |
| 10:01 | Cursor | UI-117 | Finished task |
| 10:02 | Cursor | UI-117 | Finished task |
| 10:12 | Cursor | UI-118 | Finished task |
| 10:13 | Cursor | UI-118 | Finished task |
| 10:19 | Cursor | UI-119 | Finished task |
| 12:00 | Claude Code | PRO-01 | CloudScan Pro Phase 1: Pro button + demo login, 3 draggable tracking points (Origin/X/Y type + device IP panel, saved per house in the browser). UI only, no live feed yet. |
| 12:30 | Claude Code | PRO-02 | Pro Phase 2: backend /api/pro/setup (origin/x/y frame from 3 typed points + IPs), /api/pro/simulate, site-frame position in telemetry; website Link devices + Simulate walk + live readout; setup shared via MongoDB (/api/pro/setup/[id]). 24 backend tests pass. |
| 13:00 | Claude Code | PRO-03 | Pro Phase 3: live firefighter marker + breadcrumb trail on a chosen floor, approximate-position banner, per-anchor signal/lost status, floor picker. |
| 13:30 | Claude Code | PRO-04 | Fire drill: simulated firefighter walks the planned route (doors, stairs, floors) to a fire marker, sprays it, removes it; Add test fire / Send firefighter in Pro panel. |
| 14:00 | Claude Code | PRO-05 | Pro panel redesigned: 3 steps (Place / Connect / Track), monochrome blueprint ink with colour only for Origin/X/Y, rem-based sizing, bottom sheet on narrow screens. |
| 14:20 | Claude Code | PRO-06 | Pro panel re-themed as a dark terminal (phosphor green on near-black, mono type, [1] tabs, scanlines); anchor colours now cyan/amber/pink so they stay distinct from the green UI. |
| 14:40 | Claude Code | PRO-07 | Pro button is now an orange crown + PRO (icon-only under 420px). |
| 15:00 | Claude Code | PRO-08 | Pro panel slides in from the right (bottom on phones) and slides back out; login box pops in. Respects reduced motion. |
| 15:30 | Claude Code | PRO-09 | New low-poly firefighter model (helmet, coat with reflective stripes, SCBA tank, boots, walk swing) with name tags; live / drill / signal-lost variants. |
| 15:45 | Claude Code | PRO-10 | Firefighter model scaled to real human size (1.8 m with helmet); tag and ring sized to match. |
| 16:10 | Claude Code | PRO-11 | Tracked firefighter now respects walls: lib/walk.ts walks in straight lines when clear, otherwise A* through door openings and around the building; breadcrumbs follow the walked path. Tests in lib/walk.test.ts. |
