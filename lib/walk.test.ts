import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { blockedByWall } from "./route.ts";
import { WalkMover, buildWalkGrid, isWalkable, lineClear, planPath } from "./walk.ts";

const raw = JSON.parse(readFileSync(new URL("../public/demo/demo-house.json", import.meta.url), "utf8"));
const model = raw.model ?? raw;
const floor = model.floors.find((f: { level: number }) => f.level === 0);
const grid = buildWalkGrid(floor, model.footprint);

test("a straight line through an exterior wall is not clear", () => {
  const front = floor.doors.find((d: { id: string }) => d.id === "g-d-front");
  const wall = floor.walls.find((w: { id: string }) => w.id === front.wallId);
  // Walk through the wall 1.5 m away from the door so it is a solid stretch.
  const len = Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]);
  const t = front.t + 1.8 / len > 0.95 ? front.t - 1.8 / len : front.t + 1.8 / len;
  const x = wall.a[0] + (wall.b[0] - wall.a[0]) * t;
  const y = wall.a[1] + (wall.b[1] - wall.a[1]) * t;
  assert.equal(lineClear(grid, [x, y - 3], [x, y + 3]), false);
});

test("a path from outdoors to a room goes through a door and never crosses a wall", () => {
  const goal: [number, number] = [-4, 2.5];
  const start: [number, number] = [11, 0];
  assert.ok(isWalkable(grid, goal));
  assert.equal(lineClear(grid, start, goal), false, "straight line would cross the east wall");
  const path = planPath(grid, start, goal);
  assert.ok(path && path.length >= 2, "path found");
  let from: [number, number] = start;
  for (const p of path!) {
    assert.equal(blockedByWall(floor, from, p), false, `segment ${from} -> ${p} crosses a wall`);
    from = p;
  }
});

test("the mover chases a target on the far side of a wall without crossing it", () => {
  const m = new WalkMover([11, 0]);
  let prev: [number, number] = [...m.pos];
  for (let i = 0; i < 900; i++) {
    m.step(grid, [-4, 2.5], 1 / 30);
    assert.equal(blockedByWall(floor, prev, m.pos), false, `crossed a wall at step ${i}`);
    prev = [...m.pos];
  }
  assert.ok(Math.hypot(m.pos[0] + 4, m.pos[1] - 2.5) < 0.6, `arrived, ended at ${m.pos}`);
});
