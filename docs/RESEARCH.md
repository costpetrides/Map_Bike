# Map_Bike: Literature review and mathematical model

Research notes, 19 November 2026. This document describes a model proposal, not a proven or implemented solution.

## Research question

Release a virtual fluid at A on a real road network. Uphill (positive signed grade) must impede spreading; downhill (negative signed grade) must favour spreading. Observe its propagation towards B, and investigate how to extract a route. No model of bicycle speed or cyclist performance is included.

## Related research

1. Burgess & Darken (2004), Realistic Human Path Planning using Fluid Simulation:
   https://faculty.nps.edu/cjdarken/pubs/Burgess_Darken_BRIMS04-v2.pdf
   Gas diffusion over digital terrain; source, sink, terrain-dependent exchange, near-steady gradients and path extraction. Their reported paths averaged 13% slower than their A* reference in the tested terrain samples (Section 5.1). Their approach is not first-contact routing and does not explicitly encode the directional uphill/downhill drift proposed here.
2. Advection, diffusion and delivery over a network (2012):
   https://pmc.ncbi.nlm.nih.gov/articles/PMC4026276/
   Transport PDEs on connected 1-D network edges.
3. Tero, Kobayashi & Nakagaki (2006), Physarum solver: a biologically inspired method of road-network navigation:
   https://www.sciencedirect.com/science/article/pii/S0378437106000963
   Related fluid-network algorithm, not the same as signed-elevation diffusion.
4. Tero et al. (2007), A mathematical model for adaptive transport network in path finding by true slime mold:
   https://www.sciencedirect.com/science/article/pii/S002251930600289X
5. Crane et al. (2013), Geodesics in Heat:
   https://www.cs.cmu.edu/~kmcrane/Projects/HeatMethod/
   Distance calculation uses heat flow with additional processing; ordinary first-contact diffusion is not enough.
6. Some free boundary problems involving non-local diffusion and aggregation (2015):
   https://pmc.ncbi.nlm.nih.gov/articles/PMC4535263/
   Explains finite-speed fronts in porous-medium-type nonlinear diffusion.
7. A Bio-Inspired Fluid Dynamics Approach for Unified and Efficient Path Planning and Control (2026):
   https://www.mdpi.com/2076-0825/15/3/133
   Artificial fluid field + sampled/graph-selected trajectories, not our proposed road/elevation model.
8. Propagating radial waves of travel cost in a grid (2010):
   https://www.tandfonline.com/doi/full/10.1080/13658811003779152
   Impedance-sensitive propagation as a non-diffusion alternative.

## Commercial / product comparisons (not confirmed to use this method)

- Cyclers Tech: https://cyclers.tech/docs/ ; explicit hilliness preferences.
- GraphHopper: https://www.graphhopper.com/maps-route-planner/ ; elevation-aware cycle navigation.
- BRouter: https://docs.bikerouter.de/en/costs/ ; uphill/downhill-dependent cost and elevation filtering.
- Komoot: https://support.komoot.com/hc/en-us/articles/10384661449626-Planning-Routes-FAQ ; OSM/elevation-informed cycle routing.

None was verified to use the precise elevation-biased diffusion + first arrival method. No novelty claim is made.

## Model A: linear elevation-biased diffusion on roads

Treat each road edge e as a one-dimensional interval parameterised by arc length s in [0,L_e]. Let c_e(s,t) be virtual-fluid concentration, z_e(s) be elevation, D_e>0 be diffusivity, and mu_e>0 be a terrain-drift parameter.

Mass conservation:

$$
\partial_t c_e = -\partial_s J_e
$$

Flux model:

$$
J_e=-D_e\partial_s c_e-\mu_e c_e\partial_s z_e.
$$

Therefore:

$$
\boxed{\partial_t c_e=\partial_s(D_e\partial_s c_e+\mu_e c_e\partial_s z_e)}
$$

