# Map_Bike — Fluid-Inspired Bicycle Route Optimisation

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
