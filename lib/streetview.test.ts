import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  facadeHeadings,
  frontDoorFractionFromFacade,
  mergeGarageCue,
  mergeStoriesCue,
  nudgeRoomBays,
} from "./streetview-cues.ts";

describe("street view helpers", () => {
  it("fans facade headings left and right of the look direction", () => {
    const [front, left, right] = facadeHeadings(90);
    assert.equal(front, 90);
    assert.ok(left > 40 && left < 70);
    assert.ok(right > 110 && right < 140);
    const wrap = facadeHeadings(10);
    assert.equal(wrap[0], 10);
    assert.ok(wrap[1] > 330 || wrap[1] < 10);
  });

  it("merges garage cues with Street View preferred for attached sides", () => {
    assert.equal(mergeGarageCue("unknown", "attached_left"), "attached_left");
    assert.equal(mergeGarageCue("detached", "attached_right", { primaryConfidence: 0.4, streetViewConfidence: 0.7 }), "attached_right");
    assert.equal(mergeGarageCue("attached_left", "attached_left"), "attached_left");
    assert.equal(mergeGarageCue("none", "unknown"), "none");
    assert.equal(mergeGarageCue("detached", "none", { primaryConfidence: 0.4, streetViewConfidence: 0.6 }), "none");
  });

  it("prefers Street View story counts when there is no user photo", () => {
    assert.equal(mergeStoriesCue(2, 3, { streetViewConfidence: 0.7, hadUserPhoto: false }), 3);
    assert.equal(mergeStoriesCue(2, 3, { streetViewConfidence: 0.7, hadUserPhoto: true }), 2);
    assert.equal(mergeStoriesCue(2, 2, { streetViewConfidence: 0.9 }), 2);
    assert.equal(mergeStoriesCue(undefined, 1, { streetViewConfidence: 0.6 }), 1);
  });

  it("maps entry / front_door_t onto a facade fraction and nudges bay counts", () => {
    assert.equal(frontDoorFractionFromFacade({ entry: "left" }), 0.28);
    assert.equal(frontDoorFractionFromFacade({ entry: "right" }), 0.72);
    assert.equal(frontDoorFractionFromFacade({ entry: "center", frontDoorT: 0.41 }), 0.41);
    assert.equal(frontDoorFractionFromFacade({ frontDoorT: 1.4 }), 0.85);
    assert.equal(nudgeRoomBays(3, 3), 3);
    assert.equal(nudgeRoomBays(2, 4), 3);
    assert.equal(nudgeRoomBays(4, 2), 3);
    assert.equal(nudgeRoomBays(3, null), 3);
  });
});
