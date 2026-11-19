import test from "node:test";
import assert from "node:assert/strict";
import { fallbackBounds, parseOsmDocument } from "../osm-fallback.mjs";
import { corridorSpec } from "../network.mjs";

function element(attrs = {}, children = {}) {
  return {
    getAttribute(key) { return attrs[key] ?? null; },
    getElementsByTagName(tag) { return children[tag] || []; }
  };
}

test("tiny A-B road corridor qualifies for bounded independent fallback", () => {
  const corridor = corridorSpec(
    {lat:37.97591,lng:23.73843},
    {lat:37.97685,lng:23.73920},
    125
  );
  const bounds = fallbackBounds(corridor);
  assert.ok(bounds);
  assert.ok(bounds.west < 23.73843 && bounds.east > 23.73920);
  assert.ok(bounds.south < 37.97591 && bounds.north > 37.97685);
});

test("wide road area is never sent to the OSM editing API", () => {
  const corridor = corridorSpec(
    {lat:37.97591,lng:23.73843},
    {lat:37.99591,lng:23.75843},
    500
  );
  assert.equal(fallbackBounds(corridor), null);
});

test("OSM XML adaptation extracts only road ways and their required nodes", () => {
  const nodes = [
    element({id:"11",lat:"37.976",lon:"23.739"}),
    element({id:"12",lat:"37.977",lon:"23.740"}),
    element({id:"13",lat:"37.978",lon:"23.741"})
  ];
  const road = element({id:"100"}, {
    tag:[element({k:"highway",v:"residential"}),element({k:"oneway",v:"yes"})],
    nd:[element({ref:"11"}),element({ref:"12"})]
  });
  const building = element({id:"200"}, {
    tag:[element({k:"building",v:"yes"})],
    nd:[element({ref:"12"}),element({ref:"13"})]
  });
  const doc = {getElementsByTagName(tag) {
    return tag==="node" ? nodes : tag==="way" ? [road,building] : [];
  }};
  const output = parseOsmDocument(doc);
  assert.equal(output.elements.filter(e => e.type==="way").length,1);
  assert.deepEqual(output.elements.filter(e => e.type==="node").map(n=>n.id),[11,12]);
  assert.equal(output.elements.find(e=>e.type==="way").tags.oneway,"yes");
});

test("invalid corridor polygon fails without launching a fallback request", () => {
  assert.throws(()=>fallbackBounds({poly:"bad coords"}), /Invalid road-search polygon/);
});
