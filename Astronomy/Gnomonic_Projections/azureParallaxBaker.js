// Procedural azure-parallax baker used when prebaked backdrop PNGs are absent.

export const P_DEFAULT = {
    tileSize: 2048,
    parallaxLayers: 4,
    cloudsPerLayer: 2,
    lobesPerCloud: 5,
    lobeSpread: 0.62,        // tuner default 0.48 → spread lobes wider
    minSize: 0.55,           // was 0.34 — bigger lobes
    maxSize: 1.10,           // was 0.74
    aspectRatio: 2.25,
    aspectJitter: 1.15,
    angleSpread: 10,
    baseVertices: 24,
    basePasses: 4,
    baseVariance: 0.17,
    layerPasses: 2,
    layerVariance: 0.07,
    watercolorPasses: 36,
    layerAlpha: 0.018,
    bleedBlur: 3,
    densityBoost: 0.92,
    opacity: 0.72,           // slightly stronger so the darker palette still reads
    granulation: 0.08,       // was 0.16 — softer per-pixel speckle inside cloud lobes
    seed: 7602,
    // Parallax-animation knobs, consumed by main.js's per-frame offset
    // updater. Slower than the tuner / HTML defaults so the drift reads
    // as ambient texture rather than active motion.
    baseSpeed: 1.1,          // was 2.0 (HTML) / undefined here
    speedSpread: 1.8,        // was 2.96
    tileScale: 0.95,
};

// Palette: dark scratchpad-azure gradient from azureWatercolorBaked.js,
// plus cloud-tint stops tuned to sit DARKER than the gradient so the
// cloud lobes read as dim texture patches rather than bright puffs. None
// of these stops appear in the baked PNG configs because they got
// rasterised into the PNG content — for live regeneration we set them
// explicitly here.
export const PAL_DEFAULT = {
    bgTop:       '#2563c8',
    bgMid:       '#1d58bd',
    bgBot:       '#0d3f91',
    haze:        '#1c3f80',  // was #dfeefe (near-white) — now mid-dark blue
    cloudCool:   '#0e2c5e',  // was #cce6fb
    cloudWarm:   '#1f3f7d',  // was #f2f8ff
    cloudShadow: '#06163a',  // was #3a6db2 — now deep navy
};

function mulberry32(seed) {
    let s = (seed >>> 0) || 1;
    return function () {
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function gaussianRandom(rng) {
    const u1 = Math.max(1e-10, rng());
    const u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
function parseHex(hex) {
    const h = hex.replace('#', '');
    return [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
    ];
}
function mixRGB(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function smoothstep(lo, hi, x) {
    const t = clamp01((x - lo) / (hi - lo));
    return t * t * (3 - 2 * t);
}
function hash2i(x, y, seed) {
    let h = (x * 374761393) ^ (y * 668265263) ^ (seed * 2147483647);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h = h ^ (h >>> 16);
    return ((h >>> 0) % 16777216) / 16777216;
}
function tileValueNoise(x, y, period, cellSize, seed) {
    const cells = Math.max(2, Math.round(period / cellSize));
    const gx = x / cellSize, gy = y / cellSize;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const tx = gx - x0, ty = gy - y0;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const wrap = (v) => ((v % cells) + cells) % cells;
    const h00 = hash2i(wrap(x0),     wrap(y0),     seed);
    const h10 = hash2i(wrap(x0 + 1), wrap(y0),     seed);
    const h01 = hash2i(wrap(x0),     wrap(y0 + 1), seed);
    const h11 = hash2i(wrap(x0 + 1), wrap(y0 + 1), seed);
    const nx0 = h00 + (h10 - h00) * sx;
    const nx1 = h01 + (h11 - h01) * sx;
    return nx0 + (nx1 - nx0) * sy;
}

function makeEllipse(cx, cy, rx, ry, angle, n) {
    const pts = [];
    const ca = Math.cos(angle), sa = Math.sin(angle);
    for (let i = 0; i < n; i++) {
        const t = (i / n) * Math.PI * 2;
        const ex = Math.cos(t) * rx;
        const ey = Math.sin(t) * ry;
        pts.push([cx + ex * ca - ey * sa, cy + ex * sa + ey * ca]);
    }
    return pts;
}
function deformOnce(pts, variance, rng) {
    const out = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % n];
        out.push(a);
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 0.5) {
            out.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
            continue;
        }
        const px = -dy / len;
        const py =  dx / len;
        const disp = gaussianRandom(rng) * variance * len;
        out.push([(a[0] + b[0]) / 2 + px * disp, (a[1] + b[1]) / 2 + py * disp]);
    }
    return out;
}
function deform(pts, passes, variance, rng) {
    for (let i = 0; i < passes; i++) pts = deformOnce(pts, variance, rng);
    return pts;
}
function clonePoly(pts) { return pts.map((p) => [p[0], p[1]]); }
function polyPath(ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
}

// Pad + blur + crop trick to keep gaussian blur seamless across tile edges.
function wrapBlurCanvas(canvas, radius) {
    const S = canvas.width;
    const pad = Math.max(8, Math.ceil(radius * 4 + 2));
    const padded = document.createElement('canvas');
    padded.width = S + pad * 2;
    padded.height = S + pad * 2;
    const pctx = padded.getContext('2d');
    for (let wy = -1; wy <= 1; wy++) {
        for (let wx = -1; wx <= 1; wx++) {
            pctx.drawImage(canvas, pad + wx * S, pad + wy * S);
        }
    }
    const blurred = document.createElement('canvas');
    blurred.width = padded.width;
    blurred.height = padded.height;
    const bctx = blurred.getContext('2d');
    bctx.filter = `blur(${radius}px)`;
    bctx.drawImage(padded, 0, 0);
    bctx.filter = 'none';
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, S, S);
    ctx.drawImage(blurred, pad, pad, S, S, 0, 0, S, S);
}

