# Map_Bike — Live Elevation-Driven Diffusion

A browser prototype of nonlinear diffusion with downhill drift on actual roads. Choose two points A and B on a map and watch a virtual concentration front spread through an OpenStreetMap street network. The model does not include cyclist speed, rider effort or bicycle physics.

## Launch the interactive app

The interactive entry point is `index.html`. It works as a static website: no build step, API key or backend is required.

**GitHub Pages (one-time setup by repository owner):** Go to **Settings → Pages → Build and deployment → Deploy from a branch**, select the **main** branch and the root folder, then Save. After GitHub Pages has deployed, the intended URL will be:

https://costpetrides.github.io/Map_Bike/

Until Pages is configured, use a local server:

```bash
git clone https://github.com/costpetrides/Map_Bike.git
cd Map_Bike
python3 -m http.server 8000
```

Open http://localhost:8000 in your browser. Opening `index.html` as a `file://` URL may block ES modules.

### Map appearance: Dark only

The app uses the **OpenFreeMap Dark** vector basemap only. There is no basemap switch or locally remembered light preference. If WebGL or the vector-tile service is unavailable, the OpenStreetMap raster fallback is restyled dark. The simulated fluid remains blue-to-turquoise, and the inferred trace remains green.

- Map data © OpenStreetMap contributors; vector tiles © OpenFreeMap. Attribution remains visible.
- MapLibre and its Leaflet adapter are loaded from pinned CDN versions.
- Map appearance tests: `tests/map-style.test.mjs`.

### Faster animation (November 2026)

- The default speed is **10×**, and the speed slider runs from **1× to 40×**.
- The Web Worker uses longer computation batches and yields with minimal artificial delay at normal and high speeds. Rendering updates roughly every 65 ms instead of 90 ms.
- The numerical update equations, direction restrictions, and 10 km road-distance cap are unchanged. Actual speedup depends on road density and device performance.

### How to use

1. Click the map to set point **A**.
2. Click a second point to set **B**. Alternatively select the Athens example.
3. Select **Load road network**. The app fetches permitted OpenStreetMap roads and 90 m terrain elevation samples from Open-Meteo / Copernicus.
4. Press **Start diffusion**. The line colours update as the concentration spreads. Pause and resume, adjust animation speed, or reset.
5. When the numerical concentration threshold at B is reached, the simulation pauses and highlights a heuristic predecessor trace (when one can be reconstructed).

Select A or B again to change points. For this proof of concept they must be **at least 80 metres apart**, with B inside the **10 km straight-line circle** centred on A. The shortest bicycle-permitted road path must independently be **at most 10 km**. A route outside either limit is rejected. Large networks and public service outages may still cause a loading error.

### Road API recovery (19 November 2026)

The previous loader failed after 16 s on each public Overpass endpoint; its `overpass.kumi.systems` host was an alias of `overpass.private.coffee`, so it did not provide an independent backup.

The current version:

- Uses independent providers at `overpass.private.coffee` and `overpass.openstreetmap.fr`, started at different times to avoid a simultaneous surge.
- Allows up to 35 s per request (with a 35 s Overpass server-side limit) and explains whether a provider timed out, returned an HTTP error or failed at the network/CORS layer.
- If the search is confined to a **very small** geographical region, attempts the independent OpenStreetMap API map endpoint as a last-resort fallback. Only roads and their referenced nodes are extracted from the XML, not buildings.
- Cancels other pending requests when a valid response is obtained and reports which provider succeeded in the status panel.
- Keeps the original narrow A–B corridor search, graph connectivity checks, road/elevation caching, and DEM sampling.

**Important:** the public OpenStreetMap core API is primarily intended for map editing rather than repeated read-only extraction. This very small-area fallback is experimental and not a solution for high traffic, large distances or production deployment. A self-hosted extract service or hosted Overpass instance is required for robust long-term use. Public services may still fail or block cross-origin requests. No successful end-to-end Safari/online-API test has been confirmed.

### Longer point-to-point distances (November 2026)

