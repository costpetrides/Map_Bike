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
