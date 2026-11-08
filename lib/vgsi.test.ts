import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildingUseFromAssessor,
  matchVgsiFolder,
  parseAssessorAttrs,
  placeKeyFromAddress,
} from "./vgsi.ts";

describe("VGSI place matching", () => {
  it("parses city/state from common address forms", () => {
    assert.deepEqual(placeKeyFromAddress("61 High St, New Haven, CT 06511"), {
      city: "New Haven",
      state: "CT",
    });
    assert.deepEqual(placeKeyFromAddress("1305 Hancock St, Quincy MA 02169"), {
      city: "Quincy",
      state: "MA",
    });
    assert.equal(placeKeyFromAddress("somewhere without a state"), null);
  });

  it("matches ArcGIS folders including multi-word cities and counties", () => {
    const folders = [
      "Quincy_MA",
      "New_Haven_CT",
      "Somerville_MA",
      "Tioga_County_PA",
      "North_Attleboro_MA",
      "Concord_MA",
    ];
    assert.equal(matchVgsiFolder(folders, "Quincy", "MA"), "Quincy_MA");
    assert.equal(matchVgsiFolder(folders, "New Haven", "CT"), "New_Haven_CT");
    assert.equal(matchVgsiFolder(folders, "North Attleboro", "MA"), "North_Attleboro_MA");
    assert.equal(matchVgsiFolder(folders, "Tioga", "PA"), "Tioga_County_PA");
    assert.equal(matchVgsiFolder(folders, "Troy", "NY"), null);
  });
});

describe("VGSI assessor attribute parse", () => {
  it("reads heterogeneous Vision field names", () => {
    const got = parseAssessorAttrs({
      LOCATION: "12 MAIN ST",
      CNS_STORIES: "2.0",
      CSN_STYLE_DESC: "Colonial",
      CSN_OCC_DESC: "Single Family",
      LND_USE_DESC: "Residential",
      CNS_TOTAL_ROOMS: "7",
      CNS_TOTAL_BEDS: "3",
      CNS_TOTAL_BATHS: "1.5",
      LIVING_AREA: "1,840",
    });
    assert.equal(got.address, "12 MAIN ST");
    assert.equal(got.stories, 2);
    assert.equal(got.style, "Colonial");
    assert.equal(got.occupancy, "Single Family");
    assert.equal(got.beds, 3);
    assert.equal(got.baths, 1.5);
    assert.equal(got.livingAreaSqft, 1840);
  });

  it("maps style/occupancy to building programs", () => {
    assert.equal(buildingUseFromAssessor({ style: "Colonial", occupancy: "Single Family" }), "house");
    assert.equal(buildingUseFromAssessor({ occupancy: "Apartments" }), "apartments");
    assert.equal(buildingUseFromAssessor({ useDesc: "College / University" }), "university");
    assert.equal(buildingUseFromAssessor({ style: "Warehouse" }), "warehouse");
    assert.equal(buildingUseFromAssessor({ occupancy: "General Office" }), "office");
    assert.equal(buildingUseFromAssessor({}), null);
  });
});
