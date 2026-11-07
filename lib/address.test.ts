import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseStreetAddress, streetsMatch } from "./address.ts";

describe("street address parsing", () => {
  it("reads a Census one-line address", () => {
    assert.deepEqual(parseStreetAddress("213 SIMONSON AVE, STATEN ISLAND, NY, 10303"), {
      num: "213",
      street: "simonson ave",
    });
  });

  it("reads a Nominatim name that puts a comma after the house number", () => {
    assert.deepEqual(parseStreetAddress("213, Simonson Avenue, Elm Park, Staten Island, New York, 10303"), {
      num: "213",
      street: "simonson ave",
    });
  });

  it("treats Avenue and Ave as the same street", () => {
    assert.equal(streetsMatch("simonson ave", "simonson ave"), true);
  });
});
