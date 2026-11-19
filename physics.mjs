// Conservative, nonlinear diffusion–drift on a road metric graph.
// Each edge is a finite-volume face; all distances are scaled by 50 metres.
// Boundary at A: fixed concentration reservoir (continuous injection).
// A threshold detects an operational arrival at B, not a mathematical first contact.
export const CELL_METRES = 50;
export const SOURCE_CONCENTRATION = 2;
export const DETECTION_CONCENTRATION = 0.035;
export const DIFFUSIVITY = 2.5;

export function initialiseSimulation(network, terrainStrength = 2) {
  const n = network.nodes.length;
  if (network.start === network.end) throw Error("A and B must be different road nodes.");
  const volumes = new Float64Array(n);
  const edges = network.edges.map((e) => {
    const h = Math.max(0.12, e.length / CELL_METRES);
    const grade = (network.nodes[e.b].elevation - network.nodes[e.a].elevation) / Math.max(1, e.length);
    volumes[e.a] += h / 2;
    volumes[e.b] += h / 2;
    return { ...e, h, grade };
  });
  for (let i = 0; i < n; i++) volumes[i] = Math.max(0.25, volumes[i]);
  const mass = new Float64Array(n);
  const concentration = new Float64Array(n);
  const predecessor = new Int32Array(n).fill(-1);
  const arrivalTime = new Float64Array(n).fill(Infinity);
  concentration[network.start] = SOURCE_CONCENTRATION;
  mass[network.start] = SOURCE_CONCENTRATION * volumes[network.start];
  arrivalTime[network.start] = 0;
  return {
    network, edges, volumes, mass, concentration, predecessor, arrivalTime,
    rates: new Float64Array(n), changes: new Float64Array(n),
    bestFlux: new Float64Array(n), bestFrom: new Int32Array(n),
    terrainStrength, time: 0, steps: 0, injectedMass: mass[network.start],
    arrived: false, path: [], maxConcentration: SOURCE_CONCENTRATION
  };
}

export function stepSimulation(sim) {
  if (sim.arrived) return;
  const { concentration: c, edges, rates, volumes } = sim;
  rates.fill(0);
  // Explicit finite-volume stability bound for degenerate diffusion + upwind drift.
  for (const e of edges) {
    const v = -14 * sim.terrainStrength * e.grade;
    const stiffness = 2 * DIFFUSIVITY * Math.max(c[e.a], c[e.b]) / e.h + Math.abs(v);
    rates[e.a] += stiffness / volumes[e.a];
    rates[e.b] += stiffness / volumes[e.b];
  }
  let maxRate = 0;
  for (let i = 0; i < rates.length; i++) maxRate = Math.max(maxRate, rates[i]);
  const dt = Math.min(0.12, maxRate > 0 ? 0.28 / maxRate : 0.12);
  const { changes, bestFlux, bestFrom } = sim;
  changes.fill(0);
  bestFlux.fill(0);
  bestFrom.fill(-1);
  for (const e of edges) {
    const a = e.a, b = e.b, drift = -14 * sim.terrainStrength * e.grade;
    let flux = -DIFFUSIVITY * (c[b] * c[b] - c[a] * c[a]) / e.h
      + drift * (drift >= 0 ? c[a] : c[b]);
    // One-way bicycle roads behave as one-way valves in this exploratory PDE model.
    if ((flux > 0 && !e.forward) || (flux < 0 && !e.backward)) flux = 0;
    if (flux > 0 && flux > bestFlux[b]) { bestFlux[b] = flux; bestFrom[b] = a; }
    else if (flux < 0 && -flux > bestFlux[a]) { bestFlux[a] = -flux; bestFrom[a] = b; }
    changes[a] -= flux * dt;
    changes[b] += flux * dt;
  }
  const previousTime = sim.time;
  for (let i = 0; i < c.length; i++) {
    const newMass = Math.max(0, sim.mass[i] + changes[i]);
    sim.mass[i] = newMass;
    c[i] = newMass / volumes[i];
  }
  // Replenish A; its cumulative injection is tracked explicitly.
  const sourceMass = SOURCE_CONCENTRATION * volumes[sim.network.start];
  sim.injectedMass += sourceMass - sim.mass[sim.network.start];
  sim.mass[sim.network.start] = sourceMass;
  c[sim.network.start] = SOURCE_CONCENTRATION;
  sim.time = previousTime + dt;
  sim.steps++;
  for (let i = 0; i < c.length; i++) {
    if (sim.arrivalTime[i] !== Infinity || c[i] < DETECTION_CONCENTRATION) continue;
    // Only accept a predecessor that was active earlier, preventing cyclic traces.
    const parent = bestFrom[i];
    if (parent >= 0 && sim.arrivalTime[parent] < sim.time) {
      sim.predecessor[i] = parent;
      sim.arrivalTime[i] = sim.time;
    }
  }
  if (sim.arrivalTime[sim.network.end] < Infinity) {
    sim.arrived = true;
    sim.path = tracePath(sim);
  }
}

export function tracePath(sim) {
  const p = [];
  const seen = new Set();
  let node = sim.network.end;
  while (node !== -1 && !seen.has(node) && p.length <= sim.network.nodes.length) {
    seen.add(node); p.push(node);
    if (node === sim.network.start) return p.reverse();
    node = sim.predecessor[node];
  }
  return [];
}
