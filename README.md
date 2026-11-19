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

### How to use

1. Click the map to set point **A**.
2. Click a second point to set **B**. Alternatively select the Athens example.
3. Select **Load road network**. The app fetches permitted OpenStreetMap roads and 90 m terrain elevation samples from Open-Meteo / Copernicus.
4. Press **Start diffusion**. The line colours update as the concentration spreads. Pause and resume, adjust animation speed, or reset.
5. When the numerical concentration threshold at B is reached, the simulation pauses and highlights a heuristic predecessor trace (when one can be reconstructed).

Select A or B again to change points. For this proof of concept they must be **80 metres to 2.2 km apart**. Large networks and public service outages may cause an explicit loading error.

### Physical model and important qualifications

The state evolves on the road network via a spatial finite-volume analogue of

$$
\partial_t c=\partial_s\left[D_0\partial_s(c^2)+\mu c\,\partial_s z\right].
$$

The sign of elevation grade biases the flow uphill or downhill. In the current solver, the source at A is a **replenished reservoir**, not a one-time pulse. Each road segment is spatially approximated by the downloaded graph and the numerical time is in **model units**.

For visible arrival the prototype uses a **finite concentration threshold** at B. This is an operational detection rule, not the exact mathematical free-boundary contact. The orange trace is derived heuristically from predecessor fluxes: it is **not** a demonstrated shortest or fastest route. Before use as actual routing or any research claim, the solver requires mesh and timestep convergence checks, junction verification and further validation.

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
