# Map_Bike — Mathematical Model v1: Elevation-Driven Nonlinear Diffusion

**Research stage:** Mathematical formulation, analytical benchmark and boundary conditions.  
**Date:** 19 November 2026  
**Status:** Model proposal; no numerical implementation and no proof of global optimality.

## 1. Aim and modelling assumptions

Consider a **virtual substance**, released at a point A, that propagates only along permitted roads. Its propagation is impeded by uphill signed grade and enhanced by downhill signed grade. Monitor the free boundary and stop at its **first contact** with a destination B.

The model does **not** use bicycle speed, cyclist power, bicycle mechanics, measured traffic speed or inferred travel-time weights. Its time variable is time in the virtual diffusion model.

Represent the road geometry as a **metric graph** G=(V,E). Each edge e has an arc-length coordinate s in [0,L_e] and an elevation profile z_e(s). We do not diffuse across buildings or off-road terrain.

Let:
- c_e(s,t) >= 0: virtual-substance mass per unit road length (M/L);
- J_e(s,t): signed mass flow (M/T);
- D_0 > 0: nonlinear diffusion coefficient;
- mu > 0: elevation-driven mobility;
- m > 1: porous-medium exponent;
- z_e(s): elevation (L).

Dimensional consistency, with [c]=M/L:
- [D_0] = L^2 / (T [c]^(m-1));
- [mu] = L/T because dz/ds is dimensionless.

## 2. Derivation from local conservation

Over an interval [s_1,s_2], conservation (no distributed sources) gives

$$
\frac{d}{dt}\int_{s_1}^{s_2}c_e(s,t)\,ds
=J_e(s_1,t)-J_e(s_2,t).
$$

Therefore

$$
\partial_t c_e+\partial_s J_e=0.
$$

Choose two flux mechanisms:

$$
J_e^{\rm diff}=-D_0\,\partial_s(c_e^m),
\qquad
J_e^{\rm elev}=-\mu c_e\,\partial_s z_e.
$$

Thus the model PDE is

$$
\boxed{\partial_t c_e
=\partial_s\left[D_0\,\partial_s(c_e^m)
+\mu c_e\,\partial_s z_e\right],\quad m>1.}
\tag{1}
$$

This is a **porous-medium equation with potential drift**, not the incompressible Navier–Stokes equations. The elevation term biases transport down the gradient of elevation. It is a directional drift effect, not a physical inertial acceleration of an individual particle.

## 3. Signed-grade consequences

For a straight edge with constant signed grade

$$
z(s)=z_0+qs,\qquad q=(z(L)-z(0))/L,
$$

we have z_s=q and z_ss=0, so (1) reduces to

$$
\partial_t c=D_0\partial_{ss}(c^m)+\mu q\partial_s c
=D_0\partial_{ss}(c^m)-a\partial_s c
$$

with

$$
\boxed{a=-\mu q.}
\tag{2}
$$

- Uphill when moving in increasing s: q>0, a<0 (drift opposes motion).
- Flat: q=0, a=0 (pure porous-medium diffusion).
- Downhill: q<0, a>0 (drift assists motion).

Reversing edge orientation changes the signs of both grade and drift, giving consistent directional physics.

## 4. Free-boundary motion

Define pressure variable

$$
p=\frac{m D_0}{m-1}c^{m-1}.
$$

Because c p_s = D_0 (c^m)_s, flux (1) can be written

$$
J=-c\,\partial_s(p+\mu z)=c\,v,
\qquad
v=-p_s-\mu z_s.
$$

For a sufficiently regular advancing free boundary s=s_f(t), its formal interface velocity is

$$
\boxed{\dot s_f(t)=-p_s(s_f^-,t)-\mu z_s(s_f).}
\tag{3}
$$

The equation's degeneracy at c=0 allows compact support and a finite front speed under suitable assumptions. The interface condition is formal at rough junctions and singular events.

This relation is not an inertial law: a stronger downhill drift can make the front advance faster, but the model does not compute d(velocity)/dt from Newtonian dynamics.

## 5. Exact one-edge analytical verification for m=2

Take the whole real line, constant slope q, coefficient D_0>0 and an initially concentrated mass M_0 at s=0 (fundamental solution). For m=2, let a=-mu q.

The PDE is

$$
c_t=D_0(c^2)_{ss}-a c_s.
$$

Transform to xi=s-a t, so c(s,t)=w(xi,t). Then the drift disappears and

$$
w_t=D_0(w^2)_{\xi\xi}.
$$

An exact source-type weak solution is

$$
\boxed{
c(s,t)=t^{-1/3}\left[
A-\frac{(s-a t)^2}{12D_0 t^{2/3}}
\right]_+,
\quad t>0,
}
\tag{4}
$$

where [u]_+=max(u,0) and

$$
A=\left(\frac{3M_0}{4\sqrt{12D_0}}\right)^{2/3}.
$$

To check: insert the similarity profile w=t^(-1/3) F(xi/t^(1/3)), F(y)=A-y^2/(12D_0) on its support. The coefficients of the constant and quadratic terms match in the PDE. Integrating the profile yields mass M_0 at every time.

Consequently its right and left support boundaries are

$$
\boxed{
s_\pm(t)=a t\pm (9D_0M_0t)^{1/3}.
}
\tag{5}
$$

The front toward +s is

$$
s_+(t)=-\mu q t+(9D_0M_0t)^{1/3}.
$$

