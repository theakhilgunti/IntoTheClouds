# CloudScan design plan: "open page design"

Visual direction for the website. Owner: design (branch `design/open-page`). Backend and data (`app/api/**`, `lib/**`) are not touched by this work.

## Concept
The site is a blueprint. Cyanotype blue, white linework, one coral "redline" accent. Everything sits on one centered axis. Few words; the animated building does the talking.

## Tokens (`app/globals.css`)
| Token | Value | Use |
|---|---|---|
| `bp` | `#0f3a8e` | page background (with 20px grid) |
| `bp-deep` | `#0b2e72` | panels, sheets |
| `bp-ink` | `#eaf1ff` | primary lines and text |
| `bp-line` | `#9ebcff` | secondary lines, labels |
| `bp-red` | `#ff8a6b` | route, flagged items, key headline word |

Type: Barlow Condensed (caps display), JetBrains Mono (data and labels). Radius 0. Line weights: walls 3px, interior 1.6px, dimensions 0.8px.

## Home page (A-101)
Centered column: logo and demo link at the corners, headline "See the plan. Then go in.", an animated isometric two-floor house (floors lift apart and settle, dashed route, mouse parallax), a centered address bar with Scan, an "or" divider, a dashed "Upload a photo" button of the same width, and an Address / Scan / Plan strip.
Rules: no paragraphs, no cards, no glow. `prefers-reduced-motion` freezes the house.

## Model page (next)
- Top bar: back, address, status chip (Verified solid, Exterior only dashed coral, Can't model plain).
- Left rail: ALL / 2F / 1F, 52px square buttons (glove sized). Picking a floor fades the other and lifts it away.
- Centre: lifted blueprint floors, room labels, stairs, exit, route.
- Legend: solid = verified, dashed = assumed, hatch = not scanned. Nothing unscanned is ever drawn as rooms.
- "How this was built" sheet: outline, floors, interior, each with source and status.
- Can't-model state: plain reason plus "Try another address".

## Phases
1. Tokens, fonts, home page (this branch).
2. Model page restyle: `components/model/**`, `components/viewer/**` (claim first).
3. Mobile, reduced motion, accessibility and Lighthouse pass.

## Collaboration
Claim files in `PROGRESS.md` (see `AGENTS.md`). Design owns `app/page.tsx`, `app/globals.css`, `app/layout.tsx`, `components/home/**`, `components/ui/**`. Joshua owns `app/api/**` and `lib/**`.
