import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildNav, routeToMarker } from "./route.ts";

const raw = JSON.parse(readFileSync(new URL("../public/demo/demo-house.json", import.meta.url), "utf8"));
const model = raw.model ?? raw;
const nav = buildNav(model);

test("front door is the south exterior door on the ground floor", () => {
  assert.equal(nav.frontDoor?.doorId, "g-d-front");
  assert.equal(nav.frontDoor?.level, 0);
});

test("route to a marker on the ground floor stays on one level", () => {
  const r = routeToMarker(nav, { floor: 0, pos: [-4, 3] });
  assert.ok(r, "route found");
  assert.ok(r.nodes.every((n) => n.level === 0));
  assert.equal(r.assumedStairs, false);
});

test("route to the second floor climbs the stairs", () => {
  const r = routeToMarker(nav, { floor: 1, pos: [4, -2] });
  assert.ok(r, "route found");
  assert.ok(r.nodes.some((n) => n.level === 0) && r.nodes.some((n) => n.level === 1));
  assert.equal(r.assumedStairs, true);
});

test("demo basement stairs are walled off, so no route is claimed", () => {
  // The basement stair room (y 0.5..4) has no door into it and no hall below it:
  // the router must say "no route" rather than draw a line through walls.
  assert.equal(routeToMarker(nav, { floor: -1, pos: [-4, -2] }), null);
});

test("route into a side room only crosses the hall wall at a door", () => {
  const r = routeToMarker(nav, { floor: 0, pos: [4, 3] });
  assert.ok(r);
  // Doors on wall g-w2 (x = 1.2) are at y = -2.25 and y = 2.25, each 0.9 wide.
  for (let i = 1; i < r.nodes.length; i++) {
    const a = r.nodes[i - 1].pt;
    const b = r.nodes[i].pt;
    if ((a[0] - 1.2) * (b[0] - 1.2) < 0) {
      const y = a[1] + ((b[1] - a[1]) * (1.2 - a[0])) / (b[0] - a[0]);
      assert.ok(Math.abs(Math.abs(y) - 2.25) <= 0.5, `crossed wall at y=${y}`);
    }
  }
});

test("a house with walls only (no rooms) gets a flagged straight-line estimate", () => {
  const bare = {
    ...model,
    floors: model.floors.map((f: { rooms: unknown[]; doors: unknown[]; stairs: unknown[] }) => ({ ...f, rooms: [], doors: [], stairs: [] })),
  };
  const r = routeToMarker(buildNav(bare), { floor: 1, pos: [3, 2] });
  assert.ok(r, "an estimate is still drawn");
  assert.equal(r.estimated, true);
  assert.ok(r.nodes.at(-1)!.level === 1 && r.nodes[0].level === 0);
});
