import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildingUseFromTag,
  buildingUseFromTags,
  maxStoriesForUse,
  planWordForUse,
} from "./layout-use.ts";

describe("building programs", () => {
  it("maps OSM tags to dormitory / apartments / hotel / hospital / warehouse", () => {
    assert.equal(buildingUseFromTag("dormitory"), "dormitory");
    assert.equal(buildingUseFromTag("apartments"), "apartments");
    assert.equal(buildingUseFromTag("hotel"), "hotel");
    assert.equal(buildingUseFromTag("hospital"), "hospital");
    assert.equal(buildingUseFromTag("warehouse"), "warehouse");
    assert.equal(buildingUseFromTag("industrial"), "warehouse");
    assert.equal(buildingUseFromTag("house"), "house");
    assert.equal(buildingUseFromTags({ building: "yes", amenity: "hospital" }), "hospital");
    assert.equal(buildingUseFromTags({ building: "residential", amenity: "hotel" }), "hotel");
  });

  it("raises story caps for multi-unit and institutional uses", () => {
    assert.equal(maxStoriesForUse("house"), 3);
    assert.equal(maxStoriesForUse("church"), 1);
    assert.equal(maxStoriesForUse("dormitory"), 6);
    assert.equal(maxStoriesForUse("apartments"), 6);
    assert.equal(maxStoriesForUse("hotel"), 6);
    assert.equal(maxStoriesForUse("hospital"), 6);
    assert.equal(maxStoriesForUse("warehouse"), 3);
    assert.equal(planWordForUse("dormitory"), "dormitory");
  });
});
