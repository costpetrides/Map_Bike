import { loadNetwork, distanceMetres, MAX_ROUTE_METRES } from "./network.mjs";
import { createRoadCanvas } from "./road-canvas.mjs";
import { initialiseSimulation, stepSimulation, SOURCE_CONCENTRATION } from "./physics.mjs";
import { BASEMAP_STYLES } from "./map-style.mjs";

const $ = (id) => document.getElementById(id);
const map = L.map("map", { zoomControl: false, preferCanvas: true }).setView([37.9802, 23.7395], 14);
L.control.zoom({ position: "topright" }).addTo(map);
const fallbackRaster = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

// Keep the existing Leaflet raster map usable if the vector tiles/CDN fail.
// Switching the basemap must not change A/B or the PDE solver's state.
// Dark is the only supported basemap; there is no theme preference or switch.
const selectedMapStyle = "dark";
let basemap = null;

function ensureFallbackRaster() {
  if (!map.hasLayer(fallbackRaster)) fallbackRaster.addTo(map);
  fallbackRaster.bringToBack();
}

function initialiseDarkBasemap() {
  if (typeof L.maplibreGL !== "function" ||
      typeof window.maplibregl?.supported !== "function" ||
      !window.maplibregl.supported()) {
    ensureFallbackRaster();
    return;
  }
  try {
    basemap = L.maplibreGL({
      style: BASEMAP_STYLES.dark,
      attribution: '&copy; <a href="https://openfreemap.org/">OpenFreeMap</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    const gl = basemap.getMaplibreMap();
    gl.on("idle", () => {
      if (gl.areTilesLoaded() && map.hasLayer(fallbackRaster))
        map.removeLayer(fallbackRaster);
    });
    gl.on("error", event => {
      if (!gl.isStyleLoaded()) {
        ensureFallbackRaster();
        console.warn("Dark vector map unavailable; using dark raster fallback", event.error);
      }
    });
  } catch (error) {
    console.warn("Dark vector map unavailable; using dark raster fallback", error);
    if (basemap && map.hasLayer(basemap)) map.removeLayer(basemap);
    basemap = null;
    ensureFallbackRaster();
  }
}

const routeLayer = L.layerGroup().addTo(map);
const pinLayer = L.layerGroup().addTo(map);
const roadCanvas = createRoadCanvas(L, map, selectedMapStyle);
let rangeCircle = null;
const ATHENS_A = { lat: 37.97637, lng: 23.73946 };
const ATHENS_B = { lat: 37.98147, lng: 23.74613 };

let a = null, b = null, choosing = "a";
let graph = null, sim = null, worker = null;
let running = false, frameId = null, previousFrame = 0, loading = false, controller = null;
let hasCompleted = false;

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
  $("load").disabled = !loading && (!a || !b || distanceMetres(a, b) > MAX_ROUTE_METRES);
  $("load").textContent = loading ? "Cancel loading ✕" : "Load road network ↗";
  $("set-a").disabled = loading;
  $("set-b").disabled = loading;
  $("example").disabled = loading;
  $("show-range").disabled = !a;
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
  if (rangeCircle) { map.removeLayer(rangeCircle); rangeCircle = null; }
  if (a) {
    rangeCircle = L.circle([a.lat, a.lng], {
      radius: MAX_ROUTE_METRES, color: "#69cbb2", weight: 2,
      dashArray: "8 7", fillColor: "#40bfa9", fillOpacity: 0.045,
      interactive: false
    }).addTo(map);
  }
  $("direct-distance").textContent = a && b
    ? `${(distanceMetres(a, b) / 1000).toFixed(2)} km` : "—";
}
function stopLoop() {
  running = false;
  if (worker) worker.postMessage({ type: "pause" });
  if (frameId != null) cancelAnimationFrame(frameId);
  frameId = null;
}
function invalidateGraph() {
  stopLoop();
  if (controller) controller.abort();
  controller = null;
  loading = false;
  if (worker) { worker.terminate(); worker = null; }
  graph = null;
  sim = null;
  hasCompleted = false;
  roadCanvas.setGraph(null);
  routeLayer.clearLayers();
  $("trace").hidden = true;
  $("road-count").textContent = "—";
  $("route-distance").textContent = "—";
  $("model-time").textContent = "—";
  $("elev-a").textContent = "—";
  $("elev-b").textContent = "—";
  $("elev-count").textContent = "—";
  $("elev-source").textContent = "—";
}
function placePoint(which, latlng, invalidate = true) {
  if (which === "b" && a && distanceMetres(a, latlng) > MAX_ROUTE_METRES) {
    modelState("OUTSIDE 10 KM RANGE");
    status("Destination B is outside the 10 km radius from A. Select a point inside the circle.", "error");
    return;
  }
  if (invalidate) invalidateGraph();
  if (which === "a") {
    a = { lat: latlng.lat, lng: latlng.lng };
    if (b && distanceMetres(a, b) > MAX_ROUTE_METRES) b = null;
    choosing = "b";
  } else {
    b = { lat: latlng.lat, lng: latlng.lng };
    choosing = "a";
  }
  updatePins();
  updateControls();
  // On choosing A, frame the full circle so the 10 km reach is immediately visible.
  if (which === "a" && rangeCircle) {
    map.fitBounds(rangeCircle.getBounds(), { padding: [35, 35] });
  }
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
  status("Athens example selected. The dashed circle shows the 10 km straight-line range.");
});
$("show-range").addEventListener("click", () => {
  if (rangeCircle) map.fitBounds(rangeCircle.getBounds(), { padding: [35, 35] });
});
$("terrain").addEventListener("input", () => {
  $("terrain-value").textContent = `${Number($("terrain").value).toFixed(2).replace(/\.00$/, ".0")}×`;
  if (graph) resetSimulation();
});
$("speed").addEventListener("input", () => {
  $("speed-value").textContent = `${$("speed").value}×`;
  if (worker) worker.postMessage({ type: "speed", value: Number($("speed").value) });
});