- The old 2.2 km / 25 km experiments are replaced by a **10 km road-route budget**, with a matching **10 km radius from A** drawn on the map. Longer A–B selections use small Overpass road-search corridors about 2.2 km long with overlapping end caps.
- At most **three corridor requests** run concurrently. Their OSM nodes and ways are deduplicated by ID before the usual directed, bicycle-accessible road graph is constructed; one-way rules remain in force.
- The side-margin expansion runs if no connection is found or the only connected path exceeds 10 km. The densified graph has a 14,000-node budget; DEM spacing is adapted to stay within the available node budget.
- Progress reports show completed road sections. Large or highly connected areas may still exceed the browser's graph/DEM budget, and public Overpass or terrain services can fail or rate-limit requests.
- Road range is checked by a shortest-path computation that respects bicycle one-way tags. This distance validation does not make the **fluid-derived green trace** an optimal route. The nonlinear PDE simulation still has a finite time/step budget.

### 10 km simulation optimisation (22 November 2026)

- When point **A** is placed, the map frames its dashed 10 km straight-line circle. Use **Show 10 km range** to return to the full extent after zooming.
- A quick great-circle check rejects B outside this circle. A directed Dijkstra search then validates that the downloaded legal road route is no more than 10 km (one-way restrictions apply).
- The road layer uses **two HTML canvas elements** instead of two Leaflet polylines per segment. A static pass draws roads once per map view; only reached roads receive a dynamic fluid overlay. Rendering is clipped to the viewport and colours are still blue to turquoise.
- The finite-volume solver tracks **active nodes and edges** instead of scanning every dormant road at every timestep. Negligible numerical tails do not expand the active set.
- A **Web Worker** advances the model in time-budgeted slices and transfers display snapshots, keeping the Leaflet map responsive. A main-thread fallback remains for older browsers.
- The animation caps are 800,000 numerical steps and 50,000 model-time units. A route can still take time to simulate; performance is device- and road-network-dependent. Public Overpass/DEM availability is outside the app's control.

### Faster road-data loading (November 2026)

- Road queries now use a 16-second timeout per endpoint. If the first server has not finished after 4 seconds, an alternative endpoint starts without waiting for the first to time out. Requests that lose the race are cancelled.
- The street network appears on the map as soon as roads are downloaded, before all elevation data finishes loading.
- Height samples are grouped on an approximate 130 m grid; requests contain at most 100 coordinate pairs (the elevation API limit) and up to three batches run concurrently.
- Previously retrieved height samples are cached in browser memory for repeated point selections on the same page.
- During loading, **Load road network** changes into **Cancel loading**. A failed or timed-out network request produces a visible error and lets you retry.

The public data services are still external dependencies and may occasionally reject or rate-limit requests. No guaranteed live network availability is implied. DEM sampling is an exploratory approximation.

### Tests

Run the solver and loader tests with:

```bash
node --test tests/*.test.mjs
```

### Location-aware data reduction

The map does **not** download a fixed city-wide region. For each A–B pair it:

1. Builds a four-corner polygon along A–B with a narrow **125–260 m initial side margin**, based on direct separation (not on map zoom). This removes unrelated streets in the corners of large rectangular requests.
2. Requests only road ways inside this polygon, with full tags for eligibility and minimal node geometry. Clips extraneous portions of long roads on the client.
3. Tries larger margins (**2×, then 3.5×**) only if a legal A–B road connection cannot be found. It does *not* unnecessarily broaden the search when a local connection exists.
4. Prunes graph portions unreachable in the permitted travel direction from A **before requesting elevations** or constructing the diffusion solver; other reachable branching streets remain.
5. Caches up to four road responses (same search polygon) and previously requested DEM cells in memory, reducing repeat network requests.

The narrow corridor is an **exploratory performance/coverage tradeoff**. It may omit longer detours and alternatives outside the corridor even when an in-corridor route exists. Accordingly, the simulation is not an exhaustive analysis of every possible A–B route. For a scientifically complete city-wide study, a wider user-controlled region or a boundary-aware expansion strategy is necessary.

