
const OVERPASS = [
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass-api.de/api/interpreter"
];
const elevationCache = new Map();
const roadCache = new Map();
const MAX_ROAD_CACHE = 4;
const ROAD_PATTERN = "^(residential|living_street|tertiary|secondary|primary|unclassified|service|cycleway|path|footway|pedestrian|track|road)$";
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

// A thin 4-vertex polygon centred on the line A-B. The margin is in metres,
// independent of the map's current zoom or the orientation of the route.
export function corridorSpec(a, b, marginMetres) {
  const meanLat = (a.lat + b.lat) / 2;
  const metresLat = 111195;
  const metresLon = 111195 * Math.max(0.2, Math.cos(meanLat * DEG));
  const ax = a.lng * metresLon, ay = a.lat * metresLat;
  const bx = b.lng * metresLon, by = b.lat * metresLat;
  const distance = Math.hypot(bx - ax, by - ay);
  const ux = (bx - ax) / distance, uy = (by - ay) / distance;
  const nx = -uy, ny = ux;
  const points = [
    [ax - ux * marginMetres + nx * marginMetres, ay - uy * marginMetres + ny * marginMetres],
    [bx + ux * marginMetres + nx * marginMetres, by + uy * marginMetres + ny * marginMetres],
    [bx + ux * marginMetres - nx * marginMetres, by + uy * marginMetres - ny * marginMetres],
    [ax - ux * marginMetres - nx * marginMetres, ay - uy * marginMetres - ny * marginMetres]
  ].map(([x, y]) => ({ lat: y / metresLat, lng: x / metresLon }));
  const poly = points.map(p => `${p.lat.toFixed(6)} ${p.lng.toFixed(6)}`).join(" ");
  // Local clipping uses a capsule: this is slightly tighter than the
  // Overpass rectangle but contains every A-B-aligned route segment.
  function contains(p) {
    const px = p.lng * metresLon - ax, py = p.lat * metresLat - ay;
    const along = Math.max(0, Math.min(distance, px * ux + py * uy));
    return Math.hypot(px - along * ux, py - along * uy) <= marginMetres + 20;
  }
  return { poly, contains, marginMetres };
}

async function requestRoads(corridor, signal, notify = () => {}) {
  // Return only necessary tags on ways; node coordinates without node tags.
  // Overpass poly avoids downloading unrelated streets in the box corners.
  const query = `[out:json][timeout:25];way["highway"~"${ROAD_PATTERN}"](poly:"${corridor.poly}");out body qt;>;out skel qt;`;
  const key = corridor.poly;
  if (roadCache.has(key)) {
    notify("Reusing previously downloaded roads…");
    return roadCache.get(key);
  }
  const winnerAbort = new AbortController();
  const attempts = OVERPASS.map(async (url, index) => {
    if (index > 0) {
      await new Promise(resolve => setTimeout(resolve, 4000 * index));
      if (signal?.aborted || winnerAbort.signal.aborted) throw Error("Request cancelled");
    }
    notify(index ? "Road server slow — trying alternate server…" : "Downloading local road corridor…");
    const signals = [winnerAbort.signal, AbortSignal.timeout(16000)];
    if (signal) signals.push(signal);
    try {
      const response = await fetch(url, {
        method: "POST", body: new URLSearchParams({ data: query }),
        signal: AbortSignal.any(signals)
      });
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data.elements) || data.elements.length === 0) {
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
    if (!signal?.aborted) {
      roadCache.set(key, data);
      if (roadCache.size > MAX_ROAD_CACHE) roadCache.delete(roadCache.keys().next().value);
    }
    return data;
  } catch (error) {
    const detail = error.errors?.map(e => e.message).join(" / ") || error.message;
    if (signal?.aborted) throw Error("Road loading cancelled");
    throw Error(`Road service unavailable or too slow. ${detail}. Please retry.`);
  }
}

function fromOverpass(data, corridor) {
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
      if (length > 0.5 && next !== anchor &&
          (corridor.contains(original.get(anchor)) || corridor.contains(original.get(next))
           || corridor.contains(shape[Math.floor(shape.length / 2)]))) {
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
  if (first[0].d > 150 || second[0].d > 150) {
    throw Error("One of the selected points is too far from a bicycle-accessible road.");
  }
  // A disconnected street must not be mistaken for a valid route by snapping
  // either point hundreds of metres away to a different component.
  const aLimit = Math.min(150, first[0].d + 35);
  const bLimit = Math.min(150, second[0].d + 35);
  let choice = null;
  for (const ai of first) {
    if (ai.d > aLimit) continue;
    const reachable = reachableFrom(net, ai.idx);
    for (const bi of second) {
      if (bi.d > bLimit || ai.idx === bi.idx || !reachable[bi.idx]) continue;
      const penalty = ai.d + bi.d;
      if (!choice || penalty < choice.penalty) choice = { start: ai.idx, end: bi.idx, penalty };
    }
  }
  if (!choice) throw Error("Could not connect A and B on the downloaded, permitted road network. Try closer or different points.");
  net.start = choice.start; net.end = choice.end;
}

// Unreachable components can never receive fluid from A. Remove them before
// requesting DEM heights or allocating the numerical solver.
export function pruneUnreachable(net) {
  const keep = reachableFrom(net, net.start);
  if (!keep[net.end]) throw Error("A and B are not connected");
  const indices = new Int32Array(net.nodes.length).fill(-1);
  const nodes = [];
  for (let i = 0; i < keep.length; i++) {
    if (keep[i]) { indices[i] = nodes.length; nodes.push(net.nodes[i]); }
  }
  const edges = net.edges.filter(e => keep[e.a] && keep[e.b]).map(e => ({
    ...e, a: indices[e.a], b: indices[e.b]
  }));
  return { nodes, edges, start: indices[net.start], end: indices[net.end] };
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
  // Adaptive search, with conservative fallback for detours.
  // The initial corridor is much smaller than a city-centred rectangular box.
  const baseMargin = Math.max(125, Math.min(320, 95 + direct * 0.11));
  const multipliers = [1, 2, 3.5];
  let graph = null;
  for (let attempt = 0; attempt < multipliers.length; attempt++) {
    if (signal?.aborted) throw Error("Road loading cancelled");
    const corridor = corridorSpec(a, b, baseMargin * multipliers[attempt]);
    notify(`Searching roads near A–B · corridor ${Math.round(corridor.marginMetres)} m (${attempt + 1}/${multipliers.length})…`);
    const data = await requestRoads(corridor, signal, notify);
    try {
      const candidate = fromOverpass(data, corridor);
      chooseEndpoints(candidate, a, b);
      graph = pruneUnreachable(candidate);
      break;
    } catch (error) {
      if (!/No bicycle-accessible roads|Could not connect A and B|too far from a bicycle-accessible road|A and B are not connected/i.test(error.message)) {
        throw error;
      }
      if (attempt === multipliers.length - 1) {
        throw Error("No connected A–B road network found after expanding the search. Try different points.");
      }
      notify("No connection in this corridor — expanding the road search…");
    }
  }
  if (signal?.aborted) throw Error("Road loading cancelled");
  notify(`Relevant connected roads · ${graph.edges.length} segments / ${graph.nodes.length} nodes`);
  onRoadsReady(graph);
  await attachElevations(graph, notify, signal);
  return graph;
}
