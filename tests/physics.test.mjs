import test from "node:test";
import assert from "node:assert/strict";
import { initialiseSimulation, stepSimulation, DIFFUSIVITY, GRADE_DRIFT_COEFFICIENT } from "../physics.mjs";

function smallRoad(midElevation = 0, forward = true, backward = true) {
  return {
    nodes: [
      { elevation: 0 }, { elevation: midElevation }, { elevation: midElevation }
    ],
    edges: [
      { a: 0, b: 1, length: 50, forward, backward },
      { a: 1, b: 2, length: 50, forward, backward }
    ],
    start: 0, end: 2
  };
}
function runToContact(network, strength = 2, limit = 100000) {
  const sim = initialiseSimulation(network, strength);
  for (let i = 0; i < limit && !sim.arrived; i++) stepSimulation(sim);
  return sim;
}
test("signed elevation changes the arrival order: downhill < flat < uphill", () => {
  const down = runToContact(smallRoad(-5));
  const flat = runToContact(smallRoad(0));
  const up = runToContact(smallRoad(5));
  assert.equal(down.arrived, true);
  assert.equal(flat.arrived, true);
  assert.equal(up.arrived, true);
  assert.ok(down.time < flat.time, "downhill drift should assist the front");
  assert.ok(flat.time < up.time, "uphill drift should oppose the front");
});
test("initial release and continuous A reservoir conserve accounted mass", () => {
  const sim = initialiseSimulation(smallRoad(5), 2);
  for (let i = 0; i < 50; i++) {
    stepSimulation(sim);
    const total = Array.from(sim.mass).reduce((acc, mass) => acc + mass, 0);
    assert.ok(Math.abs(total - sim.injectedMass) < 1e-8);
    assert.ok(Array.from(sim.concentration).every(c => Number.isFinite(c) && c >= 0));
  }
});
test("reconstructed predecessor trace connects A to B", () => {
  const sim = runToContact(smallRoad(0));
  assert.deepEqual(sim.path, [0, 1, 2]);
  assert.equal(sim.predecessor[2], 1);
});
test("front cannot pass an edge that forbids its direction", () => {
  const sim = runToContact(smallRoad(0, false, true), 0, 2000);
  assert.equal(sim.arrived, false);
  assert.equal(sim.concentration[2], 0);
});
test("disabled elevation effect behaves equally on two grades", () => {
  const down = runToContact(smallRoad(-5), 0);
  const up = runToContact(smallRoad(5), 0);
  assert.ok(Math.abs(down.time - up.time) < 1e-12);
});
test("simulation stops once B reaches the operational concentration threshold", () => {
  const sim = runToContact(smallRoad(0));
  const previousSteps = sim.steps;
  stepSimulation(sim);
  assert.equal(sim.steps, previousSteps);
});

test("active-front solver initially visits only roads adjacent to A", () => {
  const count = 400;
  const net = {
    nodes: Array.from({ length: count }, () => ({ elevation: 0 })),
    edges: Array.from({ length: count - 1 }, (_, i) => ({
      a: i, b: i + 1, length: 50, forward: true, backward: true
    })),
    start: 0, end: count - 1
  };
  const sim = initialiseSimulation(net, 0);
  assert.equal(sim.activeEdges.length, 1);
  assert.equal(sim.activeNodes.length, 2);
  for (let i = 0; i < 20; i++) stepSimulation(sim);
  assert.ok(sim.activeEdges.length < 40, "Distant dormant roads should not be integrated");
  assert.equal(sim.concentration[count - 1], 0);
  const total = sim.mass.reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(total - sim.injectedMass) < 1e-8);
});

test("faster nonlinear mobility and stronger terrain drift remain finite and conservative", () => {
  assert.equal(DIFFUSIVITY, 8);
  assert.equal(GRADE_DRIFT_COEFFICIENT, 30);
  const down = runToContact(smallRoad(-5), 6);
  const flat = runToContact(smallRoad(0), 6);
  const up = runToContact(smallRoad(5), 6);
  assert.ok(down.arrived && flat.arrived && up.arrived);
  assert.ok(down.time < flat.time && flat.time < up.time);
  for (const sim of [down, flat, up]) {
    assert.ok(sim.concentration.every(c => c >= 0 && Number.isFinite(c)));
    const sum = sim.mass.reduce((total, m) => total + m, 0);
    assert.ok(Math.abs(sum - sim.injectedMass) < 1e-7);
  }
});
