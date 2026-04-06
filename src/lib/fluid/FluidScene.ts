import { FlipFluid, type DualFluidConfig } from './FlipFluid';

export interface SceneConfig {
    gravity: number;
    dt: number;
    flipRatio: number;
    numPressureIters: number;
    numParticleIters: number;
    overRelaxation: number;
    compensateDrift: boolean;
    separateParticles: boolean;
    showParticles: boolean;
    showGrid: boolean;
}

export const DEFAULT_SCENE_CONFIG: SceneConfig = {
    gravity: -9.81,
    dt: 1.0 / 120.0,
    flipRatio: 0.9,
    numPressureIters: 100,
    numParticleIters: 2,
    overRelaxation: 1.9,
    compensateDrift: true,
    separateParticles: true,
    showParticles: true,
    showGrid: false
};

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
    const maxParticles = numX * numY + Math.max(0, secNumX) * Math.max(0, secNumY);

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
    const secColor = secondaryColor ?? { r: 1.0, g: 0.7, b: 0.1 };
    const actualSecNumX = Math.max(0, secNumX);
    const actualSecNumY = Math.max(0, secNumY);

    if (actualSecNumX > 0 && actualSecNumY > 0) {
        const secStartX = (tankWidth - (actualSecNumX - 1) * dx) / 2.0;
        const rawSecStartY = tankHeight - relSecondaryHeight * tankHeight - h;
        const minSecStartY = h + r;
        const maxSecStartY = tankHeight - h - r - Math.max(0, actualSecNumY - 1) * dy;
        const secStartY = Math.max(minSecStartY, Math.min(maxSecStartY, rawSecStartY));

        for (let i = 0; i < actualSecNumX; i++) {
            for (let j = 0; j < actualSecNumY; j++) {
                fluid.particlePos[p++] = secStartX + dx * i + (j % 2 === 0 ? 0.0 : r);
                fluid.particlePos[p++] = secStartY + dy * j;
            }
        }
    }

    fluid.numParticles = numWaterParticles + actualSecNumX * actualSecNumY;

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
