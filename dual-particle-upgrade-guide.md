# Dual-Particle Upgrade Guide — Version 2

> **Source:** [Copilot deep research task — azzamunza/mobile-fluid-sim](https://github.com/azzamunza/mobile-fluid-sim/tasks/49e89323-8190-4e44-8338-95921efc4782)
>
> **Revision:** v2 — addresses technical issues identified in the v1 review (see _Changes from v1_ section).

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
- **Important architectural note:** Strong immiscibility between the two fluids will always be approximate under a single shared pressure field. True phase separation at high densities requires a full **two-phase pressure solve** (out of scope here). The approach below gives strong *visual* separation through explicit inter-particle repulsion, per-type attraction, and per-type buoyancy. Implementors should be aware that increasing `crossTypeMinDistScale` beyond a safe range will not fully substitute for a two-fluid pressure model and may introduce numerical instability.
- All changes are backward-compatible: existing behavior is preserved when `numSecondaryParticles = 0`.

---

## Changes from v1

The following issues found in the v1 review are addressed in this revision:

| Issue | v1 Approach | v2 Fix |
|---|---|---|
| 1–1 cohesion was passive (close-packing only) | Reduced separation threshold | **Explicit attractive impulse** in a short-to-mid range band |
| Cross-type repulsion could cause jitter/explosions | Large `effectiveMinDist` scaled uncapped | **Cap displacement per pair**; apply `repulsionStrength < 1` multiplier; note on gradual iteration scaling |
| Spawn region could overlap boundaries | Fragile `secStartY` formula | **Clamp** spawn bounds to `[h + r, tankHeight − h − r]` |
| Foam whitening from shared density field | Foam applied to all particles from shared `particleDensity` | **Disable foam test for type-1** by default; document per-type density extension |
| Buoyancy semantically mixed with gravity scaling | `gravityY * gScale` | **Explicit upward lift term** `buoyancyLiftType1` independent from global gravity |
| Fragile positional constructor signature | Many optional trailing args | **Config object** `DualFluidConfig` groups all new parameters |
| No interaction matrix | Hardcoded `if/else` per pair | **Nice-to-have:** `minDistScale[typeI][typeJ]` matrix approach documented |
| No deterministic scenarios | — | **Nice-to-have:** seed / scenario preset pattern documented |

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

### Step 2 — Add per-type material parameters via a config object

**File:** `src/lib/fluid/FlipFluid.ts`

> **v2 change:** Parameters are grouped into a single optional `DualFluidConfig` object rather than appended as positional arguments. This avoids a fragile, order-dependent constructor signature as the parameter list grows.

Define the config type (can live in `FlipFluid.ts` or a shared `types.ts`):

```ts
export interface DualFluidConfig {
    /** Explicit upward acceleration added to type-1 particles each step (m/s²).
     *  Independent of global gravityY. Default: 6.0 (net lift when gravityY ≈ −9.81). */
    buoyancyLiftType1?: number;        // e.g. 6.0

    /** Separation distance multiplier for same-type (1–1) pairs.
     *  Values > 1.0 widen the exclusion zone; values < 1.0 allow closer packing.
     *  Default: 0.7 (allows closer packing → passive cohesion baseline). */
    cohesionMinDistScale?: number;     // e.g. 0.7

    /** Attraction strength for 1–1 pairs in the band [baseMinDist * cohesionMinDistScale, attractRadius].
     *  Applied as a mild velocity impulse capped at maxAttractionDelta per step.
     *  Default: 0.4 */
    attractionStrength?: number;       // e.g. 0.4

    /** Outer edge of the 1–1 attraction band, as a multiple of baseMinDist. Default: 1.5 */
    attractRadius?: number;            // e.g. 1.5

    /** Maximum position correction per particle per pair per iteration for attraction. Default: 0.002 */
    maxAttractionDelta?: number;       // e.g. 0.002

    /** Overlap-zone correction strength for cross-type (0–1) pairs. < 1.0 reduces jitter.
     *  Default: 0.5 */
    repulsionStrength?: number;        // e.g. 0.5

    /** Effective min-distance multiplier for cross-type (0–1) pairs.
     *  Keep ≤ 1.6 to avoid repeated over-correction. Default: 1.4 */
    crossTypeMinDistScale?: number;    // e.g. 1.4

    /** Maximum position correction per particle per pair per iteration for repulsion. Default: 0.005 */
    maxRepulsionDelta?: number;        // e.g. 0.005
}
```

Update the constructor to accept the config object as the last optional parameter:

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
    dualConfig: DualFluidConfig = {}
) {
    // ... existing body ...
    const cfg = dualConfig;
    this.buoyancyLiftType1    = cfg.buoyancyLiftType1    ?? 6.0;
    this.cohesionMinDistScale = cfg.cohesionMinDistScale ?? 0.7;
    this.attractionStrength   = cfg.attractionStrength   ?? 0.4;
    this.attractRadius        = cfg.attractRadius        ?? 1.5;
    this.maxAttractionDelta   = cfg.maxAttractionDelta   ?? 0.002;
    this.repulsionStrength    = cfg.repulsionStrength    ?? 0.5;
    this.crossTypeMinDistScale = cfg.crossTypeMinDistScale ?? 1.4;
    this.maxRepulsionDelta    = cfg.maxRepulsionDelta    ?? 0.005;
}
```

Declare the corresponding class properties:

```ts
buoyancyLiftType1:    number;
cohesionMinDistScale: number;
attractionStrength:   number;
attractRadius:        number;
maxAttractionDelta:   number;
repulsionStrength:    number;
crossTypeMinDistScale: number;
maxRepulsionDelta:    number;
```

---

### Step 3 — Per-type buoyancy as an explicit upward lift in `integrateParticles`

**File:** `src/lib/fluid/FlipFluid.ts` — method `integrateParticles`

> **v2 change:** Instead of scaling `gravityY`, an independent upward acceleration `buoyancyLiftType1` is added to type-1 particles. This keeps buoyancy tunable separately from global gravity and makes the physical intent explicit.

```ts
integrateParticles(dt: number, gravityX: number, gravityY: number, damping: number): void {
    for (let i = 0; i < this.numParticles; i++) {
        // Apply an explicit upward lift to secondary particles (type 1).
        // buoyancyLiftType1 is a positive value that opposes gravityY (which is negative).
        const liftY = this.particleType[i] === 1 ? this.buoyancyLiftType1 : 0.0;

        this.particleVel[2 * i]     += dt * gravityX;
        this.particleVel[2 * i + 1] += dt * (gravityY + liftY);

        this.particleVel[2 * i]     *= damping;
        this.particleVel[2 * i + 1] *= damping;

        this.particlePos[2 * i]     += this.particleVel[2 * i]     * dt;
        this.particlePos[2 * i + 1] += this.particleVel[2 * i + 1] * dt;
    }
}
```

> **Tuning note:** With `gravityY = −9.81`, set `buoyancyLiftType1 = 9.81` to make type-1 particles weightless. Values above `9.81` make them actively rise. Start around `6.0` for a moderate upward drift and adjust visually.

---

### Step 4 — Type-aware inter-particle forces in `pushParticlesApart`

**File:** `src/lib/fluid/FlipFluid.ts` — method `pushParticlesApart`

> **v2 changes:**
> - **1–1 attraction band:** After reducing the exclusion zone for same-type pairs, an explicit mild attractive impulse is applied when the pair distance falls in the band `(effectiveMinDist, attractRadius * baseMinDist]`. This actively pulls type-1 particles together rather than merely allowing closeness.
> - **Cross-type repulsion capping:** A `repulsionStrength` multiplier (< 1) scales down the correction for cross-type pairs, and a `maxRepulsionDelta` cap prevents over-correction in any single step. This eliminates the jitter/explosion risk from a large `crossTypeMinDistScale`.
> - **`crossTypeMinDistScale` reduced:** Kept at `≤ 1.4` (from `1.6`) to avoid repeated over-correction; increase solver iterations via `numIters` for stronger separation instead.

```ts
pushParticlesApart(numIters: number): void {
    const colorDiffusionCoeff = this.colorDiffusionCoeff;
    const baseMinDist  = 2.0 * this.particleRadius;
    const attractRadiusAbs = this.attractRadius * baseMinDist;

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
                const d2 = dx * dx + dy * dy;
                if (d2 === 0.0) continue;
                const d = Math.sqrt(d2);

                if (typeI === 1 && typeJ === 1) {
                    // ── Secondary–secondary ────────────────────────────────────────────────
                    // Exclusion zone: allow closer packing
                    const effectiveMinDist = baseMinDist * this.cohesionMinDistScale;

                    if (d < effectiveMinDist) {
                        // Overlap: push apart (normal separation)
                        const s = 0.5 * (effectiveMinDist - d) / d;
                        const cx = Math.min(Math.abs(dx * s), this.maxAttractionDelta) * Math.sign(dx * s);
                        const cy = Math.min(Math.abs(dy * s), this.maxAttractionDelta) * Math.sign(dy * s);
                        this.particlePos[2 * i]      -= cx;
                        this.particlePos[2 * i + 1]  -= cy;
                        this.particlePos[2 * id]     += cx;
                        this.particlePos[2 * id + 1] += cy;
                    } else if (d <= attractRadiusAbs) {
                        // Attraction band: pull together with a mild impulse capped per step
                        const s = this.attractionStrength * (d - effectiveMinDist) /
                                  (attractRadiusAbs - effectiveMinDist + 1e-9);
                        const ax = Math.min(dx * s * 0.5 / d, this.maxAttractionDelta);
                        const ay = Math.min(dy * s * 0.5 / d, this.maxAttractionDelta);
                        this.particlePos[2 * i]      += ax;
                        this.particlePos[2 * i + 1]  += ay;
                        this.particlePos[2 * id]     -= ax;
                        this.particlePos[2 * id + 1] -= ay;
                    }

                } else if (typeI !== typeJ) {
                    // ── Water–secondary (cross-type) ─────────────────────────────────
                    // Larger exclusion zone with capped, dampened correction
                    const effectiveMinDist = baseMinDist * this.crossTypeMinDistScale;
                    if (d >= effectiveMinDist) continue;

                    const raw = 0.5 * (effectiveMinDist - d) / d * this.repulsionStrength;
                    const cx = Math.min(Math.abs(dx * raw), this.maxRepulsionDelta) * Math.sign(dx * raw);
                    const cy = Math.min(Math.abs(dy * raw), this.maxRepulsionDelta) * Math.sign(dy * raw);
                    this.particlePos[2 * i]      -= cx;
                    this.particlePos[2 * i + 1]  -= cy;
                    this.particlePos[2 * id]     += cx;
                    this.particlePos[2 * id + 1] += cy;

                } else {
                    // ── Water–water: normal separation ───────────────────────
                    if (d >= baseMinDist) continue;
                    const s = 0.5 * (baseMinDist - d) / d;
                    this.particlePos[2 * i]      -= dx * s;
                    this.particlePos[2 * i + 1]  -= dy * s;
                    this.particlePos[2 * id]     += dx * s;
                    this.particlePos[2 * id + 1] += dy * s;
                }

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

> **Why explicit attraction matters:** Reducing the exclusion zone alone only allows type-1 particles to be close — it does not actively pull them together. The attraction band applies a small inward impulse whenever a pair is within `attractRadius * baseMinDist` but outside the exclusion zone, producing genuine clustering behavior. The impulse is capped at `maxAttractionDelta` per step to avoid instability.
>
> **Why cap cross-type repulsion:** A large `crossTypeMinDistScale` (e.g. `1.6`) combined with multiple solver iterations causes repeated over-corrections that can launch particles at high velocity (jitter/explosions). Keeping `crossTypeMinDistScale ≤ 1.4` and applying `repulsionStrength < 1` with a `maxRepulsionDelta` cap keeps each step's correction small and stable. For stronger separation, increase `numIters` rather than `crossTypeMinDistScale`.

---

### Step 5 — Per-type foam / base color in `updateParticleColors`

**File:** `src/lib/fluid/FlipFluid.ts` — method `updateParticleColors`

> **v2 change:** The shared `particleDensity` field reflects mixed-fluid density. Type-1 particles in a water-dense region would incorrectly receive the foam color because `particleDensity[cellNr] / particleRestDensity < 0.7` is true for type-1's own sparse density. The fix is to **disable the foam test for type-1 particles** by default. A future extension (noted below) can maintain a per-type density estimate for accurate per-type foam.

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

Update `updateParticleColors` to use the correct color set per particle type **and skip the foam test for type-1**:

```ts
updateParticleColors(dt: number): void {
    const h1 = this.fInvSpacing;
    const t = Math.max(0, Math.min(1, this.foamReturnRate * dt));

    for (let i = 0; i < this.numParticles; i++) {
        const isSecondary = this.particleType[i] === 1;
        const base = isSecondary ? this.secondaryBaseColor : this.baseColor;
        const foam = isSecondary ? this.secondaryFoamColor : this.foamColor;

        const x  = this.particlePos[2 * i];
        const y  = this.particlePos[2 * i + 1];
        const xi = clamp(Math.floor(x * h1), 1, this.fNumX - 1);
        const yi = clamp(Math.floor(y * h1), 1, this.fNumY - 1);
        const cellNr = xi * this.fNumY + yi;

        // For type-1 particles, skip the foam test: the shared particleDensity
        // reflects mixed-fluid density, so applying foam based on it would
        // incorrectly whiten secondary particles in water-dense regions.
        // Once a per-type density accumulation pass is added, this guard can
        // be relaxed for type-1 using that per-type estimate instead.
        let applyFoam = false;
        if (!isSecondary) {
            const d0 = this.particleRestDensity;
            if (d0 > 0.0) {
                const relDensity = this.particleDensity[cellNr] / d0;
                if (relDensity < 0.7) applyFoam = true;
            }
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

> **Future extension — per-type density:** To support accurate foam for both types, accumulate `particleDensityByType[type][cellNr]` in a separate pass during `transferVelocitiesToGrid`, using the same scatter loop as `particleDensity`. Then use `particleDensityByType[1][cellNr]` for the type-1 foam test instead of the shared field. This is out of scope for this upgrade but straightforward once the particle-type array exists.

---

### Step 6 — Spawn secondary particles in `FluidScene.ts`

**File:** `src/lib/fluid/FluidScene.ts`

> **v2 changes:**
> - `secStartY` is **clamped** to `[h + r, tankHeight − h − r]` to prevent the spawn region from overlapping boundaries or the water block regardless of dimension combinations.
> - New parameters are passed as a `DualFluidConfig` object rather than positional args.

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
    dualConfig: DualFluidConfig = {}
): FlipFluid {
    const tankHeight = simHeight;
    const tankWidth  = simWidth;
    const h  = tankHeight / resolution;
    const r  = 0.3 * h;
    const dx = 2.0 * r;
    const dy = Math.sqrt(3.0) / 2.0 * dx;

    const numX = Math.floor((relWaterWidth  * tankWidth  - 2.0 * h - 2.0 * r) / dx);
    const numY = Math.floor((relWaterHeight * tankHeight - 2.0 * h - 2.0 * r) / dy);

    const secNumX = Math.floor((relSecondaryWidth  * tankWidth  - 2.0 * r) / dx);
    const secNumY = Math.floor((relSecondaryHeight * tankHeight - 2.0 * r) / dy);
    const maxParticles = numX * numY + secNumX * secNumY;

    const fluid = new FlipFluid(
        1000.0, tankWidth, tankHeight, h, r, maxParticles,
        baseColor, foamColor, colorDiffusionCoeff, foamReturnRate,
        dualConfig
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

    // --- spawn secondary particles (type 1) --- start near the top-center ---
    // secStartY is clamped to a valid region inside the fluid boundary:
    //   lower bound: h + r        (above bottom wall + particle radius)
    //   upper bound: tankHeight - h - r - (secNumY - 1) * dy  (fits the block inside the top wall)
    const secColor = secondaryColor ?? { r: 1.0, g: 0.7, b: 0.1 };
    const secStartX = (tankWidth - (secNumX - 1) * dx) / 2.0;
    const rawSecStartY = tankHeight - relSecondaryHeight * tankHeight - h;
    const minSecStartY = h + r;
    const maxSecStartY = tankHeight - h - r - Math.max(0, secNumY - 1) * dy;
    const secStartY = Math.max(minSecStartY, Math.min(maxSecStartY, rawSecStartY));

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

> **v2 change:** Secondary parameters are grouped into a single `dualConfig` prop of type `DualFluidConfig`, avoiding a long list of individual props for the new parameters.

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
        secondaryColor     = { r: 1.0, g: 0.7, b: 0.1 },
        relSecondaryWidth  = 0.2,
        relSecondaryHeight = 0.2,
        dualConfig         = {} as DualFluidConfig,
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
        dualConfig?: DualFluidConfig;
        onclick?: () => void;
    } = $props();

    // Pass new params to setupFluidScene:
    fluid = setupFluidScene(
        simWidth, simHeight, resolution,
        relWaterWidth, relWaterHeight,
        fluidColor, foamColor, colorDiffusionCoeff, foamReturnRate,
        secondaryColor, relSecondaryWidth, relSecondaryHeight,
        dualConfig
    );
</script>
```

---

## Recommended Parameter Ranges

| Parameter | Conservative | Suggested Start | Aggressive |
|---|---|---|---|
| `buoyancyLiftType1` | 4.0 | 6.0 | 9.81+ (net rise) |
| `cohesionMinDistScale` | 0.8 | 0.7 | 0.5 |
| `attractionStrength` | 0.2 | 0.4 | 0.8 |
| `attractRadius` | 1.2 | 1.5 | 2.0 |
| `maxAttractionDelta` | 0.001 | 0.002 | 0.005 |
| `repulsionStrength` | 0.3 | 0.5 | 0.8 |
| `crossTypeMinDistScale` | 1.2 | 1.4 | 1.6 |
| `maxRepulsionDelta` | 0.003 | 0.005 | 0.01 |
| `relSecondaryWidth` | 0.1 | 0.2 | 0.4 |
| `relSecondaryHeight` | 0.1 | 0.2 | 0.3 |

> **Stability guidance:** Setting `crossTypeMinDistScale` above `1.6` without reducing `repulsionStrength` or `maxRepulsionDelta` can cause instability. For stronger immiscibility, prefer increasing `numIters` in `pushParticlesApart` gradually (e.g. `4 → 6 → 8`) over raising the repulsion radius.

---

## Nice-to-Have Improvements

### Interaction matrix (extensible N-material architecture)

Rather than hardcoding `if/else` branches per type pair, consider an interaction matrix. This makes adding a third material trivial:

```ts
// In FlipFluid class:
// minDistScale[typeI][typeJ] replaces the per-pair effectiveMinDist logic
minDistScale: number[][];   // e.g. [[1.0, 1.4], [1.4, 0.7]]
attractEnabled: boolean[][]; // e.g. [[false, false], [false, true]]

// Usage in pushParticlesApart inner loop:
const effectiveMinDist = baseMinDist * this.minDistScale[typeI][typeJ];
const doAttract = this.attractEnabled[typeI][typeJ];
```

This pattern cleanly replaces the `if (typeI === 1 && typeJ === 1)` chain.

### Deterministic seed / scenario presets

For reproducible testing and tuning comparisons, expose a `seed` parameter and named scenario presets:

```ts
export const DUAL_FLUID_PRESETS = {
    oilOnWater: {
        buoyancyLiftType1: 6.0,
        cohesionMinDistScale: 0.7,
        attractionStrength: 0.4,
        crossTypeMinDistScale: 1.4,
        repulsionStrength: 0.5
    } satisfies DualFluidConfig,
    lightFoam: {
        buoyancyLiftType1: 9.0,
        cohesionMinDistScale: 0.6,
        attractionStrength: 0.6,
        crossTypeMinDistScale: 1.3,
        repulsionStrength: 0.35
    } satisfies DualFluidConfig
};
```

A `seed` parameter in `setupFluidScene` can be used to initialize a seeded pseudo-random number generator for any stochastic placement offsets, ensuring regression tests produce identical initial conditions.

---

## Tests

No automated test infrastructure exists in this repository. The following manual verification steps are recommended after implementing the changes:

1. **Buoyancy** — Launch the simulation and confirm type-1 particles rise to the surface while water remains below. Tune `buoyancyLiftType1` in the `dualConfig` prop.
2. **Hydrophobic separation** — Place type-1 particles inside the water volume and confirm they migrate upward and form a distinct layer rather than mixing.
3. **Self-cohesion / attraction** — Observe that type-1 particles actively cluster into blob-like formations. If they merely stay close without grouping, increase `attractionStrength` or widen `attractRadius`.
4. **Stability check** — Run the simulation for several minutes with `crossTypeMinDistScale = 1.4` and confirm no particle explosions. If jitter appears, reduce `maxRepulsionDelta` or `repulsionStrength`.
5. **Spawn bounds** — Set extreme values (e.g. `relSecondaryHeight = 0.9`) and confirm the spawn region is clamped to a valid interior area without overlapping walls.
6. **No foam whitening** — Confirm type-1 particles retain their configured color even when surrounded by dense water particles. They should never briefly flash white/light.
7. **Backward compatibility** — Set `relSecondaryWidth = 0` / `relSecondaryHeight = 0` and confirm the simulation behaves identically to before the change.
8. **Color persistence** — Confirm type-1 particles do not pick up the water `baseColor` through the `pushParticlesApart` color-diffusion step (guarded by the `typeI === typeJ` check in Step 4).

---

## Summary of Changed Files

| File | Change |
|---|---|
| `src/lib/fluid/FlipFluid.ts` | Add `particleType`, `DualFluidConfig`, buoyancy lift, `pushParticlesApart` with attraction + capped repulsion, `updateParticleColors` with per-type foam guard |
| `src/lib/fluid/FluidScene.ts` | Add secondary-particle spawn block with clamped bounds; pass `DualFluidConfig` object |
| `src/lib/FluidSimulation.svelte` | Expose `dualConfig` prop; forward to `setupFluidScene` |
| `src/lib/fluid/FluidRenderer.ts` | **No changes required** — renderer already uses per-particle color |
