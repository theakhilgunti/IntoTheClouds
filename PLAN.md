# CloudScan — Build Plan & Handoff

Start a new session with: *"Read PLAN.md and continue from Next Steps."*

## What we're building
HackRPI 2026 ("Into The Clouds"), ~24h. Firefighters point a phone at a house (or type an address) → CloudScan identifies the house → shows an interactive 3D layout (floors, rooms, walls, doors, stairs) with tactical markers.

- **Web team (2 people):** this repo — website + photo/address → 3D pipeline.
- **WiFi team (2 people):** separate WiFi-based house mapping. They plug in by producing a `BuildingModel` JSON (see below) and POSTing it to `/api/models`.
- Full product vision (MFA/RBAC, permit archives, CAD dispatch, offline PWA) is **roadmap only** — mention it on the landing page, don't build it.
- Team PRD: `24-Hour Hackathon PRD - Smoke-Resistant 3D Indoor Tactical Mapping.pdf` (repo root, from Developer0wl). Not yet reviewed against this plan.

## Current state (done)
- Next.js 15.5.29 (App Router) + TypeScript + Tailwind v4 + React Three Fiber/drei + zod 4.
- `packages/schema/building-model.ts` — shared zod schema (`BuildingModel`, `Floor`, `Room`, `Wall`, `Door`, `Stairs`, `Marker`). Meters, x=east, y=north, origin at footprint center.
- `npm run schema` → writes `packages/schema/building-model.schema.json` + validated sample `public/demo/demo-house.json` (give both to the WiFi team).
- `lib/templates.ts` — `colonialTemplate()` builds a 2-story + basement colonial in any W×D footprint. Used for the demo and as the layout fallback.
- `lib/demo.ts` — placeholder demo model (Troy, NY coords).
- `components/viewer/Viewer.tsx` — 3D viewer: floor toggle, explode, X-ray (red/yellow wireframe), room labels, door gaps, glowing stairs, tap-to-drop markers (fire/victim/gas/shutoff, **local state only**), "Estimated layout" + confidence badge.
- `app/model/[id]/page.tsx` — only `demo` id works (others 404).
- `app/page.tsx` — placeholder landing page.

## Deployment (done)
- GitHub: `theakhilgunti/IntoTheClouds` (private), branch `main`. CLI git has no GitHub auth — **push via GitHub Desktop** (signed in).
- Vercel project `into-the-clouds` (team `cloudscan`, Hobby), auto-deploys every push to `main`. URL: https://into-the-clouds.vercel.app
- Domain: Porkbun DNS → `A @ 216.198.79.1`, `CNAME www → 17a1fe49ecf50a54.vercel-dns-017.com`. `cloudscan.us` 308-redirects to `www.cloudscan.us`.
  - Rollback to old WordPress: root A → `192.0.79.139` + `192.0.79.174`, delete www CNAME. Wildcard `*` A records and `_acme-challenge` TXT were left untouched.
- Next.js must stay on a patched version — Vercel blocks vulnerable Next builds.

## Core pipeline to build (photo → house → 3D)
1. **Capture** (`app/scan/page.tsx`): camera photo + `navigator.geolocation` + compass (`DeviceOrientationEvent`; iOS needs `requestPermission()` on tap). Fallbacks: EXIF GPS from upload, or typed address. Needs HTTPS (Vercel preview is fine).
2. **Candidates** (`app/api/locate`, `lib/overpass.ts`, `lib/geo.ts`): Overpass query for `way["building"]` within ~80 m; keep those within ±35° of heading; sort by distance; convert footprints lat/lng → local meters.
3. **Match** (`app/api/match`, `lib/streetview.ts`, `lib/claude.ts`): Street View Static image facing each of top 3–5 candidates; send user photo + candidates to Claude vision → `{ index, confidence, stories, roof, garage, basement, style }`. Low confidence → `app/scan/confirm` lets user tap the house on a map.
4. **Generate** (`app/api/generate`): footprint (meters) + exterior attributes → Claude returns `BuildingModel` JSON (structured output). Validate with zod; retry once; else `colonialTemplate()` fit to footprint bbox.
5. **Store/serve** (`app/api/models`): save/load models (Upstash Redis / Vercel KV). Make `/model/[id]` load from storage. WiFi team POSTs here too.
6. **Address path:** geocode → nearest footprint → steps 3 (Street View only) → 4.

Claude: Anthropic SDK, `claude-sonnet-5-5` for speed (try `claude-opus-5-5` for layout quality). **Load the `claude-api` skill before writing Claude code.**

## Env vars (Vercel → Settings → Environment Variables; never commit, `.env*` is gitignored)
- `ANTHROPIC_API_KEY`
- `GOOGLE_MAPS_API_KEY` (Geocoding API + Street View Static API enabled; billing on, free tier is enough)
- Storage/realtime keys once chosen (Upstash Redis; Supabase Realtime or Liveblocks for live markers)

## Next steps (in order)
1. Pick the **demo house**; read the team PRD and reconcile any differences with this plan.
2. **Person A:** `lib/geo.ts`, `lib/overpass.ts`, `/api/geocode`, `/api/locate` → then `/api/match` + `/api/generate` with zod validation + template fallback → `/api/models` storage.
3. **Person B:** capture flow (`/scan`, `/scan/confirm`) → real landing page (hero, how it works, demo CTA, roadmap, team) → live marker sync → mobile polish (big touch targets, loading states).
4. Pre-generate the demo house through the real pipeline, save it, add `?demo=1` to skip capture. Demo must never depend on live API calls.
5. Integrate WiFi team's JSON when ready; write demo script + Devpost.

## Verification checklist
- `npm run lint` and `npm run build` pass; Vercel deploy goes Ready.
- `npm run schema` validates sample; Claude outputs and WiFi samples also pass `BuildingModel.parse`.
- Real phone over HTTPS: photo of a known house → right candidate → 3D model in < ~10 s.
- Address path works for 3 addresses.
- Marker dropped on phone A shows on phone B (after sync is built).

## Housekeeping
- Dev server: `npm run dev` → http://localhost:3000/model/demo
- Known audit warnings (PostCSS inside Next, `sharp`) need Next 16 to clear — don't upgrade mid-hackathon.
- Separate repo `Build_Your_Website_Workshop` has an uncommitted `.env` with a Gemini key — don't push it.
- Turn on 2FA for Vercel and Porkbun.
