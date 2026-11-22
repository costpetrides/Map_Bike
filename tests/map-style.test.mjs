import test from "node:test";
import assert from "node:assert/strict";
import { BASEMAP_STYLES, normaliseMapStyle, fluidLineStyle } from "../map-style.mjs";

test("dark OpenFreeMap is the only supported basemap", () => {
  assert.deepEqual(Object.keys(BASEMAP_STYLES), ["dark"]);
  assert.equal(BASEMAP_STYLES.dark, "https://tiles.openfreemap.org/styles/dark");
});

test("legacy light preferences cannot override dark mode", () => {
  for (const style of ["dark", "positron", "", "invalid", null])
    assert.equal(normaliseMapStyle(style), "dark");
});

test("fluid colour transitions from blue to turquoise on the dark map", () => {
  const low = fluidLineStyle(1);
  const high = fluidLineStyle(12);
  assert.match(low.color, /^hsl\(209, 92%, \d+%\)$/);
  assert.match(high.color, /^hsl\(174, 92%, \d+%\)$/);
  assert.ok(high.weight > low.weight);
  assert.ok(high.opacity > low.opacity);
});

test("inactive roads stay subdued on dark", () => {
  const style = fluidLineStyle(0);
  assert.equal(style.color, "#5b7186");
  assert.equal(style.weight, 2.6);
  assert.ok(style.opacity < 0.5);
});
