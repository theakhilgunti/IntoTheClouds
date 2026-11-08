import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseStreetAddress, parseStreetName, plutoAddress, streetsMatch } from "./address.ts";

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

  it("spells a street the way NYC tax lots do", () => {
    assert.equal(plutoAddress("213 SIMONSON AVE, STATEN ISLAND, NY, 10303"), "213 SIMONSON AVENUE");
  });

  it("treats Avenue and Ave as the same street", () => {
    assert.equal(streetsMatch("simonson ave", "simonson ave"), true);
  });

  it("requires matching suffixes when both names have one", () => {
    assert.equal(streetsMatch("yardley ct", "yardley court"), true);
    assert.equal(streetsMatch("yardley ct", "yardley dr"), false);
    assert.equal(streetsMatch("yardley", "yardley ct"), true);
  });

  it("reads a street-only geocode label without a house number", () => {
    assert.equal(parseStreetName("Yardley Court, East Goshen Township, PA"), "yardley ct");
    assert.equal(parseStreetName("15 Yardley Ct, East Goshen, PA"), "yardley ct");
  });
});
