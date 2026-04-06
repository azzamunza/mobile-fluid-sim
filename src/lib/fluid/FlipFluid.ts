// Cell types
export const FLUID_CELL = 0;
export const AIR_CELL = 1;
export const SOLID_CELL = 2;

export interface DualFluidConfig {
    /** Explicit upward acceleration added to type-1 particles each step (m/s²).
     *  Independent of global gravityY. Default: 6.0 (net lift when gravityY ≈ −9.81). */
    buoyancyLiftType1?: number;

    /** Separation distance multiplier for same-type (1–1) pairs.
     *  Values > 1.0 widen the exclusion zone; values < 1.0 allow closer packing.
     *  Default: 0.7 (allows closer packing → passive cohesion baseline). */
    cohesionMinDistScale?: number;

    /** Attraction strength for 1–1 pairs in the band [baseMinDist * cohesionMinDistScale, attractRadius].
     *  Applied as a mild velocity impulse capped at maxAttractionDelta per step.
     *  Default: 0.4 */
    attractionStrength?: number;

    /** Outer edge of the 1–1 attraction band, as a multiple of baseMinDist. Default: 1.5 */
    attractRadius?: number;

    /** Maximum position correction per particle per pair per iteration for attraction. Default: 0.002 */
    maxAttractionDelta?: number;

    /** Overlap-zone correction strength for cross-type (0–1) pairs. < 1.0 reduces jitter.
     *  Default: 0.5 */
    repulsionStrength?: number;

    /** Effective min-distance multiplier for cross-type (0–1) pairs.
     *  Keep ≤ 1.6 to avoid repeated over-correction. Default: 1.4 */
    crossTypeMinDistScale?: number;

    /** Maximum position correction per particle per pair per iteration for repulsion. Default: 0.005 */
    maxRepulsionDelta?: number;
}

function clamp(x: number, min: number, max: number): number {
    if (x < min) return min;
    if (x > max) return max;
    return x;
}

export class FlipFluid {
    density: number;
    fNumX: number;
    fNumY: number;
    h: number;
    fInvSpacing: number;
    fNumCells: number;

    // Grid arrays
    u: Float32Array;
    v: Float32Array;
    du: Float32Array;
    dv: Float32Array;
    prevU: Float32Array;
    prevV: Float32Array;
    p: Float32Array;
    s: Float32Array;
    cellType: Int32Array;
    cellColor: Float32Array;

    // Particle arrays
    maxParticles: number;
    particlePos: Float32Array;
    particleColor: Float32Array;
    particleVel: Float32Array;
    particleDensity: Float32Array;
    particleRestDensity: number;
    numParticles: number;

    // Particle type: 0 = water, 1 = secondary fluid
    particleType: Int8Array;

    // Colors
    baseColor: { r: number; g: number; b: number };
    foamColor: { r: number; g: number; b: number };
    colorDiffusionCoeff: number;
    foamReturnRate: number; // per-second rate towards base color

    // Per-type colors
    secondaryBaseColor: { r: number; g: number; b: number };
    secondaryFoamColor: { r: number; g: number; b: number };

    // Dual-fluid config parameters
    buoyancyLiftType1: number;
    cohesionMinDistScale: number;
    attractionStrength: number;
    attractRadius: number;
    maxAttractionDelta: number;
    repulsionStrength: number;
    crossTypeMinDistScale: number;
    maxRepulsionDelta: number;

    // Particle grid
    particleRadius: number;
    pInvSpacing: number;
    pNumX: number;
    pNumY: number;
    pNumCells: number;
    numCellParticles: Int32Array;
    firstCellParticle: Int32Array;
    cellParticleIds: Int32Array;

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
        this.density = density;
        this.fNumX = Math.floor(width / spacing) + 1;
        this.fNumY = Math.floor(height / spacing) + 1;
        this.h = Math.max(width / this.fNumX, height / this.fNumY);
        this.fInvSpacing = 1.0 / this.h;
        this.fNumCells = this.fNumX * this.fNumY;

