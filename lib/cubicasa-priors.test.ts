import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cubicasaHousePrior, CUBICASA_HOUSE_BANK } from "./cubicasa-priors.ts";

describe("cubicasaHousePrior", () => {
  it("scales beds/bays with living area", () => {
    const small = cubicasaHousePrior(55, 1);
    assert.equal(small.targetBeds, 1);
    assert.equal(small.bays, 2);

    const mid = cubicasaHousePrior(110, 1);
    assert.equal(mid.targetBeds, 3);
    assert.equal(mid.bays, 3);

    const large = cubicasaHousePrior(120, 2);
    assert.ok(large.targetBeds >= 3);
    assert.ok(large.bays >= 3);
    assert.match(large.note, /CubiCasa5K/);
  });

  it("honors assessor bed hints", () => {
    const p = cubicasaHousePrior(90, 2, 4, 2);
    assert.equal(p.targetBeds, 4);
    assert.equal(p.targetBaths, 2);
    assert.equal(p.bays, 4);
  });

  it("exposes CubiCasa5K house bank bands", () => {
    assert.equal(CUBICASA_HOUSE_BANK.program, "house");
    assert.equal(CUBICASA_HOUSE_BANK.bedrooms[0], 1);
    assert.equal(CUBICASA_HOUSE_BANK.medianBays, 3);
  });
});
