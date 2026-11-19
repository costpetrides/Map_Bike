import test from "node:test";
import assert from "node:assert/strict";
import { tileFraction, decodeTerrarium, elevationFromTile, assignNodeElevations } from "../elevation.mjs";

test("Terrarium decoder returns known elevations", () => {
  assert.equal(decodeTerrarium(128, 0, 0), 0);
  assert.equal(decodeTerrarium(128, 100, 0), 100);
  assert.equal(decodeTerrarium(127, 255, 0), -1);
  assert.equal(decodeTerrarium(128, 100, 128), 100.5);
});

test("tile coordinates match location and are stable across local samples", () => {
  const a = tileFraction(37.97600, 23.73900);
  const b = tileFraction(37.97603, 23.73903);
  assert.equal(a.ix, b.ix);
  assert.equal(a.iy, b.iy);
  assert.ok(a.x >= a.ix && a.x < a.ix + 1);
  assert.ok(a.y >= a.iy && a.y < a.iy + 1);
});

test("bilinear elevation interpolates pixels rather than rounding geographic points", () => {
  const width = 512;
  const data = new Uint8ClampedArray(width * width * 4);
  const point = {lat:37.976, lng:23.739};
  const t = tileFraction(point.lat, point.lng);
  const x = Math.floor((t.x-t.ix)*512), y = Math.floor((t.y-t.iy)*512);
  // Deliberately set different colours for the four adjacent terrain pixels.
  function put(dx,dy,z) {
    const k = ((y+dy)*width+x+dx)*4;
    data[k] = 128; data[k+1] = z; data[k+2] = 0; data[k+3]=255;
  }
  put(0,0,100); put(1,0,140);
  put(0,1,200); put(1,1,240);
  const fx=(t.x-t.ix)*512-x, fy=(t.y-t.iy)*512-y;
  const expected=(1-fx)*(1-fy)*100 + fx*(1-fy)*140 + (1-fx)*fy*200 + fx*fy*240;
  assert.ok(Math.abs(elevationFromTile({width:512,height:512,data},point.lat,point.lng)-expected)<1e-9);
});

test("tile failure triggers exact-coordinate fallback and never substitutes a zero", async (t) => {
  const originalFetch = globalThis.fetch;
  const nodes = [{lat:37.97593,lng:23.73947,elevation:null},
                 {lat:37.97618,lng:23.73991,elevation:null}];
  let calledFallback = false;
  globalThis.fetch = async (url, opts) => {
    const dest=String(url);
    if (dest.includes("tiles.mapterhorn.com")) return {ok:false,status:503};
    if (dest.includes("open-meteo.com")) {
      calledFallback=true;
      const u=new URL(dest);
      const lat=u.searchParams.get("latitude").split(",");
      assert.deepEqual(lat,["37.975930","37.976180"]); // no 130m rounding
      return {ok:true,json:async()=>({elevation:[111.5,112.25]})};
    }
    throw Error("Unexpected test endpoint");
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const messages=[];
  const summary=await assignNodeElevations(nodes,m=>messages.push(m));
  assert.equal(summary.provider,"Open-Meteo fallback");
  assert.equal(summary.count,2);
  assert.equal(calledFallback,true);
  assert.deepEqual(nodes.map(n=>n.elevation),[111.5,112.25]);
  assert.ok(messages.some(s=>s.includes("tiles unavailable")));
});

test("missing fallback elevation rejects and does not partially mutate the graph", async (t) => {
  const originalFetch=globalThis.fetch;
  const nodes=[{lat:37.97591,lng:23.73931,elevation:null}];
  globalThis.fetch=async (url)=>{
    if (String(url).includes("tiles.mapterhorn.com")) return {ok:false,status:503};
    return {ok:true,json:async()=>({elevation:[null]})};
  };
  t.after(()=>{globalThis.fetch=originalFetch});
  await assert.rejects(assignNodeElevations(nodes),/Invalid elevation API value/);
  assert.equal(nodes[0].elevation,null);
});
