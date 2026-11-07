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