Endpoint snapping is restricted to nearby street nodes: a disconnected road hundreds of metres away cannot be silently substituted for B.

### Terrain sampling on roads (November 2026)

The elevation pipeline was revised after comparing the related `costpetrides/map-to-gpx` implementation (`website/src/lib/utils.ts`):

- Start from **OpenStreetMap road edges only**; neither buildings nor a rectangular field of off-road solver cells are constructed.
- Subdivide existing road geometries at approximately **55 m** intervals, retaining their legal connectivity and directions.
- Download only the **Mapterhorn Terrarium-encoded DEM tiles** that contain at least one road sample (512×512 WebP tiles, zoom 12). Each tile covers surrounding buildings/terrain as raster imagery, but elevation values are read **only at sampled road coordinates**.
- Use bilinear interpolation from nearby DEM pixels rather than rounding coordinates to ~130 m as before.
- Reuse tiles in memory and through browser HTTP caching. When tile loading fails, request **exact road-point coordinates** from Open-Meteo as a fallback.
- Reject incomplete/invalid elevation data; **do not silently substitute elevation zero**.
- Display the actual DEM source and number of sampled road points in the sidebar.

The reference implementation is https://github.com/costpetrides/map-to-gpx/blob/main/website/src/lib/utils.ts . The public Mapterhorn tile format and address are documented at https://mapterhorn.com/data-access/ .

**Important scientific limitation:** DEM represents source-dependent terrain/surface elevations, not necessarily the height of road surfaces at bridges, tunnels, multi-level roads, or tightly built-up areas. The raster tiles include surrounding buildings even though the model **does not sample buildings as separate locations**. The current 55 m sample spacing and zoom-12 data may smooth smaller changes in grade; do not interpret them as surveyed roadway profiles.

### Physical model and important qualifications

The state evolves on the road network via a spatial finite-volume analogue of

$$
\partial_t c=\partial_s\left[D_0\partial_s(c^2)+\mu c\,\partial_s z\right].
$$

The sign of elevation grade biases the flow uphill or downhill. In the current solver, the source at A is a **replenished reservoir**, not a one-time pulse. Each road segment is spatially approximated by the downloaded graph and the numerical time is in **model units**.

For visible arrival the prototype uses a **finite concentration threshold** at B. This is an operational detection rule, not the exact mathematical free-boundary contact. The green trace is derived heuristically from predecessor fluxes: it is **not** a demonstrated shortest or fastest route. Before use as actual routing or any research claim, the solver requires mesh and timestep convergence checks, junction verification and further validation.

**Data / access limitations:** OpenStreetMap road connectivity and bike access tags may be incomplete; elevation samples have 90 m resolution and do not capture every small local grade; public Overpass and elevation APIs can rate-limit requests. The map is a research experiment, **not navigation advice**. Open-Meteo's free public API has usage and licensing restrictions, particularly for commercial projects.

### Files

| File | Purpose |
| --- | --- |
| `index.html` | Leaflet interactive map and controls |
| `app.css` | Responsive layout and visual styles |
| `app.mjs` | Map point selection, animation, concentration overlay |
| `network.mjs` | OpenStreetMap roads and elevation API calls |
| `physics.mjs` | Explicit, mass-conservative nonlinear-diffusion approximation |
| `tests/physics.test.mjs` | Signed-grade, mass-accounting, one-way and stopping tests |
| `docs/MATHEMATICAL_MODEL.md` | PDE derivation, conditions and analytical benchmark |
| `docs/RESEARCH.md` | Related scientific publications and research roadmap |

Run the basic solver tests with:

```bash
node --test tests/physics.test.mjs
```

---


## Research question

Can a propagating front, released at a starting point **A**, recover the minimum-travel-time cycling route to a destination **B**, while accounting for terrain elevation and road constraints?

