
const OVERPASS = [
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass-api.de/api/interpreter"
];
const elevationCache = new Map();
const HIGHWAYS = /^(residential|living_street|tertiary|secondary|primary|unclassified|service|cycleway|path|footway|pedestrian|track|road)$/;
const DEG = Math.PI / 180;

export function distanceMetres(a, b) {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lng - a.lng) * DEG;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(x)));
}

function eligible(tags) {
  if (!HIGHWAYS.test(tags.highway || "")) return false;
  if (["no", "private"].includes(tags.bicycle)) return false;
  if (["no", "private"].includes(tags.access) && !["yes", "designated", "official", "permissive"].includes(tags.bicycle)) return false;
  if (["footway", "pedestrian"].includes(tags.highway)
      && !["yes", "designated", "official", "permissive"].includes(tags.bicycle)) return false;
  return true;
}

function directions(tags) {
  let forward = true, backward = true;
  const bikeOneway = tags["oneway:bicycle"];
  if (bikeOneway !== "no" && bikeOneway !== "false" && bikeOneway !== "0") {
    const rule = bikeOneway || tags.oneway || (tags.junction === "roundabout" ? "yes" : "no");
    if (rule === "yes" || rule === "1" || rule === "true") backward = false;
    if (rule === "-1") forward = false;
  }
  return { forward, backward };
}

async function requestRoads(bounds, signal, notify = () => {}) {
  const box = `${bounds.s.toFixed(6)},${bounds.w.toFixed(6)},${bounds.n.toFixed(6)},${bounds.e.toFixed(6)}`;
  const query = `[out:json][timeout:25];way["highway"~"^(residential|living_street|tertiary|secondary|primary|unclassified|service|cycleway|path|footway|pedestrian|track|road)$"](${box});(._;>;);out body qt;`;
  // A second independent service is tried after 4 seconds, not 60 seconds
  // later. Abort the losing request once valid data is received.
  const winnerAbort = new AbortController();
  const attempts = OVERPASS.map(async (url, index) => {
    if (index > 0) {
      await new Promise(resolve => setTimeout(resolve, 4000 * index));
      if (signal?.aborted || winnerAbort.signal.aborted) throw Error("Request cancelled");
    }
    notify(index ? "Road server slow — trying alternate server…" : "Downloading roads from OpenStreetMap…");
    const signals = [winnerAbort.signal, AbortSignal.timeout(16000)];
    if (signal) signals.push(signal);
    try {
      const response = await fetch(url, {
        method: "POST",
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.any(signals)
      });
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data.elements) || !data.elements.length) {
        throw Error("No road data returned");
      }
      return data;
    } catch (error) {
      throw Error(`${new URL(url).host}: ${error.message}`);
    }
  });
  try {
    const data = await Promise.any(attempts);
    winnerAbort.abort();
    return data;
  } catch (error) {
    const detail = error.errors?.map(e => e.message).join(" / ") || error.message;
    if (signal?.aborted) throw Error("Road loading cancelled");
    throw Error(`Road service unavailable or too slow. ${detail}. Please retry.`);
  }
}

function fromOverpass(data) {
  const original = new Map();
  const allWays = [];
  for (const el of data.elements) {
    if (el.type === "node") original.set(el.id, { lat: el.lat, lng: el.lon });
  }
  for (const el of data.elements) {
    if (el.type !== "way" || !eligible(el.tags || {})) continue;
    const nodes = (el.nodes || []).filter((id) => original.has(id));
    if (nodes.length > 1) allWays.push({ nodes, tags: el.tags || {}, osmWayId: el.id });
  }
  const count = new Map();
  for (const way of allWays) {
    for (const id of new Set(way.nodes)) count.set(id, (count.get(id) || 0) + 1);
  }
  const nodeIndex = new Map(), nodes = [], edges = [];
  const getIndex = (id) => {
    if (!nodeIndex.has(id)) {
      nodeIndex.set(id, nodes.length);
      nodes.push({ ...original.get(id), osmId: id, elevation: null });
    }
    return nodeIndex.get(id);
  };
  const used = new Set();
  for (const way of allWays) {
    const { forward, backward } = directions(way.tags);
    let anchor = way.nodes[0];
    let shape = [original.get(anchor)], length = 0;
    for (let i = 1; i < way.nodes.length; i++) {
      const next = way.nodes[i];
      const prev = way.nodes[i - 1];
      const segmentLength = distanceMetres(original.get(prev), original.get(next));
      length += segmentLength;
      shape.push(original.get(next));
      const isJunction = (count.get(next) || 0) > 1;
      const isEnd = i === way.nodes.length - 1;
      if (!isJunction && !isEnd && length < 60) continue;
      if (length > 0.5 && next !== anchor) {
        const a = getIndex(anchor), b = getIndex(next);
        if (a !== b) {
          const key = `${way.osmWayId}:${Math.min(a, b)}:${Math.max(a, b)}`;
          if (!used.has(key)) {
            used.add(key);
            edges.push({ a, b, length, shape: shape.map(p => [p.lat, p.lng]), forward, backward });
          }
        }
      }
      anchor = next; shape = [original.get(next)]; length = 0;
    }
  }
  if (!edges.length) throw Error("No bicycle-accessible roads in the selected area.");
  if (nodes.length > 5500 || edges.length > 7500) {
    throw Error("Road network too large. Select two closer points (ideally less than 1 km apart).");
  }
  return { nodes, edges };
}

