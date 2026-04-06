# Dual-Particle Upgrade Guide

> **Source:** [Copilot deep research task — azzamunza/mobile-fluid-sim](https://github.com/azzamunza/mobile-fluid-sim/tasks/49e89323-8190-4e44-8338-95921efc4782)

---

## Overview

This guide describes all changes required to add a **secondary particle type** to `mobile-fluid-sim` with the following properties compared to the existing water particles:

| Property | Water (type 0) | Secondary (type 1) |
|---|---|---|
| Surface tension (self-cohesion) | Normal | **Stronger** |
| Interaction with water | Normal | **Hydrophobic (repulsive)** |
| Buoyancy / effective gravity | Normal | **Greater upward force** |
| Visual color | `fluidColor` prop | New configurable color |

The simulator is a **FLIP (Fluid-Implicit-Particle)** solver: a MAC grid carries velocities and pressure, while particles act as Lagrangian tracers that carry velocity corrections and color. The core solver lives in four files:

| File | Role |
|---|---|
| `src/lib/fluid/FlipFluid.ts` | Core FLIP solver — all physics |
| `src/lib/fluid/FluidScene.ts` | Scene / particle initialization |
| `src/lib/fluid/FluidRenderer.ts` | WebGL rendering |
| `src/lib/FluidSimulation.svelte` | Svelte component & animation loop |

---

## Assumptions and Limitations

- The upgrade targets a **single shared velocity grid**. This means both fluids are advected by the same pressure-solved velocity field — they will interact hydrodynamically but will not have separate pressure fields.
- True immiscibility at high densities requires a full **two-phase pressure solve** (out of scope here). The approach below gives strong *visual* separation through explicit inter-particle repulsion and per-type buoyancy.
- All changes are backward-compatible: existing behavior is preserved when `numSecondaryParticles = 0`.

---

## File Map

```
src/lib/fluid/
  FlipFluid.ts       ← Primary changes (particle type array, forces, buoyancy)
  FluidScene.ts      ← Secondary particle spawning
  FluidRenderer.ts   ← No structural changes needed (color is per-particle already)
src/lib/
  FluidSimulation.svelte  ← Expose new props for secondary fluid
```

---

## Implementation Plan

### Step 1 — Add `particleType` array to `FlipFluid`

**File:** `src/lib/fluid/FlipFluid.ts`

Add a typed array alongside the existing particle arrays to store an integer type identifier (`0` = water, `1` = secondary) for every particle slot.

**In the class body (after `numParticles: number;`):**

```ts
// Particle type: 0 = water, 1 = secondary fluid
particleType: Int8Array;
```

**In the constructor (after `this.particleVel` allocation):**

```ts
this.particleType = new Int8Array(this.maxParticles);
// default 0 (water) — no explicit fill needed because Int8Array zero-initializes
```

---

### Step 2 — Add per-type material parameters

**File:** `src/lib/fluid/FlipFluid.ts`

Add the following properties to the class and constructor signature to drive the new behaviors:

```ts
// Per-type buoyancy scale (multiplies gravityY for upward correction)
// type-1 particles feel reduced downward gravity → more buoyancy
secondaryGravityScale: number;   // e.g. 0.3 (30% of normal gravity)

// Cohesion radius multiplier for same-type (type-1) pairs
// > 1.0 → secondary particles attract each other more
secondaryCohesionScale: number;  // e.g. 1.4

// Repulsion radius multiplier for cross-type (0–1) pairs
// > 1.0 → water and secondary repel each other more
crossTypeRepulsionScale: number; // e.g. 1.6
```

Pass these in the constructor as optional parameters with sensible defaults:

```ts
constructor(
    density: number,
    width: number,
    height: number,
    spacing: number,
    particleRadius: number,
    maxParticles: number,
    baseColor?: { r: number; g: number; b: number },
    foamColor?: { r: number; g: number; b: number },
    colorDiffusionCoeff: number = 0.01,
    foamReturnRate: number = 1.0,
    secondaryGravityScale: number = 0.3,
    secondaryCohesionScale: number = 1.4,
    crossTypeRepulsionScale: number = 1.6
) {
    // ... existing body ...
    this.secondaryGravityScale = secondaryGravityScale;
    this.secondaryCohesionScale = secondaryCohesionScale;
    this.crossTypeRepulsionScale = crossTypeRepulsionScale;
}
```

---

### Step 3 — Per-type buoyancy in `integrateParticles`

**File:** `src/lib/fluid/FlipFluid.ts` — method `integrateParticles`

The current implementation applies the same `gravityY` to every particle. Modify it to apply a reduced (or reversed) gravity to type-1 particles, giving them higher buoyancy:

```ts
integrateParticles(dt: number, gravityX: number, gravityY: number, damping: number): void {
    for (let i = 0; i < this.numParticles; i++) {
        // Scale gravity for secondary particles (lower gravity = more buoyancy)
        const gScale = this.particleType[i] === 1 ? this.secondaryGravityScale : 1.0;

        this.particleVel[2 * i]     += dt * gravityX;
        this.particleVel[2 * i + 1] += dt * gravityY * gScale;

        this.particleVel[2 * i]     *= damping;
        this.particleVel[2 * i + 1] *= damping;

        this.particlePos[2 * i]     += this.particleVel[2 * i]     * dt;
        this.particlePos[2 * i + 1] += this.particleVel[2 * i + 1] * dt;
    }
}
```

> **Tuning note:** `secondaryGravityScale = 0.0` makes type-1 particles weightless; negative values make them actively rise. Start around `0.3` and adjust visually.

---

### Step 4 — Type-aware inter-particle forces in `pushParticlesApart`

**File:** `src/lib/fluid/FlipFluid.ts` — method `pushParticlesApart`

This is the most important change. The existing method separates overlapping particles using a fixed minimum distance (`2 * particleRadius`). Extend it to:

- **Same-type (1–1) pairs:** use a *smaller* effective separation distance (particles are allowed to stay closer → they cluster together, mimicking strong self-cohesion / surface tension).
- **Cross-type (0–1) pairs:** use a *larger* effective separation distance (particles push further apart → hydrophobic repulsion).

Replace the constant `minDist` / `minDist2` with pair-specific values inside the inner loop:

```ts
pushParticlesApart(numIters: number): void {
    const colorDiffusionCoeff = this.colorDiffusionCoeff;
    const baseMinDist = 2.0 * this.particleRadius;

    // ... spatial hash build (unchanged) ...

    for (let iter = 0; iter < numIters; iter++) {
        for (let i = 0; i < this.numParticles; i++) {
            const px = this.particlePos[2 * i];
            const py = this.particlePos[2 * i + 1];
            const typeI = this.particleType[i];

            // ... cell neighborhood lookup (unchanged) ...

            for (let j = first; j < last; j++) {
                const id = this.cellParticleIds[j];
                if (id === i) continue;

                const typeJ = this.particleType[id];
                const qx = this.particlePos[2 * id];
                const qy = this.particlePos[2 * id + 1];
                const dx = qx - px;
                const dy = qy - py;

                // Determine effective minimum distance based on type pair
                let effectiveMinDist: number;
                if (typeI === 1 && typeJ === 1) {
                    // Secondary–secondary: allow closer packing (strong cohesion)
                    effectiveMinDist = baseMinDist / this.secondaryCohesionScale;
                } else if (typeI !== typeJ) {
                    // Water–secondary: push further apart (hydrophobic)
                    effectiveMinDist = baseMinDist * this.crossTypeRepulsionScale;
                } else {
                    // Water–water: normal
                    effectiveMinDist = baseMinDist;
                }

                const minDist2 = effectiveMinDist * effectiveMinDist;
                const d2 = dx * dx + dy * dy;
                if (d2 > minDist2 || d2 === 0.0) continue;

                const d = Math.sqrt(d2);
                const s = 0.5 * (effectiveMinDist - d) / d;
                const deltaX = dx * s;
                const deltaY = dy * s;

                this.particlePos[2 * i]      -= deltaX;
                this.particlePos[2 * i + 1]  -= deltaY;
                this.particlePos[2 * id]     += deltaX;
                this.particlePos[2 * id + 1] += deltaY;

                // Color mixing: only mix particles of the same type
                if (typeI === typeJ) {
                    for (let k = 0; k < 3; k++) {
                        const color0 = this.particleColor[3 * i  + k];
                        const color1 = this.particleColor[3 * id + k];
                        const color  = (color0 + color1) * 0.5;
                        this.particleColor[3 * i  + k] = color0 + (color - color0) * colorDiffusionCoeff;
                        this.particleColor[3 * id + k] = color1 + (color - color1) * colorDiffusionCoeff;
                    }
                }
            }
        }
    }
}
```

> **Why this works:** A larger effective separation distance forces cross-type particles apart on every `pushParticlesApart` iteration, replicating the visual effect of hydrophobic repulsion. A smaller effective distance for same-type pairs permits them to clump together naturally, mimicking cohesion / surface tension.

---

### Step 5 — Per-type foam / base color in `updateParticleColors`

**File:** `src/lib/fluid/FlipFluid.ts` — method `updateParticleColors`

Add a second set of base/foam colors for type-1 particles. Expose `secondaryBaseColor` and `secondaryFoamColor` as class properties (similar to `baseColor` / `foamColor`):

```ts
// Per-type colors (initialized in constructor; defaults below)
secondaryBaseColor: { r: number; g: number; b: number };  // default: { r: 1.0, g: 0.7, b: 0.1 }
secondaryFoamColor: { r: number; g: number; b: number };  // default: { r: 1.0, g: 0.95, b: 0.7 }
```

Initialize them in the constructor (defaults to a warm amber for visibility):

```ts
this.secondaryBaseColor = { r: 1.0, g: 0.7, b: 0.1 };
this.secondaryFoamColor = { r: 1.0, g: 0.95, b: 0.7 };
```

Update `updateParticleColors` to use the correct color set per particle type:

```ts
updateParticleColors(dt: number): void {
    const h1 = this.fInvSpacing;
    const t = Math.max(0, Math.min(1, this.foamReturnRate * dt));

    for (let i = 0; i < this.numParticles; i++) {
        const isSecondary = this.particleType[i] === 1;
        const base  = isSecondary ? this.secondaryBaseColor  : this.baseColor;
        const foam  = isSecondary ? this.secondaryFoamColor  : this.foamColor;

        const x  = this.particlePos[2 * i];
        const y  = this.particlePos[2 * i + 1];
        const xi = clamp(Math.floor(x * h1), 1, this.fNumX - 1);
        const yi = clamp(Math.floor(y * h1), 1, this.fNumY - 1);
        const cellNr = xi * this.fNumY + yi;

        let applyFoam = false;
        const d0 = this.particleRestDensity;
        if (d0 > 0.0) {
            const relDensity = this.particleDensity[cellNr] / d0;
            if (relDensity < 0.7) applyFoam = true;
        }

        if (applyFoam) {
            this.particleColor[3 * i]     = foam.r;
            this.particleColor[3 * i + 1] = foam.g;
            this.particleColor[3 * i + 2] = foam.b;
        } else {
            const cr = this.particleColor[3 * i];
            const cg = this.particleColor[3 * i + 1];
            const cb = this.particleColor[3 * i + 2];
            this.particleColor[3 * i]     = cr + (base.r - cr) * t;
            this.particleColor[3 * i + 1] = cg + (base.g - cg) * t;
            this.particleColor[3 * i + 2] = cb + (base.b - cb) * t;
        }
    }
}
```

---

### Step 6 — Spawn secondary particles in `FluidScene.ts`

**File:** `src/lib/fluid/FluidScene.ts`

Extend `setupFluidScene` to accept secondary-particle configuration and spawn a configurable number of type-1 particles in a separate region (e.g., a small block on the surface):

```ts
export function setupFluidScene(
    simWidth: number,
    simHeight: number,
    resolution = 100,
    relWaterWidth = 0.6,
    relWaterHeight = 0.8,
    baseColor?: { r: number; g: number; b: number },
    foamColor?: { r: number; g: number; b: number },
    colorDiffusionCoeff: number = 0.01,
    foamReturnRate: number = 1.0,
    // --- new parameters ---
    secondaryColor?: { r: number; g: number; b: number },
    relSecondaryWidth: number = 0.2,
    relSecondaryHeight: number = 0.2,
    secondaryGravityScale: number = 0.3,
    secondaryCohesionScale: number = 1.4,
    crossTypeRepulsionScale: number = 1.6
): FlipFluid {
    const tankHeight = simHeight;
    const tankWidth  = simWidth;
    const h  = tankHeight / resolution;
    const r  = 0.3 * h;
    const dx = 2.0 * r;
    const dy = Math.sqrt(3.0) / 2.0 * dx;

    const numX = Math.floor((relWaterWidth * tankWidth - 2.0 * h - 2.0 * r) / dx);
    const numY = Math.floor((relWaterHeight * tankHeight - 2.0 * h - 2.0 * r) / dy);

    const secNumX = Math.floor((relSecondaryWidth  * tankWidth  - 2.0 * r) / dx);
    const secNumY = Math.floor((relSecondaryHeight * tankHeight - 2.0 * r) / dy);
    const maxParticles = numX * numY + secNumX * secNumY;

    const fluid = new FlipFluid(
        1000.0, tankWidth, tankHeight, h, r, maxParticles,
        baseColor, foamColor, colorDiffusionCoeff, foamReturnRate,
        secondaryGravityScale, secondaryCohesionScale, crossTypeRepulsionScale
    );

    // --- spawn water particles (type 0) ---
    const totalPW = (numX - 1) * dx;
    const totalPH = (numY - 1) * dy;
    const startX  = (tankWidth  - totalPW) / 2.0;
    const startY  = (tankHeight - totalPH) / 2.0;

    let p = 0;
    for (let i = 0; i < numX; i++) {
        for (let j = 0; j < numY; j++) {
            fluid.particlePos[p++] = startX + dx * i + (j % 2 === 0 ? 0.0 : r);
            fluid.particlePos[p++] = startY + dy * j;
        }
    }
    const numWaterParticles = numX * numY;

    // --- spawn secondary particles (type 1) — start near the top-center ---
    const secColor = secondaryColor ?? { r: 1.0, g: 0.7, b: 0.1 };
    const secStartX = (tankWidth  - (secNumX - 1) * dx) / 2.0;
    const secStartY =  tankHeight - relSecondaryHeight * tankHeight - h;

    for (let i = 0; i < secNumX; i++) {
        for (let j = 0; j < secNumY; j++) {
            fluid.particlePos[p++] = secStartX + dx * i + (j % 2 === 0 ? 0.0 : r);
            fluid.particlePos[p++] = secStartY + dy * j;
        }
    }

    fluid.numParticles = numWaterParticles + secNumX * secNumY;

    // Mark type-1 particles
    for (let i = numWaterParticles; i < fluid.numParticles; i++) {
        fluid.particleType[i] = 1;
        fluid.particleColor[3 * i]     = secColor.r;
        fluid.particleColor[3 * i + 1] = secColor.g;
        fluid.particleColor[3 * i + 2] = secColor.b;
    }

    // Set secondary colors on fluid object
    fluid.secondaryBaseColor = { ...secColor };
    fluid.secondaryFoamColor = { r: 1.0, g: 0.95, b: 0.7 };

    // --- grid boundaries (unchanged) ---
    const n = fluid.fNumY;
    for (let i = 0; i < fluid.fNumX; i++) {
        for (let j = 0; j < fluid.fNumY; j++) {
            fluid.s[i * n + j] = (i === 0 || i === fluid.fNumX - 1 || j === 0) ? 0.0 : 1.0;
        }
    }

    return fluid;
}
```

---

### Step 7 — Expose new props in `FluidSimulation.svelte`

**File:** `src/lib/FluidSimulation.svelte`

Add Svelte props so the secondary fluid can be configured from the parent component or page:

```svelte
<script lang="ts">
    let {
        gravity = { x: 0, y: -9.81 },
        resolution = 70,
        fluidColor = { r: 0.09, g: 0.4, b: 1.0 },
        foamColor  = { r: 0.75, g: 0.9, b: 1.0 },
        colorDiffusionCoeff = 0.0008,
        foamReturnRate = 0.5,
        // --- secondary fluid props ---
        secondaryColor        = { r: 1.0, g: 0.7, b: 0.1 },
        relSecondaryWidth     = 0.2,
        relSecondaryHeight    = 0.2,
        secondaryGravityScale = 0.3,
        secondaryCohesionScale    = 1.4,
        crossTypeRepulsionScale   = 1.6,
        onclick
    }: {
        gravity?: { x: number; y: number };
        resolution?: number;
        fluidColor?: { r: number; g: number; b: number };
        foamColor?: { r: number; g: number; b: number };
        colorDiffusionCoeff?: number;
        foamReturnRate?: number;
        secondaryColor?: { r: number; g: number; b: number };
        relSecondaryWidth?: number;
        relSecondaryHeight?: number;
        secondaryGravityScale?: number;
        secondaryCohesionScale?: number;
        crossTypeRepulsionScale?: number;
        onclick?: () => void;
    } = $props();

    // Pass new params to setupFluidScene:
    fluid = setupFluidScene(
        simWidth, simHeight, resolution,
        relWaterWidth, relWaterHeight,
        fluidColor, foamColor, colorDiffusionCoeff, foamReturnRate,
        secondaryColor, relSecondaryWidth, relSecondaryHeight,
        secondaryGravityScale, secondaryCohesionScale, crossTypeRepulsionScale
    );
</script>
```

---

## Recommended Parameter Ranges

| Parameter | Conservative | Suggested Start | Aggressive |
|---|---|---|---|
| `secondaryGravityScale` | 0.5 | 0.3 | 0.0 (weightless) |
| `secondaryCohesionScale` | 1.2 | 1.4 | 2.0 |
| `crossTypeRepulsionScale` | 1.3 | 1.6 | 2.5 |
| `relSecondaryWidth` | 0.1 | 0.2 | 0.4 |
| `relSecondaryHeight` | 0.1 | 0.2 | 0.3 |

> Setting `crossTypeRepulsionScale` above `2.5` can cause instability (particles tunnel past each other in a single time-step). If artifacts appear, reduce this value or increase `numParticleIters` in `FluidSimulation.svelte`.

---

## Tests

No automated test infrastructure exists in this repository. The following manual verification steps are recommended after implementing the changes:

1. **Buoyancy** — Launch the simulation and confirm type-1 particles rise to the surface while water remains below.
2. **Hydrophobic separation** — Place type-1 particles inside the water volume and confirm they migrate upward and form a distinct layer rather than mixing.
3. **Self-cohesion** — Observe that type-1 particles cluster together into blob-like formations rather than spreading into single-particle layers.
4. **Backward compatibility** — Set `relSecondaryWidth = 0` / `relSecondaryHeight = 0` and confirm the simulation behaves identically to before the change.
5. **Color persistence** — Confirm type-1 particles retain their color and do not pick up the water `baseColor` through the `pushParticlesApart` color-diffusion step (guarded by the `typeI === typeJ` check in Step 4).

---

## Summary of Changed Files

| File | Change |
|---|---|
| `src/lib/fluid/FlipFluid.ts` | Add `particleType`, `secondaryGravityScale`, `secondaryCohesionScale`, `crossTypeRepulsionScale`, `secondaryBaseColor`, `secondaryFoamColor`; modify `integrateParticles`, `pushParticlesApart`, `updateParticleColors` |
| `src/lib/fluid/FluidScene.ts` | Add secondary-particle spawn block; pass new constructor params |
| `src/lib/FluidSimulation.svelte` | Expose new props; forward them to `setupFluidScene` |
| `src/lib/fluid/FluidRenderer.ts` | **No changes required** — renderer already uses per-particle color |