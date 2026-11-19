import { loadNetwork, distanceMetres } from "./network.mjs";
import { initialiseSimulation, stepSimulation, SOURCE_CONCENTRATION } from "./physics.mjs";

const $ = (id) => document.getElementById(id);
const map = L.map("map", { zoomControl: false, preferCanvas: true }).setView([37.9802, 23.7395], 14);
L.control.zoom({ position: "topright" }).addTo(map);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

const roadLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const pinLayer = L.layerGroup().addTo(map);
const ATHENS_A = { lat: 37.97637, lng: 23.73946 };
const ATHENS_B = { lat: 37.98147, lng: 23.74613 };

let a = null, b = null, choosing = "a";
let graph = null, sim = null, lines = [];
let running = false, frameId = null, previousFrame = 0, loading = false, controller = null;

function status(message, kind = "") {
  $("status").textContent = message;
  $("status").className = `status ${kind}`.trim();
}
function modelState(message, active = false) {
  $("map-mode").textContent = message.toUpperCase();
  document.querySelector(".live-led").classList.toggle("is-active", active);
}
function formatPoint(p) {
  return p ? `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}` : "Click map";
}
function updateControls() {
  $("set-a").classList.toggle("selected", choosing === "a");
  $("set-b").classList.toggle("selected", choosing === "b");
  $("a-state").textContent = formatPoint(a);
  $("b-state").textContent = formatPoint(b);
  $("load").disabled = !loading && (!a || !b);
  $("load").textContent = loading ? "Cancel loading ✕" : "Load road network ↗";
  $("set-a").disabled = loading;
  $("set-b").disabled = loading;
  $("example").disabled = loading;
  $("simulate").disabled = !sim || loading || sim.arrived;
  $("restart").disabled = !sim || loading;
  $("simulate").textContent = sim?.arrived ? "Front reached B ✓" : running ? "Pause simulation ⏸" : "Start diffusion ▶";
}
function pointIcon(letter) {
  const cls = letter.toLowerCase();
  return L.divIcon({
    className: "",
    html: `<div class="point-pin ${cls}">${letter}</div>`,
    iconSize: [33, 33],
    iconAnchor: [16, 16]
  });
}
function updatePins() {
  pinLayer.clearLayers();
  if (a) L.marker([a.lat, a.lng], { icon: pointIcon("A") }).addTo(pinLayer);
  if (b) L.marker([b.lat, b.lng], { icon: pointIcon("B") }).addTo(pinLayer);
}
function stopLoop() {
  running = false;
  if (frameId != null) cancelAnimationFrame(frameId);
  frameId = null;
}
function invalidateGraph() {
  stopLoop();
  if (controller) controller.abort();
  controller = null;
  loading = false;
  graph = null;
  sim = null;
  lines = [];
  roadLayer.clearLayers();
  routeLayer.clearLayers();
  $("trace").hidden = true;
  $("road-count").textContent = "—";
  $("model-time").textContent = "—";
  $("elev-a").textContent = "—";
  $("elev-b").textContent = "—";
  $("elev-count").textContent = "—";
  $("elev-source").textContent = "—";
}
function placePoint(which, latlng, invalidate = true) {
  if (invalidate) invalidateGraph();
  if (which === "a") {
    a = { lat: latlng.lat, lng: latlng.lng };
    choosing = "b";
  } else {
    b = { lat: latlng.lat, lng: latlng.lng };
    choosing = "a";
  }
  updatePins();
  updateControls();
  if (a && b) {
    modelState("READY TO LOAD ROADS");
    status("Points selected. Load the road network and elevation data.");
  } else {
    modelState(which === "a" ? "SELECT POINT B" : "SELECT POINT A");
    status(`Set point ${which === "a" ? "B" : "A"} on the map.`);
  }
}
map.on("click", (e) => { if (!loading) placePoint(choosing, e.latlng); });
$("set-a").addEventListener("click", () => { choosing = "a"; updateControls(); modelState("SELECT POINT A"); status("Click the map to select A."); });
$("set-b").addEventListener("click", () => { choosing = "b"; updateControls(); modelState("SELECT POINT B"); status("Click the map to select B."); });
$("example").addEventListener("click", () => {
  invalidateGraph();
  a = { ...ATHENS_A }; b = { ...ATHENS_B }; choosing = "a";
  updatePins(); updateControls();
  map.fitBounds([a, b], { padding: [80, 90], maxZoom: 15 });
  modelState("READY TO LOAD ROADS");
  status("Athens example selected. Load the streets to begin.");
});
$("terrain").addEventListener("input", () => {
  $("terrain-value").textContent = `${Number($("terrain").value).toFixed(2).replace(/\.00$/, ".0")}×`;
  if (graph) resetSimulation();
});
$("speed").addEventListener("input", () => {
  $("speed-value").textContent = `${$("speed").value}×`;
});