function generateLayerMask(params, layerIndex) {
    const S = params.tileSize | 0;
    const mask = document.createElement('canvas');
    mask.width = S;
    mask.height = S;
    const ctx = mask.getContext('2d');
    ctx.clearRect(0, 0, S, S);

    const rng = mulberry32(params.seed + layerIndex * 100003);
    const minSize = Math.min(params.minSize, params.maxSize);
    const maxSize = Math.max(params.minSize, params.maxSize);
    const layerT = params.parallaxLayers <= 1 ? 0 : layerIndex / (params.parallaxLayers - 1);
    const clouds = Math.max(1, params.cloudsPerLayer | 0);
    const lobes  = Math.max(1, params.lobesPerCloud | 0);
    const allLobes = [];

    for (let ci = 0; ci < clouds; ci++) {
        const cloudX = rng() * S;
        const cloudY = rng() * S;
        const sizeJitter = 0.92 + rng() * 0.22 + layerT * 0.08;
        const cloudSize = (minSize + rng() * (maxSize - minSize)) * S * sizeJitter;
        for (let li = 0; li < lobes; li++) {
            const spreadX = (rng() - 0.5) * 2 * params.lobeSpread * cloudSize;
            const spreadY = (rng() - 0.5) * 2 * params.lobeSpread * cloudSize * 0.42;
            const aspect = Math.max(1, params.aspectRatio + (rng() - 0.5) * params.aspectJitter);
            const rx = cloudSize * (0.42 + rng() * 0.48);
            const ry = rx / aspect;
            const angle = (rng() - 0.5) * 2 * params.angleSpread * Math.PI / 180;
            allLobes.push({
                x: cloudX + spreadX,
                y: cloudY + spreadY,
                rx, ry, angle,
                t: clamp01(cloudY / S),
            });
        }
    }

    ctx.globalCompositeOperation = 'source-over';
    for (const lobe of allLobes) {
        const lobeSeed = params.seed + layerIndex * 13007 + Math.round(lobe.x * 1000 + lobe.y * 777);
        const lobeRng = mulberry32(lobeSeed);
        const ellipse = makeEllipse(lobe.x, lobe.y, lobe.rx, lobe.ry, lobe.angle, params.baseVertices | 0);
        const master = deform(ellipse, params.basePasses | 0, params.baseVariance, lobeRng);
        const maxDim = Math.max(lobe.rx, lobe.ry) * 2.05;
        const wrap = Math.max(1, Math.ceil(maxDim / S) + 1);
        const posR = Math.round(lobe.t * 255);

        ctx.fillStyle = `rgb(${posR},255,255)`;
        ctx.globalAlpha = params.layerAlpha;

        for (let layer = 0; layer < params.watercolorPasses; layer++) {
            const shapeSeed = params.seed + layerIndex * 90011 + layer * 7919 + Math.round(lobe.x * 100);
            const layerRng = mulberry32(shapeSeed);
            const shape = deform(clonePoly(master), params.layerPasses | 0, params.layerVariance, layerRng);
            for (let wy = -wrap; wy <= wrap; wy++) {
                for (let wx = -wrap; wx <= wrap; wx++) {
                    const ox = wx * S;
                    const oy = wy * S;
                    const cx = lobe.x + ox;
                    const cy = lobe.y + oy;
                    if (cx + maxDim < 0 || cx - maxDim > S) continue;
                    if (cy + maxDim < 0 || cy - maxDim > S) continue;
                    if (ox === 0 && oy === 0) {
                        polyPath(ctx, shape);
                    } else {
                        ctx.save();
                        ctx.translate(ox, oy);
                        polyPath(ctx, shape);
                        ctx.restore();
                    }
                    ctx.fill();
                }
            }
        }
    }
    ctx.globalAlpha = 1;
    if (params.bleedBlur > 0) wrapBlurCanvas(mask, params.bleedBlur);
    return mask;
}

