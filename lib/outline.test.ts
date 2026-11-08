import assert from "node:assert/strict";
import test from "node:test";
import {
  clipPolyToRect,
  expandPoly,
  rectifyRoomPoly,
  signedArea,
  splitAtX,
  splitAtY,
  wallsAlongOutline,
} from "./outline.ts";

const notch = [
  [0, 0], [10, 0], [10, 2], [4, 2], [4, 3], [0, 3],
] as [number, number][];

test("a rectangle inside the outline stays a rectangle", () => {
  const got = clipPolyToRect(notch, { x0: 0.5, y0: 0.4, x1: 3, y1: 2.2 });
  assert.equal(got.length, 4);
  assert.ok(Math.abs(signedArea(got) - 2.5 * 1.8) < 0.05);
});

test("a room that covers the step keeps the step and drops the missing corner", () => {
  const got = clipPolyToRect(notch, { x0: 3, y0: -1, x1: 11, y1: 4 });
  const has = (x: number, y: number) => got.some((p) => Math.hypot(p[0] - x, p[1] - y) < 0.05);
  assert.ok(has(10, 0));
  assert.ok(has(10, 2));
  assert.ok(has(4, 2));
  assert.ok(has(4, 3));
  assert.equal(got.some((p) => p[0] > 10.05 || p[1] > 3.05), false);
});

test("the shared wall is interior and the step is exterior", () => {
  const left = clipPolyToRect(notch, { x0: -1, y0: -1, x1: 4, y1: 4 });
  const right = clipPolyToRect(notch, { x0: 4, y0: -1, x1: 11, y1: 4 });
  const walls = wallsAlongOutline([
    { zone: "hall", poly: left },
    { zone: "living", poly: right },
  ]);
  const interior = walls.filter((w) => !w.exterior);
  assert.ok(interior.some((w) => Math.abs(w.a[0] - 4) < 0.05 && Math.abs(w.b[0] - 4) < 0.05));
  const step = walls.find(
    (w) => w.exterior && Math.hypot((w.a[0] + w.b[0]) / 2 - 7, (w.a[1] + w.b[1]) / 2 - 2) < 0.2,
  );
  assert.ok(step);
});

test("the ridge split meets at x = 0", () => {
  const rect = [[-2, -3], [2, -3], [2, 3], [-2, 3]] as [number, number][];
  const { neg, pos } = splitAtX(rect, 0);
  assert.ok(neg.every((p) => p[0] <= 0.001));
  assert.ok(pos.every((p) => p[0] >= -0.001));
  assert.ok(neg.some((p) => Math.abs(p[0]) < 0.001));
  assert.ok(Math.abs(Math.abs(signedArea(neg)) + Math.abs(signedArea(pos)) - 24) < 0.05);
});

test("a side-to-side ridge splits on y", () => {
  const rect = [[-2, -3], [2, -3], [2, 3], [-2, 3]] as [number, number][];
  const { neg, pos } = splitAtY(rect, 0);
  assert.ok(neg.every((p) => p[1] <= 0.001));
  assert.ok(pos.every((p) => p[1] >= -0.001));
});

test("expanding the eaves keeps the step and grows the area", () => {
  const before = Math.abs(signedArea(notch));
  const grown = expandPoly(notch, 0.4);
  assert.ok(Math.abs(signedArea(grown)) > before);
  assert.ok(grown.length >= 5);
});

test("rectifyRoomPoly snaps near-axis jogs to straight H/V edges", () => {
  const wobbly: [number, number][] = [
    [0, 0],
    [5, 0.08],
    [5.05, 4],
    [0.04, 3.95],
  ];
  const got = rectifyRoomPoly(wobbly);
  assert.ok(got.length >= 4);
  for (let i = 0; i < got.length; i++) {
    const a = got[i];
    const b = got[(i + 1) % got.length];
    const dx = Math.abs(b[0] - a[0]);
    const dy = Math.abs(b[1] - a[1]);
    assert.ok(dx < 0.05 || dy < 0.05, `edge ${a}->${b} should be axis-aligned`);
  }
});

test("large-extent rectify snaps steeper slants that small houses leave alone", () => {
  // ~18° off horizontal — outside house tol (~12°) but inside campus tol (~24°).
  const slant: [number, number][] = [
    [0, 0],
    [10, Math.tan((18 * Math.PI) / 180) * 10],
    [10, 8],
    [0, 8],
  ];
  const house = rectifyRoomPoly(slant, 12, 0.13);
  const campus = rectifyRoomPoly(slant, 24, 0.28);
  const edge0 = (poly: [number, number][]) => {
    const a = poly[0];
    const b = poly[1];
    return Math.abs(b[1] - a[1]);
  };
  assert.ok(edge0(house) > 0.5, "house tol should leave the 18° edge slanted");
  assert.ok(edge0(campus) < 0.08, "campus tol should flatten the 18° edge");
});

test("corridor edges split per neighbor — no wall spans through stacked rooms", () => {
  const rooms = [
    { zone: "hall", poly: [[0, 0], [2, 0], [2, 20], [0, 20]] as [number, number][] },
    { zone: "r0", poly: [[-5, 0], [0, 0], [0, 6], [-5, 6]] as [number, number][] },
    { zone: "r1", poly: [[-5, 6], [0, 6], [0, 12], [-5, 12]] as [number, number][] },
    { zone: "r2", poly: [[-5, 12], [0, 12], [0, 20], [-5, 20]] as [number, number][] },
    { zone: "bath", poly: [[0, 17], [2, 17], [2, 20], [0, 20]] as [number, number][] },
  ];
  const walls = wallsAlongOutline(rooms);
  const leftInterior = walls.filter(
    (w) => !w.exterior && Math.abs(w.a[0]) < 0.05 && Math.abs(w.b[0]) < 0.05,
  );
  // Must not keep one 20 m hall wall labeled against a single neighbor.
  assert.equal(
    leftInterior.some((w) => Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) > 12),
    false,
    "no left wall longer than ~one room bay",
  );
  // Neighbor-specific segments for each stacked room.
  for (const z of ["r0", "r1", "r2"]) {
    assert.ok(
      leftInterior.some((w) => w.zones.includes("hall") && w.zones.includes(z)),
      `expected hall↔${z} partition`,
    );
  }
  // No remaining wall sample should sit inside a foreign room.
  const pip = (p: [number, number], ring: [number, number][]) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  for (const w of walls) {
    for (let s = 1; s <= 5; s++) {
      const t = s / 6;
      const p: [number, number] = [w.a[0] + (w.b[0] - w.a[0]) * t, w.a[1] + (w.b[1] - w.a[1]) * t];
      for (const r of rooms) {
        if (w.zones[0] === r.zone || w.zones[1] === r.zone) continue;
        assert.equal(pip(p, r.poly), false, `wall ${w.zones} must not pass through ${r.zone}`);
      }
    }
  }
});
