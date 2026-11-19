export const BASEMAP_STYLES = Object.freeze({
  positron: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark"
});

export function normaliseMapStyle(value) {
  return value === "positron" ? "positron" : "dark";
}

export function fluidLineStyle(level, mapStyle = "dark") {
  const value = Math.max(0, Math.min(12, Number(level) || 0));
  const dark = normaliseMapStyle(mapStyle) === "dark";
  if (value === 0) {
    return {
      color: dark ? "#5b7186" : "#8fa3ad",
      weight: dark ? 2.6 : 3,
      opacity: dark ? 0.39 : 0.34
    };
  }
  const intensity = value / 12;
  // Blue at the low-density front -> saturated turquoise near the source.
  const hue = Math.round(212 - 38 * intensity);
  const lightness = Math.round((dark ? 49 : 42) + (dark ? 12 : 9) * intensity);
  return {
    color: `hsl(${hue}, 92%, ${lightness}%)`,
    weight: 3.1 + 4.5 * intensity,
    opacity: 0.62 + 0.38 * intensity
  };
}
