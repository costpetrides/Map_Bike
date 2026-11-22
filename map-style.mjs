// The only available basemap and road palette are dark.
export const BASEMAP_STYLES = Object.freeze({
  dark: "https://tiles.openfreemap.org/styles/dark"
});

export function normaliseMapStyle() {
  return "dark";
}

export function fluidLineStyle(level) {
  const value = Math.max(0, Math.min(12, Number(level) || 0));
  if (value === 0) {
    return { color: "#5b7186", weight: 2.6, opacity: 0.39 };
  }
  const intensity = value / 12;
  const hue = Math.round(212 - 38 * intensity);
  const lightness = Math.round(49 + 12 * intensity);
  return {
    color: `hsl(${hue}, 92%, ${lightness}%)`,
    weight: 3.1 + 4.5 * intensity,
    opacity: 0.62 + 0.38 * intensity
  };
}