function colorizeLayer(mask, params, pal, layerIndex) {
    const S = mask.width;
    const tile = document.createElement('canvas');
    tile.width = S;
    tile.height = S;
    const ctx = tile.getContext('2d');
    const maskData = mask.getContext('2d').getImageData(0, 0, S, S).data;
    const img = ctx.createImageData(S, S);
    const out = img.data;

    const haze   = parseHex(pal.haze);
    const cool   = parseHex(pal.cloudCool);
    const warm   = parseHex(pal.cloudWarm);
    const shadow = parseHex(pal.cloudShadow);
    const countT = params.parallaxLayers <= 1 ? 0 : layerIndex / (params.parallaxLayers - 1);
    const layerOpacity = params.opacity * (0.52 + countT * 0.26);

    for (let py = 0; py < S; py++) {
        for (let px = 0; px < S; px++) {
            const i = (py * S + px) * 4;
            let density = maskData[i + 3] / 255;
            if (density < 0.010) {
                out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0;
                continue;
            }
            const posT = maskData[i] / 255;
            density = clamp01(1 - Math.pow(1 - clamp01(density * params.densityBoost), 1.18));
            const coreT = smoothstep(0.05, 0.62, density);
            const washT = clamp01(posT * 0.62 + countT * 0.18);
            const wash  = mixRGB(cool, warm, washT);
            const edge  = mixRGB(haze, wash, coreT * 0.72);
            const core  = mixRGB(wash, shadow, Math.pow(density, 1.45) * 0.30);
            let col = mixRGB(edge, core, coreT);

            const grain = (tileValueNoise(px, py, S, 4, params.seed + layerIndex * 4099) - 0.5) * params.granulation;
            const alphaGrain = 0.90 + tileValueNoise(px, py, S, 16, params.seed + layerIndex * 811) * 0.18;
            col[0] = Math.max(0, Math.min(255, col[0] + grain * 58));
            col[1] = Math.max(0, Math.min(255, col[1] + grain * 48));
            col[2] = Math.max(0, Math.min(255, col[2] + grain * 34));

            const alpha = clamp01(Math.pow(density, 1.08) * layerOpacity * alphaGrain);
            out[i]     = col[0];
            out[i + 1] = col[1];
            out[i + 2] = col[2];
            out[i + 3] = alpha * 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    return tile;
}

export function makeGrainCanvas(seed) {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 256;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(c.width, c.height);
    const d = img.data;
    for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
            const i = (y * c.width + x) * 4;
            const n = tileValueNoise(x, y, c.width, 4, seed + 991);
            const v = 118 + (n - 0.5) * 80;
            d[i] = d[i + 1] = d[i + 2] = v;
            d[i + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    return c;
}

export function bakeAzureParallaxLayers(overrides = {}) {
    const P   = { ...P_DEFAULT,   ...(overrides.P   || {}) };
    const PAL = { ...PAL_DEFAULT, ...(overrides.PAL || {}) };
    const count = Math.max(3, Math.min(4, P.parallaxLayers | 0));
    P.parallaxLayers = count;
    const layers = [];
    for (let i = 0; i < count; i++) {
        const mask = generateLayerMask(P, i);
        layers.push(colorizeLayer(mask, P, PAL, i));
    }
    const grain = makeGrainCanvas(P.seed);
    return { P, PAL, layers, grain };
}

// Bake a single static equirect sphere texture using the same watercolor
// cloud generator as the parallax backdrop, but with a parchment palette
// instead of azure. Output is a 4096×2048 canvas with: the parchment
// gradient as base, every cloud layer drawn (no parallax — fixed
// composition), and an overlay-grain pass. The tile is 2048 wide and is
// drawn twice across the 4096 canvas so the texture tiles cleanly at the
// lon = ±180° seam. Returned canvas can be passed to setParchmentImage()
// the same way the baked PNGs are.
const PAL_PARCHMENT_DEFAULT = {
    bgTop:       '#f5ead6',
    bgMid:       '#ecdcb8',
    bgBot:       '#d9b88a',
    haze:        '#cdb088',
    cloudCool:   '#9d7848',
    cloudWarm:   '#b89260',
    cloudShadow: '#5a3a14',
};
const P_PARCHMENT_DEFAULT = {
    tileSize: 2048,
    parallaxLayers: 3,
    cloudsPerLayer: 3,
    lobesPerCloud: 5,
    lobeSpread: 0.62,
    minSize: 0.38,
    maxSize: 0.90,
    opacity: 0.48,
    granulation: 0.10,
    seed: 4217,
};
// Lighter variant: same algorithm, paler cream-white palette and lower
// per-layer opacity so the background reads stronger.
const PAL_PARCHMENT_LIGHT_DEFAULT = {
    bgTop:       '#fbf6e9',
    bgMid:       '#f6ecd6',
    bgBot:       '#ecdcbd',
    haze:        '#e0c69e',
    cloudCool:   '#c2a070',
    cloudWarm:   '#d4b388',
    cloudShadow: '#8a6a3a',
};
const P_PARCHMENT_LIGHT_OVERRIDES = {
    opacity: 0.32,
    granulation: 0.07,
};

export function bakeParchmentCloudSphereLight(overrides = {}) {
    return bakeParchmentCloudSphere({
        P:   { ...P_PARCHMENT_LIGHT_OVERRIDES, ...(overrides.P   || {}) },
        PAL: { ...PAL_PARCHMENT_LIGHT_DEFAULT, ...(overrides.PAL || {}) },
        outputW: overrides.outputW,
        outputH: overrides.outputH,
    });
}

export function bakeParchmentCloudSphere(overrides = {}) {
    const layersResult = bakeAzureParallaxLayers({
        P:   { ...P_PARCHMENT_DEFAULT,   ...(overrides.P   || {}) },
        PAL: { ...PAL_PARCHMENT_DEFAULT, ...(overrides.PAL || {}) },
    });
    const W = (overrides.outputW | 0) || 4096;
    const H = (overrides.outputH | 0) || 2048;
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const ctx = out.getContext('2d');

    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0,    layersResult.PAL.bgTop);
    grad.addColorStop(0.48, layersResult.PAL.bgMid);
    grad.addColorStop(1,    layersResult.PAL.bgBot);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    const TILE = layersResult.layers[0].width;
    for (const layer of layersResult.layers) {
        for (let x = 0; x < W; x += TILE) {
            for (let y = 0; y < H; y += TILE) {
                ctx.drawImage(layer, x, y);
            }
        }
    }

    const grainTile = layersResult.grain;
    const G = grainTile.width;
    ctx.globalAlpha = 0.045;
    ctx.globalCompositeOperation = 'overlay';
    for (let y = 0; y < H; y += G) {
        for (let x = 0; x < W; x += G) {
            ctx.drawImage(grainTile, x, y);
        }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    return out;
}