        // Initialize grid arrays
        this.u = new Float32Array(this.fNumCells);
        this.v = new Float32Array(this.fNumCells);
        this.du = new Float32Array(this.fNumCells);
        this.dv = new Float32Array(this.fNumCells);
        this.prevU = new Float32Array(this.fNumCells);
        this.prevV = new Float32Array(this.fNumCells);
        this.p = new Float32Array(this.fNumCells);
        this.s = new Float32Array(this.fNumCells);
        this.cellType = new Int32Array(this.fNumCells);
        this.cellColor = new Float32Array(3 * this.fNumCells);

        // Initialize particle arrays
        this.maxParticles = maxParticles;
        this.particlePos = new Float32Array(2 * this.maxParticles);
        this.particleColor = new Float32Array(3 * this.maxParticles);

        // Use provided base color or default to a deeper water-like blue
        const defaultColor = { r: 0.06, g: 0.45, b: 0.9 };
        const color = baseColor || defaultColor;
        this.baseColor = { ...color };
        this.foamColor = foamColor || { r: 0.7, g: 0.9, b: 1.0 };
        this.colorDiffusionCoeff = colorDiffusionCoeff;
        this.foamReturnRate = foamReturnRate;

        for (let i = 0; i < this.maxParticles; i++) {
            // Single base color for all particles
            this.particleColor[3 * i] = color.r;
            this.particleColor[3 * i + 1] = color.g;
            this.particleColor[3 * i + 2] = color.b;
        }

        this.particleVel = new Float32Array(2 * this.maxParticles);
        this.particleType = new Int8Array(this.maxParticles);
        // default 0 (water) — no explicit fill needed because Int8Array zero-initializes

        this.particleDensity = new Float32Array(this.fNumCells);
        this.particleRestDensity = 0.0;

        // Secondary particle colors (defaults to warm amber)
        this.secondaryBaseColor = { r: 1.0, g: 0.7, b: 0.1 };
        this.secondaryFoamColor = { r: 1.0, g: 0.95, b: 0.7 };

        // Dual-fluid config
        const cfg = dualConfig;
        this.buoyancyLiftType1     = cfg.buoyancyLiftType1    ?? 6.0;
        this.cohesionMinDistScale  = cfg.cohesionMinDistScale  ?? 0.7;
        this.attractionStrength    = cfg.attractionStrength    ?? 0.4;
        this.attractRadius         = cfg.attractRadius         ?? 1.5;
        this.maxAttractionDelta    = cfg.maxAttractionDelta    ?? 0.002;
        this.repulsionStrength     = cfg.repulsionStrength     ?? 0.5;
        this.crossTypeMinDistScale = cfg.crossTypeMinDistScale ?? 1.4;
        this.maxRepulsionDelta     = cfg.maxRepulsionDelta     ?? 0.005;

        // Initialize particle grid
        this.particleRadius = particleRadius;
        this.pInvSpacing = 1.0 / (2.2 * particleRadius);
        this.pNumX = Math.floor(width * this.pInvSpacing) + 1;
        this.pNumY = Math.floor(height * this.pInvSpacing) + 1;
        this.pNumCells = this.pNumX * this.pNumY;

        this.numCellParticles = new Int32Array(this.pNumCells);
        this.firstCellParticle = new Int32Array(this.pNumCells + 1);
        this.cellParticleIds = new Int32Array(maxParticles);

