import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isNominatimStreetOnly, nominatimBuildingWayId } from "./geocode.ts";

describe("nominatim building way filter", () => {
  it("accepts a building way", () => {
    assert.equal(nominatimBuildingWayId({ osm_type: "way", osm_id: 99, class: "building", type: "house" }), 99);
  });

  it("rejects a highway way even when typed residential", () => {
    assert.equal(
      nominatimBuildingWayId({
        osm_type: "way",
        osm_id: 14256201,
        class: "highway",
        type: "residential",
        addresstype: "residential",
      }),
      null,
    );
  });

  it("flags street-only highway hits", () => {
    assert.equal(
      isNominatimStreetOnly({ class: "highway", type: "residential", addresstype: "residential" }),
      true,
    );
    assert.equal(isNominatimStreetOnly({ class: "building", type: "house", addresstype: "building" }), false);
  });
});
