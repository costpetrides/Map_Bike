// Numerical integration runs outside the map/UI thread.
// Each slice has a CPU time budget, and only sparse snapshots are sent to UI.
import { initialiseSimulation, stepSimulation } from "./physics.mjs";

let sim = null;
let running = false;
let speed = 5;
let timer = null;
let lastSnapshot = 0;
const MAX_STEPS = 800000;
const MAX_MODEL_TIME = 50000;

function snapshot() {
  if (!sim) return;
  const concentration = new Float32Array(sim.concentration);
  self.postMessage({
    type: "frame", concentration, time: sim.time, steps: sim.steps,
    arrived: sim.arrived, path: sim.arrived ? sim.path : null
  }, [concentration.buffer]);
  lastSnapshot = performance.now();
}
function pause() {
  running = false;
  if (timer != null) clearTimeout(timer);
  timer = null;
}
function runSlice() {
  timer = null;
  if (!running || !sim) return;
  const deadline = performance.now() + 12;
  const maxIterations = Math.round(speed * 25);
  for (let i = 0; i < maxIterations && performance.now() < deadline; i++) {
    stepSimulation(sim);
    if (sim.arrived) {
      pause();
      snapshot();
      return;
    }
    if (sim.steps >= MAX_STEPS || sim.time >= MAX_MODEL_TIME) {
      pause();
      snapshot();
      self.postMessage({ type: "limit",
        message: "No arrival at the numerical threshold within the model limit. Try a lower elevation effect or a different route." });
      return;
    }
  }
  if (performance.now() - lastSnapshot >= 90) snapshot();
  if (running) timer = setTimeout(runSlice, 12);
}
self.onmessage = ({ data }) => {
  try {
    if (data.type === "init") {
      pause();
      sim = initialiseSimulation(data.network, data.terrainStrength);
      speed = Math.max(1, Math.min(20, data.speed || 5));
      snapshot();
    } else if (data.type === "start" && sim && !sim.arrived) {
      if (!running) {
        running = true;
        timer = setTimeout(runSlice, 0);
      }
    } else if (data.type === "pause") {
      pause();
      snapshot();
    } else if (data.type === "speed") {
      speed = Math.max(1, Math.min(20, data.value));
    }
  } catch (error) {
    pause();
    self.postMessage({ type: "error", message: error.message || "Numerical solver failed" });
  }
};