function reachableFrom(net, start) {
  const adjacency = Array.from({ length: net.nodes.length }, () => []);
  for (const e of net.edges) {
    if (e.forward) adjacency[e.a].push(e.b);
    if (e.backward) adjacency[e.b].push(e.a);
  }
  const seen = new Uint8Array(net.nodes.length), queue = [start];
  seen[start] = 1;
  for (let idx = 0; idx < queue.length; idx++) {
    for (const next of adjacency[queue[idx]]) {
      if (!seen[next]) { seen[next] = 1; queue.push(next); }
    }
  }
  return seen;
}

function chooseEndpoints(net, a, b) {
  const near = (p) => net.nodes.map((v, idx) => ({
    idx, d: distanceMetres(p, v)
  })).sort((u, v) => u.d - v.d).slice(0, 10);
  const first = near(a), second = near(b);
  if (first[0].d > 250 || second[0].d > 250) {
    throw Error("One of the selected points is too far from a bicycle-accessible road.");
  }
  let choice = null;
  for (const ai of first) {
    if (ai.d > 250) continue;
    const reachable = reachableFrom(net, ai.idx);
    for (const bi of second) {
      if (bi.d > 250 || ai.idx === bi.idx || !reachable[bi.idx]) continue;
      const penalty = ai.d + bi.d;
      if (!choice || penalty < choice.penalty) choice = { start: ai.idx, end: bi.idx, penalty };
    }
  }
  if (!choice) throw Error("Could not connect A and B on the downloaded, permitted road network. Try closer or different points.");
  net.start = choice.start; net.end = choice.end;
}

async function attachElevations(net, notify, signal) {
  // ~130m sampling limits redundant DEM requests and makes small areas fast.
  // Copernicus DEM data source is approximately 90m, so this is a
  // deliberately coarse first-version approximation (not survey-grade).
  const grouped = new Map();
  for (let i = 0; i < net.nodes.length; i++) {
    const node = net.nodes[i];
    const qLat = Math.round(node.lat / 0.0012) * 0.0012;
    const lonStep = 0.0012 / Math.max(0.2, Math.cos(node.lat * DEG));
    const qLon = Math.round(node.lng / lonStep) * lonStep;
    const key = `${qLat.toFixed(5)},${qLon.toFixed(5)}`;
    if (!grouped.has(key)) grouped.set(key, { key, lat: qLat, lng: qLon, indices: [] });
    grouped.get(key).indices.push(i);
  }
  const cells = [...grouped.values()];
  if (cells.length > 900) throw Error("Too many elevation samples. Choose two closer points.");
  const outstanding = [];
  for (const cell of cells) {
    if (elevationCache.has(cell.key)) {
      for (const i of cell.indices) net.nodes[i].elevation = elevationCache.get(cell.key);
    } else {
      outstanding.push(cell);
    }
  }
  if (!outstanding.length) {
    notify(`Elevations loaded from cache · ${cells.length} samples`);
    return;
  }
  notify(`Loading terrain elevations · 0 / ${outstanding.length} samples`);
  const batches = [];
  for (let i = 0; i < outstanding.length; i += 100) batches.push(outstanding.slice(i, i + 100));
  let cursor = 0, complete = 0;
  async function worker() {
    while (cursor < batches.length) {
      if (signal?.aborted) throw Error("Loading cancelled");
      const batch = batches[cursor++];
      const url = new URL("https://api.open-meteo.com/v1/elevation");
      url.searchParams.set("latitude", batch.map(p => p.lat.toFixed(5)).join(","));
      url.searchParams.set("longitude", batch.map(p => p.lng.toFixed(5)).join(","));
      const signals = [AbortSignal.timeout(15000)];
      if (signal) signals.push(signal);
      const response = await fetch(url, { signal: AbortSignal.any(signals) });
      if (!response.ok) throw Error(`Elevation service HTTP ${response.status}. Try again.`);
      const result = await response.json();
      if (!Array.isArray(result.elevation) || result.elevation.length !== batch.length) {
        throw Error("Elevation data was incomplete.");
      }
      for (let j = 0; j < batch.length; j++) {
        const elevation = result.elevation[j];
        if (!Number.isFinite(elevation)) throw Error("Elevation data contains invalid values.");
        elevationCache.set(batch[j].key, elevation);
        for (const i of batch[j].indices) net.nodes[i].elevation = elevation;
      }
      complete += batch.length;
      notify(`Loading terrain elevations · ${complete} / ${outstanding.length} samples`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, batches.length) }, () => worker()));
}

export async function loadNetwork(a, b, notify = () => {}, signal, onRoadsReady = () => {}) {
  const direct = distanceMetres(a, b);
  if (direct < 80) throw Error("Choose A and B at least 80 metres apart.");
  if (direct > 2200) throw Error("For this first prototype choose points at most 2.2 km apart.");
  const latPad = 0.0026 + Math.abs(a.lat - b.lat) * 0.10;
  const lngPad = 0.0026 / Math.cos(a.lat * DEG) + Math.abs(a.lng - b.lng) * 0.10;
  const bounds = {
    s: Math.min(a.lat, b.lat) - latPad, n: Math.max(a.lat, b.lat) + latPad,
    w: Math.min(a.lng, b.lng) - lngPad, e: Math.max(a.lng, b.lng) + lngPad
  };
  notify("Loading permitted roads from OpenStreetMap…");
  const graph = fromOverpass(await requestRoads(bounds, signal, notify));
  notify(`Roads loaded · ${graph.edges.length} segments. Connecting A to B…`);
  chooseEndpoints(graph, a, b);
  onRoadsReady(graph);
  await attachElevations(graph, notify, signal);
  return graph;
}
