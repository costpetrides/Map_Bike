
const OVERPASS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter"
];
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

async function requestRoads(bounds, signal) {
  const box = `${bounds.s.toFixed(6)},${bounds.w.toFixed(6)},${bounds.n.toFixed(6)},${bounds.e.toFixed(6)}`;
  const query = `[out:json][timeout:50];way["highway"~"^(residential|living_street|tertiary|secondary|primary|unclassified|service|cycleway|path|footway|pedestrian|track|road)$"](${box});(._;>;);out body qt;`;
  const errors = [];
  for (const url of OVERPASS) {
    try {
      const timeout = AbortSignal.timeout(60000);
      const composite = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await fetch(url, {
        method: "POST",
        body: new URLSearchParams({ data: query }),
        signal: composite
      });
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data.elements)) throw Error("Invalid map response");
      return data;
    } catch (error) {
      if (signal?.aborted) throw error;
      errors.push(`${url}: ${error.message}`);
    }
  }
  throw Error(`OpenStreetMap road service unavailable. ${errors.join(" / ")}`);
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
    if (nodes.length > 1) allWays.push({ nodes, tags: el.tags || {} });
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
          const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
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
  // Open-Meteo DEM has ~90 m resolution; quantise around 100 m to reduce API calls.
  const grouped = new Map();
  for (let i = 0; i < net.nodes.length; i++) {
    const node = net.nodes[i];
    const qLat = Math.round(node.lat / 0.0009) * 0.0009;
    const lonStep = 0.0009 / Math.cos(node.lat * DEG);
    const qLon = Math.round(node.lng / lonStep) * lonStep;
    const key = `${qLat.toFixed(5)},${qLon.toFixed(5)}`;
    if (!grouped.has(key)) grouped.set(key, { lat: qLat, lng: qLon, indices: [] });
    grouped.get(key).indices.push(i);
  }
  const cells = [...grouped.values()];
  if (cells.length > 1600) throw Error("Too many elevation samples; choose a smaller area.");
  for (let offset = 0; offset < cells.length; offset += 100) {
    if (signal?.aborted) throw Error("Request cancelled");
    const batch = cells.slice(offset, offset + 100);
    notify(`Loading elevation · ${Math.min(offset + 100, cells.length)} / ${cells.length}`);
    const url = new URL("https://api.open-meteo.com/v1/elevation");
    url.searchParams.set("latitude", batch.map(p => p.lat.toFixed(5)).join(","));
    url.searchParams.set("longitude", batch.map(p => p.lng.toFixed(5)).join(","));
    const response = await fetch(url, { signal });
    if (!response.ok) throw Error(`Elevation service HTTP ${response.status}. Retry after a moment.`);
    const result = await response.json();
    if (!Array.isArray(result.elevation) || result.elevation.length !== batch.length) {
      throw Error("Elevation service returned incomplete data.");
    }
    for (let j = 0; j < batch.length; j++) {
      if (!Number.isFinite(result.elevation[j])) throw Error("Invalid elevation sample.");
      for (const index of batch[j].indices) net.nodes[index].elevation = result.elevation[j];
    }
  }
}

export async function loadNetwork(a, b, notify = () => {}, signal) {
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
  const graph = fromOverpass(await requestRoads(bounds, signal));
  notify(`Roads loaded · ${graph.edges.length} segments. Connecting A to B…`);
  chooseEndpoints(graph, a, b);
  await attachElevations(graph, notify, signal);
  return graph;
}
