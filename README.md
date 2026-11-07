# IntoTheClouds
HackRPI Hackathon "Into The Clouds"

**CloudScan** — point your phone at a building (or type an address) and get a 3D layout of its floors, rooms, stairs and exits for firefighters. Live at [cloudscan.us](https://cloudscan.us).

## Run locally
```bash
npm install
npm run dev        # http://localhost:3000, demo model at /model/demo
```

## Shared data format (for the WiFi mapping team)
Every data source produces a **BuildingModel**:
- TypeScript / zod: `packages/schema/building-model.ts`
- JSON Schema: `packages/schema/building-model.schema.json`
- Validated example: `public/demo/demo-house.json`

Coordinates are meters, x = east, y = north, origin at the footprint center. Regenerate the JSON files after changing the schema with `npm run schema`.

## Wi-Fi + Pi position tracking (`project/`)
The firefighter-location half of the project: a Raspberry Pi wearable (Wi-Fi signal strength + step counting) streams to a FastAPI backend and a live Three.js dashboard.
- Overview and quick start: [`project/README.md`](project/README.md)
- **Team work orders: [`project/WORK_ORDERS.md`](project/WORK_ORDERS.md)**
- Multi-agent rules: [`AGENTS.md`](AGENTS.md) · live task board: [`PROGRESS.md`](PROGRESS.md)

## Code layout
```
app/                 Next.js routes (/, /model/[id], /api/scan, /api/floorplan, /api/models/[id])
components/          UI: home/ (address+photo form), model/ (screen, report, floor-plan panel), viewer/ (3D)
lib/scan/            Pipeline (scan.ts), result types (sources.ts), saved-scan store (store.ts)
lib/providers/       Outside data: geocode, OpenStreetMap (overpass), aerial imagery, Gemini vision, pins
lib/model/           Building construction: layout, templates, floor-plan reading, verified interiors, demo
lib/client/          Browser-only: localStorage store, streaming scan client
lib/geo.ts           Shared geometry helpers
packages/schema/     BuildingModel (zod + JSON Schema), the shared data contract
data/interiors/      Verified room layouts keyed by building id
project/             Wi-Fi + Pi tracking subproject (separate stack; excluded from the web build)
project/docs/        Original hackathon PRD (PDF)
```

## LiDAR scans (Apple RoomPlan) → verified interiors
`POST /api/lidar` (JSON) with `{ address, scan, frame?, level?, capturedBy? }`, where `scan` is the JSON of a RoomPlan `CapturedRoom` or `CapturedStructure` (`{ "rooms": [...] }`). Header `x-upload-key` must equal `LIDAR_UPLOAD_KEY` (unset = dev-only).
- Finds the real building for the address, places the measured walls/doors/stairs inside its outline, saves it. Typing the address later shows the scanned interior.
- Refuses a scan that doesn't fit the outline (wrong building) and reports uncertainty in the notes (no compass, partial coverage, stair direction). Use `frame: "north"` when the scan was captured with ARKit `gravityAndHeading` for exact rotation.
- Format example: `public/demo/sample-roomplan.json`. Converter: `lib/model/roomplan.ts`.
- Dev saves scans to `.data/` (git-ignored). On Vercel it is memory-only until the shared database lands.