        this.numParticles = 0;
    }

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

    pushParticlesApart(numIters: number): void {
        const colorDiffusionCoeff = this.colorDiffusionCoeff;
        const baseMinDist = 2.0 * this.particleRadius;
        const attractRadiusAbs = this.attractRadius * baseMinDist;

        // v2.1 fix A5: pre-compute the largest effective distance across all type pairs
        // so we can skip pairs that are clearly out of range BEFORE the expensive sqrt.
        const maxEffectiveDist = Math.max(baseMinDist, attractRadiusAbs, this.crossTypeMinDistScale * baseMinDist);
        const maxEffectiveDist2 = maxEffectiveDist * maxEffectiveDist;

        // Build spatial hash
        this.numCellParticles.fill(0);
        for (let i = 0; i < this.numParticles; i++) {
            const x = this.particlePos[2 * i];
            const y = this.particlePos[2 * i + 1];
            const xi = clamp(Math.floor(x * this.pInvSpacing), 0, this.pNumX - 1);
            const yi = clamp(Math.floor(y * this.pInvSpacing), 0, this.pNumY - 1);
            const cellNr = xi * this.pNumY + yi;
            this.numCellParticles[cellNr]++;
        }

        let first = 0;
        for (let i = 0; i < this.pNumCells; i++) {
            first += this.numCellParticles[i];
            this.firstCellParticle[i] = first;
        }
        this.firstCellParticle[this.pNumCells] = first;

        for (let i = 0; i < this.numParticles; i++) {
            const x = this.particlePos[2 * i];
            const y = this.particlePos[2 * i + 1];
            const xi = clamp(Math.floor(x * this.pInvSpacing), 0, this.pNumX - 1);
            const yi = clamp(Math.floor(y * this.pInvSpacing), 0, this.pNumY - 1);
            const cellNr = xi * this.pNumY + yi;
            this.firstCellParticle[cellNr]--;
            this.cellParticleIds[this.firstCellParticle[cellNr]] = i;
        }

        for (let iter = 0; iter < numIters; iter++) {
            for (let i = 0; i < this.numParticles; i++) {
                const px = this.particlePos[2 * i];
                const py = this.particlePos[2 * i + 1];
                const typeI = this.particleType[i];
                const pxi = Math.floor(px * this.pInvSpacing);
                const pyi = Math.floor(py * this.pInvSpacing);

                const x0 = Math.max(pxi - 1, 0);
                const y0 = Math.max(pyi - 1, 0);
                const x1 = Math.min(pxi + 1, this.pNumX - 1);
                const y1 = Math.min(pyi + 1, this.pNumY - 1);

                for (let xi = x0; xi <= x1; xi++) {
                    for (let yi = y0; yi <= y1; yi++) {
                        const cellNr = xi * this.pNumY + yi;
                        const first = this.firstCellParticle[cellNr];
                        const last = this.firstCellParticle[cellNr + 1];

                        for (let j = first; j < last; j++) {
                            const id = this.cellParticleIds[j];
                            if (id === i) continue;

                            const typeJ = this.particleType[id];
                            const qx = this.particlePos[2 * id];
                            const qy = this.particlePos[2 * id + 1];
                            const dx = qx - px;
                            const dy = qy - py;
                            const d2 = dx * dx + dy * dy;
                            // v2.1 fix A5: early exit before sqrt
                            if (d2 > maxEffectiveDist2 || d2 === 0.0) continue;
                            const d = Math.sqrt(d2);

                            if (typeI === 1 && typeJ === 1) {
                                // ── Secondary–secondary ──────────────────────────────
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
                                    const rawAx = dx * s * 0.5 / d;
                                    const rawAy = dy * s * 0.5 / d;
                                    const ax = Math.min(Math.abs(rawAx), this.maxAttractionDelta) * Math.sign(rawAx);
                                    const ay = Math.min(Math.abs(rawAy), this.maxAttractionDelta) * Math.sign(rawAy);
                                    this.particlePos[2 * i]      += ax;
                                    this.particlePos[2 * i + 1]  += ay;
                                    this.particlePos[2 * id]     -= ax;
                                    this.particlePos[2 * id + 1] -= ay;
                                }

                            } else if (typeI !== typeJ) {
                                // ── Water–secondary (cross-type) ─────────────────────
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
                                // ── Water–water: normal separation ───────────────────
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
        }
    }

    handleParticleCollisions(): void {
        const h = 1.0 / this.fInvSpacing;
        const r = this.particleRadius;

        const minX = h + r;
        const maxX = (this.fNumX - 1) * h - r;
        const minY = h + r;
        const maxY = (this.fNumY - 1) * h - r;

        for (let i = 0; i < this.numParticles; i++) {
            let x = this.particlePos[2 * i];
            let y = this.particlePos[2 * i + 1];

            // Wall collisions
            if (x < minX) {
                x = minX;
                this.particleVel[2 * i] = 0.0;
            }
            if (x > maxX) {
                x = maxX;
                this.particleVel[2 * i] = 0.0;
            }
            if (y < minY) {
                y = minY;
                this.particleVel[2 * i + 1] = 0.0;
            }
            if (y > maxY) {
                y = maxY;
                this.particleVel[2 * i + 1] = 0.0;
            }

            this.particlePos[2 * i] = x;
            this.particlePos[2 * i + 1] = y;
        }
    }

    updateParticleDensity(): void {
        const n = this.fNumY;
        const h = this.h;
        const h1 = this.fInvSpacing;
        const h2 = 0.5 * h;
        const d = this.particleDensity;

        d.fill(0.0);

        for (let i = 0; i < this.numParticles; i++) {
            const x = clamp(this.particlePos[2 * i], h, (this.fNumX - 1) * h);
            const y = clamp(this.particlePos[2 * i + 1], h, (this.fNumY - 1) * h);

            const x0 = Math.floor((x - h2) * h1);
            const tx = ((x - h2) - x0 * h) * h1;
            const x1 = Math.min(x0 + 1, this.fNumX - 2);

            const y0 = Math.floor((y - h2) * h1);
            const ty = ((y - h2) - y0 * h) * h1;
            const y1 = Math.min(y0 + 1, this.fNumY - 2);

            const sx = 1.0 - tx;
            const sy = 1.0 - ty;

            if (x0 < this.fNumX && y0 < this.fNumY) d[x0 * n + y0] += sx * sy;
            if (x1 < this.fNumX && y0 < this.fNumY) d[x1 * n + y0] += tx * sy;
            if (x1 < this.fNumX && y1 < this.fNumY) d[x1 * n + y1] += tx * ty;
            if (x0 < this.fNumX && y1 < this.fNumY) d[x0 * n + y1] += sx * ty;
        }

        // Calculate rest density
        if (this.particleRestDensity === 0.0) {
            let sum = 0.0;
            let numFluidCells = 0;
            for (let i = 0; i < this.fNumCells; i++) {
                if (this.cellType[i] === FLUID_CELL) {
                    sum += d[i];
                    numFluidCells++;
                }
            }
            if (numFluidCells > 0) {
                this.particleRestDensity = sum / numFluidCells;
            }
        }
    }

    transferVelocities(toGrid: boolean, flipRatio: number): void {
        const n = this.fNumY;
        const h = this.h;
        const h1 = this.fInvSpacing;
        const h2 = 0.5 * h;

        if (toGrid) {
            this.prevU.set(this.u);
            this.prevV.set(this.v);
            this.du.fill(0.0);
            this.dv.fill(0.0);
            this.u.fill(0.0);
            this.v.fill(0.0);

            // Mark cells
            for (let i = 0; i < this.fNumCells; i++) {
                this.cellType[i] = this.s[i] === 0.0 ? SOLID_CELL : AIR_CELL;
            }

            for (let i = 0; i < this.numParticles; i++) {
                const x = this.particlePos[2 * i];
                const y = this.particlePos[2 * i + 1];
                const xi = clamp(Math.floor(x * h1), 0, this.fNumX - 1);
                const yi = clamp(Math.floor(y * h1), 0, this.fNumY - 1);
                const cellNr = xi * n + yi;
                if (this.cellType[cellNr] === AIR_CELL) {
                    this.cellType[cellNr] = FLUID_CELL;
                }
            }
        }

        for (let component = 0; component < 2; component++) {
            const dx = component === 0 ? 0.0 : h2;
            const dy = component === 0 ? h2 : 0.0;
            const f = component === 0 ? this.u : this.v;
            const prevF = component === 0 ? this.prevU : this.prevV;
            const d = component === 0 ? this.du : this.dv;

            for (let i = 0; i < this.numParticles; i++) {
                const x = clamp(this.particlePos[2 * i], h, (this.fNumX - 1) * h);
                const y = clamp(this.particlePos[2 * i + 1], h, (this.fNumY - 1) * h);

                const x0 = Math.min(Math.floor((x - dx) * h1), this.fNumX - 2);
                const tx = ((x - dx) - x0 * h) * h1;
                const x1 = Math.min(x0 + 1, this.fNumX - 2);

                const y0 = Math.min(Math.floor((y - dy) * h1), this.fNumY - 2);
                const ty = ((y - dy) - y0 * h) * h1;
                const y1 = Math.min(y0 + 1, this.fNumY - 2);

                const sx = 1.0 - tx;
                const sy = 1.0 - ty;

                const d0 = sx * sy;
                const d1 = tx * sy;
                const d2 = tx * ty;
                const d3 = sx * ty;

                const nr0 = x0 * n + y0;
                const nr1 = x1 * n + y0;
                const nr2 = x1 * n + y1;
                const nr3 = x0 * n + y1;

                if (toGrid) {
                    const pv = this.particleVel[2 * i + component];
                    f[nr0] += pv * d0; d[nr0] += d0;
                    f[nr1] += pv * d1; d[nr1] += d1;
                    f[nr2] += pv * d2; d[nr2] += d2;
                    f[nr3] += pv * d3; d[nr3] += d3;
                } else {
                    const offset = component === 0 ? n : 1;
                    const valid0 = this.cellType[nr0] !== AIR_CELL || this.cellType[nr0 - offset] !== AIR_CELL ? 1.0 : 0.0;
                    const valid1 = this.cellType[nr1] !== AIR_CELL || this.cellType[nr1 - offset] !== AIR_CELL ? 1.0 : 0.0;
                    const valid2 = this.cellType[nr2] !== AIR_CELL || this.cellType[nr2 - offset] !== AIR_CELL ? 1.0 : 0.0;
                    const valid3 = this.cellType[nr3] !== AIR_CELL || this.cellType[nr3 - offset] !== AIR_CELL ? 1.0 : 0.0;

                    const v = this.particleVel[2 * i + component];
                    const totalValid = valid0 * d0 + valid1 * d1 + valid2 * d2 + valid3 * d3;

                    if (totalValid > 0.0) {
                        const picV = (valid0 * d0 * f[nr0] + valid1 * d1 * f[nr1] + valid2 * d2 * f[nr2] + valid3 * d3 * f[nr3]) / totalValid;
                        const corr = (valid0 * d0 * (f[nr0] - prevF[nr0]) + valid1 * d1 * (f[nr1] - prevF[nr1]) + valid2 * d2 * (f[nr2] - prevF[nr2]) + valid3 * d3 * (f[nr3] - prevF[nr3])) / totalValid;
                        const flipV = v + corr;
                        this.particleVel[2 * i + component] = (1.0 - flipRatio) * picV + flipRatio * flipV;
                    }
                }
            }

            if (toGrid) {
                for (let i = 0; i < f.length; i++) {
                    if (d[i] > 0.0) f[i] /= d[i];
                }

                for (let i = 0; i < this.fNumX; i++) {
                    for (let j = 0; j < this.fNumY; j++) {
                        const solid = this.cellType[i * n + j] === SOLID_CELL;
                        if (solid || (i > 0 && this.cellType[(i - 1) * n + j] === SOLID_CELL)) {
                            this.u[i * n + j] = this.prevU[i * n + j];
                        }
                        if (solid || (j > 0 && this.cellType[i * n + j - 1] === SOLID_CELL)) {
                            this.v[i * n + j] = this.prevV[i * n + j];
                        }
                    }
                }
            }
        }
    }

    solveIncompressibility(numIters: number, dt: number, overRelaxation: number, compensateDrift = true): void {
        this.p.fill(0.0);
        this.prevU.set(this.u);
        this.prevV.set(this.v);

        const n = this.fNumY;
        const cp = this.density * this.h / dt;

        for (let iter = 0; iter < numIters; iter++) {
            for (let i = 1; i < this.fNumX - 1; i++) {
                for (let j = 1; j < this.fNumY - 1; j++) {
                    if (this.cellType[i * n + j] !== FLUID_CELL) continue;

                    const center = i * n + j;
                    const left = (i - 1) * n + j;
                    const right = (i + 1) * n + j;
                    const bottom = i * n + j - 1;
                    const top = i * n + j + 1;

                    const sx0 = this.s[left];
                    const sx1 = this.s[right];
                    const sy0 = this.s[bottom];
                    const sy1 = this.s[top];
                    const s = sx0 + sx1 + sy0 + sy1;

                    if (s === 0.0) continue;

                    let div = this.u[right] - this.u[center] + this.v[top] - this.v[center];

                    if (this.particleRestDensity > 0.0 && compensateDrift) {
                        const k = 1.0;
                        const compression = this.particleDensity[i * n + j] - this.particleRestDensity;
                        if (compression > 0.0) div = div - k * compression;
                    }

                    let p = -div / s;
                    p *= overRelaxation;
                    this.p[center] += cp * p;

                    this.u[center] -= sx0 * p;
                    this.u[right] += sx1 * p;
                    this.v[center] -= sy0 * p;
                    this.v[top] += sy1 * p;
                }
            }
        }
    }

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

    setSciColor(cellNr: number, val: number, minVal: number, maxVal: number): void {
        val = Math.min(Math.max(val, minVal), maxVal - 0.0001);
        const d = maxVal - minVal;
        val = d === 0.0 ? 0.5 : (val - minVal) / d;
        const m = 0.25;
        const num = Math.floor(val / m);
        const s = (val - num * m) / m;
        let r: number, g: number, b: number;

        switch (num) {
            case 0: r = 0.0; g = s; b = 1.0; break;
            case 1: r = 0.0; g = 1.0; b = 1.0 - s; break;
            case 2: r = s; g = 1.0; b = 0.0; break;
            case 3: r = 1.0; g = 1.0 - s; b = 0.0; break;
            default: r = 1.0; g = 0.0; b = 0.0; break;
        }

        this.cellColor[3 * cellNr] = r;
        this.cellColor[3 * cellNr + 1] = g;
        this.cellColor[3 * cellNr + 2] = b;
    }

    updateCellColors(): void {
        this.cellColor.fill(0.0);

        for (let i = 0; i < this.fNumCells; i++) {
            if (this.cellType[i] === SOLID_CELL) {
                this.cellColor[3 * i] = 0.5;
                this.cellColor[3 * i + 1] = 0.5;
                this.cellColor[3 * i + 2] = 0.5;
            } else if (this.cellType[i] === FLUID_CELL) {
                let d = this.particleDensity[i];
                if (this.particleRestDensity > 0.0) d /= this.particleRestDensity;
                this.setSciColor(i, d, 0.0, 2.0);
            }
        }
    }

    simulate(
        dt: number,
        gravityX: number,
        gravityY: number,
        flipRatio: number,
        numPressureIters: number,
        numParticleIters: number,
        overRelaxation: number,
        compensateDrift: boolean,
        separateParticles: boolean,
        damping: number = 1.00
    ): void {
        const numSubSteps = 1;
        const sdt = dt / numSubSteps;

        for (let step = 0; step < numSubSteps; step++) {
            this.integrateParticles(sdt, gravityX, gravityY, damping);
            if (separateParticles) this.pushParticlesApart(numParticleIters);
            this.handleParticleCollisions();
            this.transferVelocities(true, flipRatio);
            this.updateParticleDensity();
            this.solveIncompressibility(numPressureIters, sdt, overRelaxation, compensateDrift);
            this.transferVelocities(false, flipRatio);
        }

        this.updateParticleColors(sdt);
        this.updateCellColors();
    }

    setFluidColor(baseColor: { r: number; g: number; b: number }): void {
        this.baseColor = { ...baseColor };
        for (let i = 0; i < this.maxParticles; i++) {
            // v2.1 fix A1: only update type-0 (water) particles
            if (this.particleType[i] === 1) continue;
            this.particleColor[3 * i]     = baseColor.r;
            this.particleColor[3 * i + 1] = baseColor.g;
            this.particleColor[3 * i + 2] = baseColor.b;
        }
    }

    setSecondaryColor(color: { r: number; g: number; b: number }): void {
        this.secondaryBaseColor = { ...color };
        for (let i = 0; i < this.maxParticles; i++) {
            if (this.particleType[i] !== 1) continue;
            this.particleColor[3 * i]     = color.r;
            this.particleColor[3 * i + 1] = color.g;
            this.particleColor[3 * i + 2] = color.b;
        }
    }

    setFoamColor(foamColor: { r: number; g: number; b: number }): void {
        this.foamColor = { ...foamColor };
    }

    setColorDiffusionCoeff(coeff: number): void {
        this.colorDiffusionCoeff = Math.max(0, Math.min(1, coeff));
    }

    setFoamReturnRate(rate: number): void {
        this.foamReturnRate = Math.max(0, rate);
    }
}
