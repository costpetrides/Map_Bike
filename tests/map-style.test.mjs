import test from "node:test";
import assert from "node:assert/strict";
import { BASEMAP_STYLES, normaliseMapStyle, fluidLineStyle } from "../map-style.mjs";

test("both basemap styles use OpenFreeMap, no API key necessary", () => {
  assert.equal(BASEMAP_STYLES.positron, "https://tiles.openfreemap.org/styles/positron");
  assert.equal(BASEMAP_STYLES.dark, "https://tiles.openfreemap.org/styles/dark");
});

test("map style always normalises to a supported style", () => {
  assert.equal(normaliseMapStyle("positron"), "positron");
  assert.equal(normaliseMapStyle("dark"), "dark");
  assert.equal(normaliseMapStyle(""), "dark");
  assert.equal(normaliseMapStyle("wrong"), "dark");
});

test("flow changes from blue (low) toward turquoise (high) on both maps", () => {
  for (const style of ["dark", "positron"]) {
    const low = fluidLineStyle(1, style);
    const high = fluidLineStyle(12, style);
    assert.match(low.color, /^hsl\(209, 92%, \d+%\)$/);
    assert.match(high.color, /^hsl\(174, 92%, \d+%\)$/);
    assert.ok(high.weight > low.weight);
    assert.ok(high.opacity > low.opacity);
  }
});

test("no-fluid roads stay subdued in both styles", () => {
  for (const style of ["dark", "positron"]) {
    const unfilled = fluidLineStyle(0, style);
    assert.ok(unfilled.opacity < 0.5);
    assert.match(unfilled.color, /^#[0-9a-f]{6}$/);
  }
});
