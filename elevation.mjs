const DEM_ZOOM = 12;
const TILE_SIZE = 512;
const TILE_HOST = "https://tiles.mapterhorn.com";
const tileCache = new Map();

export function tileFraction(lat, lng, zoom = DEM_ZOOM) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw Error("Invalid coordinates");
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const n = 2 ** zoom, rad = clamped * Math.PI / 180;
  const x = ((lng + 180) / 360 * n + n) % n;
  const y = Math.max(0, Math.min(n - 1e-9,
    (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) * n / 2));
  return { x, y, ix: Math.floor(x), iy: Math.floor(y) };
}

export function decodeTerrarium(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}

export function elevationFromTile(image, lat, lng, zoom = DEM_ZOOM) {
  const t = tileFraction(lat, lng, zoom);
  if (image.width !== TILE_SIZE || image.height !== TILE_SIZE) throw Error("Invalid tile dimensions");
  const x = (t.x - t.ix) * TILE_SIZE, y = (t.y - t.iy) * TILE_SIZE;
  const x0 = Math.max(0, Math.min(TILE_SIZE - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(TILE_SIZE - 1, Math.floor(y)));
  const x1 = Math.min(TILE_SIZE - 1, x0 + 1), y1 = Math.min(TILE_SIZE - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, x - x0)), fy = Math.max(0, Math.min(1, y - y0));
  const sample = (px, py) => {
    const k = (py * TILE_SIZE + px) * 4;
    return decodeTerrarium(image.data[k], image.data[k+1], image.data[k+2]);
  };
  return (1-fx)*(1-fy)*sample(x0,y0) + fx*(1-fy)*sample(x1,y0)
    + (1-fx)*fy*sample(x0,y1) + fx*fy*sample(x1,y1);
}

async function decodeImage(blob) {
  if (typeof createImageBitmap === "function") {
    const bmp = await createImageBitmap(blob);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bmp.width; canvas.height = bmp.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw Error("Canvas unavailable");
      ctx.drawImage(bmp, 0, 0);
      return ctx.getImageData(0, 0, canvas.width, canvas.height);
    } finally { bmp.close(); }
  }
  // Blob object URLs let Safari decode cross-origin fetched images safely.
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(Error("Cannot decode DEM tile"));
      element.src = objectUrl;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw Error("Canvas unavailable");
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  } finally { URL.revokeObjectURL(objectUrl); }
}

async function fetchTile(ix, iy, signal) {
  const key = `${DEM_ZOOM}/${ix}/${iy}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const signals = [AbortSignal.timeout(15000)];
  if (signal) signals.push(signal);
  const response = await fetch(`${TILE_HOST}/${key}.webp`, {
    signal: AbortSignal.any(signals), cache: "force-cache"
  });
  if (!response.ok) throw Error(`DEM tile HTTP ${response.status}`);
  const pixels = await decodeImage(await response.blob());
  if (pixels.width !== TILE_SIZE || pixels.height !== TILE_SIZE) throw Error("Invalid DEM image");
  if (!signal?.aborted) {
    tileCache.set(key, pixels);
    if (tileCache.size > 32) tileCache.delete(tileCache.keys().next().value);
  }
  return pixels;
}

async function sampleMapterhorn(nodes, notify, signal) {
  const tileGroups = new Map();
  nodes.forEach((node, index) => {
    const { ix, iy } = tileFraction(node.lat, node.lng);
    const key = `${ix}/${iy}`;
    if (!tileGroups.has(key)) tileGroups.set(key, { ix, iy, indices: [] });
    tileGroups.get(key).indices.push(index);
  });
  const groups = [...tileGroups.values()];
  if (groups.length > 32) throw Error("DEM area exceeds the prototype limit");
  notify(`Downloading terrain · 0 / ${groups.length} DEM tiles`);
  const output = new Float64Array(nodes.length);
  let cursor = 0, done = 0;
  async function worker() {
    while (cursor < groups.length) {
      if (signal?.aborted) throw Error("Terrain loading cancelled");
      const { ix, iy, indices } = groups[cursor++];
      const pixels = await fetchTile(ix, iy, signal);
      for (const i of indices) {
        output[i] = elevationFromTile(pixels, nodes[i].lat, nodes[i].lng);
        if (!Number.isFinite(output[i])) throw Error("Invalid DEM elevation");
      }
      done++;
      notify(`Downloading terrain · ${done} / ${groups.length} DEM tiles`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, groups.length) }, () => worker()));
  return output;
}

async function sampleOpenMeteo(nodes, notify, signal) {
  // Explicit fallback: exact lat/lng, no coordinate rounding or gridding.
  const batches = [];
  for (let i = 0; i < nodes.length; i += 70) batches.push({ i, nodes: nodes.slice(i,i+70) });
  const result = new Float64Array(nodes.length);
  let cursor = 0, done = 0;
  notify(`Fallback terrain API · 0 / ${nodes.length} points`);
  async function worker() {
    while (cursor < batches.length) {
      if (signal?.aborted) throw Error("Terrain loading cancelled");
      const batch = batches[cursor++];
      const url = new URL("https://api.open-meteo.com/v1/elevation");
      url.searchParams.set("latitude", batch.nodes.map(p => p.lat.toFixed(6)).join(","));
      url.searchParams.set("longitude", batch.nodes.map(p => p.lng.toFixed(6)).join(","));
      const signals = [AbortSignal.timeout(15000)];
      if (signal) signals.push(signal);
      const response = await fetch(url, { signal: AbortSignal.any(signals) });
      if (!response.ok) throw Error(`Fallback HTTP ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data.elevation) || data.elevation.length !== batch.nodes.length)
        throw Error("Incomplete elevation API response");
      data.elevation.forEach((z,j) => {
        if (!Number.isFinite(z)) throw Error("Invalid elevation API value");
        result[batch.i + j] = z;
      });
      done += batch.nodes.length;
      notify(`Fallback terrain API · ${done} / ${nodes.length} points`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, batches.length) }, () => worker()));
  return result;
}

export async function assignNodeElevations(nodes, notify = () => {}, signal) {
  if (!nodes.length) return { provider: "none", count: 0 };
  let elevations, provider;
  try {
    elevations = await sampleMapterhorn(nodes, notify, signal);
    provider = "Mapterhorn DEM";
  } catch (error) {
    if (signal?.aborted) throw Error("Terrain loading cancelled");
    notify(`DEM tiles unavailable (${error.message}); trying elevation API…`);
    elevations = await sampleOpenMeteo(nodes, notify, signal);
    provider = "Open-Meteo fallback";
  }
  if (signal?.aborted) throw Error("Terrain loading cancelled");
  // Never silently fill missing samples with zero.
  for (let i = 0; i < nodes.length; i++)
    if (!Number.isFinite(elevations[i])) throw Error("Incomplete DEM sampling");
  for (let i = 0; i < nodes.length; i++) nodes[i].elevation = elevations[i];
  notify(`${provider} · ${nodes.length} road locations ready`);
  return { provider, count: nodes.length };
}
