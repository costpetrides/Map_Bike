import { assignNodeElevations } from "./elevation.mjs";
import { getSmallAreaRoads, fallbackBounds } from "./osm-fallback.mjs";

// Two independent providers. kumi.systems is the old name for private.coffee.
const OVERPASS = [
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter"
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
  const query = `[out:json][timeout:35];way["highway"~"${ROAD_PATTERN}"](poly:"${corridor.poly}");out body qt;>;out skel qt;`;
  const key = corridor.poly;
  if (roadCache.has(key)) {
    notify("Reusing cached road network…");
    return roadCache.get(key);
  }
  const localAbort = new AbortController();
  const attempts = [];

  const pause = ms => new Promise(resolve => setTimeout(resolve,ms));

  // Delayed independent providers avoid a sudden burst of identical requests.
  for (const [index, url] of OVERPASS.entries()) {
    attempts.push((async () => {
      if(index>0)await pause(5000*index);
      if(localAbort.signal.aborted || signal?.aborted)throw Error("Request cancelled");
      notify(index===0 ? "Querying roads from Overpass…" :
        "First Overpass slow — trying a different data provider…");
      const timeout = AbortSignal.timeout(45000);
      const signals=[localAbort.signal,timeout];
      if(signal)signals.push(signal);
      try {
        const response=await fetch(`${url}?data=${encodeURIComponent(query)}`,{
          method:"GET",signal:AbortSignal.any(signals),cache:"no-store"
        });
        if(!response.ok)throw Error(`HTTP ${response.status}`);
        const data=await response.json();
        if(!Array.isArray(data.elements)||!data.elements.some(e=>e.type==="way"))
          throw Error(data.remark || "No road ways in response");
        if(data.remark && /runtime error|timed out|out of memory/i.test(data.remark))
          throw Error(data.remark);
        data.source=new URL(url).host;
        return data;
      } catch(error) {
        if(signal?.aborted)throw Error("User cancelled loading");
        if(timeout.aborted)throw Error(`${new URL(url).host}: timed out after 45 seconds`);
        throw Error(`${new URL(url).host}: ${error.message||"network/CORS failure"}`);
      }
    })());
  }

  // Independent, strictly bounded fallback for small areas only. Never use
  // the OSM editing API for large extracts; it is not a production data API.
  if(fallbackBounds(corridor)) {
    attempts.push((async () => {
      await pause(9000);
      if(localAbort.signal.aborted || signal?.aborted)throw Error("Request cancelled");
      notify("Trying independent OpenStreetMap small-area fallback…");
      try{return await getSmallAreaRoads(corridor,AbortSignal.any([localAbort.signal,...(signal?[signal]:[])]));}
      catch(error){throw Error(`OSM small-area fallback: ${error.message}`);}
    })());
  }
  try {
    const data=await Promise.any(attempts);
    localAbort.abort();
    if(signal?.aborted)throw Error("Road loading cancelled");
    notify(`Road data received from ${data.source||"OpenStreetMap"}`);
    roadCache.set(key,data);
    if(roadCache.size>MAX_ROAD_CACHE)roadCache.delete(roadCache.keys().next().value);
    return data;
  } catch(error) {
    localAbort.abort();
    if(signal?.aborted)throw Error("Road loading cancelled");
    const errors=error.errors?.map(e=>e.message)||[error.message];
    throw Error(`Road data providers failed: ${errors.join(" / ")}. Please retry later.`);
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

export function densifyRoadGraph(graph, maxSpacingMetres = 55) {
  // Sample the road geometry at regular arc-length intervals so DEM slopes
  // are not calculated only from distant junction endpoints.
  const nodes = graph.nodes.slice();
  const edges = [];
  for (const edge of graph.edges) {
    const count = Math.max(1, Math.ceil(edge.length / maxSpacingMetres));
    if (count === 1) { edges.push(edge); continue; }
    const shape = edge.shape.map(([lat, lng]) => ({lat, lng}));
    const cumulative = [0];
    for (let k = 1; k < shape.length; k++) {
      cumulative.push(cumulative[k-1] + distanceMetres(shape[k-1], shape[k]));
    }
    const total = cumulative[cumulative.length - 1];
    if (total < 0.01) { edges.push(edge); continue; }
    let prev = edge.a, previousPos = [graph.nodes[edge.a].lat, graph.nodes[edge.a].lng];
    let cursor = 1;
    for (let k = 1; k <= count; k++) {
      let targetIndex, position;
      if (k === count) {
        targetIndex = edge.b;
        position = [graph.nodes[edge.b].lat, graph.nodes[edge.b].lng];
      } else {
        const target = total * k / count;
        while (cursor < cumulative.length - 1 && cumulative[cursor] < target) cursor++;
        const start = Math.max(0, cursor - 1);
        const span = Math.max(1e-9, cumulative[cursor] - cumulative[start]);
        const fraction = Math.max(0, Math.min(1, (target - cumulative[start]) / span));
        const p = shape[start], q = shape[cursor];
        const lat = p.lat + fraction * (q.lat - p.lat);
        const lng = p.lng + fraction * (q.lng - p.lng);
        targetIndex = nodes.length;
        nodes.push({lat, lng, elevation:null});
        position = [lat, lng];
      }
      edges.push({
        a:prev, b:targetIndex, length:edge.length/count,
        shape:[previousPos,position], forward:edge.forward, backward:edge.backward
      });
      prev = targetIndex;
      previousPos = position;
    }
  }
  if (nodes.length > 12000 || edges.length > 16000)
    throw Error("Road network is too large for the prototype. Choose closer points.");
  return {nodes, edges, start:graph.start, end:graph.end};
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
      graph = densifyRoadGraph(pruneUnreachable(candidate));
      graph.roadSource = data.source || "OpenStreetMap";
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
  graph.elevationInfo = await assignNodeElevations(graph.nodes, notify, signal);
  return graph;
}
