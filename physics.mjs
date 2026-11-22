// Conservative nonlinear diffusion–drift on a directed road graph.
// The active frontier skips dormant edges, preserving the original finite-volume
// flux and mass balance (zero concentration gives zero flux on dormant edges).
export const CELL_METRES = 50;
export const SOURCE_CONCENTRATION = 2;
export const DETECTION_CONCENTRATION = 0.035;
export const DIFFUSIVITY = 2.5;

function exposeNode(sim, node) {
  for (const edgeIndex of sim.adjacency[node]) {
    if (sim.activeEdgeFlags[edgeIndex]) continue;
    sim.activeEdgeFlags[edgeIndex] = 1;
    sim.activeEdges.push(edgeIndex);
    const edge = sim.edges[edgeIndex];
    const neighbour = edge.a === node ? edge.b : edge.a;
    if (!sim.activeNodeFlags[neighbour]) {
      sim.activeNodeFlags[neighbour] = 1;
      sim.activeNodes.push(neighbour);
    }
  }
}

export function initialiseSimulation(network, terrainStrength = 2) {
  const n = network.nodes.length;
  if (network.start === network.end) throw Error("A and B must be different road nodes.");
  const volumes = new Float64Array(n);
  const adjacency = Array.from({ length: n }, () => []);
  const edges = network.edges.map((edge, index) => {
    const h = Math.max(0.12, edge.length / CELL_METRES);
    const grade = (network.nodes[edge.b].elevation - network.nodes[edge.a].elevation)
      / Math.max(1, edge.length);
    volumes[edge.a] += h / 2;
    volumes[edge.b] += h / 2;
    adjacency[edge.a].push(index);
    adjacency[edge.b].push(index);
    // The solver doesn't need coordinates, OSM IDs or polyline shapes.
    return { a: edge.a, b: edge.b, h, grade,
      forward: edge.forward, backward: edge.backward };
  });
  for (let i = 0; i < n; i++) volumes[i] = Math.max(0.25, volumes[i]);
  const mass = new Float64Array(n);
  const concentration = new Float64Array(n);
  const predecessor = new Int32Array(n).fill(-1);
  const arrivalTime = new Float64Array(n).fill(Infinity);
  concentration[network.start] = SOURCE_CONCENTRATION;
  mass[network.start] = SOURCE_CONCENTRATION * volumes[network.start];
  arrivalTime[network.start] = 0;
  const sim = {
    network, edges, adjacency, volumes, mass, concentration, predecessor, arrivalTime,
    rates: new Float64Array(n), changes: new Float64Array(n),
    bestFlux: new Float64Array(n), bestFrom: new Int32Array(n),
    activeEdges: [], activeEdgeFlags: new Uint8Array(edges.length),
    activeNodes: [network.start], activeNodeFlags: new Uint8Array(n),
    expandedFlags: new Uint8Array(n),
    terrainStrength, time: 0, steps: 0, injectedMass: mass[network.start],
    arrived: false, path: [], maxConcentration: SOURCE_CONCENTRATION
  };
  sim.activeNodeFlags[network.start] = 1;
  sim.expandedFlags[network.start] = 1;
  exposeNode(sim, network.start);
  return sim;
}

export function stepSimulation(sim) {
  if (sim.arrived) return;
  const { concentration: c, edges, rates, changes, bestFlux, bestFrom,
    volumes, activeEdges, activeNodes } = sim;
  // Reset and visit only the reached region and its immediate neighbours.
  for (const i of activeNodes) {
    rates[i] = 0;
    changes[i] = 0;
    bestFlux[i] = 0;
    bestFrom[i] = -1;
  }
  for (const edgeIndex of activeEdges) {
    const e = edges[edgeIndex];
    const v = -14 * sim.terrainStrength * e.grade;
    const stiffness = 2 * DIFFUSIVITY * Math.max(c[e.a], c[e.b]) / e.h + Math.abs(v);
    rates[e.a] += stiffness / volumes[e.a];
    rates[e.b] += stiffness / volumes[e.b];
  }
  let maxRate = 0;
  for (const i of activeNodes) maxRate = Math.max(maxRate, rates[i]);
  const dt = Math.min(0.12, maxRate > 0 ? 0.28 / maxRate : 0.12);
  for (const edgeIndex of activeEdges) {
    const e = edges[edgeIndex], a = e.a, b = e.b;
    const drift = -14 * sim.terrainStrength * e.grade;
    let flux = -DIFFUSIVITY * (c[b] * c[b] - c[a] * c[a]) / e.h
      + drift * (drift >= 0 ? c[a] : c[b]);
    if ((flux > 0 && !e.forward) || (flux < 0 && !e.backward)) flux = 0;
    if (flux > 0 && flux > bestFlux[b]) { bestFlux[b] = flux; bestFrom[b] = a; }
    else if (flux < 0 && -flux > bestFlux[a]) { bestFlux[a] = -flux; bestFrom[a] = b; }
    changes[a] -= flux * dt;
    changes[b] += flux * dt;
  }
  const previousTime = sim.time;
  // Newly reached nodes become active at the next step; no dormant edges can
  // have non-zero flux before one of their endpoints has positive concentration.
  const currentNodeCount = activeNodes.length;
  for (let k = 0; k < currentNodeCount; k++) {
    const i = activeNodes[k];
    const newMass = Math.max(0, sim.mass[i] + changes[i]);
    sim.mass[i] = newMass;
    c[i] = newMass / volumes[i];
    if (newMass > 0 && !sim.expandedFlags[i]) {
      sim.expandedFlags[i] = 1;
      exposeNode(sim, i);
    }
  }
  const sourceMass = SOURCE_CONCENTRATION * volumes[sim.network.start];
  sim.injectedMass += sourceMass - sim.mass[sim.network.start];
  sim.mass[sim.network.start] = sourceMass;
  c[sim.network.start] = SOURCE_CONCENTRATION;
  sim.time = previousTime + dt;
  sim.steps++;
  for (let k = 0; k < currentNodeCount; k++) {
    const i = activeNodes[k];
    if (sim.arrivalTime[i] !== Infinity || c[i] < DETECTION_CONCENTRATION) continue;
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
    seen.add(node);
    p.push(node);
    if (node === sim.network.start) return p.reverse();
    node = sim.predecessor[node];
  }
  return [];
}
