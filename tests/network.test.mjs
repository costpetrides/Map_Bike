import test from "node:test";
import assert from "node:assert/strict";
import { loadNetwork } from "../network.mjs";

const sampleNodes = [
  { type: "node", id: 1, lat: 37.97600, lon: 23.73900 },
  { type: "node", id: 2, lat: 37.97645, lon: 23.73950 },
  { type: "node", id: 3, lat: 37.97690, lon: 23.74000 },
  { type: "node", id: 4, lat: 37.97735, lon: 23.74050 },
  { type: "node", id: 5, lat: 37.97780, lon: 23.74100 }
];
const osmResponse = {
  elements: [
    ...sampleNodes,
    { type: "way", id: 100, nodes: [1, 2, 3, 4, 5],
      tags: { highway: "residential", bicycle: "yes" } }
  ]
};

test("loads roads before elevation and reports progressive stages", async (t) => {
  const originalFetch = globalThis.fetch;
  let roadRequests = 0;
  let elevationRequests = 0;
  let roadCallbackReceived = false;
  let elevationStartedAfterRoadCallback = false;
  const messages = [];
  globalThis.fetch = async (requestUrl, options) => {
    const url = String(requestUrl);
    assert.ok(options?.signal, "All requests should have an abort/timeout signal");
    if (url.includes("/api/interpreter")) {
      roadRequests++;
      return { ok: true, json: async () => osmResponse };
    }
    if (url.includes("/v1/elevation")) {
      elevationRequests++;
      elevationStartedAfterRoadCallback = roadCallbackReceived;
      const count = new URL(url).searchParams.get("latitude").split(",").length;
      assert.ok(count > 0 && count <= 100);
      return { ok: true, json: async () => ({ elevation: Array(count).fill(95) }) };
    }
    throw Error("Unexpected API URL: " + url);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const graph = await loadNetwork(
    { lat: 37.976, lng: 23.739 },
    { lat: 37.9778, lng: 23.741 },
    (msg) => messages.push(msg),
    undefined,
    (partial) => {
      roadCallbackReceived = true;
      assert.ok(partial.nodes.length > 0);
      assert.ok(partial.edges.length > 0);
      assert.equal(partial.nodes[partial.start].elevation, null);
    }
  );
  assert.ok(roadRequests >= 1);
  assert.ok(elevationRequests >= 1);
  assert.ok(roadCallbackReceived);
  assert.ok(elevationStartedAfterRoadCallback);
  assert.ok(messages.some(msg => msg.includes("elevations")));
  assert.ok(graph.nodes.every(node => node.elevation === 95));
  assert.notEqual(graph.start, graph.end);
});

test("rejects too-close A/B points before making API calls", async () => {
  await assert.rejects(
    loadNetwork({ lat: 37.976, lng: 23.739 }, { lat: 37.97601, lng: 23.73901 }),
    /at least 80 metres/
  );
});


test("adaptive corridor is local and expands geometrically around A–B", async () => {
  const { corridorSpec } = await import("../network.mjs");
  const a = { lat: 37.97600, lng: 23.73900 };
  const b = { lat: 37.97920, lng: 23.74400 };
  const narrow = corridorSpec(a, b, 125);
  const wide = corridorSpec(a, b, 250);
  assert.equal(narrow.poly.split(" ").length, 8); // four lat/lon pairs
  assert.ok(narrow.contains(a));
  assert.ok(narrow.contains(b));
  assert.ok(wide.contains({ lat: 37.976, lng: 23.737 }));
  assert.equal(narrow.contains({ lat: 37.990, lng: 23.760 }), false);
  assert.ok(wide.marginMetres > narrow.marginMetres);
});

test("automatic corridor expansion retries when initial data lacks a road connection", async (t) => {
  const originalFetch = globalThis.fetch;
  let roadRequests = 0;
  const messages = [];
  const disconnected = {
    elements: [
      ...sampleNodes,
      { type: "way", id: 101, nodes: [1, 2], tags: { highway: "residential" } },
      { type: "way", id: 102, nodes: [4, 5], tags: { highway: "residential" } }
    ]
  };
  globalThis.fetch = async (requestUrl, options) => {
    const url = String(requestUrl);
    if (url.includes("/api/interpreter")) {
      roadRequests++;
      const query = String(options.body.get("data"));
      assert.ok(query.includes('(poly:"'), "Road search should be bounded by a polygon");
      return { ok: true, json: async () => roadRequests === 1 ? disconnected : osmResponse };
    }
    if (url.includes("/v1/elevation")) {
      const count = new URL(url).searchParams.get("latitude").split(",").length;
      return { ok: true, json: async () => ({ elevation: Array(count).fill(95) }) };
    }
    throw Error("Unexpected request");
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const graph = await loadNetwork(
    { lat: 37.97602, lng: 23.73902 },
    { lat: 37.97778, lng: 23.74098 },
    m => messages.push(m)
  );
  assert.ok(roadRequests >= 2);
  assert.ok(messages.some(m => m.includes("expanding")));
  assert.ok(graph.edges.length > 0);
  assert.ok(graph.nodes.every(n => Number.isFinite(n.elevation)));
});

test("unreachable side components are pruned before DEM sampling", async () => {
  const { pruneUnreachable } = await import("../network.mjs");
  const g = {
    nodes: Array.from({ length: 6 }, () => ({ elevation: null })),
    edges: [
      { a: 0, b: 1, forward: true, backward: true },
      { a: 1, b: 2, forward: true, backward: true },
      { a: 3, b: 4, forward: true, backward: true },
      { a: 5, b: 1, forward: true, backward: false }
    ],
    start: 0, end: 2
  };
  const pruned = pruneUnreachable(g);
  assert.equal(pruned.nodes.length, 3);
  assert.equal(pruned.edges.length, 2);
  assert.equal(pruned.start, 0);
  assert.equal(pruned.end, 2);
});
