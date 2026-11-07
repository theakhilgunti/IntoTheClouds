# CloudScan — Status, Problems, Pros & Cons

Written 2026-11-07. Read this with `PLAN.md` (how it works) and `README.md` (code layout).
Goal of the product: type an address → find the real building → show a 3D model with **verified** walls, doors and stairs, **no guesses**.

## 1. What works today (verified)
- Address → geocode → real building outline (OpenStreetMap) → floors/roof → 3D exterior. Tested on 17 Schuyler Ave (Latham), 45 Brunswick Rd (Troy), 1600 Pennsylvania Ave (DC). Bad addresses return a clean error.
- Interior is **never guessed**: unless a verified source exists, the site shows only the outside and a red "Interior unknown" panel.
- `POST /api/lidar` accepts an Apple RoomPlan scan for an address, checks it fits the building outline, saves it, and the address then shows the scanned rooms/walls/doors. Tested only with a **synthetic** scan.
- Floor-plan image upload (Gemini reads rooms/doors) exists but is **disabled without a key**.
- 3D viewer: rotate/zoom, floor toggles, roof, explode, X-ray, markers, room labels.
- Lint, `tsc`, and `npm run build` pass. No console errors in the viewer.

## 2. Things that are wrong or missing (fix list, most important first)

### Blocking for a real demo
1. **No real LiDAR data has ever been run through the converter.** `lib/model/roomplan.ts` was written from knowledge of Apple's RoomPlan JSON (`dimensions` = [w,h,d], column-major 4×4 `transform`, category as string or `{wall:{}}`, optional `story`, `sections`, `polygonCorners`). A real export may differ (key names, matrix layout, units, coordinate axes). **Action:** get one real CapturedRoom/CapturedStructure JSON from the LiDAR teammates, run it through `/api/lidar`, fix whatever breaks. Format example: `public/demo/sample-roomplan.json`.
2. **No `GEMINI_API_KEY`.** Photo reading and floor-plan upload are skipped. Add a free key from Google AI Studio to `.env.local` and to Vercel env vars.
3. **Saved scans don't persist on Vercel.** `lib/scan/store.ts` is memory-only in production (dev also writes to git-ignored `.data/`). Instances restart → LiDAR scans and share links vanish. Needs the shared database (MongoDB Atlas per `PLAN.md` backend contract: `get(id)` / `put(result)`).
4. **No upload password set in production.** `/api/lidar` returns 401 in production unless `LIDAR_UPLOAD_KEY` is set (and the uploader sends it in `x-upload-key`). Set it in Vercel and share it only with the scanning team.

### Accuracy problems
5. **Scan rotation is a guess unless the scan has a compass.** RoomPlan frames have arbitrary orientation. The converter fits the scan to the outline and reports "may be turned 90°/180°". Fix: LiDAR app should capture with ARKit `gravityAndHeading` and send `frame: "north"`, or the UI should let a person confirm/rotate the placement.
6. **Scan position is just "centered on the outline."** For partial scans (one room) the position can be off by metres. Needs anchoring (e.g. entrance door matched to the front street side) or manual placement.
7. **Wrong building possible.** The outline picker can choose a neighbor (`chosenBy: "nearest"` → warning). Some addresses have no OSM outline at all (parts of Troy) → typical 11×9 m box with a warning.
8. **Stair direction is assumed** (scanner records stairs, not up/down). Multi-story scans with several levels are untested.
9. **Floor count comes from OSM tags/photos and can be wrong**, which changes which floors exist in the shell.
10. **Wall/door merging is simple.** Shared walls are de-duplicated only when both endpoints match within 0.25 m; doors snap to a wall within 0.6 m; partial-overlap walls, curved walls and non-90° rooms are untested.
11. **Floor-plan upload fits plans to a bounding rectangle**, so L-shaped houses get rooms filling the rectangle (outline still drawn exactly).
12. **Interiors go stale.** Capture date is stored (`capturedAt`) but the UI does not yet warn "scanned 2 years ago". Renovations make old scans wrong.