- Uphill in the positive-s direction: z_s>0, terrain-directed flux is negative.
- Downhill: z_s<0, terrain-directed flux is positive.
- Flat: z_s=0, pure diffusion.
- D units: m^2/s; mu units: m/s for z and s measured in metres.
- This is **drift, not inertial acceleration**. An actual velocity acceleration law requires momentum dynamics.
- At junctions: mass conservation (Kirchhoff flux balance), along with appropriate concentration continuity assumptions.
- At A: initially localised mass or specified source flux. At B: monitor concentration or cumulative absorbed mass.

### Critical first-arrival caveat

Linear diffusion is parabolic and has immediate nonzero tails on accessible connected nodes. Strictly, first nonzero contact at B is at t=0+, so it cannot be used as a finite arrival-time objective. An operational threshold could instead be defined by

$$
t_\varepsilon=\inf\{t\ge0:M_B(t)\ge\varepsilon M_0\},\quad 0<\varepsilon<1
$$

where M_B(t) is the total mass collected by an absorbing B and M_0 is initial mass. Threshold time depends on concentration, route splitting and parameters. It does not prove shortest path or identify a unique route.

## A matrix prototype for efficient numerical simulation

Subdivide road segments to approximate uniform spacing ell and elevation samples z_i. Define the proposed positive directed transition rates

$$
k_{ij}=\frac{D}{\ell_{ij}^{2}}\exp\left[-\frac{\beta}{2}(z_j-z_i)\right],\qquad \beta>0,\quad [\beta]=\mathrm{m}^{-1}.
$$

For equal length and D, moving uphill i->j gives k_ij<k_ji; downhill the reverse. In a refined regular-cell limit, beta corresponds to a biased drift strength. The relation is a proposed test model, not an empirically calibrated material law.

Set Q_ij=k_ij for i!=j, Q_ii=-sum_j k_ij, and make B absorbing (no outward transitions). For column vector of node masses m:

$$
\frac{d\mathbf m}{dt}=Q^{\mathsf T}\mathbf m,\qquad
\mathbf m^{n+1}=\mathbf m^n+\Delta t Q^{\mathsf T}\mathbf m^n.
$$

The explicit step is nonnegative if Delta t <= 1/max_i(sum_{j!=i} k_ij), where the maximum is over nonzero outgoing rows. The formulation conserves total mass including the absorbing B. The component m_B(t) records the absorbed mass fraction for initial total mass 1.

Implementation can use a sparse Q, one loop over time and vectorised sparse matrix-vector products, without spatial nested loops. Strict positivity for all t>0 also occurs with this continuous-time master equation on any reachable target, reinforcing the first-contact caveat.

A route is NOT determined by the total mass alone. A separate path extraction rule must be specified and validated; using first-threshold activation and predecessor recording is a heuristic, not a proven minimum.

## Model B: finite-speed nonlinear front (second phase)

To preserve an actual initially compact front, investigate degenerate diffusion:

$$
\partial_t c=\partial_s\left[D_0\partial_s(c^m)+\mu c\partial_s z\right],\quad m>1.
$$

Porous-medium nonlinear diffusion can support finite propagation speeds. A mathematically meaningful front-contact time may then be defined, subject to compatible edge/junction conditions. This still does not guarantee that the first-contact route is a global minimum-cost path.

## Controlled validation

1. Simple graph with two A->B routes: level route vs climb and descent.
2. Reverse A and B; verify uphill/downhill asymmetry.
3. Flat elevation (beta=0): recover unbiased diffusion.
4. Check mass conservation, nonnegativity, mesh convergence and time-step convergence.
5. Sweep beta, D, and epsilon; test whether chosen route is stable.
6. Define and evaluate candidate path extraction, including counterexamples where a flux-following path is not optimal.
7. Compare to a graph shortest-path reference using an explicitly defined surrogate edge cost, without claiming it is measured cyclist travel time.
8. If necessary, test nonlinear finite-front model rather than thresholding linear diffusion.
9. Only then import real roads and signed grades using OSMnx: https://osmnx.readthedocs.io/en/stable/index.html and https://osmnx.readthedocs.io/en/stable/internals-reference.html .

This file documents hypotheses and existing research; implementation and claims of optimality require numerical and mathematical verification.
