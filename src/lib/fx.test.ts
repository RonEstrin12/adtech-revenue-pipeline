import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_ILS_PER_USD, fixedRates, fixedRatesFromEnv } from "./fx.js";

describe("fixed FX rates", () => {
  it("converts ILS at the configured rate and USD at 1", () => {
    const fx = fixedRatesFromEnv({ FX_ILS_PER_USD: "3.5" });
    assert.equal(fx.usdPer("ILS"), 1 / 3.5);
    assert.equal(fx.usdPer("USD"), 1);
    assert.equal(fx.usdPer("EUR"), null);
    assert.match(fx.source, /3\.5 \(FX_ILS_PER_USD\)/);
  });

  it("falls back to the default and says so", () => {
    const fx = fixedRatesFromEnv({});
    assert.equal(fx.usdPer("ILS"), 1 / DEFAULT_ILS_PER_USD);
    assert.match(fx.source, /default/);
  });

  it("refuses a bad rate", () => {
    assert.throws(() => fixedRatesFromEnv({ FX_ILS_PER_USD: "abc" }), /positive number/);
    assert.throws(() => fixedRates(0), /invalid/);
  });
});
