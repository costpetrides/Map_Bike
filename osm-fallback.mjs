const API_URL = "https://api.openstreetmap.org/api/0.6/map";
const LAT_LIMIT = 0.013;
const LON_LIMIT = 0.017;
const AREA_LIMIT = 0.00012;  // small, explicitly user-requested research corridor only
const MAX_ELEMENTS = 95000;

// The core OSM editing API is not a production read-only map service. This
// limited fallback is intentionally enabled only for tiny areas when Overpass
// is unavailable. A supported/hosted extracts backend is needed for scale.
export function fallbackBounds(corridor) {
  const numbers = corridor.poly.split(/\s+/).map(Number);
  if (numbers.length !== 8 || numbers.some(v => !Number.isFinite(v)))
    throw Error("Invalid road-search polygon");
  const lats = [numbers[0],numbers[2],numbers[4],numbers[6]];
  const lngs = [numbers[1],numbers[3],numbers[5],numbers[7]];
  const south=Math.min(...lats),north=Math.max(...lats);
  const west=Math.min(...lngs),east=Math.max(...lngs);
  if ((north-south)>LAT_LIMIT || (east-west)>LON_LIMIT ||
      (north-south)*(east-west)>AREA_LIMIT) return null;
  return { south,north,west,east };
}

export function parseOsmXml(xmlText) {
  if (typeof DOMParser === "undefined") throw Error("Browser XML parser unavailable");
  const xml = new DOMParser().parseFromString(xmlText,"application/xml");
  if (xml.querySelector("parsererror")) throw Error("Invalid XML from OSM data service");
  return parseOsmDocument(xml);
}

export function parseOsmDocument(xml) {
  const wayElements = Array.from(xml.getElementsByTagName("way"));
  const ways = [], needed = new Set();
  for (const el of wayElements) {
    const tags={};
    for (const child of el.getElementsByTagName("tag")) tags[child.getAttribute("k")]=child.getAttribute("v");
    if (!tags.highway) continue;
    const refs = Array.from(el.getElementsByTagName("nd")).map(n=>Number(n.getAttribute("ref")));
    if (refs.length<2 || refs.some(n=>!Number.isSafeInteger(n))) continue;
    for(const ref of refs)needed.add(ref);
    ways.push({type:"way",id:Number(el.getAttribute("id")),nodes:refs,tags});
  }
  if (!ways.length) throw Error("Fallback area contains no road data");
  const nodes=[];
  for (const el of xml.getElementsByTagName("node")) {
    const id=Number(el.getAttribute("id"));
    if (!needed.has(id)) continue;
    const lat=Number(el.getAttribute("lat")),lon=Number(el.getAttribute("lon"));
    if (Number.isFinite(lat)&&Number.isFinite(lon))nodes.push({type:"node",id,lat,lon});
  }
  if (nodes.length+ways.length>MAX_ELEMENTS)throw Error("Fallback area has too many elements");
  return {elements:[...nodes,...ways], source:"OpenStreetMap small-area fallback"};
}

export async function getSmallAreaRoads(corridor, signal) {
  const bounds=fallbackBounds(corridor);
  if (!bounds) throw Error("Area too wide for small-area fallback");
  const url = new URL(API_URL);
  url.searchParams.set("bbox", [bounds.west,bounds.south,bounds.east,bounds.north].map(v=>v.toFixed(6)).join(","));
  const signals=[AbortSignal.timeout(22000)];
  if(signal)signals.push(signal);
  const response=await fetch(url.toString(),{signal:AbortSignal.any(signals)});
  if(!response.ok)throw Error(`OpenStreetMap small-area API HTTP ${response.status}`);
  const xml=await response.text();
  if (xml.length>18000000)throw Error("Fallback response too large");
  return parseOsmXml(xml);
}