function splitAtMidpoint(shape) {
  if (!shape || shape.length < 2) return [shape, shape];
  let total = 0;
  for (let i = 1; i < shape.length; i++) {
    total += distanceMetres({ lat: shape[i-1][0], lng: shape[i-1][1] }, { lat: shape[i][0], lng: shape[i][1] });
  }
  if (!total) return [[shape[0],shape[1]],[shape[0],shape[1]]];
  let distance = 0;
  const left = [shape[0]];
  for (let i = 1; i < shape.length; i++) {
    const segment = distanceMetres({ lat: shape[i-1][0], lng: shape[i-1][1] }, { lat: shape[i][0], lng: shape[i][1] });
    if (distance + segment >= total / 2) {
      const fraction = Math.min(1, Math.max(0, (total / 2 - distance) / segment));
      const mid = [
        shape[i-1][0] + (shape[i][0] - shape[i-1][0]) * fraction,
        shape[i-1][1] + (shape[i][1] - shape[i-1][1]) * fraction
      ];
      left.push(mid);
      return [left, [mid, ...shape.slice(i)]];
    }
    left.push(shape[i]);
    distance += segment;
  }
  return [shape, shape.slice(-2)];
}

function addRoads() {
  roadLayer.clearLayers();
  routeLayer.clearLayers();
  lines = graph.edges.map((edge) => {
    const [left, right] = splitAtMidpoint(edge.shape);
    const style = { color: "#81969d", weight: 3, opacity: 0.38, interactive: false };
    const leftLine = L.polyline(left, style).addTo(roadLayer);
    const rightLine = L.polyline(right, style).addTo(roadLayer);
    return { leftLine, rightLine, ca: -1, cb: -1 };
  });
}
function concentrationLevel(c) {
  if (c < 0.002) return 0;
  return Math.min(12, Math.max(1, Math.ceil(12 * Math.sqrt(c / SOURCE_CONCENTRATION))));
}
function styleFor(level) {
  if (level === 0) return { color: "#889da5", weight: 3, opacity: 0.33 };
  const alpha = 0.44 + 0.56 * (level / 12);
  return { color: `hsl(${195 - 34 * level / 12}, 65%, ${41 - 7 * level / 12}%)`, weight: 3 + 4 * level / 12, opacity: alpha };
}
function paint() {
  if (!graph || !sim) return;
  for (let i = 0; i < graph.edges.length; i++) {
    const edge = graph.edges[i], visual = lines[i];
    if (!visual) continue;
    const ca = concentrationLevel(sim.concentration[edge.a]);
    const cb = concentrationLevel(sim.concentration[edge.b]);
    if (ca !== visual.ca) { visual.leftLine.setStyle(styleFor(ca)); visual.ca = ca; }
    if (cb !== visual.cb) { visual.rightLine.setStyle(styleFor(cb)); visual.cb = cb; }
  }
  $("model-time").textContent = `${sim.time.toFixed(1)} units`;
}
function resetSimulation() {
  if (!graph) return;
  stopLoop();
  sim = initialiseSimulation(graph, Number($("terrain").value));
  routeLayer.clearLayers();
  $("trace").hidden = true;
  $("model-time").textContent = "0.0 units";
  previousFrame = 0;
  for (const line of lines) { line.ca = -1; line.cb = -1; }
  paint();
  modelState("READY TO SIMULATE");
  status("Ready. Start diffusion to see the virtual fluid spreading.");
  updateControls();
}
function pathRoads(path) {
  const lookup = new Map();
  for (const edge of graph.edges) {
    lookup.set(`${edge.a}:${edge.b}`, { edge, reverse: false });
    lookup.set(`${edge.b}:${edge.a}`, { edge, reverse: true });
  }
  routeLayer.clearLayers();
  let length = 0, climb = 0, drop = 0;
  for (let i = 1; i < path.length; i++) {
    const connection = lookup.get(`${path[i-1]}:${path[i]}`);
    if (!connection) continue;
    const { edge, reverse } = connection;
    const dz = graph.nodes[path[i]].elevation - graph.nodes[path[i-1]].elevation;
    climb += Math.max(0, dz); drop += Math.max(0, -dz);
    length += edge.length;
    L.polyline(reverse ? [...edge.shape].reverse() : edge.shape, {
      color: "#d48032", weight: 6, opacity: 0.92, interactive: false, lineCap: "round"
    }).addTo(routeLayer);
  }
  return { length, climb, drop };
}
function completed() {
  stopLoop();
  modelState("FIRST NUMERICAL ARRIVAL AT B");
  if (sim.path.length > 1) {
    const { length, climb, drop } = pathRoads(sim.path);
    $("trace").hidden = false;
    $("trace").textContent = `Inferred flux trace · ${(length / 1000).toFixed(2)} km · +${climb.toFixed(0)} m / −${drop.toFixed(0)} m. This trace is heuristic and is not a proven minimum route.`;
  } else {
    $("trace").hidden = false;
    $("trace").textContent = "The numerical threshold arrived at B, but a consistent predecessor trace could not be reconstructed.";
  }
  status(`Arrival threshold reached at B · model t = ${sim.time.toFixed(2)} units.`, "success");
  updateControls();
}
function tick(timestamp) {
  if (!running || !sim) return;
  if (!previousFrame || timestamp - previousFrame >= 40) {
    previousFrame = timestamp;
    const iterations = Math.round(Number($("speed").value) * 7);
    for (let i = 0; i < iterations && !sim.arrived; i++) stepSimulation(sim);
    paint();
    if (sim.arrived) { completed(); return; }
    if (sim.steps > 180000 || sim.time > 12000) {
      stopLoop();
      modelState("SIMULATION LIMIT REACHED");
      status("No arrival at the selected threshold. Try reducing the elevation effect, or choose closer points.", "error");
      updateControls();
      return;
    }
  }
  frameId = requestAnimationFrame(tick);
}
$("simulate").addEventListener("click", () => {
  if (!sim || sim.arrived) return;
  if (running) {
    stopLoop();
    modelState("PAUSED");
    status(`Paused at t = ${sim.time.toFixed(2)} units.`);
  } else {
    running = true;
    previousFrame = 0;
    modelState("DIFFUSION IN PROGRESS", true);
    status("Virtual fluid is propagating through the road network…");
    frameId = requestAnimationFrame(tick);
  }
  updateControls();
});
$("restart").addEventListener("click", resetSimulation);
$("load").addEventListener("click", async () => {
  if (loading) {
    invalidateGraph();
    updateControls();
    modelState("LOADING CANCELLED");
    status("Loading cancelled. Choose points and try again.");
    return;
  }
  if (!a || !b) return;
  invalidateGraph();
  loading = true;
  controller = new AbortController();
  const activeController = controller;
  const loadingSignal = activeController.signal;
  updateControls();
  modelState("LOADING ROAD NETWORK");
  status("Connecting to the OpenStreetMap road service…");
  try {
    graph = await loadNetwork(a, b, (message) => {
      if (!loadingSignal.aborted) status(message);
    }, loadingSignal, (loadedRoads) => {
      if (loadingSignal.aborted) return;
      graph = loadedRoads;
      addRoads();
      $("road-count").textContent = graph.edges.length.toLocaleString();
      modelState("ROADS LOADED · SAMPLING ELEVATION");
      status(`Roads loaded (${graph.edges.length.toLocaleString()} segments). Loading heights…`);
    });
    if (loadingSignal.aborted) return;
    $("elev-a").textContent = `${graph.nodes[graph.start].elevation.toFixed(0)} m`;
    $("elev-b").textContent = `${graph.nodes[graph.end].elevation.toFixed(0)} m`;
    $("elev-count").textContent = graph.elevationInfo.count.toLocaleString();
    $("elev-source").textContent = graph.elevationInfo.provider;
    resetSimulation();
    status(`Ready: ${graph.edges.length.toLocaleString()} segments from ${graph.roadSource}; ${graph.elevationInfo.count.toLocaleString()} DEM points. Start diffusion.`);
    map.fitBounds([a, b], { padding: [80, 80], maxZoom: 16 });
  } catch (error) {
    if (!loadingSignal.aborted) {
      modelState("DATA LOAD ERROR");
      status(error.message || "Could not load map data. Try again.", "error");
      console.error("Map_Bike loading failed:", error);
    }
  } finally {
    if (controller === activeController) {
      loading = false;
      controller = null;
      updateControls();
    }
  }
});

updateControls();
modelState("SELECT POINT A");