### Operations / security
13. **No rate limiting** on `/api/scan`, `/api/floorplan`, `/api/lidar` → one user could exhaust free OSM/Nominatim/Esri limits and the Gemini quota.
14. **Free shared services** (Census/Nominatim, OSM, Overpass mirrors, Esri) are fine for a hackathon, not for traffic. Pre-scan the demo houses so the demo doesn't depend on live calls.
15. **Zero automated tests.** Everything was checked by hand. At minimum add tests for `roomplan.ts` (sample in, expected walls/doors out) and the placement fit check.
16. **Browser localStorage keeps a base64 aerial image per scan** (can fill the 5 MB quota; there's a fallback that drops images). Old scans saved before the "never guess" change show an "old scan, layout was guessed" banner.
17. **No auth/roles for who may submit or view verified interiors.** The full product vision (MFA, RBAC, audit log) is roadmap only.

### Code health
18. `lib/model/layout.ts` (360 lines) still builds a full room plan that is then thrown away unless a verified interior exists. Trimming it to just the exterior shell (walls, roof, stairs) would remove wasted work. Do it as its own change.
19. `lib/model/templates.ts` + `demo.ts` exist only for `/model/demo`.
20. Known `npm audit` warnings (PostCSS inside Next, `sharp`) need Next 16. Don't upgrade mid-hackathon.
21. `project/` (Wi-Fi + Pi tracking) is a separate Python/Vite stack owned by teammates; follow `AGENTS.md` (read `PROGRESS.md`, claim files, stay in your folder). Its local `.venv`/`node_modules` are ~370 MB and git-ignored.
22. Pushing to `main` auto-deploys cloudscan.us on Vercel. Work on branches and merge when verified.

## 3. Pros
- **Honest by design:** "no verified source → no rooms" matches life-safety needs; every value is tagged `map` / `photos` / `estimated` and shown in "How this was built."
- **Free to run:** all data sources are free; hosting is free tier.
- **One contract:** `BuildingModel` (zod + JSON Schema) lets the web, LiDAR and WiFi teams plug in independently.
- **Real ground truth path:** RoomPlan LiDAR gives measured walls/doors, not AI inference; the converter refuses scans that don't fit the building.
- **Provenance kept:** source, capture date, who captured, coverage and placement caveats travel with the model.
- **Small, fast app:** ~125 kB first-load JS, 90 tracked files, 1.7 MB git history, clean lint/types/build.
- **Cached by building ID** (`osm-<wayId>`), so the same house maps to the same record however the address is typed.

## 4. Cons / honest limits
- **Only works for houses someone already scanned.** Cold start: an unscanned address shows only the exterior. This is the right behavior but limits coverage.
- **"Failproof / zero guesses" is the wrong promise.** LiDAR has centimetre error, struggles with glass/mirrors/clutter, scans go stale, and placement inside the outline is partly inferred. Promise provenance + confidence + capture date instead.
- **RoomPlan needs a Pro iPhone/iPad and a native iOS app** (a website can't read LiDAR); scanning a whole house room-by-room can drift.
- **Exterior depends on OpenStreetMap quality**, which is patchy in some areas.
- **Free APIs can fail or throttle** at any time; there is a fallback chain but no SLA.
- **Single-region, in-memory prototype** until the database lands.

## 5. Suggested order of work
1. Get a real RoomPlan JSON, run it through `/api/lidar`, fix the converter (item 1).
2. Add `GEMINI_API_KEY` (local + Vercel) and test photo + floor-plan upload (item 2).
3. Backend friend: MongoDB `ScanStore` + `LIDAR_UPLOAD_KEY` in Vercel (items 3, 4).
4. Add rate limiting (13) and a few tests for `roomplan.ts` (15).
5. UI: show scan age and a "confirm placement / rotate" control (items 5, 6, 12).
6. Pre-scan the demo houses so the demo never depends on live calls (14).
7. Trim `layout.ts` to exterior only (18).

## 6. How to run on another device
```bash
git clone https://github.com/theakhilgunti/IntoTheClouds.git && cd IntoTheClouds
git checkout cleanup-and-lidar      # the branch this was pushed to
npm install
cp .env.example .env.local          # add GEMINI_API_KEY; LIDAR_UPLOAD_KEY is optional in dev
npm run dev                         # http://localhost:3000
```
Test the LiDAR path locally (dev accepts uploads without a key):
```bash
curl -X POST localhost:3000/api/lidar -H 'content-type: application/json' \
  -d "{\"address\":\"45 Brunswick Rd, Troy, NY\",\"scan\":$(cat public/demo/sample-roomplan.json)}"
```
(That sample is synthetic. Delete `.data/scans/` afterward so it isn't mistaken for a real scan.)