**Analytical conclusion:** For identical D_0, mu and M_0 at a fixed t, a downhill q<0 increases the right-front position relative to flat; an uphill q>0 decreases it.

### Dimensionless demonstration (infinite straight edge)

Set D_0=0.02, mu=0.4, M_0=1 and place the target at L=1. These are **illustrative dimensionless parameters, not empirically calibrated times or distances**. Solve the equation

$$
1=-\mu q t+(9D_0M_0t)^{1/3}.
$$

For signed grade q:
- q=-0.05 (downhill): first contact t_B ≈ 4.2546.
- q= 0.00 (flat): first contact t_B = 5.5556.
- q=+0.05 (uphill): first contact t_B ≈ 9.2396.

The uphill profile in this infinite-line instantaneous-release example can later recede due to the constant opposing drift, so t_B means **first** positive contact, not permanent inundation. For strong enough uphill drift the front may never reach the target; a continuous source at A is a different experiment.

This closed-form test is only valid on an unbranched, effectively unbounded edge with **constant** elevation grade and instantaneous point-mass initial data. On a finite road graph, junctions and endpoint conditions change the solution.

## 6. Initial condition and vertex/boundary conditions

### Initial release

For actual simulation on a metric graph, use a smooth or piecewise compact non-negative bump concentrated near A:

$$
c_e(s,0)=C\left[1-\left(\frac{d_G(A,s)}{r_0}\right)^2\right]_+^2,
$$

where d_G is arc-length shortest distance along the graph (only used to initialise the release), r_0 is small, and C is chosen so

$$
\sum_e\int_0^{L_e} c_e(s,0)\,ds=M_0.
$$

There is **no continuing injection** for this first experiment. Alternatively a source flux at A could be used, but must not be mixed into this model without updating the mass balance.

### Road junctions

At each ordinary junction v, impose concentration continuity

$$
c_e(v,t)=c_v(t)\qquad(e\sim v)
$$

and conservation of flux:

$$
\boxed{\sum_{e\sim v}J^{\rm out}_{e}(v,t)=0.}
\tag{6}
$$

Here J_out is oriented outward from the vertex along each incident road. These are standard-style coupling assumptions on metric graphs, but their detailed weak solution/numerical enforcement needs checking for degenerate nonlinear diffusion.

### Other endpoints

At dead-end road endpoints, use reflecting/no-flux conditions J_out=0.

### Target B

For the first experiment B is only a *monitored location*, not a concentration-clamped sink. Stop at the first mathematical contact:

$$
\boxed{
t_B=\inf\{t>0:B\in\operatorname{supp}c(\cdot,t)\}.
}
\tag{7}
$$

This becomes meaningful for the nonlinear finite-support model under suitable assumptions. In computation, use a converged front location/positivity tolerance rather than treating solver roundoff as mathematical contact.

If B is made absorbing later, its flux and boundary conditions must be redesigned.

## 7. What this mathematical model proves — and does not

For the single straight slope test, the exact solution gives a **rigorous model-specific ordering**: downhill first, flat second, uphill last, provided each front reaches the chosen target in the compared regime.

**It does not prove** that the first B-contact on a branched graph corresponds to an optimally weighted A-to-B route. The nonlinear front depends on M_0, spreading through competing branches and intersection boundary conditions; a unique 'path taken by the fluid' need not exist. Path extraction and optimality are distinct tasks.

For the numerical stage, investigate edgewise finite volumes:

$$
\frac{d c_i}{dt}=-\frac{J_{i+1/2}-J_{i-1/2}}{h},
$$

with numerical face flux

$$
J_{i+1/2}=
-D_0\frac{c_{i+1}^m-c_i^m}{h}
+v_{i+1/2}c_{i+1/2}^{up},
\quad
v_{i+1/2}=-\mu\frac{z_{i+1}-z_i}{h}.
$$

Choose c_up=c_i when v_face>=0, and c_up=c_{i+1} otherwise. This gives conservative face fluxes, with a suitably chosen stable nonnegative time integration method; conservation at graph vertices must be implemented separately.

## 8. Verification gates before real-world maps

1. Derive/verify the closed-form profile (4) and front locations (5).
2. Validate 1-D finite-volume numerical solutions against the exact m=2 profile for uphill/flat/downhill.
3. Check mass conservation, nonnegativity, finite support/front convergence.
4. Test A-B reversed orientation, and a simple Y-shaped junction.
5. Test different release masses M_0, diffusivities D_0 and mobilities mu.
6. Explicitly test how a reconstructed path depends on branching, and whether 'first contact' alone can identify a route.
7. Only then use OSM road graphs with elevations.

## References

- Kim, I. & Zhang, Y. P., *Porous Medium Equation with A Drift: Free Boundary Regularity*: https://arxiv.org/abs/1812.08770
- *The Porous Medium Equation in 1D* and Barenblatt benchmark, ESAIM M2AN: https://www.numdam.org/item/10.1051/m2an/2021080.pdf
- *Porous medium equations with reactions on a metric graph* (junction conditions; different source terms): https://www.aimsciences.org/article/doi/10.3934/dcdsb.2026079
- *Semigroups for dynamical processes on metric graphs* (continuity and Kirchhoff coupling): https://pmc.ncbi.nlm.nih.gov/articles/PMC7658743/
- *Realistic Human Path Planning using Fluid Simulation*, Burgess & Darken (2004): https://faculty.nps.edu/cjdarken/pubs/Burgess_Darken_BRIMS04-v2.pdf
