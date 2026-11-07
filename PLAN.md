# CloudScan — Build Plan & Handoff

Start a new session with: *"Read PLAN.md and continue from Next Steps."*

## What we're building
HackRPI 2026 ("Into The Clouds"), ~24h. Firefighters type an address (or upload a photo) → CloudScan finds the real building → shows an interactive 3D model (floors, rooms, walls, doors, stairs, roof) with tactical markers.

- **Web (this repo):** website + address/photo → 3D pipeline. Working end to end.
- **Backend (friend):** shared database for saved scans. Plugs in behind `lib/scan/store.ts` (see contract below).
- **WiFi team:** separate WiFi-based house mapping. They plug in by producing `BuildingModel` JSON.
- Full product vision (MFA/RBAC, permit archives, CAD dispatch, offline PWA) is **roadmap only**.
- Sponsor tracks we qualify for: **Best Use of Gemini API** (photo reading) and, once the backend lands, **Best Use of MongoDB Atlas**.

## How the system works (done)
`POST /api/scan` streams progress lines, then one result. Pipeline is `lib/scan/scan.ts`:

| Step | Code | Source (all free) | Output |
|---|---|---|---|
| 1 Locate | `lib/providers/geocode.ts` | US Census Geocoder → OSM Nominatim fallback. Photo path: EXIF GPS or device location | lat/lng |
| 2 Outline | `lib/providers/overpass.ts` | Main OSM API (`/api/0.6/map.json`, fast) → Overpass mirrors fallback | Real footprint, OSM tags (levels, roof:shape, height), nearest street direction |
| 3 Imagery | `lib/providers/imagery.ts` | Esri World Imagery export (needs ≥ ~40 m half-width or it 500s) | Aerial JPEG |
| 4 Photos | `lib/providers/vision.ts` | Google Gemini REST, structured JSON output. Skipped if no key | Floors, roof, garage side, basement, material, style |
| 5 Build | `lib/model/layout.ts` | Our layout engine | `BuildingModel`: real footprint, front faces the street, typical room plan, roof |

- Merge rules (`lib/scan/scan.ts`): photo-based values when the user gave a photo, else OSM tags, else Gemini on the aerial, else typical values. Every value is tagged `map` / `photos` / `estimated` and shown in the "How this was built" panel.
- Layout engine: center-hall plan for wide houses, side-hall plan for narrow ones (row houses), attached garage strip, 1–3 stories, optional basement. Walls are derived from room rectangles; doors are added until every room is reachable; front/back/garage exits are marked.
- Saved scans: server memory (`lib/scan/store.ts`) + browser localStorage (`lib/client/clientStore.ts`). Same building → same ID (`osm-<wayId>`) → no repeat work.
- UI: `/` (address or photo, live step list, recent scans) → `/model/[id]` (3D viewer + "How this was built" panel + Re-scan). `/model/demo` still works.
- Viewer (`components/viewer/Viewer.tsx`): rotate/zoom, hide any floor, roof toggle, explode, X-ray (exits green, stairs yellow), windows, markers.

## Backend contract (for the friend building the database)
Implement `ScanStore` in `lib/scan/store.ts` and export it as `store`:
```ts
interface ScanStore {
  get(id: string): Promise<ScanResult | null>;   // id = model.id, e.g. "osm-1469882767"
  put(result: ScanResult): Promise<void>;        // upsert by result.model.id
}
```
- `ScanResult` is in `lib/scan/sources.ts` (model + sources + attributes + warnings + images + summary + createdAt).
- MongoDB Atlas suggestion: db `cloudscan`, collection `scans`, `_id = model.id`. Consider dropping `images` (base64) or moving them to object storage to keep documents small.
- Nothing else changes: `/api/scan` already checks `store.get` before doing any work and calls `store.put` after.
- `GET /api/models/[id]` already reads from the store, so shared links work across devices once this lands.
- Optional: `POST /api/models` for the WiFi team to upload a `BuildingModel` (validate with `BuildingModel.parse`).

## Env vars (`.env.local` locally, Vercel → Settings → Environment Variables in prod; never commit)
- `GEMINI_API_KEY` — free key from Google AI Studio (mlh.link/aistudio). Without it, step 4 is skipped and the app still works.
- `GEMINI_MODEL` — optional, defaults to `gemini-flash-latest`.
- Backend keys (e.g. `MONGODB_URI`) once the store lands.

## Deployment
- GitHub: `theakhilgunti/IntoTheClouds` (private), branch `main`. CLI git has no GitHub auth — **push via GitHub Desktop**.
- Vercel project `into-the-clouds` (team `cloudscan`, Hobby), auto-deploys every push to `main`. URL: https://into-the-clouds.vercel.app
- Domain: Porkbun DNS → `A @ 216.198.79.1`, `CNAME www → 17a1fe49ecf50a54.vercel-dns-017.com`. `cloudscan.us` 308-redirects to `www.cloudscan.us`.
  - Rollback to old WordPress: root A → `192.0.79.139` + `192.0.79.174`, delete www CNAME.
- Next.js must stay on a patched version — Vercel blocks vulnerable Next builds.
- `/api/scan` has `maxDuration = 60` (Hobby allows it).

## Next steps (in order)
1. Add `GEMINI_API_KEY` to `.env.local` and Vercel; scan the two example addresses and check the photo values look right.
2. Test the photo path on a real phone over HTTPS (iPhone photos with location on; HEIC works in Safari, not Chrome desktop).
3. Backend friend: MongoDB `ScanStore` (contract above). Add a simple per-IP rate limit on `/api/scan`.
4. Pick the demo house(s); pre-scan them so the demo never depends on live calls.
5. Integrate WiFi team's JSON; write demo script + Devpost + dev.to post.

## Known limits (say these out loud in the demo)
- Interior rooms are a typical plan, not the real floor plan. Outline, size, orientation (and floors/roof when data exists) are real.
- Non-rectangular outlines (L-shapes) are drawn exactly as a yellow line, but rooms fill the bounding rectangle.
- Some addresses have no OSM outline (e.g. parts of Troy) → typical 11 × 9 m house, flagged with a warning.
- OSM / Nominatim / Esri are free shared services: fine for a hackathon, not for heavy traffic.

## Verification checklist
- `npm run lint`, `npx tsc --noEmit`, `npm run build` pass; Vercel deploy goes Ready.
- `npm run schema` regenerates the JSON Schema + validated sample.
- Addresses tested: 17 Schuyler Ave Latham (narrow, faces east), 45 Brunswick Rd Troy (wide), 185 2nd St Troy, 110 8th St Troy (university building → warning, 5 floors capped to 3).

## Housekeeping
- Dev server: `npm run dev` → http://localhost:3000
- Known audit warnings (PostCSS inside Next, `sharp`) need Next 16 to clear — don't upgrade mid-hackathon.
- Separate repo `Build_Your_Website_Workshop` has an uncommitted `.env` with a Gemini key — don't push it.
- Turn on 2FA for Vercel and Porkbun.