The visual analogy is fluid spreading through a network of roads: the simulation ends once the earliest valid arrival at B is **finalised**, then the corresponding path is reconstructed. **This is a modelling hypothesis, not a claim that real water flow always solves shortest-travel-time routing.**

## Stage 01 — Problem definition

### 1. Geometry and feasible movement

Represent the cycling network as a directed graph \(G=(V,E)\):

- \(V\): junctions, road endpoints, start A and destination B.
- \(E\): legally traversable, directed road segments.
- \(L_e>0\): length of segment \(e\), in metres.
- \(z_i\): elevation at node \(i\), in metres.
- \(s_{ij}=(z_j-z_i)/L_{ij}\): signed road grade along directed edge \((i,j)\).

Direction matters: the same road may be uphill from A to B, but downhill in the reverse direction. One-way restrictions, bicycle access, and legal turns must be respected.

### 2. Quantity to minimise

For a feasible route \(P\) from A to B, define

\[
\tau_e = \frac{L_e}{v_e}, \qquad
T(P)=\sum_{e\in P}\tau_e, \qquad
P^*=\operatorname*{arg\,min}_{P:A\rightarrow B} T(P).
\]

Here \(v_e>0\) denotes the *predicted cycling speed* along edge \(e\), in metres per second, and \(\tau_e\) is traversal time in seconds. Stage 03 will define and justify the dependence \(v_e=f(s_e,\ldots)\), including uphill effort, downhill safety, and any other factors adopted.

**Elevation is not itself a resistance coefficient.** The positive or negative grade modifies cycling effort and feasible speed; an actual physical speed model has yet to be selected.

For the first prototype, edge travel times are assumed fixed during one route computation. Dynamic traffic or time-dependent conditions can be considered later.

### 3. Fluid/front analogy and stopping condition

- Release an abstract front at A at \(T_A=0\).
- On each legal edge, the front takes the predicted cycling time \(\tau_e\) to reach the next node.
- The arrival-time field obeys the minimum-time recurrence

\[
T_j = \min_{(i,j)\in E}\bigl(T_i+\tau_{ij}\bigr).
\]

- Record a predecessor whenever an earlier arrival is found.
- Stop when B's *minimum arrival time is finalised*; trace predecessors backwards from B to A to reconstruct \(P^*\).

With fixed non-negative edge costs, this discrete propagation is mathematically equivalent to a shortest-path computation (for example, Dijkstra). Whether to implement a physical fluid model or a front-propagation model is an open Stage 02 decision.

### 4. What counts as a successful result?

1. The computed route is a valid cycling route from A to B.
2. The route minimises the stated predicted travel-time function, not necessarily distance.
3. The earliest finalised arrival at B agrees with a Dijkstra reference using the **same** edge costs.
4. The complete path, total distance, elevation gain/loss, and predicted travel time can be reported.
5. A visualisation shows the propagating front and resulting path.

### 5. Limitations acknowledged at the outset

- Real water/CFD dynamics do **not** guarantee a bicycle-optimal route because pressure, gravity, mixing, and flow splitting do not directly encode bicycle travel times.
- Grades must be direction-dependent; downhill is not automatically faster without limit.
- Elevation datasets, road-geometry sampling, junction delays, bicycle access, and the cyclist's effort model all affect realism.
- An event-driven front may be terminated at B only after B's minimum arrival has been established, not upon an unverified tentative update.

## Research roadmap

1. **Stage 01 — Define the optimisation problem** (this document).
2. **Stage 02 — Choose the physical analogy:** real fluid dynamics vs. travel-time front propagation.
3. **Stage 03 — Model terrain resistance and cycling speed.**
4. **Stage 04 — Derive mathematical equations and assumptions.**
5. **Stage 05 — Implement the numerical propagation and path reconstruction.**
6. **Stage 06 — Validate against a shortest-path reference on controlled examples.**
7. **Stage 07 — Integrate real road/elevation data and map-based visualisation.**

## Current status

Stage 01: initial draft. No routing algorithm, physical flow equation, or elevation-resistance formula has been implemented or finalised.