function addRoads() {
  routeLayer.clearLayers();
  roadCanvas.setGraph(graph);
}
function paint() {
  if (!graph || !sim) return;
  roadCanvas.render(sim.concentration, sim.activeEdges);
  $("model-time").textContent = `${sim.time.toFixed(1)} units`;
}
function resetSimulation() {
  if (!graph) return;
  stopLoop();
  if (worker) { worker.terminate(); worker = null; }
  hasCompleted = false;
  routeLayer.clearLayers();
  $("trace").hidden = true;
  $("model-time").textContent = "0.0 units";
  previousFrame = 0;

  // A dedicated worker keeps CPU-intensive numerical integration off the map
  // thread. If unavailable, the same solver runs locally with a time budget.
  if (typeof Worker === "function") {
    try {
      const instance = new Worker(new URL("./simulation-worker.mjs", import.meta.url), { type: "module" });
      worker = instance;
      sim = {
        concentration: new Float32Array(graph.nodes.length), time: 0,
        steps: 0, arrived: false, path: [], activeEdges: null
      };
      sim.concentration[graph.start] = SOURCE_CONCENTRATION;
      instance.onmessage = ({ data }) => {
        if (worker !== instance || !graph) return;
        if (data.type === "frame") {
          sim.concentration = data.concentration;
          sim.time = data.time;
          sim.steps = data.steps;
          sim.arrived = data.arrived;
          sim.path = data.path || [];
          paint();
          if (sim.arrived && !hasCompleted) {
            hasCompleted = true;
            completed();
          }
        } else if (data.type === "limit" || data.type === "error") {
          stopLoop();
          modelState(data.type === "limit" ? "SIMULATION LIMIT REACHED" : "SIMULATION ERROR");
          status(data.message, "error");
          updateControls();
        }
      };
      instance.onerror = (event) => {
        if (worker !== instance) return;
        console.error("Simulation worker error", event);
        stopLoop();
        instance.terminate();
        worker = null;
        sim = initialiseSimulation(graph, Number($("terrain").value));
        paint();
        modelState("READY TO SIMULATE");
        status("Background solver unavailable. Main-thread simulation is ready.");
        updateControls();
      };
      const network = {
        start: graph.start, end: graph.end,
        nodes: graph.nodes.map(node => ({ elevation: node.elevation })),
        edges: graph.edges.map(edge => ({
          a: edge.a, b: edge.b, length: edge.length,
          forward: edge.forward, backward: edge.backward
        }))
      };
      instance.postMessage({
        type: "init", network, terrainStrength: Number($("terrain").value),
        speed: Number($("speed").value)
      });
    } catch (error) {
      if (worker) { worker.terminate(); worker = null; }
      console.warn("Simulation worker not available", error);
      sim = initialiseSimulation(graph, Number($("terrain").value));
    }
  } else {
    sim = initialiseSimulation(graph, Number($("terrain").value));
  }
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
      color: "#22C55E", weight: 6, opacity: 0.92, interactive: false, lineCap: "round"
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
  if (!previousFrame || timestamp - previousFrame >= 18) {
    previousFrame = timestamp;
    const iterations = Math.round(Number($("speed").value) * 40);
    const deadline = performance.now() + 18;
    for (let i = 0; i < iterations && !sim.arrived && performance.now() < deadline; i++)
      stepSimulation(sim);
    paint();
    if (sim.arrived) { completed(); return; }
    if (sim.steps > 800000 || sim.time > 50000) {
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
    if (worker) worker.postMessage({ type: "start" });
    else frameId = requestAnimationFrame(tick);
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
      $("route-distance").textContent = `${(graph.routeDistance / 1000).toFixed(2)} km`;
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
    // Show the loaded street footprint, not merely the straight A–B line.
    const roadBounds = L.latLngBounds([[a.lat, a.lng], [b.lat, b.lng]]);
    for (const node of graph.nodes) roadBounds.extend([node.lat, node.lng]);
    map.fitBounds(roadBounds, { padding: [45, 45], maxZoom: 16 });
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

initialiseDarkBasemap();
updateControls();
modelState("SELECT POINT A");
