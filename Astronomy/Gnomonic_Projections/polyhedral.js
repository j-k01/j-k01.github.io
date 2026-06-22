import {
    affineFromPolygons,
    preRenderEarthFaces,
    preRenderMilkyWayFaces,
    extractMilkyWayTextureData,
    allocateMilkyWayFaceCanvases,
    fillMilkyWayFaces,
} from './earth.js';
import {
    imagoForward, imagoInverse, imagoRectSize,
    imagoWideForward, imagoWideInverse, imagoWideRectSize,
} from './imago.js';
import { buildPolyhedron, polyhedronName } from './polyhedra.js';
import {
    makeGrainCanvas,
    bakeParchmentCloudSphere,
    bakeParchmentCloudSphereLight,
} from './azureParallaxBaker.js';

// Per-frame scratch vectors used by _updateCutEdgeLines so the inner Bezier
// loop doesn't allocate. Module-scoped to stay alive across all ModeI
// instances; the function only ever runs on one instance at a time.
const _scratchCutA0 = new THREE.Vector3();
const _scratchCutA1 = new THREE.Vector3();
const _scratchCutA2 = new THREE.Vector3();
const _scratchCutB0 = new THREE.Vector3();
const _scratchCutB1 = new THREE.Vector3();
const _scratchCutB2 = new THREE.Vector3();
const _scratchCutMid  = new THREE.Vector3();
const _scratchCutCtrl = new THREE.Vector3();
const _scratchCutP1   = new THREE.Vector3();
const _scratchCutP2   = new THREE.Vector3();
const _scratchCutSagDir = new THREE.Vector3();

function _bezierPoint(out, A, C, B, t) {
    const u = 1 - t;
    out.x = u * u * A.x + 2 * u * t * C.x + t * t * B.x;
    out.y = u * u * A.y + 2 * u * t * C.y + t * t * B.y;
    out.z = u * u * A.z + 2 * u * t * C.z + t * t * B.z;
}

// Lazy-baked canvases used as the texture for the Mode I backing tile that
// appears under the fully-unfolded net. One cache per "style" slug. Bakes
// (parchmentClouds + parchmentCloudsLight) are heavy so we defer them
// until the user actually selects that style; cartographer / cottonRag /
// whiteWash / shaderPaper come from main.js's PNG-loaded ImageData and
// are converted to canvases on demand.
const _modeIBackingCanvasCache = new Map();
function _getModeIBackingCanvasBaked(slug) {
    let canvas = _modeIBackingCanvasCache.get(slug);
    if (canvas) return canvas;
    const t0 = (typeof performance !== 'undefined') ? performance.now() : 0;
    if (slug === 'parchmentCloudsLight') {
        canvas = bakeParchmentCloudSphereLight({ outputW: 2048, outputH: 2048 });
    } else if (slug === 'parchmentClouds') {
        canvas = bakeParchmentCloudSphere({ outputW: 2048, outputH: 2048 });
    } else {
        return null;
    }
    if (typeof console !== 'undefined') {
        const dt = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
        console.log(`[modeI] backing tile '${slug}' baked in ${Math.round(dt)}ms`);
    }
    _modeIBackingCanvasCache.set(slug, canvas);
    return canvas;
}

// FINAL_TWIST_PRESETS — additional in-plane rotation (radians) applied
// around the camera-look-axis at t = 1 so specific (polyhedron, strategy)
// combinations land in the visual orientation the project wants. Keyed by
// `${polyhedron.type}:${strategy}` with a `${type}:` fallback used for any
// strategy. Values can be overridden at runtime via setFinalTwist (e.g.
// arrow-key tuning in main.js); the override map below wins over the
// hardcoded presets when set.
const FINAL_TWIST_PRESETS = {
    // Hand-tuned via the arrow-key adjuster in main.js — see the console
    // log it prints on every keypress. Edit by running the app, picking
    // the matching shape + strategy, tapping ArrowLeft/Right (Shift for
    // fine step) until the unfold lands in the desired orientation, then
    // lifting the printed value here.
    'cube:steepest':              25 * Math.PI / 180,    // 0.43633 rad
    'waterman5:butterfly':        30 * Math.PI / 180,    // 0.52360 rad
    'dymaxionIcosa:dymaxion':     35 * Math.PI / 180,    // 0.61087 rad
    'pentagonalBipyramid:steepest': -50 * Math.PI / 180, // -0.87266 rad
};
const _finalTwistOverrides = new Map();
function _getFinalTwistRad(polyType, strategy) {
    if (!polyType) return 0;
    const exactKey = `${polyType}:${strategy}`;
    if (_finalTwistOverrides.has(exactKey)) return _finalTwistOverrides.get(exactKey);
    const anyKey = `${polyType}:`;
    if (_finalTwistOverrides.has(anyKey)) return _finalTwistOverrides.get(anyKey);
    if (FINAL_TWIST_PRESETS[exactKey] !== undefined) return FINAL_TWIST_PRESETS[exactKey];
    if (FINAL_TWIST_PRESETS[anyKey]   !== undefined) return FINAL_TWIST_PRESETS[anyKey];
    return 0;
}
function _setFinalTwistRad(polyType, strategy, rad) {
    if (!polyType) return;
    _finalTwistOverrides.set(`${polyType}:${strategy}`, rad);
}

// Cached 256x256 grain tile that matches the Mode I backdrop's grain pass.
// Lazily built on first request so the import side-effect stays cheap.
let _azureGrainTile = null;
function _getAzureGrainTile() {
    if (!_azureGrainTile) _azureGrainTile = makeGrainCanvas(7602);
    return _azureGrainTile;
}
function _applyAzureGrainOverlay(ctx, size, opacity) {
    const grain = _getAzureGrainTile();
    const G = grain.width;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.globalCompositeOperation = 'overlay';
    for (let y = 0; y < size; y += G) {
        for (let x = 0; x < size; x += G) {
            ctx.drawImage(grain, x, y);
        }
    }
    ctx.restore();
}

// Project the celestial sphere onto the faces of an inscribed Platonic solid.
// Each face = gnomonic projection of a patch of sky onto a flat N-gon. The
// active polyhedron is chosen via PolyhedralProjection.setPolyhedronType(); the
// default is the regular dodecahedron.
//
// View modes (toggle from main.js):
//   A - 3D inscribed widget   (polyhedron wireframe + face-projected star points + constellation lines)
//   B - 2D unfolded net       (faces drawn on a Canvas2D overlay, in a grid)
//   C - 2D single targeted face (one face full-screen, arrow keys cycle)
//   D - 2D topological unfold (spanning-tree based)
//   E - Imago / AuthaGraph-style (fixed tetrahedron, polyhedron selector does NOT apply)
//   F - Waterman butterfly W5 with detached south-pole tips
//   G - Simplified octant butterfly (fixed truncated-octahedron hexes)
//   J - AuthaGraph-inspired 96-triangle rigid fold
//
// API:
//   const p = new PolyhedralProjection(scene, sphereRadius, starCapacity)
//   p.attachCanvases(canvasB, canvasC, canvasD, canvasE, canvasF, canvasG)
//   p.setStarPropsFn(star => ({ visible, colorHex, colorCss, size, opacity }))
//   p.setConstellationLines(linePairs)  // Array<[starId1, starId2]>
//   p.setMode('A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J')
//   p.setPolyhedronType('tetra' | 'cube' | 'octa' | 'dodec' | 'icosa')
//   p.update(starMap)

// 3x3 row-major rotation matrix that takes unit vector `from` to unit vector `to`.
// Uses minimum-angle rotation (axis = from x to).
function rotationFromTo(from, to) {
    const cosA = Math.max(-1, Math.min(1, from[0]*to[0] + from[1]*to[1] + from[2]*to[2]));
    if (cosA > 0.999999) return [1,0,0, 0,1,0, 0,0,1];
    if (cosA < -0.999999) {
        // Antipodal: 180deg rotation about any axis perpendicular to `from`.
        const perp = Math.abs(from[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
        const d = from[0]*perp[0] + from[1]*perp[1] + from[2]*perp[2];
        const px = perp[0] - from[0]*d, py = perp[1] - from[1]*d, pz = perp[2] - from[2]*d;
        const pl = Math.sqrt(px*px + py*py + pz*pz);
        return rodrigues3([px/pl, py/pl, pz/pl], Math.PI);
    }
    const ax = from[1]*to[2] - from[2]*to[1];
    const ay = from[2]*to[0] - from[0]*to[2];
    const az = from[0]*to[1] - from[1]*to[0];
    const al = Math.sqrt(ax*ax + ay*ay + az*az);
    return rodrigues3([ax/al, ay/al, az/al], Math.acos(cosA));
}

function rodrigues3(axis, angle) {
    const c = Math.cos(angle), s = Math.sin(angle), oc = 1 - c;
    const x = axis[0], y = axis[1], z = axis[2];
    return [
        c + oc*x*x,   oc*x*y - s*z, oc*x*z + s*y,
        oc*x*y + s*z, c + oc*y*y,   oc*y*z - s*x,
        oc*x*z - s*y, oc*y*z + s*x, c + oc*z*z,
    ];
}

function projectDirToFace(unitDir, faces, inradius) {
    // For each face, the ray from origin in unitDir crosses the face plane
    // at distance t = face.planeDist / (unitDir . normal). Prefer the
    // nearest hit whose projected point lies inside the face polygon; this
    // matters when a logical face is split into coplanar pieces.
    let bestAny = null, bestInside = null;
    for (let i = 0; i < faces.length; i++) {
        const face = faces[i];
        const dot = unitDir.dot(face.normal);
        if (dot <= 0) continue;
        const t = face.planeDist / dot;
        if (!Number.isFinite(t) || t <= 0) continue;

        const px = unitDir.x * t;
        const py = unitDir.y * t;
        const pz = unitDir.z * t;
        const ox = px - face.center.x;
        const oy = py - face.center.y;
        const oz = pz - face.center.z;
        const u = ox * face.basisU.x + oy * face.basisU.y + oz * face.basisU.z;
        const v = ox * face.basisV.x + oy * face.basisV.y + oz * face.basisV.z;
        const candidate = { face, t, px, py, pz, u, v };

        if (!bestAny || t < bestAny.t) bestAny = candidate;
        if (face.vertices2D && _faceCanvas_pointInPolygonOrEdge(u, v, face.vertices2D, _faceCanvas_faceHitTolerance(face))) {
            if (!bestInside || t < bestInside.t) bestInside = candidate;
        }
    }
    const best = bestInside || bestAny;
    if (!best) return null;
    return {
        face: best.face,
        point3D: new THREE.Vector3(best.px, best.py, best.pz),
        u: best.u,
        v: best.v,
    };
}

function hexToCss(n) {
    return '#' + n.toString(16).padStart(6, '0');
}

// 2D point-in-polygon test against a polygon given as [{u, v}, ...]. Used by
// per-face Earth canvas rasterizers to skip pixels outside the face polygon.
function _faceCanvas_pointInPolygon(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].u, yi = poly[i].v;
        const xj = poly[j].u, yj = poly[j].v;
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}

function _faceCanvas_faceHitTolerance(face) {
    return 1e-6 * Math.max(1, face && face.faceCircumradius ? face.faceCircumradius : 1);
}

function _faceCanvas_pointOnSegment(x, y, ax, ay, bx, by, eps) {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 <= eps * eps) return Math.hypot(x - ax, y - ay) <= eps;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
    const px = ax + t * dx;
    const py = ay + t * dy;
    return (x - px) * (x - px) + (y - py) * (y - py) <= eps * eps;
}

function _faceCanvas_pointInPolygonOrEdge(x, y, poly, eps = 1e-7) {
    if (!poly || poly.length < 3) return false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        if (_faceCanvas_pointOnSegment(x, y, poly[j].u, poly[j].v, poly[i].u, poly[i].v, eps)) {
            return true;
        }
    }
    return _faceCanvas_pointInPolygon(x, y, poly);
}

// Build a per-face canvas at the given size by stroking/filling SVG country
// paths (already parsed to lat-lon) through the face's gnomonic projection.
// Result: a Canvas with `polygonCorners` (face's 2D vertices in canvas pixel
// coords) usable as a face texture in Mode A-2. Lines are drawn by the
// canvas-2D API's native antialiased path rasterization — vector-crisp at any
// screen size or distortion.
// Precomputed per-pixel brightness OFFSETS that reproduce all THREE
// procedural-noise layers of the Mode I WebGL backdrop:
//   1. hash21 per-pixel grain   (`grain  * 0.045 * 255` ≈ ±5.74)
//   2. smooth value noise blob1 (`(blob1 - 0.5) * 0.05  * 255` ≈ ±6.4)
//   3. smooth value noise blob2 (`(blob2 - 0.5) * 0.025 * 255` ≈ ±3.2)
//
// Sum is applied ADDITIVELY to the face's bg colour (rather than via the
// canvas 'overlay' composite) because overlay produces near-zero offset on
// bright base colours like the parchment #f5e7c1 default, which made the
// grain invisible. Additive matches the WebGL backdrop math identically:
// `col_out = col_base + offset`, clamped to [0, 255].
//
// The offsets are face-LOCAL — same noise pattern on every face — because
// the backdrop's blob layers index by screen coords; sampling them in
// face-local space gives the same character if not the same pattern.
let _faceNoiseOffsets = null;
function _hash21(x, y) {
    let px = x * 123.34, py = y * 456.21;
    px -= Math.floor(px); py -= Math.floor(py);
    const d = px * (px + 45.32) + py * (py + 45.32);
    px += d; py += d;
    let r = px * py;
    return r - Math.floor(r);
}
function _smoothNoise(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const a = _hash21(ix, iy);
    const b = _hash21(ix + 1, iy);
    const c = _hash21(ix, iy + 1);
    const d = _hash21(ix + 1, iy + 1);
    return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
}
function _getFaceNoiseOffsets(size) {
    if (_faceNoiseOffsets && _faceNoiseOffsets._size === size) return _faceNoiseOffsets;
    const offsets = new Float32Array(size * size);
    offsets._size = size;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const fcX = x + 0.5;
            const fcY = y + 0.5;
            const grain = _hash21(fcX, fcY) - 0.5;
            // Blob noise sampled in normalized face coords so both scales
            // produce features at predictable sizes regardless of canvas
            // resolution.
            const buvX = fcX / size;
            const buvY = fcY / size;
            const blob1 = _smoothNoise(buvX * 2.0, buvY * 2.0);
            const blob2 = _smoothNoise(buvX * 5.0, buvY * 5.0);
            offsets[y * size + x] =
                grain         * 0.045 * 255
              + (blob1 - 0.5) * 0.050 * 255
              + (blob2 - 0.5) * 0.025 * 255;
        }
    }
    _faceNoiseOffsets = offsets;
    return offsets;
}

// Gnomonic-project an equirectangular sphere image (e.g. the baked parchment
// PNGs from bake-parchment.html) onto a single face's canvas. Each output
// pixel back-projects through the face plane to a 3D direction, then samples
// the equirect source at (lon, lat). The resulting canvas is intended as the
// pre-Earth-content background layer in renderEarthFaceFromSvgPaths.
//
// `parchmentData` must be a precomputed ImageData (so callers avoid the
// per-face getImageData cost). Layout / rotation convention matches the
// Earth-content rendering (faceFirstAngle → rotation, scale = pxRadius /
// face.faceCircumradius), so the parchment lines up exactly with the
// continental strokes painted on top.
function renderParchmentFaceBackground(face, parchmentData, size) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    // alpha:false so the per-face parchment canvas (used as bgCanvas by the
    // Earth renderers above) is itself fully opaque, even before its loop
    // writes alpha=255 — no chance for a stray transparent pixel to slip
    // through if the loop ever skips one.
    const ctx = canvas.getContext('2d', { alpha: false });
    const half = size / 2;
    const pxRadius = half * 0.95;
    const faceFirstAngle = Math.atan2(face.vertices2D[0].v, face.vertices2D[0].u);
    const rotation = Math.PI / 2 - faceFirstAngle;
    const cosR = Math.cos(rotation), sinR = Math.sin(rotation);
    const scale = pxRadius / face.faceCircumradius;

    const pw = parchmentData.width, ph = parchmentData.height;
    const src = parchmentData.data;
    const cx = face.center.x, cy = face.center.y, cz = face.center.z;
    const bUx = face.basisU.x, bUy = face.basisU.y, bUz = face.basisU.z;
    const bVx = face.basisV.x, bVy = face.basisV.y, bVz = face.basisV.z;

    const out = ctx.createImageData(size, size);
    const dst = out.data;
    const INV_2PI = 1 / (2 * Math.PI);
    const INV_PI = 1 / Math.PI;
    const phMinus1 = ph - 1;
    for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
            const uR = (px + 0.5 - half) / scale;
            const vR = (half - (py + 0.5)) / scale;
            // Inverse of the forward rotation used by Earth-path rendering:
            //   (u, v)_canvas = (u·cosR − v·sinR,  u·sinR + v·cosR)
            const u = uR * cosR + vR * sinR;
            const v = -uR * sinR + vR * cosR;
            // Face-plane point → unit direction (gnomonic from origin).
            const pX = cx + u * bUx + v * bVx;
            const pY = cy + u * bUy + v * bVy;
            const pZ = cz + u * bUz + v * bVz;
            const len = Math.sqrt(pX * pX + pY * pY + pZ * pZ) || 1;
            const nx = pX / len, ny = pY / len, nz = pZ / len;
            // Equirect lookup. App convention: lon = atan2(−z, x).
            const lat = Math.asin(ny < -1 ? -1 : (ny > 1 ? 1 : ny));
            const lon = Math.atan2(-nz, nx);
            // Bilinear sample. Each face covers ~10–25% of the sphere, so a
            // 1024-wide source map gives only ~100–250 source pixels per
            // face — nearest-neighbour shows obvious stair-stepping. Bilinear
            // smooths it out cheaply; bake higher (e.g. 4096) for true detail.
            const ftx = (lon * INV_2PI + 0.5) * pw;
            const fty = (0.5 - lat * INV_PI) * ph;
            const ix0 = Math.floor(ftx);
            const iy0 = Math.floor(fty);
            const fx = ftx - ix0;
            const fy = fty - iy0;
            const x0 = ((ix0 % pw) + pw) % pw;
            const x1 = ((ix0 + 1) % pw + pw) % pw;
            const y0 = iy0 < 0 ? 0 : (iy0 > phMinus1 ? phMinus1 : iy0);
            const y1 = (iy0 + 1) < 0 ? 0 : ((iy0 + 1) > phMinus1 ? phMinus1 : (iy0 + 1));
            const i00 = (y0 * pw + x0) * 4;
            const i10 = (y0 * pw + x1) * 4;
            const i01 = (y1 * pw + x0) * 4;
            const i11 = (y1 * pw + x1) * 4;
            const w00 = (1 - fx) * (1 - fy);
            const w10 = fx * (1 - fy);
            const w01 = (1 - fx) * fy;
            const w11 = fx * fy;
            const di = (py * size + px) * 4;
            dst[di]     = src[i00]     * w00 + src[i10]     * w10 + src[i01]     * w01 + src[i11]     * w11;
            dst[di + 1] = src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
            dst[di + 2] = src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;
            dst[di + 3] = 255;
        }
    }
    ctx.putImageData(out, 0, 0);
    return canvas;
}

function renderEarthFaceFromSvgPaths(face, faces, pathData, style, size, bgCanvas, grainEnabled) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    // alpha:false — opaque backing store so the WebGL texture never carries
    // partial-alpha pixels (otherwise the HTML backdrop bleeds through the
    // tile even with material.transparent=false).
    const ctx = canvas.getContext('2d', { alpha: false });

    const half = size / 2;
    const pxRadius = half * 0.95;
    const faceFirstAngle = Math.atan2(face.vertices2D[0].v, face.vertices2D[0].u);
    const rotation = Math.PI / 2 - faceFirstAngle;
    const cosR = Math.cos(rotation), sinR = Math.sin(rotation);
    const scale = pxRadius / face.faceCircumradius;

    // bgCanvas (when provided) is a pre-rendered parchment/texture image
    // already gnomonically projected to this face's frame; paint it instead
    // of the plain bgColor fill so Earth content draws on top of it.
    if (bgCanvas) {
        ctx.drawImage(bgCanvas, 0, 0, size, size);
        if (grainEnabled !== false) {
            // Match the Mode I backdrop's grain pass — 256x256 value-noise
            // tile overlay-blended at low opacity. Applied on top of the
            // parchment so the Earth content drawn below picks up its own
            // grain tone through the blend.
            _applyAzureGrainOverlay(ctx, size, 0.06);
        }
    } else {
        ctx.fillStyle = style.bgColor || '#ffffff';
        ctx.fillRect(0, 0, size, size);
        if (grainEnabled !== false) {
            // Apply all three procedural-noise layers from the Mode I
            // backdrop (per-pixel hash grain + two smooth-noise blobs)
            // ADDITIVELY in pixel space. Overlay blend was disappearing on
            // bright parchment base colours; additive shifts by the same
            // absolute amount no matter how saturated the base is.
            const imgData = ctx.getImageData(0, 0, size, size);
            const data = imgData.data;
            const offsets = _getFaceNoiseOffsets(size);
            for (let i = 0, k = 0; k < offsets.length; k++, i += 4) {
                const o = offsets[k];
                let r = data[i]     + o;
                let g = data[i + 1] + o;
                let b = data[i + 2] + o;
                data[i]     = r < 0 ? 0 : r > 255 ? 255 : r;
                data[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
                data[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
            }
            ctx.putImageData(imgData, 0, 0);
        }
    }

    // Project (lat_rad, lon_rad) directly onto THIS face's plane (no per-call
    // projectDirToFace loop). Returns null if the direction is parallel to or
    // behind the face. Points whose natural face is a neighbour still resolve
    // to a valid (possibly off-polygon) canvas position; the face-polygon
    // mesh clips them on the GPU so lines end exactly at the polygon edge
    // instead of stopping at the last source-point inside the polygon.
    const fnX = face.normal.x, fnY = face.normal.y, fnZ = face.normal.z;
    const planeDist = face.planeDist;
    const fcX = face.center.x, fcY = face.center.y, fcZ = face.center.z;
    const bUx = face.basisU.x, bUy = face.basisU.y, bUz = face.basisU.z;
    const bVx = face.basisV.x, bVy = face.basisV.y, bVz = face.basisV.z;
    const MAX_OFFSCREEN = size * 4;   // cap runaway projections so canvas API stays happy
    const projectLatLon = (lat, lon) => {
        const cosLat = Math.cos(lat);
        // Geographic-frame unit direction. lon=0 (Greenwich) at +X,
        // lon=+90E at -Z, matching the rest of Mode A-2's conventions.
        const dx = cosLat * Math.cos(lon);
        const dy = Math.sin(lat);
        const dz = -cosLat * Math.sin(lon);
        const dot = dx * fnX + dy * fnY + dz * fnZ;
        if (dot <= 1e-6) return null;   // direction misses (or grazes) face plane
        const t = planeDist / dot;
        const px = dx * t, py = dy * t, pz = dz * t;
        const ux = px - fcX, uy = py - fcY, uz = pz - fcZ;
        const u = ux * bUx + uy * bUy + uz * bUz;
        const v = ux * bVx + uy * bVy + uz * bVz;
        const uR = u * cosR - v * sinR;
        const vR = u * sinR + v * cosR;
        const cx = half + scale * uR;
        const cy = half - scale * vR;
        if (Math.abs(cx - half) > MAX_OFFSCREEN || Math.abs(cy - half) > MAX_OFFSCREEN) return null;
        return { x: cx, y: cy };
    };

    ctx.lineJoin = 'round';
    ctx.lineCap  = 'round';
    const strokeWidth = style.strokeWidthPx || 1.0;

    for (const path of pathData.paths) {
        const cls = path.className || '';
        const isATA = /\bATA\b/.test(cls);
        const isGRL = /\bGRL\b/.test(cls);
        const specialFillColor =
            (isATA && style.antarcticFill) ? style.antarcticFill :
            (isGRL && style.greenlandFill) ? style.greenlandFill : null;

        ctx.beginPath();
        let penDown = false;
        for (const pt of path.points) {
            const p = projectLatLon(pt.lat, pt.lon);
            if (!p) {
                penDown = false;
                continue;
            }
            // pt.skipFromPrev is set by earth.js's edge-dedupe pass for the
            // "continents" preset on segments shared between two country paths
            // — i.e. internal land-land borders. We move the pen rather than
            // drawing, so only land-water boundaries get stroked.
            if (!penDown || pt.move || pt.skipFromPrev) {
                ctx.moveTo(p.x, p.y);
                penDown = true;
            } else {
                ctx.lineTo(p.x, p.y);
            }
        }

        if (specialFillColor) {
            ctx.fillStyle = specialFillColor;
            ctx.fill();
        } else if (style.fill) {
            ctx.fillStyle = style.fill;
            ctx.fill();
        }
        if (style.stroke) {
            ctx.strokeStyle = style.stroke;
            ctx.lineWidth = strokeWidth;
            ctx.stroke();
        }
    }

    canvas.polygonCorners = face.vertices2D.map(({ u, v }) => {
        const uR = u * cosR - v * sinR;
        const vR = u * sinR + v * cosR;
        return { x: half + scale * uR, y: half - scale * vR };
    });
    return canvas;
}

// Per-face canvas rasterized by gnomonic-sampling an equirectangular raster
// image. Used by Mode A-2 for raster-source presets (terrain) so all paths
// take the same per-face-canvas pipeline as SVG paths. Same orientation
// convention (+X = lon 0, -Z = lon +90E) as renderEarthFaceFromSvgPaths.
function renderEarthFaceFromRaster(face, faces, earthImage, size, bgCanvas) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    // alpha:false forces an opaque backing store. Without it, the canvas
    // carries an alpha channel that leaks into the WebGL texture: the
    // outside-polygon pixels written below would land at alpha=0, bilinear
    // filtering would bleed that into the polygon edge, and the HTML
    // backdrop behind the WebGL canvas would show through the tile.
    const ctx = canvas.getContext('2d', { alpha: false });
    const half = size / 2;
    const pxRadius = half * 0.95;
    const faceFirstAngle = Math.atan2(face.vertices2D[0].v, face.vertices2D[0].u);
    const rotation = Math.PI / 2 - faceFirstAngle;
    const cosR = Math.cos(rotation), sinR = Math.sin(rotation);
    const scale = pxRadius / face.faceCircumradius;
    // When the parchment background is enabled, paint it under the Earth
    // raster sampling. The raster sampling below only writes pixels inside
    // the polygon — outside-polygon pixels keep the parchment colour
    // (read off the canvas via getImageData below) so the tile is
    // fully opaque across the entire face canvas.
    if (bgCanvas) {
        ctx.drawImage(bgCanvas, 0, 0, size, size);
        // Same overlay-grain pass as the SVG path renderer above; matches
        // the Mode I backdrop's grain tile so the parchment reads with
        // the same noise tone as the live background.
        _applyAzureGrainOverlay(ctx, size, 0.06);
    } else {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, size, size);
    }
    const bgPixels = ctx.getImageData(0, 0, size, size).data;

    const sw = earthImage.naturalWidth  || earthImage.width;
    const sh = earthImage.naturalHeight || earthImage.height;
    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = sw;
    sourceCanvas.height = sh;
    const sctx = sourceCanvas.getContext('2d');
    sctx.drawImage(earthImage, 0, 0);
    let texData;
    try {
        texData = sctx.getImageData(0, 0, sw, sh);
    } catch (e) {
        // CORS-tainted; fall back to a blank face canvas
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, size, size);
        canvas.polygonCorners = face.vertices2D.map(({ u, v }) => {
            const uR = u * cosR - v * sinR;
            const vR = u * sinR + v * cosR;
            return { x: half + scale * uR, y: half - scale * vR };
        });
        return canvas;
    }
    const tw = texData.width, th = texData.height;
    const texPixels = texData.data;
    const imgData = ctx.createImageData(size, size);
    const pixels = imgData.data;
    const verts2D = face.vertices2D;
    const cx = face.center.x, cy = face.center.y, cz = face.center.z;
    const bUx = face.basisU.x, bUy = face.basisU.y, bUz = face.basisU.z;
    const bVx = face.basisV.x, bVy = face.basisV.y, bVz = face.basisV.z;

    for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
            const j = (py * size + px) * 4;
            const uR = (px - half) / scale;
            const vR = (half - py) / scale;
            const u = uR * cosR + vR * sinR;
            const v = -uR * sinR + vR * cosR;
            if (!_faceCanvas_pointInPolygon(u, v, verts2D)) {
                // Outside polygon: keep the bg colour (parchment/white)
                // we already painted, but at full alpha so bilinear
                // filtering across the polygon edge stays opaque.
                pixels[j]     = bgPixels[j];
                pixels[j + 1] = bgPixels[j + 1];
                pixels[j + 2] = bgPixels[j + 2];
                pixels[j + 3] = 255;
                continue;
            }
            const xx = cx + u * bUx + v * bVx;
            const yy = cy + u * bUy + v * bVy;
            const zz = cz + u * bUz + v * bVz;
            const len = Math.sqrt(xx * xx + yy * yy + zz * zz);
            const nx = xx / len, ny = yy / len, nz = zz / len;
            const lat = Math.asin(ny < -1 ? -1 : (ny > 1 ? 1 : ny));
            // lon = atan2(-z, x) — matches the Mode A-2 shader's atan(z, -x)
            // convention so the same lat/lon-> texel formula works.
            const lon = Math.atan2(-nz, nx);
            let tx = (lon / (2 * Math.PI) + 0.5) * tw;
            let ty = (0.5 - lat / Math.PI) * th;
            if (tx < 0) tx = 0; else if (tx >= tw) tx = tw - 1; else tx |= 0;
            if (ty < 0) ty = 0; else if (ty >= th) ty = th - 1; else ty |= 0;
            const ti = (ty * tw + tx) * 4;
            pixels[j]     = texPixels[ti];
            pixels[j + 1] = texPixels[ti + 1];
            pixels[j + 2] = texPixels[ti + 2];
            pixels[j + 3] = 255;
        }
    }
    ctx.putImageData(imgData, 0, 0);

    canvas.polygonCorners = face.vertices2D.map(({ u, v }) => {
        const uR = u * cosR - v * sinR;
        const vR = u * sinR + v * cosR;
        return { x: half + scale * uR, y: half - scale * vR };
    });
    return canvas;
}

// Shared scratch vectors to avoid per-call allocation.
const _tmpDirA = new THREE.Vector3();
const _tmpDirB = new THREE.Vector3();
const _tmpEclipDir = new THREE.Vector3();

// Apply a 3x3 row-major matrix M to a THREE.Vector3 in place. Used for the
// observer-to-geographic rotation pushed to face-based modes so their stars
// land on the same polyhedron points that the geographic-frame Earth
// renderer samples to.
function applyObsToGeo(M, v) {
    const x = v.x, y = v.y, z = v.z;
    v.x = M[0] * x + M[1] * y + M[2] * z;
    v.y = M[3] * x + M[4] * y + M[5] * z;
    v.z = M[6] * x + M[7] * y + M[8] * z;
}

// J2000 galactic-to-this-app's-celestial-frame matrix (rows of standard
// galactic-to-equatorial permuted so celY corresponds to NCP).
const GAL_TO_CEL = [
    -0.0548755604, -0.8734370902, -0.4838350155,  // celX = std x_eq
    -0.8676661490, -0.1980763734,  0.4559837762,  // celY = std z_eq (NCP)
     0.4941094279, -0.4448296300,  0.7469822445,  // celZ = std y_eq
];

// Compose observer-to-galactic = (skyRotation * GAL_TO_CEL)^T. skyRotation is
// celestial->observer, both row-major 3x3. Returned matrix is also row-major.
function computeObsToGal(skyRotation) {
    const out = new Array(9);
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            let s = 0;
            for (let k = 0; k < 3; k++) s += skyRotation[i * 3 + k] * GAL_TO_CEL[k * 3 + j];
            out[j * 3 + i] = s;  // transpose
        }
    }
    return out;
}

// Bucket consecutive (closed) ecliptic-point pairs per face. `projFn(dir)`
// returns { face, u, v } or null. `getFaceIdx(face)` lets callers customise
// bucket indexing when face.idx is not 0..n-1 (eg. Mode G's hexFaces).
function bucketEcliptic(points, bucketCount, projFn, getFaceIdx = (f => f.idx)) {
    const buckets = Array.from({ length: bucketCount }, () => []);
    if (!points || points.length < 2) return buckets;
    let prev = null;
    for (let i = 0; i <= points.length; i++) {
        _tmpEclipDir.copy(points[i % points.length]).normalize();
        const r = projFn(_tmpEclipDir);
        if (prev && r) {
            const pi = getFaceIdx(prev.face), ri = getFaceIdx(r.face);
            if (pi === ri && pi >= 0 && pi < bucketCount) {
                buckets[ri].push({ u1: prev.u, v1: prev.v, u2: r.u, v2: r.v });
            }
        }
        prev = r;
    }
    return buckets;
}

// Bucket multiple closed polylines (eg. the +/-8 deg zodiac band) into a
// single shared per-face bucket. Cheaper than running bucketEcliptic once
// per line and concatenating since face-index lookup happens in one pass.
function bucketEclipticLines(lines, bucketCount, projFn, getFaceIdx = (f => f.idx)) {
    const buckets = Array.from({ length: bucketCount }, () => []);
    if (!lines) return buckets;
    for (const points of lines) {
        if (!points || points.length < 2) continue;
        let prev = null;
        for (let i = 0; i <= points.length; i++) {
            _tmpEclipDir.copy(points[i % points.length]).normalize();
            const r = projFn(_tmpEclipDir);
            if (prev && r) {
                const pi = getFaceIdx(prev.face), ri = getFaceIdx(r.face);
                if (pi === ri && pi >= 0 && pi < bucketCount) {
                    buckets[ri].push({ u1: prev.u, v1: prev.v, u2: r.u, v2: r.v });
                }
            }
            prev = r;
        }
    }
    return buckets;
}

const ECLIPTIC_COLOR = '#ffaa44';        // canvas stroke (central ecliptic)
const ECLIPTIC_COLOR_HEX = 0xffaa44;     // three.js material (central ecliptic)
const ZODIAC_BAND_COLOR = '#cc7733';     // dimmer for boundary lines
const ZODIAC_BAND_COLOR_HEX = 0xcc7733;

// =====================================================================
// Mode A - 3D inscribed widget.
// =====================================================================
class ModeA {
    constructor(scene, polyhedron, starCapacity) {
        this.scene = scene;
        this.polyhedron = polyhedron;
        this.faces = polyhedron.faces;
        this.R = polyhedron.R;
        this.inradius = polyhedron.inradius;
        this.group = new THREE.Group();
        this.constellationLines = [];

        this._opaque = false;
        this._buildPolyhedronMeshes();

        const sphereGeom = new THREE.SphereGeometry(this.R, 24, 16);
        this.sphereLines = new THREE.LineSegments(
            new THREE.WireframeGeometry(sphereGeom),
            new THREE.LineBasicMaterial({ color: 0x223344, transparent: true, opacity: 0.18 })
        );
        this.group.add(this.sphereLines);

        // Star points cloud
        this.starCapacity = starCapacity;
        this.positions = new Float32Array(starCapacity * 3);
        this.spherePositions = new Float32Array(starCapacity * 3);
        this.colors = new Float32Array(starCapacity * 3);

        // Per-star twinkle attributes (phase, speed) are deterministic per
        // index and shared between both Mode A star geoms — same index has
        // the same twinkle timing in the polyhedron-projected view and on
        // the celestial sphere. `sizes` is populated in update() from
        // star.size.
        this.starSizes = new Float32Array(starCapacity);
        const _twinkleFixed = fillTwinkleStarAttribs(starCapacity);
        this.starPhases = _twinkleFixed.phases;
        this.starSpeeds = _twinkleFixed.speeds;

        const starGeom = new THREE.BufferGeometry();
        starGeom.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
        starGeom.setAttribute('color',    new THREE.BufferAttribute(this.colors,    3));
        starGeom.setAttribute('aPhase',   new THREE.BufferAttribute(this.starPhases, 1));
        starGeom.setAttribute('aSpeed',   new THREE.BufferAttribute(this.starSpeeds, 1));
        starGeom.setAttribute('aSize',    new THREE.BufferAttribute(this.starSizes,  1));
        this.starGeom = starGeom;
        // Foreground stars on the polyhedron faces — full brightness, modest
        // size since multiple stars cluster on each face.
        this.starPoints = new THREE.Points(starGeom,
            makeTwinkleStarMaterial({ sizeBase: 16.0, sizeFloor: 4.0, dim: 1.0 }));
        this.group.add(this.starPoints);

        // Sphere star points (dimmer, on the outer celestial sphere). Same
        // shader, same per-star attributes (so a star twinkles in sync on
        // both renderings), just smaller and dimmer.
        const sphereStarsGeom = new THREE.BufferGeometry();
        sphereStarsGeom.setAttribute('position', new THREE.BufferAttribute(this.spherePositions, 3));
        sphereStarsGeom.setAttribute('color',    new THREE.BufferAttribute(this.colors,    3));
        sphereStarsGeom.setAttribute('aPhase',   new THREE.BufferAttribute(this.starPhases, 1));
        sphereStarsGeom.setAttribute('aSpeed',   new THREE.BufferAttribute(this.starSpeeds, 1));
        sphereStarsGeom.setAttribute('aSize',    new THREE.BufferAttribute(this.starSizes,  1));
        this.sphereStarsGeom = sphereStarsGeom;
        this.sphereStars = new THREE.Points(sphereStarsGeom,
            makeTwinkleStarMaterial({ sizeBase: 10.0, sizeFloor: 2.0, dim: 0.55 }));
        this.group.add(this.sphereStars);

        // Constellation line segments - geometry allocated in setConstellationLines.
        this.linePositions = null;
        this.lineGeom = null;
        this.lines = null;

        // Ecliptic - allocated in setEcliptic().
        this.eclipticPoints = null;
        this.eclipticPositions = null;
        this.eclipticLineGeom = null;
        this.eclipticLine = null;
        this.eclipticSpherePositions = null;
        this.eclipticSphereGeom = null;
        this.eclipticSphereLine = null;

        // Zodiac band - allocated in setZodiacBand(). One LineSegments holds
        // all band polylines (typically 2: +/-8 deg ecliptic-lat). Separate
        // buffer for the celestial-sphere companion line.
        this.zodiacBands = null;
        this.zodiacPositions = null;
        this.zodiacLineGeom = null;
        this.zodiacLine = null;
        this.zodiacSpherePositions = null;
        this.zodiacSphereGeom = null;
        this.zodiacSphereLine = null;

        // Milky Way panorama - BackSide sphere textured with an equirectangular
        // galactic-frame image. Allocated in setMilkyWayImage; oriented per
        // frame via setSkyRotation(R_celestial_to_observer).
        this.milkyWaySphere = null;
        this._skyRotation = null;

        // Overlay visibility flags. MW defaults off because its per-frame
        // rotation compose is cheap but the 2D modes' MW work is heavy enough
        // that the global default is off.
        this._showConstellations = true;
        this._showEcliptic = true;
        this._showZodiac = true;
        this._showMW = false;
        this._showFaceOutlines = true;

        this.group.visible = false;
        scene.add(this.group);
    }

    setVisible(v) { this.group.visible = v; }

    setEarthMesh(mesh) {
        if (this.earthMesh) this.group.remove(this.earthMesh);
        this.earthMesh = mesh;
        if (mesh) this.group.add(mesh);
    }

    setConstellationLines(linePairs) {
        this.constellationLines = linePairs;
        if (this.lines) {
            this.group.remove(this.lines);
            this.lineGeom.dispose();
        }
        // Each line is subdivided into LINE_SEGMENTS pieces along its great-circle
        // arc, so the polyline traces the dodec surface (kinks at face edges)
        // instead of cutting through the interior.
        this.lineSegmentsPerLine = 24;
        this.lineCapacity = linePairs.length * this.lineSegmentsPerLine;
        this.linePositions = new Float32Array(this.lineCapacity * 6);
        this.lineGeom = new THREE.BufferGeometry();
        this.lineGeom.setAttribute('position', new THREE.BufferAttribute(this.linePositions, 3));
        this.lines = new THREE.LineSegments(this.lineGeom,
            new THREE.LineBasicMaterial({ color: 0x6688aa, transparent: true, opacity: 0.55 }));
        this.lines.visible = this._showConstellations;
        this.group.add(this.lines);
    }

    setEcliptic(xyzArray) {
        if (this.eclipticLine) {
            this.group.remove(this.eclipticLine);
            this.eclipticLineGeom.dispose();
            this.eclipticLine = null;
        }
        if (this.eclipticSphereLine) {
            this.group.remove(this.eclipticSphereLine);
            this.eclipticSphereGeom.dispose();
            this.eclipticSphereLine = null;
        }
        this.eclipticPoints = xyzArray || null;
        if (!xyzArray || xyzArray.length < 2) return;
        // Each pair of consecutive ecliptic samples (looped) generates one
        // segment on the polyhedron face surface (kink at face edges).
        const segCount = xyzArray.length;
        this.eclipticPositions = new Float32Array(segCount * 6);
        this.eclipticLineGeom = new THREE.BufferGeometry();
        this.eclipticLineGeom.setAttribute('position',
            new THREE.BufferAttribute(this.eclipticPositions, 3));
        this.eclipticLine = new THREE.LineSegments(this.eclipticLineGeom,
            new THREE.LineBasicMaterial({ color: ECLIPTIC_COLOR_HEX, transparent: true, opacity: 0.95 }));
        this.eclipticLine.visible = this._showEcliptic;
        this.group.add(this.eclipticLine);

        // Companion line on the outer celestial sphere (so the ecliptic is
        // visible against the sky too, not just on the polyhedron facets).
        this.eclipticSpherePositions = new Float32Array(segCount * 6);
        this.eclipticSphereGeom = new THREE.BufferGeometry();
        this.eclipticSphereGeom.setAttribute('position',
            new THREE.BufferAttribute(this.eclipticSpherePositions, 3));
        this.eclipticSphereLine = new THREE.LineSegments(this.eclipticSphereGeom,
            new THREE.LineBasicMaterial({ color: ECLIPTIC_COLOR_HEX, transparent: true, opacity: 0.5 }));
        this.eclipticSphereLine.visible = this._showEcliptic;
        this.group.add(this.eclipticSphereLine);
    }

    setZodiacBand(bands) {
        if (this.zodiacLine) {
            this.group.remove(this.zodiacLine);
            this.zodiacLineGeom.dispose();
            this.zodiacLine = null;
        }
        if (this.zodiacSphereLine) {
            this.group.remove(this.zodiacSphereLine);
            this.zodiacSphereGeom.dispose();
            this.zodiacSphereLine = null;
        }
        this.zodiacBands = bands || null;
        if (!bands || bands.length === 0) return;
        let totalSegs = 0;
        for (const b of bands) if (b && b.length >= 2) totalSegs += b.length;
        if (totalSegs === 0) return;
        this.zodiacPositions = new Float32Array(totalSegs * 6);
        this.zodiacLineGeom = new THREE.BufferGeometry();
        this.zodiacLineGeom.setAttribute('position',
            new THREE.BufferAttribute(this.zodiacPositions, 3));
        this.zodiacLine = new THREE.LineSegments(this.zodiacLineGeom,
            new THREE.LineBasicMaterial({ color: ZODIAC_BAND_COLOR_HEX, transparent: true, opacity: 0.55 }));
        this.zodiacLine.visible = this._showZodiac;
        this.group.add(this.zodiacLine);

        this.zodiacSpherePositions = new Float32Array(totalSegs * 6);
        this.zodiacSphereGeom = new THREE.BufferGeometry();
        this.zodiacSphereGeom.setAttribute('position',
            new THREE.BufferAttribute(this.zodiacSpherePositions, 3));
        this.zodiacSphereLine = new THREE.LineSegments(this.zodiacSphereGeom,
            new THREE.LineBasicMaterial({ color: ZODIAC_BAND_COLOR_HEX, transparent: true, opacity: 0.3 }));
        this.zodiacSphereLine.visible = this._showZodiac;
        this.group.add(this.zodiacSphereLine);
    }

    setMilkyWayImage(img) {
        if (this.milkyWaySphere) {
            this.group.remove(this.milkyWaySphere);
            this.milkyWaySphere.geometry.dispose();
            this.milkyWaySphere.material.map.dispose();
            this.milkyWaySphere.material.dispose();
            this.milkyWaySphere = null;
        }
        if (!img) return;
        const tex = new THREE.Texture(img);
        tex.needsUpdate = true;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        // Mesh on the celestial sphere itself - the MW is painted *onto* the
        // sphere, not used as a skybox. R*0.99 keeps it just inside the
        // wireframe so stars (drawn at R) sit on top.
        const radius = this.R * 0.99;
        const geom = new THREE.SphereGeometry(radius, 128, 64);
        const mat = new THREE.MeshBasicMaterial({
            map: tex,
            side: THREE.FrontSide,
            transparent: true,
            opacity: 1.0,
            depthWrite: false,
        });
        this.milkyWaySphere = new THREE.Mesh(geom, mat);
        // Render before stars + facets so they sit on top, but after the
        // wireframe sphere so the MW reads as the painted-on backdrop.
        this.milkyWaySphere.renderOrder = -5;
        this.milkyWaySphere.visible = this._showMW;
        this.group.add(this.milkyWaySphere);
        if (this._showMW) this._applyMilkyWayOrientation();
    }

    setSkyRotation(m) {
        this._skyRotation = m;
        if (this._showMW) this._applyMilkyWayOrientation();
    }

    setConstellationsVisible(v) {
        this._showConstellations = !!v;
        if (this.lines) this.lines.visible = this._showConstellations;
    }
    setEclipticVisible(v) {
        this._showEcliptic = !!v;
        if (this.eclipticLine) this.eclipticLine.visible = this._showEcliptic;
        if (this.eclipticSphereLine) this.eclipticSphereLine.visible = this._showEcliptic;
    }
    setZodiacVisible(v) {
        this._showZodiac = !!v;
        if (this.zodiacLine) this.zodiacLine.visible = this._showZodiac;
        if (this.zodiacSphereLine) this.zodiacSphereLine.visible = this._showZodiac;
    }
    setMilkyWayVisible(v) {
        this._showMW = !!v;
        if (this.milkyWaySphere) this.milkyWaySphere.visible = this._showMW;
        if (this._showMW) this._applyMilkyWayOrientation();
    }

    // Compose R_celestial_to_observer * R_galactic_to_celestial * R_sphereLocal_to_galactic
    // and apply as the Milky Way sphere's local orientation. The first two
    // matrices live in the celestial/galactic conventions documented below;
    // the third is the empirical fixup mapping the equirectangular-texture
    // UV frame onto galactic axes.
    _applyMilkyWayOrientation() {
        if (!this.milkyWaySphere || !this._skyRotation) return;
        const R = this._skyRotation;  // celestial -> observer, this app's celestial convention
        // Galactic -> celestial (this app's celestial: +X=vernal eq, +Y=NCP, +Z=RA90).
        // Built from the standard J2000 galactic-to-equatorial matrix by
        // permuting rows so celY corresponds to the NCP (standard z_eq).
        const G = [
            -0.0548755604, -0.8734370902, -0.4838350155,  // celX (= std x_eq)
            -0.8676661490, -0.1980763734,  0.4559837762,  // celY (= std z_eq, NCP)
             0.4941094279, -0.4448296300,  0.7469822445,  // celZ (= std y_eq)
        ];
        // Sphere-local -> galactic. Three.js SphereGeometry with default UV
        // mapping puts the texture's u=0 seam on the -Z axis going CCW (when
        // viewed from +Y), so the texture center (u=0.5, v=0.5) ends up at
        // sphere local +Z. We want the texture center (galactic center,
        // l=0 b=0) to map to galactic +X. Rotate sphere-local by +90 deg
        // around +Y to swap +Z -> +X.
        const cos90 = 0, sin90 = 1;
        const S = [
            cos90,  0, sin90,
                0,  1,     0,
           -sin90,  0, cos90,
        ];
        // M = R * G * S
        const GS = new Array(9);
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
            let s = 0;
            for (let k = 0; k < 3; k++) s += G[i*3+k] * S[k*3+j];
            GS[i*3+j] = s;
        }
        const M = new Array(9);
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
            let s = 0;
            for (let k = 0; k < 3; k++) s += R[i*3+k] * GS[k*3+j];
            M[i*3+j] = s;
        }
        const m4 = new THREE.Matrix4();
        m4.set(
            M[0], M[1], M[2], 0,
            M[3], M[4], M[5], 0,
            M[6], M[7], M[8], 0,
            0,    0,    0,    1,
        );
        this.milkyWaySphere.quaternion.setFromRotationMatrix(m4);
    }

    update(starMap, getStarProps) {
        if (!this.group.visible) return;

        // 1) Stars
        let n = 0;
        for (const star of starMap.values()) {
            if (!star.XYZ) continue;
            const props = getStarProps(star);
            if (!props || !props.visible) continue;
            if (n >= this.starCapacity) break;
            _tmpDirA.copy(star.XYZ).normalize();
            const result = projectDirToFace(_tmpDirA, this.faces, this.inradius);
            if (!result) continue;
            this.positions[n*3]   = result.point3D.x;
            this.positions[n*3+1] = result.point3D.y;
            this.positions[n*3+2] = result.point3D.z;
            this.spherePositions[n*3]   = star.XYZ.x;
            this.spherePositions[n*3+1] = star.XYZ.y;
            this.spherePositions[n*3+2] = star.XYZ.z;
            // Mode A now uses the same twinkle shader + stylized BV palette
            // as Mode K so star colours read consistently across modes
            // (red→orange→white→blue→purple, more saturated than the
            // physical CIE response colorFromBV gives elsewhere).
            const rgb = modeKColorFromBV(star.BV);
            this.colors[n*3]   = rgb[0] / 255;
            this.colors[n*3+1] = rgb[1] / 255;
            this.colors[n*3+2] = rgb[2] / 255;
            // aSize attribute (shared between starPoints and sphereStars
            // geoms): brightest catalog star ~1.4, dimmest ~0.25.
            this.starSizes[n] = star.size != null ? star.size : 0.7;
            n++;
        }
        this.starGeom.attributes.position.needsUpdate = true;
        this.starGeom.attributes.color.needsUpdate    = true;
        this.starGeom.attributes.aSize.needsUpdate    = true;
        this.starGeom.setDrawRange(0, n);
        this.sphereStarsGeom.attributes.position.needsUpdate = true;
        this.sphereStarsGeom.attributes.color.needsUpdate    = true;
        this.sphereStarsGeom.attributes.aSize.needsUpdate    = true;
        this.sphereStarsGeom.setDrawRange(0, n);

        // 2) Constellation lines - slerp N points along each great-circle arc,
        // project each onto its containing dodec face, and emit connecting
        // segments. Each segment connects two consecutive sub-points; within a
        // single face the chain reproduces a straight line (gnomonic projects
        // great circles to lines), and at a face boundary the polyline "folds".
        if (this._showConstellations && this.lines) {
            const N = this.lineSegmentsPerLine;
            let ln = 0;
            const interpDir = new THREE.Vector3();
            for (const [aId, bId] of this.constellationLines) {
                const a = starMap.get(aId);
                const b = starMap.get(bId);
                if (!a || !b || !a.XYZ || !b.XYZ) continue;
                const pa = getStarProps(a);
                const pb = getStarProps(b);
                if (!pa || !pb || !pa.visible || !pb.visible) continue;
                _tmpDirA.copy(a.XYZ).normalize();
                _tmpDirB.copy(b.XYZ).normalize();
                const dot = Math.max(-1, Math.min(1, _tmpDirA.dot(_tmpDirB)));
                const omega = Math.acos(dot);
                const sinO = Math.sin(omega);

                let prevX = 0, prevY = 0, prevZ = 0, hasPrev = false;
                for (let i = 0; i <= N; i++) {
                    const t = i / N;
                    if (sinO < 1e-9) {
                        interpDir.copy(_tmpDirA);
                    } else {
                        const s0 = Math.sin((1 - t) * omega) / sinO;
                        const s1 = Math.sin(t * omega) / sinO;
                        interpDir.copy(_tmpDirA).multiplyScalar(s0).addScaledVector(_tmpDirB, s1);
                    }
                    const r = projectDirToFace(interpDir, this.faces, this.inradius);
                    if (!r) { hasPrev = false; continue; }
                    const px = r.point3D.x, py = r.point3D.y, pz = r.point3D.z;
                    if (hasPrev && ln < this.lineCapacity) {
                        this.linePositions[ln * 6]     = prevX;
                        this.linePositions[ln * 6 + 1] = prevY;
                        this.linePositions[ln * 6 + 2] = prevZ;
                        this.linePositions[ln * 6 + 3] = px;
                        this.linePositions[ln * 6 + 4] = py;
                        this.linePositions[ln * 6 + 5] = pz;
                        ln++;
                    }
                    prevX = px; prevY = py; prevZ = pz;
                    hasPrev = true;
                }
            }
            this.lineGeom.attributes.position.needsUpdate = true;
            this.lineGeom.setDrawRange(0, ln * 2);
        }

        // 3) Ecliptic - same surface-tracing scheme as constellation lines.
        if (this._showEcliptic && this.eclipticLine && this.eclipticPoints) {
            const n = this.eclipticPoints.length;
            let el = 0;
            let prevPx = 0, prevPy = 0, prevPz = 0;
            let prevSpX = 0, prevSpY = 0, prevSpZ = 0;
            let hasPrev = false;
            for (let i = 0; i <= n; i++) {
                const v = this.eclipticPoints[i % n];
                const len = Math.hypot(v.x, v.y, v.z) || 1;
                _tmpDirA.set(v.x / len, v.y / len, v.z / len);
                const r = projectDirToFace(_tmpDirA, this.faces, this.inradius);
                const spx = _tmpDirA.x * this.R, spy = _tmpDirA.y * this.R, spz = _tmpDirA.z * this.R;
                if (!r) { hasPrev = false; continue; }
                const px = r.point3D.x, py = r.point3D.y, pz = r.point3D.z;
                if (hasPrev && el < n) {
                    this.eclipticPositions[el * 6]     = prevPx;
                    this.eclipticPositions[el * 6 + 1] = prevPy;
                    this.eclipticPositions[el * 6 + 2] = prevPz;
                    this.eclipticPositions[el * 6 + 3] = px;
                    this.eclipticPositions[el * 6 + 4] = py;
                    this.eclipticPositions[el * 6 + 5] = pz;
                    this.eclipticSpherePositions[el * 6]     = prevSpX;
                    this.eclipticSpherePositions[el * 6 + 1] = prevSpY;
                    this.eclipticSpherePositions[el * 6 + 2] = prevSpZ;
                    this.eclipticSpherePositions[el * 6 + 3] = spx;
                    this.eclipticSpherePositions[el * 6 + 4] = spy;
                    this.eclipticSpherePositions[el * 6 + 5] = spz;
                    el++;
                }
                prevPx = px; prevPy = py; prevPz = pz;
                prevSpX = spx; prevSpY = spy; prevSpZ = spz;
                hasPrev = true;
            }
            this.eclipticLineGeom.attributes.position.needsUpdate = true;
            this.eclipticLineGeom.setDrawRange(0, el * 2);
            this.eclipticSphereGeom.attributes.position.needsUpdate = true;
            this.eclipticSphereGeom.setDrawRange(0, el * 2);
        }

        // 4) Zodiac band - one polyline per band; project each point to a
        // face and emit surface segments + companion sphere segments.
        if (this._showZodiac && this.zodiacLine && this.zodiacBands && this.zodiacBands.length) {
            let zl = 0;
            const cap = this.zodiacPositions.length / 6;
            for (const band of this.zodiacBands) {
                if (!band || band.length < 2) continue;
                const n = band.length;
                let prevPx = 0, prevPy = 0, prevPz = 0;
                let prevSpX = 0, prevSpY = 0, prevSpZ = 0;
                let hasPrev = false;
                for (let i = 0; i <= n; i++) {
                    const v = band[i % n];
                    const len = Math.hypot(v.x, v.y, v.z) || 1;
                    _tmpDirA.set(v.x / len, v.y / len, v.z / len);
                    const r = projectDirToFace(_tmpDirA, this.faces, this.inradius);
                    const spx = _tmpDirA.x * this.R, spy = _tmpDirA.y * this.R, spz = _tmpDirA.z * this.R;
                    if (!r) { hasPrev = false; continue; }
                    const px = r.point3D.x, py = r.point3D.y, pz = r.point3D.z;
                    if (hasPrev && zl < cap) {
                        this.zodiacPositions[zl * 6]     = prevPx;
                        this.zodiacPositions[zl * 6 + 1] = prevPy;
                        this.zodiacPositions[zl * 6 + 2] = prevPz;
                        this.zodiacPositions[zl * 6 + 3] = px;
                        this.zodiacPositions[zl * 6 + 4] = py;
                        this.zodiacPositions[zl * 6 + 5] = pz;
                        this.zodiacSpherePositions[zl * 6]     = prevSpX;
                        this.zodiacSpherePositions[zl * 6 + 1] = prevSpY;
                        this.zodiacSpherePositions[zl * 6 + 2] = prevSpZ;
                        this.zodiacSpherePositions[zl * 6 + 3] = spx;
                        this.zodiacSpherePositions[zl * 6 + 4] = spy;
                        this.zodiacSpherePositions[zl * 6 + 5] = spz;
                        zl++;
                    }
                    prevPx = px; prevPy = py; prevPz = pz;
                    prevSpX = spx; prevSpY = spy; prevSpZ = spz;
                    hasPrev = true;
                }
            }
            this.zodiacLineGeom.attributes.position.needsUpdate = true;
            this.zodiacLineGeom.setDrawRange(0, zl * 2);
            this.zodiacSphereGeom.attributes.position.needsUpdate = true;
            this.zodiacSphereGeom.setDrawRange(0, zl * 2);
        }
    }

    setEarthVisible(v) { if (this.earthMesh) this.earthMesh.visible = v; }
    setSphereVisible(v) {
        if (this.sphereLines) this.sphereLines.visible = v;
        if (this.sphereStars) this.sphereStars.visible = v;
    }
    // Polyhedron wireframe + fill visibility / opacity.
    setDodecVisible(v) {
        if (this.polyLines) this.polyLines.visible = v;
        if (this.polyFill) this.polyFill.visible = v;
    }
    // Toggle the inscribed solid between translucent shell (default) and
    // opaque body. Three.js r121 doesn't always reliably recompile a material
    // when the transparent flag flips mid-flight, so we just swap in a fresh
    // one. Opaque uses depthWrite + polygonOffset so face-projected star
    // points and constellation lines stay on the outside surface without
    // z-fighting and back-of-shape content is correctly hidden.
    setDodecOpaque(v) {
        this._opaque = v;
        if (!this.polyFill) return;
        const old = this.polyFill.material;
        this.polyFill.material = this._buildFillMaterial(v);
        if (old && old.dispose) old.dispose();
    }

    _buildFillMaterial(opaque) {
        return opaque
            ? new THREE.MeshBasicMaterial({
                color: 0x0e2540, transparent: false, opacity: 1.0,
                side: THREE.DoubleSide, depthWrite: true,
                polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
            })
            : new THREE.MeshBasicMaterial({
                color: 0x1a3a5c, transparent: true, opacity: 0.10,
                side: THREE.DoubleSide, depthWrite: false,
            });
    }

    _buildPolyhedronMeshes() {
        const geom = this.polyhedron.threeGeometry;
        const edges = new THREE.EdgesGeometry(geom);
        this.polyLines = new THREE.LineSegments(edges,
            new THREE.LineBasicMaterial({ color: 0x55aaff, transparent: true, opacity: 0.55 }));
        this.group.add(this.polyLines);
        this.polyFill = new THREE.Mesh(geom, this._buildFillMaterial(this._opaque));
        this.group.add(this.polyFill);
    }

    _disposePolyhedronMeshes() {
        if (this.polyLines) {
            this.group.remove(this.polyLines);
            if (this.polyLines.geometry) this.polyLines.geometry.dispose();
            if (this.polyLines.material) this.polyLines.material.dispose();
            this.polyLines = null;
        }
        if (this.polyFill) {
            this.group.remove(this.polyFill);
            if (this.polyFill.geometry) this.polyFill.geometry.dispose();
            if (this.polyFill.material) this.polyFill.material.dispose();
            this.polyFill = null;
        }
    }

    // Swap to a new polyhedron (preserves star + sphere meshes, replaces only
    // the wireframe + fill). Caller is responsible for updating `this.faces`
    // bookkeeping in dependent modes - the manager does this.
    setPolyhedron(polyhedron) {
        this.polyhedron = polyhedron;
        this.faces = polyhedron.faces;
        this.inradius = polyhedron.inradius;
        this._disposePolyhedronMeshes();
        this._buildPolyhedronMeshes();
    }
}

// =====================================================================
// Mode A-2 - 3D widget showing the Earth wrapped onto the polyhedron.
// Skips the gnomonic-canvas pipeline entirely - those exist for the 2D
// unfold modes, which need face-shaped bitmaps. Here we have flat 3D
// polygons, so we use the same equirectangular Earth image the Mode A
// globe uses, and compute per-vertex UVs from each vertex's 3D direction
// using Three.js SphereGeometry's convention. Linear UV interpolation
// across each face gives a clean "Earth wrapped on a polyhedron" that
// agrees with the Mode A globe.
// =====================================================================
class ModeA2 {
    constructor(scene, polyhedron) {
        this.scene = scene;
        this.polyhedron = polyhedron;
        this.faces = polyhedron.faces;
        this.group = new THREE.Group();
        this.faceMeshes = [];
        this.edgeLines = null;
        this._showFaceOutlines = true;

        // Per-face Earth pipeline. The face texture is rendered offscreen:
        //   - SVG-source presets (outlines/bare/solid) -> per-face canvas with
        //     country paths stroked/filled via the gnomonic projection, so the
        //     outlines stay vector-crisp at any face distortion.
        //   - Raster preset (terrain) -> per-face canvas via gnomonic raster
        //     sampling at 1024^2 (same algorithm as earth.js renderEarthFace,
        //     just higher resolution per face than the 256 used by Modes B/C/D).
        this._earthImage = null;
        this._earthSvgPaths = null;
        this._earthStyle = null;
        this._faceCanvases = [];
        this._faceTextures = [];
        this._faceCanvasSize = 1024;
        this._faceMeshesDirty = false;  // defer expensive per-face renders until A-2 is visible

        // Optional elevation-ridgeline overlay (off by default). Loads the
        // ETOPO-derived curve binary on demand; rebuilds when polyhedron R,
        // exaggeration, projection mode, or lat-step density changes.
        this._elevCurves = null;
        this._elevCurvesMeta = null;
        this._elevLineSegments = null;
        this._elevExag = 150;
        this._elevProjectionMode = 'polygon';   // 'polygon' = on faces; 'sphere' = wrap circumradius
        this._elevLatStepDeg = 3;               // density of latitude curves; ETOPO binaries exist at 0.5/1/2/3/5
        this._showElev = false;
        this._facesOpaque = true;
        this._landOnly = false;
        this._edgeRadiusFactor = 0.004;         // fraction of polyhedron R used for the gold tube edges
        this.EARTH_R_METERS = 6378137.0;   // WGS84 semi-major axis (matches source CRS)

        this._buildEdgeWireframe();

        this.group.visible = false;
        scene.add(this.group);
    }

    _buildEdgeWireframe() {
        // Tear down any previous wireframe — it's a Group containing one
        // CylinderGeometry mesh per polyhedron edge (rebuilt on polyhedron
        // swap or rebuild). LineBasicMaterial.linewidth is ignored by WebGL,
        // so we use actual 3D cylinder geometry to get visibly thick gold
        // edges that read like illuminated borders.
        if (this.edgeLines) {
            this.group.remove(this.edgeLines);
            this.edgeLines.traverse((obj) => {
                if (obj.geometry) obj.geometry.dispose();
            });
        }
        if (this._edgeMat) {
            this._edgeMat.dispose();
            this._edgeMat = null;
        }

        const edges = new THREE.EdgesGeometry(this.polyhedron.threeGeometry);
        const posArr = edges.attributes.position.array;
        const edgeCount = edges.attributes.position.count / 2;

        const R = this.polyhedron.R || 100;
        const tubeRadius = R * (this._edgeRadiusFactor || 0.004);
        const radialSegments = 16;

        // MeshPhongMaterial catches the scene lights set up in main.js so the
        // tube curvature reads as a raised gold bezel rather than a flat
        // ribbon. Parameters come from _edgeParams so a preset / slider
        // change applied while A-2 was hidden is preserved across rebuilds
        // (e.g. polyhedron-type change).
        const params = this._edgeParams || {
            color: 0xffd700, specular: 0xfff4cc, shininess: 90,
            emissive: 0x4a3500, emissiveIntensity: 0.45,
        };
        this._edgeMat = new THREE.MeshPhongMaterial({
            color: params.color,
            specular: params.specular,
            shininess: params.shininess,
            emissive: params.emissive,
            emissiveIntensity: params.emissiveIntensity,
        });

        const group = new THREE.Group();
        const yAxis = new THREE.Vector3(0, 1, 0);
        const dir = new THREE.Vector3();
        const quat = new THREE.Quaternion();

        for (let i = 0; i < edgeCount; i++) {
            const ax = posArr[i * 6 + 0];
            const ay = posArr[i * 6 + 1];
            const az = posArr[i * 6 + 2];
            const bx = posArr[i * 6 + 3];
            const by = posArr[i * 6 + 4];
            const bz = posArr[i * 6 + 5];
            const dx = bx - ax, dy = by - ay, dz = bz - az;
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (len < 1e-6) continue;

            const geom = new THREE.CylinderGeometry(tubeRadius, tubeRadius, len, radialSegments);
            const mesh = new THREE.Mesh(geom, this._edgeMat);
            mesh.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
            dir.set(dx / len, dy / len, dz / len);
            quat.setFromUnitVectors(yAxis, dir);
            mesh.quaternion.copy(quat);
            group.add(mesh);
        }

        // Spheres at each polyhedron vertex round the joints between
        // adjacent edge cylinders (cylinder end-caps are flat, so without
        // these the joints look pinched/angular). Dedup by quantized coord
        // since EdgesGeometry repeats each shared vertex per adjacent edge.
        const tol = R * 0.0005;
        const vSet = new Map();
        const keyOf = (x, y, z) =>
            Math.round(x / tol) + ',' + Math.round(y / tol) + ',' + Math.round(z / tol);
        for (let i = 0; i < edgeCount * 2; i++) {
            const x = posArr[i * 3 + 0];
            const y = posArr[i * 3 + 1];
            const z = posArr[i * 3 + 2];
            const k = keyOf(x, y, z);
            if (!vSet.has(k)) vSet.set(k, { x, y, z });
        }
        const sphereWidthSeg = radialSegments;
        const sphereHeightSeg = Math.max(8, radialSegments / 2);
        for (const pt of vSet.values()) {
            const geom = new THREE.SphereGeometry(tubeRadius, sphereWidthSeg, sphereHeightSeg);
            const mesh = new THREE.Mesh(geom, this._edgeMat);
            mesh.position.set(pt.x, pt.y, pt.z);
            group.add(mesh);
        }

        edges.dispose();
        this.edgeLines = group;
        this.edgeLines.visible = this._showFaceOutlines;
        this.group.add(this.edgeLines);
    }

    setPolyhedron(polyhedron) {
        this.polyhedron = polyhedron;
        this.faces = polyhedron.faces;
        this._buildEdgeWireframe();
        this._rebuildFaceMeshes();
        // Elevation curve radius depends on polyhedron circumradius; rebuild
        // if curves are loaded.
        if (this._elevCurves) this._buildElevationCurves();
    }

    // Raster Earth image (used as a fallback when SVG paths aren't supplied,
    // e.g. the terrain preset). Triggers a per-face canvas rebuild ONLY if
    // we'd actually use the raster — when SVG paths are already loaded, the
    // image is just stored as a fallback and no expensive rebuild fires.
    // Even then, we defer rebuilds until A-2 becomes visible so init doesn't
    // freeze the page rendering 12x1024^2 canvases of country paths.
    setEarthImage(img) {
        this._earthImage = img || null;
        if (this._earthSvgPaths && this._earthStyle) return; // SVG pipeline owns rendering
        if (this.group.visible) this._rebuildFaceMeshes();
        else this._faceMeshesDirty = true;
    }

    // SVG country-path data + render style for the per-face vector renderer.
    // Path data comes from earth.js loadEarthSvgPaths(); style comes from
    // earth.js PRESET_PATH_STYLES[presetId]. Pass (null, null) to clear and
    // fall back to the raster image.
    setEarthSvgPaths(pathData, style) {
        this._earthSvgPaths = pathData || null;
        this._earthStyle = style || null;
        if (this.group.visible) this._rebuildFaceMeshes();
        else this._faceMeshesDirty = true;
    }

    // Match the Mode A earthMesh rotation so the polyhedron's NP sits at the
    // celestial-pole direction in observer frame, just like the globe.
    setObserverLatitude(latRad) {
        this.group.rotation.x = -(Math.PI / 2 - latRad);
    }

    _disposeFaceMeshes() {
        for (const m of this.faceMeshes) {
            this.group.remove(m);
            if (m.geometry) m.geometry.dispose();
            if (m.material) m.material.dispose();
        }
        this.faceMeshes = [];
        for (const t of this._faceTextures) t.dispose();
        this._faceTextures = [];
        // Canvas elements don't need explicit disposal beyond dropping refs.
        this._faceCanvases = [];
    }

    _rebuildFaceMeshes() {
        this._disposeFaceMeshes();
        // Choose source. Prefer SVG paths (vector-crisp); fall back to raster.
        if (this._earthSvgPaths && this._earthStyle) {
            for (const face of this.faces) {
                const canvas = renderEarthFaceFromSvgPaths(
                    face, this.faces, this._earthSvgPaths, this._earthStyle,
                    this._faceCanvasSize,
                );
                this._faceCanvases.push(canvas);
            }
        } else if (this._earthImage) {
            for (const face of this.faces) {
                const canvas = renderEarthFaceFromRaster(
                    face, this.faces, this._earthImage, this._faceCanvasSize,
                );
                this._faceCanvases.push(canvas);
            }
        } else {
            return; // No data yet; meshes built later when setEarthImage or setEarthSvgPaths is called.
        }
        for (const c of this._faceCanvases) {
            const tex = new THREE.Texture(c);
            tex.minFilter = THREE.LinearFilter;
            tex.magFilter = THREE.LinearFilter;
            tex.needsUpdate = true;
            this._faceTextures.push(tex);
        }
        for (let i = 0; i < this.faces.length; i++) {
            const mesh = this._buildFaceMesh(this.faces[i], i);
            if (mesh) {
                this.faceMeshes.push(mesh);
                this.group.add(mesh);
            }
        }
    }

    // Flat triangulated face mesh with UVs mapped to its per-face texture
    // canvas. The texture is pre-rendered (gnomonic) by either the SVG path
    // renderer or the raster sampler, so no projection math runs in the
    // fragment stage — just a UV-mapped texture sample.
    _buildFaceMesh(face, idx) {
        const corners3D = face.vertices3D;
        if (!corners3D || corners3D.length < 3) return null;
        const canvas = this._faceCanvases[idx];
        const texture = this._faceTextures[idx];
        if (!canvas || !texture) return null;
        const N = corners3D.length;
        const positions = new Float32Array(N * 3);
        const uvs = new Float32Array(N * 2);
        const sizeX = canvas.width;
        const sizeY = canvas.height;
        for (let i = 0; i < N; i++) {
            positions[i * 3]     = corners3D[i].x;
            positions[i * 3 + 1] = corners3D[i].y;
            positions[i * 3 + 2] = corners3D[i].z;
            const c = canvas.polygonCorners[i];
            uvs[i * 2]     = c.x / sizeX;
            uvs[i * 2 + 1] = 1 - c.y / sizeY;
        }
        const indices = [];
        for (let i = 1; i < N - 1; i++) indices.push(0, i + 1, i);

        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geom.setAttribute('uv',       new THREE.BufferAttribute(uvs, 2));
        geom.setIndex(indices);
        geom.computeVertexNormals();

        const opacity = this._facesOpaque ? 1.0 : 0.4;
        const mat = new THREE.MeshBasicMaterial({
            map: texture,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: opacity,
            depthWrite: this._facesOpaque,
            // Push face depth-buffer values back a couple of units so the
            // elevation contour lines (which sit on the face plane at sea
            // level) pass the depth test cleanly without z-fight or clipping.
            polygonOffset: true,
            polygonOffsetFactor: 2,
            polygonOffsetUnits: 2,
        });
        return new THREE.Mesh(geom, mat);
    }

    setFacesOpaque(v) {
        this._facesOpaque = !!v;
        const opacity = this._facesOpaque ? 1.0 : 0.4;
        for (const mesh of this.faceMeshes) {
            if (mesh.material) {
                mesh.material.opacity = opacity;
                mesh.material.depthWrite = this._facesOpaque;
                mesh.material.needsUpdate = true;
            }
        }
    }

    // Tile tint: stored and applied to each face mesh's MeshBasicMaterial
    // color, which multiplies with the white-background map texture.
    setTileTint(hex) {
        this._tileTint = (hex | 0) & 0xffffff;
        for (const mesh of this.faceMeshes) {
            if (mesh.material && mesh.material.color) {
                mesh.material.color.setHex(this._tileTint);
                mesh.material.needsUpdate = true;
            }
        }
    }

    setFaceOutlinesVisible(v) {
        this._showFaceOutlines = !!v;
        if (this.edgeLines) this.edgeLines.visible = this._showFaceOutlines;
    }

    setVisible(v) {
        const wasVisible = this.group.visible;
        this.group.visible = !!v;
        // Lazy: kick off the deferred per-face render on first time A-2 is
        // shown so init doesn't burn a few seconds on canvases nobody is
        // looking at yet.
        if (!wasVisible && this.group.visible && this._faceMeshesDirty) {
            this._faceMeshesDirty = false;
            this._rebuildFaceMeshes();
        }
    }

    setElevationCurvesVisible(v) {
        this._showElev = !!v;
        if (this._elevLineSegments) {
            this._elevLineSegments.visible = this._showElev;
        } else if (this._showElev) {
            this._loadElevationData();
        }
    }

    setElevationCurvesExaggeration(x) {
        const next = Math.max(1, Math.min(2000, +x || 150));
        if (next === this._elevExag) return;
        this._elevExag = next;
        if (this._elevCurves) this._buildElevationCurves();
    }

    setElevationProjectionMode(mode) {
        if (mode !== 'polygon' && mode !== 'sphere') return;
        if (mode === this._elevProjectionMode) return;
        this._elevProjectionMode = mode;
        if (this._elevCurves) this._buildElevationCurves();
    }

    setLandOnly(v) {
        const next = !!v;
        if (next === this._landOnly) return;
        this._landOnly = next;
        if (this._elevCurves) this._buildElevationCurves();
    }

    setEdgeRadiusFactor(f) {
        const next = Math.max(0.0005, Math.min(0.03, +f || 0.004));
        if (Math.abs(next - this._edgeRadiusFactor) < 1e-6) return;
        this._edgeRadiusFactor = next;
        this._buildEdgeWireframe();
    }

    // Live-update the shared MeshPhongMaterial for the gold tube edges. No
    // geometry rebuild needed — just pokes the material properties. Accepts
    // any subset of {color, specular, shininess, emissive, emissiveIntensity}.
    setEdgeParams(params) {
        if (!params) return;
        if (!this._edgeParams) {
            this._edgeParams = {
                color: 0xffd700, specular: 0xfff4cc, shininess: 90,
                emissive: 0x4a3500, emissiveIntensity: 0.45,
            };
        }
        if (params.color !== undefined) this._edgeParams.color = params.color;
        if (params.specular !== undefined) this._edgeParams.specular = params.specular;
        if (params.shininess !== undefined) this._edgeParams.shininess = params.shininess;
        if (params.emissive !== undefined) this._edgeParams.emissive = params.emissive;
        if (params.emissiveIntensity !== undefined) this._edgeParams.emissiveIntensity = params.emissiveIntensity;
        if (this._edgeMat) {
            if (params.color !== undefined) this._edgeMat.color.setHex(params.color);
            if (params.specular !== undefined) this._edgeMat.specular.setHex(params.specular);
            if (params.shininess !== undefined) this._edgeMat.shininess = params.shininess;
            if (params.emissive !== undefined) this._edgeMat.emissive.setHex(params.emissive);
            if (params.emissiveIntensity !== undefined) this._edgeMat.emissiveIntensity = params.emissiveIntensity;
            this._edgeMat.needsUpdate = true;
        }
    }

    async _loadElevationData() {
        if (this._elevCurves) return;
        const slug = elevationStepSlug(this._elevLatStepDeg);
        try {
            const [binResp, jsonResp] = await Promise.all([
                fetch(`./data/elevation_curves_${slug}deg.bin`),
                fetch(`./data/elevation_curves_${slug}deg.json`),
            ]);
            if (!binResp.ok)  throw new Error(`elev bin (${slug}deg): HTTP ${binResp.status}`);
            if (!jsonResp.ok) throw new Error(`elev json (${slug}deg): HTTP ${jsonResp.status}`);
            const buf = await binResp.arrayBuffer();
            this._elevCurvesMeta = await jsonResp.json();
            this._elevCurves = new Float32Array(buf);
            const [nBand, nLon] = this._elevCurvesMeta.shape;
            if (this._elevCurves.length !== nBand * nLon) {
                throw new Error(`A-2 elev bin length ${this._elevCurves.length} != ${nBand}*${nLon}`);
            }
            this._buildElevationCurves();
        } catch (e) {
            console.warn('Mode A-2 elevation data load failed:', e);
        }
    }

    setElevationLatStepDeg(step) {
        const valid = [0.5, 1, 2, 3, 5];
        if (!valid.includes(step)) return;
        if (step === this._elevLatStepDeg) return;
        this._elevLatStepDeg = step;
        // Force re-fetch the new file on next access.
        this._elevCurves = null;
        this._elevCurvesMeta = null;
        if (this._elevLineSegments) {
            this.group.remove(this._elevLineSegments);
            this._elevLineSegments.geometry.dispose();
            this._elevLineSegments.material.dispose();
            this._elevLineSegments = null;
        }
        if (this._showElev) this._loadElevationData();
    }

    _buildElevationCurves() {
        if (this._elevLineSegments) {
            this.group.remove(this._elevLineSegments);
            this._elevLineSegments.geometry.dispose();
            this._elevLineSegments.material.dispose();
            this._elevLineSegments = null;
        }
        if (!this._elevCurves || !this._elevCurvesMeta) return;
        const meta = this._elevCurvesMeta;
        const [nBand, nLon] = meta.shape;
        const data = this._elevCurves;
        const latFirst = meta.lat_first_deg;
        const latStep  = meta.lat_step_deg;
        const lonFirst = meta.lon_first_deg;
        const lonStep  = meta.lon_step_deg;
        const D2R = Math.PI / 180;
        const polyR = this.polyhedron.R;
        const inrad = this.polyhedron.inradius;
        const elevScale = (polyR / this.EARTH_R_METERS) * this._elevExag;
        const isPolygon = (this._elevProjectionMode === 'polygon');

        // Polygon mode: subdivide each 0.5° interval into SUB_N sub-vertices so
        // a chord between two sub-vertices on different faces only dips a
        // negligible amount into the polyhedron interior. Sphere mode: smooth
        // wrap, no subdivision needed.
        const SUB_N = isPolygon ? 4 : 1;
        const nVertSub = nLon * SUB_N;
        const totalSegs = nBand * nVertSub;
        const positions = new Float32Array(totalSegs * 6);
        const colors    = new Float32Array(totalSegs * 6);
        // Per-band reusable scratch buffers.
        const vx = new Float64Array(nVertSub);
        const vy = new Float64Array(nVertSub);
        const vz = new Float64Array(nVertSub);
        const ve = new Float32Array(nVertSub);
        const ok = new Uint8Array(nVertSub);
        const tmpDir = new THREE.Vector3();
        // BIAS lifts sea-level (elev=0) lines outward by 0.5% in polygon mode
        // so they don't z-fight with the Earth-textured face surface. In
        // sphere mode the line sits at polyR (clearly outside the polyhedron
        // inradius), so no bias needed.
        const BIAS = isPolygon ? 1.005 : 1.0;

        let segIdx = 0;
        for (let bi = 0; bi < nBand; bi++) {
            const lat = (latFirst + bi * latStep) * D2R;
            const sinLat = Math.sin(lat);
            const cosLat = Math.cos(lat);

            for (let i = 0; i < nVertSub; i++) {
                const li = Math.floor(i / SUB_N);
                const sub = i - li * SUB_N;
                const tFrac = sub / SUB_N;       // 0, 1/N, 2/N, ...
                const li2 = (li + 1) % nLon;
                const lon = (lonFirst + (li + tFrac) * lonStep) * D2R;
                const e0 = data[bi * nLon + li];
                const e1 = data[bi * nLon + li2];
                const elev = e0 + tFrac * (e1 - e0);
                ve[i] = elev;
                // "Land only" clamps anything <= -500 m to a flat baseline so
                // ocean trenches stop pulling the contour inward. Raw elev is
                // still stored in ve[] for color (so the bathymetry/land
                // colormap keeps reading correctly).
                const elevDisp = this._landOnly ? landOnlyElev(elev) : elev;

                if (isPolygon) {
                    // Geographic-frame unit direction. Mode A-2 shader uses
                    // atan(z, -x) for longitude so +90E lives at -Z, -90W at +Z.
                    tmpDir.set(cosLat * Math.cos(lon), sinLat, -cosLat * Math.sin(lon));
                    const r = projectDirToFace(tmpDir, this.faces, inrad);
                    if (!r) { ok[i] = 0; continue; }
                    ok[i] = 1;
                    const len = Math.sqrt(
                        r.point3D.x * r.point3D.x +
                        r.point3D.y * r.point3D.y +
                        r.point3D.z * r.point3D.z
                    );
                    const factor = BIAS * (len + elevDisp * elevScale) / len;
                    vx[i] = r.point3D.x * factor;
                    vy[i] = r.point3D.y * factor;
                    vz[i] = r.point3D.z * factor;
                } else {
                    // Sphere mode: wrap radially around the polyhedron's
                    // circumscribed sphere at baseline polyR.
                    ok[i] = 1;
                    const rr = polyR + elevDisp * elevScale;
                    vx[i] =  rr * cosLat * Math.cos(lon);
                    vy[i] =  rr * sinLat;
                    vz[i] = -rr * cosLat * Math.sin(lon);
                }
            }

            for (let i = 0; i < nVertSub; i++) {
                const i2 = (i + 1) % nVertSub;
                // Skip degenerate segments AND, in Land Only, any segment that
                // sits entirely under water (so oceans disappear instead of
                // flattening to the baseline).
                const skipOcean = this._landOnly && ve[i] <= 0 && ve[i2] <= 0;
                if (!ok[i] || !ok[i2] || skipOcean) {
                    positions[segIdx * 6 + 0] = positions[segIdx * 6 + 1] = positions[segIdx * 6 + 2] = 0;
                    positions[segIdx * 6 + 3] = positions[segIdx * 6 + 4] = positions[segIdx * 6 + 5] = 0;
                    colors[segIdx * 6 + 0] = colors[segIdx * 6 + 1] = colors[segIdx * 6 + 2] = 0;
                    colors[segIdx * 6 + 3] = colors[segIdx * 6 + 4] = colors[segIdx * 6 + 5] = 0;
                    segIdx++;
                    continue;
                }
                positions[segIdx * 6 + 0] = vx[i];
                positions[segIdx * 6 + 1] = vy[i];
                positions[segIdx * 6 + 2] = vz[i];
                positions[segIdx * 6 + 3] = vx[i2];
                positions[segIdx * 6 + 4] = vy[i2];
                positions[segIdx * 6 + 5] = vz[i2];
                const c1 = colorForElev(ve[i]);
                const c2 = colorForElev(ve[i2]);
                colors[segIdx * 6 + 0] = c1[0];
                colors[segIdx * 6 + 1] = c1[1];
                colors[segIdx * 6 + 2] = c1[2];
                colors[segIdx * 6 + 3] = c2[0];
                colors[segIdx * 6 + 4] = c2[1];
                colors[segIdx * 6 + 5] = c2[2];
                segIdx++;
            }
        }

        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geom.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
        this._elevLineSegments = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({
            vertexColors: true,
            transparent: true,
            opacity: 0.95,
        }));
        this._elevLineSegments.visible = this._showElev;
        this.group.add(this._elevLineSegments);
    }
}

// =====================================================================
// Mode A-3 - AuthaGraph vs gnomonic, side by side.
//
// Two inflatable tetrahedra rendered next to each other on the same
// observer-rotated parent group, so the difference between Narukawa's
// AuthaGraph map and a plain gnomonic projection is directly visible
// (especially at flat inflation, where the AuthaGraph face shows
// approximately equal-area continents and the gnomonic face exaggerates
// the centre of each triangle).
//
// Both tetrahedra share the same recursive 4-way subdivision tree
// (LEVELS = 4 -> 256 leaves per face x 4 faces). At every level, the
// FLAT triangle's edges are split at Euclidean midpoints and the
// SPHERICAL triangle's edges are split at GEODESIC (great-circle)
// midpoints. The recursion carries flat AND spherical corner triples
// down to each leaf and the two arrays diverge at every subdivision
// step (because chord midpoints don't equal great-circle midpoints
// when scaled to |p|=R).
//
// The only difference between the two meshes is what each vertex carries
// as its sphereCorner attribute:
//   - left  (gnomonic)  : sphereCorner = radial projection of flat corner
//   - right (autha)     : sphereCorner = recursively-paired geodesic
//                         corner from Narukawa's subdivision
// Same shader for both: normalise the barycentric-interpolated
// sphereCorner, compute equirectangular UV, sample the Earth image.
//
// The Earth pattern within each leaf sub-triangle is invariant under
// inflation, so the slider just morphs the geometry between flat tetra
// (t=0), puffed tetra (t in (0,1)), and spherical tetra (t=1). At t=1
// both meshes converge to a sphere with the Earth correctly oriented to
// match the Mode A globe (to within ~1/4^LEVELS per-leaf approximation).
// =====================================================================
class ModeA3 {
    constructor(scene, R) {
        this.scene = scene;
        this.R = R;
        // Recursive 4-way subdivision depth. 4 levels = 256 leaves/face,
        // which is enough that the piecewise-affine map looks smooth and
        // matches the Mode A globe well at t=1.
        this.levels = 4;
        // The wireframe uses level 3 (64 leaves/face = 256 total, close
        // to Narukawa's 96-sub-triangle decomposition) - dense enough to
        // read as a "graticule" on the sphere, coarse enough that each
        // sub-triangle's distortion is clearly visible on the flat tetra.
        this.wireframeLevels = 3;
        this.inflation = 0.7;              // default: clearly inflated but still polyhedral
        // Two parallel mesh lists, one per projection method. Both lists
        // contain one mesh per tetra face (4 each); the *only* difference
        // is what each vertex carries as its "sphere corner" (and hence
        // what direction the fragment samples Earth from).
        this.gnomonicMeshes = [];
        this.authaMeshes = [];
        this.gnomonicEdges = null;
        this.authaEdges = null;
        // Per-method wireframes of every leaf sub-triangle. Drawn TWICE -
        // once on each tetra group - so each side shows the gnomonic
        // wireframe (red) AND the AuthaGraph wireframe (cyan) overlaid on
        // the same sphere. That makes the divergence between the two
        // triangulations directly visible on a single object instead of
        // requiring the eye to compare two separated tetras.
        this.subdivLines = [];
        this.earthTexture = null;
        this._showFaceOutlines = true;
        this._showSubdivision = true;

        this.group = new THREE.Group();
        this.group.visible = false;
        scene.add(this.group);

        // Side-by-side layout: gnomonic on the left, AuthaGraph on the
        // right, each centered ~1.3R from the world origin so the two
        // tetra silhouettes have a clear gap between them.
        this.gnomonicGroup = new THREE.Group();
        this.gnomonicGroup.position.x = -1.3 * R;
        this.authaGroup = new THREE.Group();
        this.authaGroup.position.x =  1.3 * R;
        this.group.add(this.gnomonicGroup);
        this.group.add(this.authaGroup);

        // 2D unfolded view (Mode E's imago projection - replicated inside
        // ModeA3 without touching Mode E). NOT a child of this.group
        // because it shouldn't rotate with observer latitude - it's a
        // flat map of the sphere, the rotation is baked into the texture
        // during _renderUnfoldedCanvas.
        this._observerLat = 0;
        this._earthImg = null;
        this.unfoldedGroup = new THREE.Group();
        this.unfoldedGroup.visible = false;
        scene.add(this.unfoldedGroup);

        this._tetra = buildPolyhedron('tetra', R);
        this._buildFaceMeshes();
        this._buildEdgeLines();
        this._buildUnfoldedView();
    }

    setEarthImage(img) {
        if (this.earthTexture) this.earthTexture.dispose();
        const allMeshes = [...this.gnomonicMeshes, ...this.authaMeshes];
        if (!img) {
            this.earthTexture = null;
            this._earthImg = null;
            for (const m of allMeshes) m.material.uniforms.earthMap.value = null;
            this._renderUnfoldedCanvas();
            return;
        }
        this.earthTexture = new THREE.Texture(img);
        this.earthTexture.wrapS = THREE.RepeatWrapping;
        this.earthTexture.needsUpdate = true;
        this._earthImg = img;
        for (const m of allMeshes) m.material.uniforms.earthMap.value = this.earthTexture;
        this._renderUnfoldedCanvas();
    }

    setObserverLatitude(latRad) {
        // Parent rotation; both sub-groups (gnomonic & autha) rotate
        // together so the side-by-side comparison stays aligned.
        this.group.rotation.x = -(Math.PI / 2 - latRad);
        this._observerLat = latRad;
        // Earth orientation on the imago canvas depends on observer-lat,
        // so we have to re-render the canvas every time the latitude
        // changes. (Cheap: one canvas pass.)
        this._renderUnfoldedCanvas();
    }

    setInflation(t) {
        this.inflation = Math.max(0, Math.min(1, t));
        for (const m of this.gnomonicMeshes) this._applyInflationToMesh(m);
        for (const m of this.authaMeshes) this._applyInflationToMesh(m);
        this._applyInflationToEdgeLines(this.gnomonicEdges);
        this._applyInflationToEdgeLines(this.authaEdges);
        for (const lines of this.subdivLines) this._applyInflationToSubdivLines(lines);
    }

    setFaceOutlinesVisible(v) {
        this._showFaceOutlines = !!v;
        if (this.gnomonicEdges) this.gnomonicEdges.visible = this._showFaceOutlines;
        if (this.authaEdges) this.authaEdges.visible = this._showFaceOutlines;
    }

    setVisible(v) {
        this.group.visible = !!v;
        this.unfoldedGroup.visible = !!v;
    }

    // Build one ShaderMaterial mesh per tetra face per projection method.
    // The two methods share the same recursive subdivision tree (so the
    // leaf triangles tile identically) and the same per-vertex sphere
    // position used to inflate the geometry. Only the SHADER differs:
    //   - gnomonic mesh : fragment shader normalises the interpolated
    //                     mesh-local position. At t=0 this is exact
    //                     gnomonic projection of the sphere onto the flat
    //                     face (no piecewise-affine approximation), with
    //                     the full 1/cos^2 area distortion near vertices.
    //   - autha mesh    : fragment shader normalises the interpolated
    //                     `sphereCorner` attribute, which carries the
    //                     recursively-paired geodesic-midpoint corner from
    //                     Narukawa's subdivision. The leaf-by-leaf affine
    //                     map between flat and spherical sub-triangles is
    //                     the AuthaGraph projection at this granularity.
    _buildFaceMeshes() {
        for (const face of this._tetra.faces) {
            const { flatLeaves, authaSphereLeaves } =
                this._buildSubdivisionLeaves(face.vertices3D[0], face.vertices3D[1], face.vertices3D[2]);
            // Both meshes use the same inflation geometry (vertex at
            // radProj(flat_corner) when t=1). They only differ in shader
            // sampling logic.
            const gnomonicSphereLeaves = flatLeaves.map(p => {
                const len = Math.hypot(p.x, p.y, p.z) || 1;
                const s = this.R / len;
                return { x: p.x * s, y: p.y * s, z: p.z * s };
            });

            const gnomonicMesh = this._buildMeshFromLeaves(flatLeaves, gnomonicSphereLeaves, 'gnomonic', face);
            const authaMesh    = this._buildMeshFromLeaves(flatLeaves, authaSphereLeaves, 'autha', face);
            if (gnomonicMesh) {
                this.gnomonicMeshes.push(gnomonicMesh);
                this.gnomonicGroup.add(gnomonicMesh);
            }
            if (authaMesh) {
                this.authaMeshes.push(authaMesh);
                this.authaGroup.add(authaMesh);
            }
        }
        // Wireframes are built independently at a *coarser* subdivision
        // so per-triangle divergence reads visually.
        this._buildSubdivisionWireframes();
    }

    _buildSubdivisionWireframes() {
        // Sphere subdivision: recursive geodesic midpoints (depth =
        // wireframeLevels = 3 -> 64 sub-triangles per face, 256 total).
        //
        //   gnomonic    : flat position = each sphere vertex radially
        //                 projected onto the face plane (P * d / (P.n)).
        //                 Interior geodesic-midpoint sphere vertices
        //                 project to non-uniform flat positions, so the
        //                 grid is visibly distorted on the flat face.
        //
        //   AuthaGraph  : flat position = Narukawa's recursive pairing,
        //                 i.e. the matched Euclidean-midpoint flat
        //                 sub-triangle vertex. Stays inside the triangle
        //                 (edges respected by construction) and gives a
        //                 uniform Euclidean-midpoint grid on the flat
        //                 face - which IS AuthaGraph's defining feature:
        //                 the inflate-deflate cycle recovers a uniform
        //                 layout from a gnomonically-distorted source.
        //
        // Note: imago (Mode E's projection) is designed to map a sphere
        // face onto a hexagonal output region (its 6 x 2sqrt(3) rectangle
        // assembles four such hexagons). Applying it directly to a flat
        // tetrahedral face overshoots the triangle boundary, so the only
        // sphere->flat-triangle projection that respects edges and area
        // simultaneously is Narukawa's recursive piecewise-affine map.
        const gnomonicFlat = [], gnomonicSphere = [];
        const authaFlat = [], authaSphere = [];

        for (const face of this._tetra.faces) {
            const { flatLeaves, authaSphereLeaves } = this._buildSubdivisionLeaves(
                face.vertices3D[0], face.vertices3D[1], face.vertices3D[2], this.wireframeLevels);
            const n = face.normal;
            const d = face.planeDist;

            const gnomonicFlatLeaves = authaSphereLeaves.map(p => {
                const dot = p.x * n.x + p.y * n.y + p.z * n.z;
                const k = d / dot;
                return { x: p.x * k, y: p.y * k, z: p.z * k };
            });

            for (let i = 0; i < authaSphereLeaves.length; i += 3) {
                const sAa = authaSphereLeaves[i], sAb = authaSphereLeaves[i + 1], sAc = authaSphereLeaves[i + 2];
                const fGa = gnomonicFlatLeaves[i], fGb = gnomonicFlatLeaves[i + 1], fGc = gnomonicFlatLeaves[i + 2];
                const fEa = flatLeaves[i],         fEb = flatLeaves[i + 1],         fEc = flatLeaves[i + 2];
                gnomonicFlat.push  (fGa, fGb,  fGb, fGc,  fGc, fGa);
                gnomonicSphere.push(sAa, sAb,  sAb, sAc,  sAc, sAa);
                authaFlat.push     (fEa, fEb,  fEb, fEc,  fEc, fEa);
                authaSphere.push   (sAa, sAb,  sAb, sAc,  sAc, sAa);
            }
        }

        const RED = 0xff5544;
        const CYAN = 0x44ddff;
        // Each tetra carries only its own wireframe so the visual is clean:
        // left side shows the gnomonic triangulation, right side shows the
        // AuthaGraph triangulation. (See the 2D unfolded view below for the
        // direct overlay comparison.)
        const gnomonicLines = this._buildSubdivisionLineSegments(gnomonicFlat, gnomonicSphere, RED);
        const authaLines    = this._buildSubdivisionLineSegments(authaFlat,    authaSphere,    CYAN);
        this.gnomonicGroup.add(gnomonicLines);
        this.authaGroup.add(authaLines);
        this.subdivLines = [gnomonicLines, authaLines];
    }

    // Recursive 4-way subdivision of one tetrahedral face: at every level
    // the flat triangle is split at Euclidean midpoints and the spherical
    // triangle is split at geodesic (great-circle) midpoints. Returns two
    // parallel arrays of corners-per-leaf-triangle (each leaf -> 3 corners).
    _buildSubdivisionLeaves(A, B, C, depth = this.levels) {
        const R = this.R;
        const midFlat = (p, q) => ({
            x: (p.x + q.x) / 2,
            y: (p.y + q.y) / 2,
            z: (p.z + q.z) / 2,
        });
        const midSphere = (p, q) => {
            const mx = (p.x + q.x) / 2;
            const my = (p.y + q.y) / 2;
            const mz = (p.z + q.z) / 2;
            const len = Math.hypot(mx, my, mz) || 1;
            const s = R / len;
            return { x: mx * s, y: my * s, z: mz * s };
        };

        const flatLeaves = [];
        const authaSphereLeaves = [];

        const subdivide = (aF, bF, cF, aS, bS, cS, d) => {
            if (d === 0) {
                flatLeaves.push(aF, bF, cF);
                authaSphereLeaves.push(aS, bS, cS);
                return;
            }
            const abF = midFlat(aF, bF), bcF = midFlat(bF, cF), caF = midFlat(cF, aF);
            const abS = midSphere(aS, bS), bcS = midSphere(bS, cS), caS = midSphere(cS, aS);
            subdivide(aF,  abF, caF, aS,  abS, caS, d - 1);
            subdivide(abF, bF,  bcF, abS, bS,  bcS, d - 1);
            subdivide(caF, bcF, cF,  caS, bcS, cS,  d - 1);
            subdivide(abF, bcF, caF, abS, bcS, caS, d - 1);
        };
        // Root: the tetra vertices are themselves on |p|=R, so flat and
        // spherical corners coincide at level 0.
        subdivide(A, B, C, A, B, C, depth);

        return { flatLeaves, authaSphereLeaves };
    }

    // Common geometry builder.
    //   'gnomonic' : fragment shader normalises the interpolated mesh-local
    //                position - exact gnomonic projection at any
    //                subdivision level.
    //   'autha'    : fragment shader applies the imago (AuthaGraph)
    //                INVERSE per-pixel: face-local 2D -> Newton on lambda
    //                -> face-local (lon, lat) -> 3D direction in face
    //                basis -> equirectangular sample. Per-face uniforms
    //                (faceNormal, faceCenter, faceU, faceV, imagoScale)
    //                set up the face-local frame and the scaling that
    //                makes a tetra vertex land at its actual 3D position.
    _buildMeshFromLeaves(flatLeaves, sphereLeaves, kind, face) {
        const n = flatLeaves.length;
        const flatArr = new Float32Array(n * 3);
        const sphereArr = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
            flatArr[i * 3]     = flatLeaves[i].x;
            flatArr[i * 3 + 1] = flatLeaves[i].y;
            flatArr[i * 3 + 2] = flatLeaves[i].z;
            sphereArr[i * 3]     = sphereLeaves[i].x;
            sphereArr[i * 3 + 1] = sphereLeaves[i].y;
            sphereArr[i * 3 + 2] = sphereLeaves[i].z;
        }

        const posArr = new Float32Array(n * 3);
        const t = this.inflation;
        for (let i = 0; i < posArr.length; i++) {
            posArr[i] = flatArr[i] * (1 - t) + sphereArr[i] * t;
        }

        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
        geom.setAttribute('sphereCorner', new THREE.BufferAttribute(sphereArr, 3));
        geom.setAttribute('flatPos', new THREE.BufferAttribute(flatArr, 3));
        geom.computeVertexNormals();

        const sampleEarth = `
            #define PI 3.141592653589793
            uniform sampler2D earthMap;
            vec4 sampleEarth(vec3 dir) {
                float phi = atan(dir.z, -dir.x);
                float theta = acos(clamp(dir.y, -1.0, 1.0));
                float u = phi / (2.0 * PI);
                if (u < 0.0) u += 1.0;
                float v = 1.0 - theta / PI;
                return texture2D(earthMap, vec2(u, v));
            }
        `;

        let uniforms, vertexShader, fragmentShader;
        if (kind === 'autha') {
            // Build the face-local basis used by the imago inverse:
            // n is the face normal (face-local "north pole"), u is the
            // direction from face centre to the first listed vertex
            // (face-local "longitude 0"), v = n x u (face-local
            // "longitude pi/2").
            const fn = face.normal;
            const d = face.planeDist;
            const fc = { x: d * fn.x, y: d * fn.y, z: d * fn.z };
            const V0 = face.vertices3D[0];
            const dux = V0.x - fc.x, duy = V0.y - fc.y, duz = V0.z - fc.z;
            const dul = Math.hypot(dux, duy, duz);
            const fu = { x: dux / dul, y: duy / dul, z: duz / dul };
            const fv = {
                x: fn.y * fu.z - fn.z * fu.y,
                y: fn.z * fu.x - fn.x * fu.z,
                z: fn.x * fu.y - fn.y * fu.x,
            };
            // imagoScale makes the imago tetra-vertex r value land at
            // the actual 3D vertex distance from face centre.
            const psiV = Math.acos(1 / 3);
            const pV = psiV / Math.atan(Math.SQRT2);
            const rV = Math.pow(pV, 0.68) * Math.sqrt(3);
            const vertexDist = this.R * Math.sqrt(8) / 3;
            const imagoScale = vertexDist / rV;

            uniforms = {
                earthMap:    { value: this.earthTexture },
                faceNormal:  { value: new THREE.Vector3(fn.x, fn.y, fn.z) },
                faceCenter:  { value: new THREE.Vector3(fc.x, fc.y, fc.z) },
                faceU:       { value: new THREE.Vector3(fu.x, fu.y, fu.z) },
                faceV:       { value: new THREE.Vector3(fv.x, fv.y, fv.z) },
                imagoScale:  { value: imagoScale },
            };
            vertexShader = `
                attribute vec3 flatPos;
                varying vec3 vFlatPos;
                void main() {
                    vFlatPos = flatPos;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `;
            fragmentShader = `
                #define HALF_PI 1.5707963267948966
                #define SQRT3 1.7320508075688772
                #define K_AUTHA 0.68
                uniform vec3 faceNormal;
                uniform vec3 faceCenter;
                uniform vec3 faceU;
                uniform vec3 faceV;
                uniform float imagoScale;
                varying vec3 vFlatPos;
                ${sampleEarth}

                // Imago face-local forward map (lambda -> tht) used by Newton.
                float thtOfLambda(float l) {
                    float term = l - asin(sin(l) / SQRT3);
                    return atan((term / PI) * sqrt(12.0));
                }

                void main() {
                    // Face-local 2D in imago units.
                    vec3 rel = vFlatPos - faceCenter;
                    float fx = dot(rel, faceU) / imagoScale;
                    float fy = dot(rel, faceV) / imagoScale;
                    float r = sqrt(fx * fx + fy * fy);
                    float tht = atan(fy, fx);

                    // 6-fold planar symmetry: reduce tht to the principal
                    // wedge [-pi/6, pi/6]. Remember the rotation as thBase.
                    float sec = PI / 3.0;
                    float thBase = floor((tht + PI / 6.0) / sec) * sec;
                    float thInWedge = tht - thBase;

                    // Newton's method for the imago inverse: find lambda
                    // such that thtOfLambda(lambda) = thInWedge.
                    float lambda = thInWedge;
                    for (int i = 0; i < 8; i++) {
                        float f = thtOfLambda(lambda);
                        float err = f - thInWedge;
                        float h = 1e-4;
                        float fp = (thtOfLambda(lambda + h) - thtOfLambda(lambda - h)) / (2.0 * h);
                        if (abs(fp) < 1e-9) break;
                        lambda -= err / fp;
                    }

                    // R_val recovers p from r and tht (imago forward had
                    // r = pow(p, K) * sqrt(3) / cos(tht)).
                    float R_val = r * cos(thInWedge) / SQRT3;
                    float lat_local = HALF_PI - pow(max(R_val, 0.0), 1.0 / K_AUTHA) * atan(sqrt(2.0) / cos(lambda));
                    // 6-fold planar wedge -> 3-fold sphere wedge: planarSym/sphereSym = 2.
                    float lon_local = lambda + thBase * 2.0;

                    // Face-local (lon_local, lat_local) -> 3D direction
                    // in mesh-local frame, via face basis. faceNormal is
                    // the face-local "north pole", faceU is the lon=0
                    // direction, faceV is the lon=pi/2 direction.
                    float cosLat = cos(lat_local);
                    vec3 dir = sin(lat_local) * faceNormal
                             + cosLat * cos(lon_local) * faceU
                             + cosLat * sin(lon_local) * faceV;

                    gl_FragColor = sampleEarth(normalize(dir));
                }
            `;
        } else {
            uniforms = { earthMap: { value: this.earthTexture } };
            vertexShader = `
                varying vec3 vLocalPos;
                void main() {
                    vLocalPos = position;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `;
            fragmentShader = `
                varying vec3 vLocalPos;
                ${sampleEarth}
                void main() {
                    gl_FragColor = sampleEarth(normalize(vLocalPos));
                }
            `;
        }

        const mat = new THREE.ShaderMaterial({
            uniforms,
            vertexShader,
            fragmentShader,
            side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.userData.flatPositions = flatArr;
        mesh.userData.spherePositions = sphereArr;
        return mesh;
    }

    _applyInflationToMesh(mesh) {
        const flat = mesh.userData.flatPositions;
        const sphere = mesh.userData.spherePositions;
        const attr = mesh.geometry.getAttribute('position');
        const arr = attr.array;
        const t = this.inflation;
        for (let i = 0; i < flat.length; i++) {
            arr[i] = flat[i] * (1 - t) + sphere[i] * t;
        }
        attr.needsUpdate = true;
        mesh.geometry.computeVertexNormals();
    }

    // Build one LineSegments per sub-group (gnomonic / autha) for the six
    // tetra edges. Each edge is a subdivided polyline so it can curve from
    // chord (t=0) to great-circle arc (t=1). Both sub-groups get the same
    // edge geometry; they only differ in which face mesh they sit on top of.
    _buildEdgeLines() {
        const seen = new Set();
        const edgeList = [];
        for (const face of this._tetra.faces) {
            const v = face.vertices3D;
            for (let i = 0; i < v.length; i++) {
                const a = v[i], b = v[(i + 1) % v.length];
                const key = a.x < b.x || (a.x === b.x && (a.y < b.y || (a.y === b.y && a.z <= b.z)))
                    ? `${a.x},${a.y},${a.z}|${b.x},${b.y},${b.z}`
                    : `${b.x},${b.y},${b.z}|${a.x},${a.y},${a.z}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    edgeList.push([a, b]);
                }
            }
        }

        const STEPS = 32;
        const flat = [];
        const sphere = [];
        for (const [A, B] of edgeList) {
            for (let s = 0; s < STEPS; s++) {
                const t0 = s / STEPS, t1 = (s + 1) / STEPS;
                for (const tt of [t0, t1]) {
                    const px = A.x * (1 - tt) + B.x * tt;
                    const py = A.y * (1 - tt) + B.y * tt;
                    const pz = A.z * (1 - tt) + B.z * tt;
                    flat.push(px, py, pz);
                    const len = Math.hypot(px, py, pz) || 1;
                    sphere.push(px / len * this.R, py / len * this.R, pz / len * this.R);
                }
            }
        }

        this.gnomonicEdges = this._buildEdgeLineSegments(flat, sphere);
        this.authaEdges    = this._buildEdgeLineSegments(flat, sphere);
        this.gnomonicGroup.add(this.gnomonicEdges);
        this.authaGroup.add(this.authaEdges);
    }

    _buildEdgeLineSegments(flat, sphere) {
        const flatArr = new Float32Array(flat);
        const sphereArr = new Float32Array(sphere);
        const posArr = new Float32Array(flat.length);
        const t = this.inflation;
        const bias = 1.0015;
        for (let i = 0; i < flat.length; i++) {
            posArr[i] = (flatArr[i] * (1 - t) + sphereArr[i] * t) * bias;
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
        const mat = new THREE.LineBasicMaterial({ color: 0x66aaff, transparent: true, opacity: 0.85 });
        const lines = new THREE.LineSegments(geom, mat);
        lines.userData.flatPositions = flatArr;
        lines.userData.spherePositions = sphereArr;
        lines.visible = this._showFaceOutlines;
        lines.renderOrder = 2;
        lines.material.depthTest = true;
        return lines;
    }

    _applyInflationToEdgeLines(lines) {
        if (!lines) return;
        const flat = lines.userData.flatPositions;
        const sphere = lines.userData.spherePositions;
        const attr = lines.geometry.getAttribute('position');
        const arr = attr.array;
        const t = this.inflation;
        const bias = 1.0015;
        for (let i = 0; i < flat.length; i++) {
            arr[i] = (flat[i] * (1 - t) + sphere[i] * t) * bias;
        }
        attr.needsUpdate = true;
    }

    // Subdivision wireframe sitting just outside the face surface. Each
    // side's lines carry that side's per-vertex sphere positions, so the
    // wireframes visibly diverge as inflation increases.
    _buildSubdivisionLineSegments(flatEndpoints, sphereEndpoints, color) {
        const n = flatEndpoints.length;
        const flatArr = new Float32Array(n * 3);
        const sphereArr = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
            flatArr[i * 3]     = flatEndpoints[i].x;
            flatArr[i * 3 + 1] = flatEndpoints[i].y;
            flatArr[i * 3 + 2] = flatEndpoints[i].z;
            sphereArr[i * 3]     = sphereEndpoints[i].x;
            sphereArr[i * 3 + 1] = sphereEndpoints[i].y;
            sphereArr[i * 3 + 2] = sphereEndpoints[i].z;
        }
        const posArr = new Float32Array(flatArr.length);
        const t = this.inflation;
        // No radial bias - the line material has depthTest disabled so
        // depth-fighting with the textured face mesh is avoided directly
        // (lines always render last, on top of the surface).
        for (let i = 0; i < flatArr.length; i++) {
            posArr[i] = flatArr[i] * (1 - t) + sphereArr[i] * t;
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
        const mat = new THREE.LineBasicMaterial({
            color, transparent: true, opacity: 0.95,
            depthTest: false,         // always render on top of meshes
            depthWrite: false,
        });
        const lines = new THREE.LineSegments(geom, mat);
        lines.userData.flatPositions = flatArr;
        lines.userData.spherePositions = sphereArr;
        lines.visible = this._showSubdivision;
        lines.renderOrder = 3;
        return lines;
    }

    _applyInflationToSubdivLines(lines) {
        if (!lines) return;
        const flat = lines.userData.flatPositions;
        const sphere = lines.userData.spherePositions;
        const attr = lines.geometry.getAttribute('position');
        const arr = attr.array;
        const t = this.inflation;
        for (let i = 0; i < flat.length; i++) {
            arr[i] = flat[i] * (1 - t) + sphere[i] * t;
        }
        attr.needsUpdate = true;
    }

    setSubdivisionVisible(v) {
        this._showSubdivision = !!v;
        for (const lines of this.subdivLines) lines.visible = this._showSubdivision;
    }

    // -----------------------------------------------------------------
    // 2D unfolded AuthaGraph view (Mode E's imago projection, rendered
    // into a CanvasTexture-backed plane mesh sitting next to the two
    // tetrahedra). The canvas content (Earth + sub-triangle wireframe)
    // is generated by the same imago code Mode E uses, just replicated
    // here so Mode E is left untouched.
    // -----------------------------------------------------------------
    _buildUnfoldedView() {
        const W = 480, H = 208;       // 480 / 208 ~= 2.31 (wide imago aspect)
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        this._unfoldedCanvas = canvas;

        const tex = new THREE.CanvasTexture(canvas);
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        // CanvasTexture default flipY=true; the canvas's pixel-y=0 row
        // (top of canvas) ends up at UV v=1 (top of plane). Explicitly
        // set it so the convention is obvious to readers.
        tex.flipY = true;
        this._unfoldedTexture = tex;

        const planeW = 2.0 * this.R;
        const planeH = planeW * H / W;
        const geom = new THREE.PlaneGeometry(planeW, planeH);
        const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(geom, mat);
        // Sit just below the two 3D tetras. Camera at (0, 60, 280) with
        // 55deg vertical FOV sees y in roughly [-145, +145] at z=0; the
        // tetras span ~+/-58 in y, so y=-100 puts the plane center 42
        // units below the tetra bottom and the whole plane (height ~87)
        // inside the default frustum.
        mesh.position.set(0, -1.05 * this.R, 0);
        this._unfoldedMesh = mesh;
        this.unfoldedGroup.add(mesh);

        this._renderUnfoldedCanvas();
    }

    _renderUnfoldedCanvas() {
        if (!this._unfoldedCanvas) return;
        const canvas = this._unfoldedCanvas;
        const ctx = canvas.getContext('2d');
        const W = canvas.width, H = canvas.height;
        const rect = imagoWideRectSize();

        ctx.fillStyle = '#0a1a30';
        ctx.fillRect(0, 0, W, H);

        if (this._earthImg) {
            try {
                const tex = document.createElement('canvas');
                tex.width = this._earthImg.naturalWidth;
                tex.height = this._earthImg.naturalHeight;
                const tctx = tex.getContext('2d');
                tctx.drawImage(this._earthImg, 0, 0);
                const texData = tctx.getImageData(0, 0, tex.width, tex.height);
                const texPixels = texData.data;
                const tw = texData.width, th = texData.height;

                // Same observer-frame -> geographic-frame rotation Mode E uses:
                // rotate by (pi/2 - lat) around X so the observer-frame
                // celestial pole lands at geographic +Y.
                const angle = Math.PI / 2 - this._observerLat;
                const ca = Math.cos(angle), sa = Math.sin(angle);

                const imgData = ctx.createImageData(W, H);
                const pixels = imgData.data;
                for (let py = 0; py < H; py++) {
                    for (let px = 0; px < W; px++) {
                        const xN = (px + 0.5) / W - 0.5;
                        const yN = -((py + 0.5) / H - 0.5);
                        const x = xN * rect.width;
                        const y = yN * rect.height;
                        const j = (py * W + px) * 4;
                        let lonLat = null;
                        try { lonLat = imagoWideInverse(x, y, 0.68); } catch (e) {}
                        if (!lonLat) { pixels[j + 3] = 0; continue; }
                        const lonO = lonLat[0], latO = lonLat[1];
                        const cosLatO = Math.cos(latO);
                        const dxo = cosLatO * Math.cos(lonO);
                        const dyo = Math.sin(latO);
                        const dzo = cosLatO * Math.sin(lonO);
                        // Observer -> geographic rotation around X by (pi/2 - lat).
                        const dxg = dxo;
                        const dyg = dyo * ca - dzo * sa;
                        const dzg = dyo * sa + dzo * ca;
                        const latG = Math.asin(dyg < -1 ? -1 : (dyg > 1 ? 1 : dyg));
                        const lonG = Math.atan2(dzg, dxg);
                        let ttx = (lonG / (2 * Math.PI) + 0.5) * tw;
                        let tty = (0.5 - latG / Math.PI) * th;
                        if (ttx < 0) ttx = 0; else if (ttx >= tw) ttx = tw - 1; else ttx |= 0;
                        if (tty < 0) tty = 0; else if (tty >= th) tty = th - 1; else tty |= 0;
                        const ti = (tty * tw + ttx) * 4;
                        pixels[j]     = texPixels[ti];
                        pixels[j + 1] = texPixels[ti + 1];
                        pixels[j + 2] = texPixels[ti + 2];
                        pixels[j + 3] = 255;
                    }
                }
                ctx.putImageData(imgData, 0, 0);
            } catch (e) {
                console.warn('ModeA3 unfolded Earth render failed:', e.message);
            }
        }

        this._drawUnfoldedWireframe(ctx, W, H, rect);

        if (this._unfoldedTexture) this._unfoldedTexture.needsUpdate = true;
    }

    _drawUnfoldedWireframe(ctx, W, H, rect) {
        // Uniform N=5 barycentric subdivision per face -> radial projection
        // to sphere -> imago forward, drawn as line segments on the canvas.
        // Matches Mode E's SUB_N=5 ("Narukawa's quoted 96 triangles").
        const SUB_N = 5;
        const tetraVerts = this._unfoldedTetraVertices();
        const faces = [[1, 2, 3], [0, 3, 2], [0, 1, 3], [0, 2, 1]];
        ctx.strokeStyle = '#44ddff';
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        const maxJump = W * 0.4;
        for (const [ia, ib, ic] of faces) {
            const A = tetraVerts[ia], B = tetraVerts[ib], C = tetraVerts[ic];
            const grid = [];
            for (let i = 0; i <= SUB_N; i++) {
                grid.push([]);
                for (let j = 0; j <= SUB_N - i; j++) {
                    const k = SUB_N - i - j;
                    const sx = (i * A[0] + j * B[0] + k * C[0]) / SUB_N;
                    const sy = (i * A[1] + j * B[1] + k * C[1]) / SUB_N;
                    const sz = (i * A[2] + j * B[2] + k * C[2]) / SUB_N;
                    const len = Math.hypot(sx, sy, sz) || 1;
                    const dx = sx / len, dy = sy / len, dz = sz / len;
                    const lat = Math.asin(dy);
                    const lon = Math.atan2(dz, dx);
                    const xy = imagoWideForward(lon, lat, 0.68);
                    const cx = (xy[0] / rect.width + 0.5) * W;
                    const cy = (0.5 - xy[1] / rect.height) * H;
                    grid[i].push([cx, cy]);
                }
            }
            const line = (a, b) => {
                if (Math.hypot(a[0] - b[0], a[1] - b[1]) > maxJump) return;
                ctx.moveTo(a[0], a[1]);
                ctx.lineTo(b[0], b[1]);
            };
            for (let i = 0; i <= SUB_N; i++) {
                for (let j = 0; j <= SUB_N - i; j++) {
                    if (j < SUB_N - i) line(grid[i][j], grid[i][j + 1]);
                    if (i < SUB_N && j <= SUB_N - i - 1) line(grid[i][j], grid[i + 1][j]);
                    if (i < SUB_N && j > 0) line(grid[i][j], grid[i + 1][j - 1]);
                }
            }
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
    }

    _unfoldedTetraVertices() {
        // Match Mode E's tetraVertices() exactly (imago.js's CENTRUMS
        // assume this orientation: south-pole vertex + three northern
        // vertices). Inlined here so Mode E is untouched.
        const asinThird = Math.asin(1 / 3);
        return [
            [-Math.PI / 2, 0],
            [asinThird, Math.PI],
            [asinThird, -Math.PI / 3],
            [asinThird, Math.PI / 3],
        ].map(([lat, lon]) => [
            Math.cos(lat) * Math.cos(lon),
            Math.sin(lat),
            Math.cos(lat) * Math.sin(lon),
        ]);
    }
}

// =====================================================================
// Mode B - 2D unfolded net (Canvas2D overlay).
// =====================================================================
class ModeB {
    constructor(canvas, polyhedron) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this._adoptPolyhedron(polyhedron);
        this.constellationLines = [];
        this.eclipticPoints = null;
        this.zodiacBands = null;
        this._showConstellations = true;
        this._showEcliptic = true;
        this._showZodiac = true;
        this._showMW = false;
        this._showFaceOutlines = true;
        // ETOPO elevation-contour overlay (off by default). The bucketed
        // per-face runs come from PolyhedralProjection.
        this._showElevation = false;
        this._elevationBuckets = null;
        this._elevExag = 150;
        this._tileOpaque = true;
        this._landOnly = false;
        this._tileTint = 0xffffff;
        this.resize();
        window.addEventListener('resize', () => this.resize());
    }

    setElevationVisible(v) { this._showElevation = !!v; }
    setElevationBuckets(buckets) { this._elevationBuckets = buckets || null; }
    setElevationExaggeration(x) { this._elevExag = +x || 150; }
    setTileOpaque(v) { this._tileOpaque = v !== false; }
    setLandOnly(v) { this._landOnly = !!v; }
    setTileTint(hex) { this._tileTint = (hex | 0) & 0xffffff; }

    _adoptPolyhedron(polyhedron) {
        this.polyhedron = polyhedron;
        this.faces = polyhedron.faces;
        this.R = polyhedron.R;
        this.inradius = polyhedron.inradius;
        const n = this.faces.length;
        this.starBuckets = Array.from({ length: n }, () => []);
        this.lineBuckets = Array.from({ length: n }, () => []);
        this.eclipticBuckets = Array.from({ length: n }, () => []);
        this.zodiacBuckets = Array.from({ length: n }, () => []);
        this.faceOrder = [...this.faces.keys()].sort((a, b) => {
            const dy = this.faces[b].normal.y - this.faces[a].normal.y;
            if (Math.abs(dy) > 1e-3) return dy;
            return Math.atan2(this.faces[a].normal.z, this.faces[a].normal.x)
                 - Math.atan2(this.faces[b].normal.z, this.faces[b].normal.x);
        });
    }

    setPolyhedron(polyhedron) {
        this._adoptPolyhedron(polyhedron);
        this.earthCanvases = null;
    }

    resize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
    }

    setConstellationLines(linePairs) { this.constellationLines = linePairs; }
    setEcliptic(xyzArray) { this.eclipticPoints = xyzArray || null; }
    setZodiacBand(bands) { this.zodiacBands = bands || null; }
    setEarthCanvases(canvases) { this.earthCanvases = canvases; }
    setMilkyWayImage(mwCanvas) {
        if (!mwCanvas) {
            this.mwCanvases = null;
            this._mwTexData = null;
            return;
        }
        try {
            this._mwTexData = extractMilkyWayTextureData(mwCanvas);
        } catch (e) {
            console.warn('Mode B Milky Way:', e.message);
            this.mwCanvases = null;
            this._mwTexData = null;
            return;
        }
        this.mwCanvases = allocateMilkyWayFaceCanvases(this.faces);
    }
    setObsToGal(m) { this._mwObsToGal = m; }
    setConstellationsVisible(v) { this._showConstellations = !!v; }
    setEclipticVisible(v) { this._showEcliptic = !!v; }
    setZodiacVisible(v) { this._showZodiac = !!v; }
    setMilkyWayVisible(v) { this._showMW = !!v; }
    setFaceOutlinesVisible(v) { this._showFaceOutlines = !!v; }
    setObsToGeographic(m) { this._obsToGeo = m || null; }

    update(starMap, getStarProps) {
        for (const b of this.starBuckets) b.length = 0;
        for (const b of this.lineBuckets) b.length = 0;
        for (const b of this.eclipticBuckets) b.length = 0;
        for (const b of this.zodiacBuckets) b.length = 0;

        if (this._showMW && this.mwCanvases && this._mwTexData && this._mwObsToGal) {
            fillMilkyWayFaces(this.mwCanvases, this.faces, this._mwTexData, this._mwObsToGal);
        }

        const M = this._obsToGeo;
        const projFn = M
            ? (d) => { applyObsToGeo(M, d); return projectDirToFace(d, this.faces, this.inradius); }
            : (d) => projectDirToFace(d, this.faces, this.inradius);

        // Bucket stars by face
        for (const star of starMap.values()) {
            if (!star.XYZ) continue;
            const props = getStarProps(star);
            if (!props || !props.visible) continue;
            _tmpDirA.copy(star.XYZ).normalize();
            const r = projFn(_tmpDirA);
            if (!r) continue;
            this.starBuckets[r.face.idx].push({
                u: r.u, v: r.v,
                colorCss: props.colorCss, size: props.size, opacity: props.opacity,
            });
        }

        // Bucket constellation lines by face (only when both endpoints land on the same face)
        if (this._showConstellations) for (const [aId, bId] of this.constellationLines) {
            const a = starMap.get(aId);
            const b = starMap.get(bId);
            if (!a || !b || !a.XYZ || !b.XYZ) continue;
            const pa = getStarProps(a);
            const pb = getStarProps(b);
            if (!pa || !pb || !pa.visible || !pb.visible) continue;
            _tmpDirA.copy(a.XYZ).normalize();
            _tmpDirB.copy(b.XYZ).normalize();
            const ra = projFn(_tmpDirA);
            const rb = projFn(_tmpDirB);
            if (!ra || !rb) continue;
            if (ra.face.idx !== rb.face.idx) continue;  // skip lines crossing face boundaries
            this.lineBuckets[ra.face.idx].push({
                u1: ra.u, v1: ra.v, u2: rb.u, v2: rb.v,
            });
        }

        if (this._showEcliptic) {
            this.eclipticBuckets = bucketEcliptic(
                this.eclipticPoints,
                this.faces.length,
                projFn,
            );
        }
        if (this._showZodiac) {
            this.zodiacBuckets = bucketEclipticLines(
                this.zodiacBands,
                this.faces.length,
                projFn,
            );
        }

        this.draw();
    }

    draw() {
        const ctx = this.ctx;
        const W = this.canvas.width, H = this.canvas.height;
        ctx.clearRect(0, 0, W, H);

        const n = this.faces.length;
        const { cols, rows } = bestGridLayout(n);

        const hasEarth = !!this.earthCanvases;
        const margin = 30, headerH = 30;
        const halfH = hasEarth ? H / 2 : H;
        const cellW = (W - margin * 2) / cols;
        const cellH = (halfH - margin * 2 - headerH) / rows;
        const pentSize = Math.min(cellW, cellH) * 0.43;

        ctx.fillStyle = '#cccccc';
        ctx.font = '13px sans-serif';
        ctx.fillText(`Stars - ${this.polyhedron.name} ${cols}x${rows} grid (sorted by normal.y)`, 16, 20);
        if (hasEarth) ctx.fillText('Earth - same projection', 16, halfH + 20);

        for (let i = 0; i < n; i++) {
            const col = i % cols;
            const row = Math.floor(i / cols);
            const cx = margin + cellW * (col + 0.5);
            const cy = margin + headerH + cellH * (row + 0.5);
            this.drawFace(this.faceOrder[i], cx, cy, pentSize);
        }
        if (hasEarth) {
            for (let i = 0; i < n; i++) {
                const col = i % cols;
                const row = Math.floor(i / cols);
                const cx = margin + cellW * (col + 0.5);
                const cy = halfH + margin + headerH + cellH * (row + 0.5);
                this.drawEarthFace(this.faceOrder[i], cx, cy, pentSize);
                if (this._showElevation && this._elevationBuckets) {
                    this.drawElevationFace(this.faceOrder[i], cx, cy, pentSize);
                }
            }
        }
    }

    drawElevationFace(faceIdx, cx, cy, pentSize) {
        const face = this.faces[faceIdx];
        const runs = this._elevationBuckets && this._elevationBuckets[faceIdx];
        if (!runs || runs.length === 0) return;
        const corners = faceCornersAt(face, cx, cy, pentSize);
        const aff = affineFromFace2DToDisplay(face.vertices2D, corners);
        if (!aff) return;
        drawElevationRunsOnFace(this.ctx, runs, corners, aff, 1.0, this._elevExag, this._landOnly);
    }

    drawEarthFace(faceIdx, cx, cy, pentSize) {
        if (!this.earthCanvases || !this.earthCanvases[faceIdx]) return;
        const ctx = this.ctx;
        const face = this.faces[faceIdx];
        const earthCanvas = this.earthCanvases[faceIdx];

        const corners = faceCornersAt(face, cx, cy, pentSize);
        const aff = affineFromPolygons(earthCanvas.polygonCorners, corners);
        if (!aff) return;

        ctx.save();
        tracePolygon(ctx, corners);
        ctx.clip();
        // Tile tint: fill the polygon with the chosen white-range color, then
        // composite-multiply the Earth canvas on top so the canvas's white
        // background turns into the tint and the sepia outlines darken
        // slightly (since sepia × near-white tint ≈ sepia).
        if (this._tileTint != null && this._tileTint !== 0xffffff) {
            tracePolygon(ctx, corners);
            ctx.fillStyle = '#' + this._tileTint.toString(16).padStart(6, '0');
            ctx.fill();
            ctx.globalCompositeOperation = 'multiply';
        }
        if (!this._tileOpaque) ctx.globalAlpha = 0.35;
        ctx.setTransform(aff.a, aff.b, aff.c, aff.d, aff.e, aff.f);
        ctx.drawImage(earthCanvas, 0, 0);
        ctx.restore();

        if (this._showFaceOutlines) {
            ctx.strokeStyle = '#ffd700';
            ctx.lineWidth = 3;
            tracePolygon(ctx, corners);
            ctx.stroke();
        }

        ctx.fillStyle = '#7a8a9a';
        ctx.font = '11px sans-serif';
        ctx.fillText(`f${faceIdx}`, cx - pentSize + 4, cy - pentSize + 12);
    }

    drawFace(faceIdx, cx, cy, pentSize) {
        const ctx = this.ctx;
        const face = this.faces[faceIdx];
        const faceFirstAngle = Math.atan2(face.vertices2D[0].v, face.vertices2D[0].u);
        const rotation = Math.PI / 2 - faceFirstAngle;
        const cosR = Math.cos(rotation), sinR = Math.sin(rotation);
        const scale = pentSize / face.faceCircumradius;

        const corners = faceCornersAt(face, cx, cy, pentSize);

        ctx.fillStyle = '#0a1a30';
        tracePolygon(ctx, corners);
        ctx.fill();
        if (this._showFaceOutlines) {
            ctx.strokeStyle = '#3366aa';
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        // Milky Way coverage map: drawn first so everything else (stars,
        // lines, zodiac, ecliptic) overlays it.
        if (this._showMW && this.mwCanvases && this.mwCanvases[faceIdx]) {
            const mw = this.mwCanvases[faceIdx];
            const aff = affineFromPolygons(mw.polygonCorners, corners);
            if (aff) {
                ctx.save();
                tracePolygon(ctx, corners);
                ctx.clip();
                ctx.setTransform(aff.a, aff.b, aff.c, aff.d, aff.e, aff.f);
                ctx.drawImage(mw, 0, 0);
                ctx.restore();
            }
        }

        // Constellation lines on this face (before stars so stars sit on top)
        ctx.strokeStyle = '#6688aa';
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        for (const line of this.lineBuckets[faceIdx]) {
            const u1R = line.u1 * cosR - line.v1 * sinR;
            const v1R = line.u1 * sinR + line.v1 * cosR;
            const u2R = line.u2 * cosR - line.v2 * sinR;
            const v2R = line.u2 * sinR + line.v2 * cosR;
            ctx.moveTo(cx + scale * u1R, cy - scale * v1R);
            ctx.lineTo(cx + scale * u2R, cy - scale * v2R);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;

        // Zodiac band boundary lines (drawn first so the ecliptic sits on top).
        ctx.strokeStyle = ZODIAC_BAND_COLOR;
        ctx.lineWidth = 0.9;
        ctx.globalAlpha = 0.55;
        ctx.beginPath();
        for (const line of this.zodiacBuckets[faceIdx] || []) {
            const u1R = line.u1 * cosR - line.v1 * sinR;
            const v1R = line.u1 * sinR + line.v1 * cosR;
            const u2R = line.u2 * cosR - line.v2 * sinR;
            const v2R = line.u2 * sinR + line.v2 * cosR;
            ctx.moveTo(cx + scale * u1R, cy - scale * v1R);
            ctx.lineTo(cx + scale * u2R, cy - scale * v2R);
        }
        ctx.stroke();

        // Ecliptic (rendered above zodiac band + constellation lines so it stays visible)
        ctx.strokeStyle = ECLIPTIC_COLOR;
        ctx.lineWidth = 1.2;
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        for (const line of this.eclipticBuckets[faceIdx] || []) {
            const u1R = line.u1 * cosR - line.v1 * sinR;
            const v1R = line.u1 * sinR + line.v1 * cosR;
            const u2R = line.u2 * cosR - line.v2 * sinR;
            const v2R = line.u2 * sinR + line.v2 * cosR;
            ctx.moveTo(cx + scale * u1R, cy - scale * v1R);
            ctx.lineTo(cx + scale * u2R, cy - scale * v2R);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;

        // Stars
        for (const star of this.starBuckets[faceIdx]) {
            const uR = star.u * cosR - star.v * sinR;
            const vR = star.u * sinR + star.v * cosR;
            const x = cx + scale * uR;
            const y = cy - scale * vR;
            ctx.globalAlpha = star.opacity;
            ctx.fillStyle = star.colorCss;
            ctx.beginPath();
            ctx.arc(x, y, Math.max(0.7, star.size * 1.6), 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;

        ctx.fillStyle = '#7a8a9a';
        ctx.font = '11px sans-serif';
        ctx.fillText(`f${faceIdx}`, cx - pentSize + 4, cy - pentSize + 12);
        ctx.fillText(`${this.starBuckets[faceIdx].length} *`, cx + pentSize - 28, cy - pentSize + 12);
    }
}

// Best 2D grid layout for n faces (cols x rows >= n, prefers slightly wider).
function bestGridLayout(n) {
    switch (n) {
        case 4:  return { cols: 2, rows: 2 };
        case 6:  return { cols: 3, rows: 2 };
        case 8:  return { cols: 4, rows: 2 };
        case 12: return { cols: 4, rows: 3 };
        case 20: return { cols: 5, rows: 4 };
        default: {
            const cols = Math.ceil(Math.sqrt(n));
            return { cols, rows: Math.ceil(n / cols) };
        }
    }
}

// Compute polygon corner positions for a face centered at (cx, cy) with the
// face's first vertex pointing canvas-up, scaled so faceCircumradius -> size.
function faceCornersAt(face, cx, cy, size) {
    const faceFirstAngle = Math.atan2(face.vertices2D[0].v, face.vertices2D[0].u);
    const rotation = Math.PI / 2 - faceFirstAngle;
    const cosR = Math.cos(rotation), sinR = Math.sin(rotation);
    const scale = size / face.faceCircumradius;
    return face.vertices2D.map(({ u, v }) => {
        const uR = u * cosR - v * sinR;
        const vR = u * sinR + v * cosR;
        return { x: cx + scale * uR, y: cy - scale * vR };
    });
}

// Trace a closed polygon path on ctx (works for triangles, squares, pentagons).
function tracePolygon(ctx, corners) {
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
}

// =====================================================================
// Mode C - Single targeted face full-screen.
// =====================================================================
class ModeC {
    constructor(canvas, polyhedron) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this._adoptPolyhedron(polyhedron);
        this.faceIdx = 0;
        this.starBucket = [];
        this.lineBucket = [];
        this.eclipticBucket = [];
        this.zodiacBucket = [];
        this.constellationLines = [];
        this.eclipticPoints = null;
        this.zodiacBands = null;
        this._showConstellations = true;
        this._showEcliptic = true;
        this._showZodiac = true;
        this._showMW = false;
        this._showFaceOutlines = true;
        this._showElevation = false;
        this._elevationBuckets = null;
        this._elevExag = 150;
        this._tileOpaque = true;
        this._landOnly = false;
        this._tileTint = 0xffffff;

        this.resize();
        window.addEventListener('resize', () => this.resize());
    }

    setElevationVisible(v) { this._showElevation = !!v; }
    setElevationBuckets(buckets) { this._elevationBuckets = buckets || null; }
    setElevationExaggeration(x) { this._elevExag = +x || 150; }
    setTileOpaque(v) { this._tileOpaque = v !== false; }
    setLandOnly(v) { this._landOnly = !!v; }
    setTileTint(hex) { this._tileTint = (hex | 0) & 0xffffff; }

    _adoptPolyhedron(polyhedron) {
        this.polyhedron = polyhedron;
        this.faces = polyhedron.faces;
        this.R = polyhedron.R;
        this.inradius = polyhedron.inradius;
    }

    setPolyhedron(polyhedron) {
        this._adoptPolyhedron(polyhedron);
        // Keep face index in range.
        if (this.faceIdx >= this.faces.length) this.faceIdx = 0;
        this.earthCanvases = null;
    }

    resize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
    }

    setFace(idx) {
        const n = this.faces.length;
        this.faceIdx = ((idx % n) + n) % n;
    }
    cycle(delta) { this.setFace(this.faceIdx + delta); }
    setConstellationLines(linePairs) { this.constellationLines = linePairs; }
    setEcliptic(xyzArray) { this.eclipticPoints = xyzArray || null; }
    setZodiacBand(bands) { this.zodiacBands = bands || null; }
    setEarthCanvases(canvases) { this.earthCanvases = canvases; }
    setMilkyWayImage(mwCanvas) {
        if (!mwCanvas) {
            this.mwCanvases = null;
            this._mwTexData = null;
            return;
        }
        try {
            this._mwTexData = extractMilkyWayTextureData(mwCanvas);
        } catch (e) {
            console.warn('Mode C Milky Way:', e.message);
            this.mwCanvases = null;
            this._mwTexData = null;
            return;
        }
        this.mwCanvases = allocateMilkyWayFaceCanvases(this.faces);
    }
    setObsToGal(m) { this._mwObsToGal = m; }
    setConstellationsVisible(v) { this._showConstellations = !!v; }
    setEclipticVisible(v) { this._showEcliptic = !!v; }
    setZodiacVisible(v) { this._showZodiac = !!v; }
    setMilkyWayVisible(v) { this._showMW = !!v; }
    setFaceOutlinesVisible(v) { this._showFaceOutlines = !!v; }
    setObsToGeographic(m) { this._obsToGeo = m || null; }

    update(starMap, getStarProps) {
        this.starBucket.length = 0;
        this.lineBucket.length = 0;
        this.eclipticBucket.length = 0;
        this.zodiacBucket.length = 0;

        // Only the active face is displayed; re-fill that one face's MW canvas.
        if (this._showMW && this.mwCanvases && this._mwTexData && this._mwObsToGal &&
            this.faceIdx < this.mwCanvases.length) {
            fillMilkyWayFaces(
                [this.mwCanvases[this.faceIdx]],
                [this.faces[this.faceIdx]],
                this._mwTexData,
                this._mwObsToGal,
            );
        }

        const M = this._obsToGeo;
        const projFn = M
            ? (d) => { applyObsToGeo(M, d); return projectDirToFace(d, this.faces, this.inradius); }
            : (d) => projectDirToFace(d, this.faces, this.inradius);

        for (const star of starMap.values()) {
            if (!star.XYZ) continue;
            const props = getStarProps(star);
            if (!props || !props.visible) continue;
            _tmpDirA.copy(star.XYZ).normalize();
            const r = projFn(_tmpDirA);
            if (!r || r.face.idx !== this.faceIdx) continue;
            this.starBucket.push({
                u: r.u, v: r.v,
                colorCss: props.colorCss, size: props.size, opacity: props.opacity,
            });
        }

        if (this._showConstellations) for (const [aId, bId] of this.constellationLines) {
            const a = starMap.get(aId);
            const b = starMap.get(bId);
            if (!a || !b || !a.XYZ || !b.XYZ) continue;
            const pa = getStarProps(a);
            const pb = getStarProps(b);
            if (!pa || !pb || !pa.visible || !pb.visible) continue;
            _tmpDirA.copy(a.XYZ).normalize();
            _tmpDirB.copy(b.XYZ).normalize();
            const ra = projFn(_tmpDirA);
            const rb = projFn(_tmpDirB);
            if (!ra || !rb) continue;
            if (ra.face.idx !== this.faceIdx || rb.face.idx !== this.faceIdx) continue;
            this.lineBucket.push({ u1: ra.u, v1: ra.v, u2: rb.u, v2: rb.v });
        }

        if (this._showEcliptic) {
            const allBuckets = bucketEcliptic(
                this.eclipticPoints,
                this.faces.length,
                projFn,
            );
            if (allBuckets[this.faceIdx]) this.eclipticBucket = allBuckets[this.faceIdx];
        }
        if (this._showZodiac) {
            const allZBuckets = bucketEclipticLines(
                this.zodiacBands,
                this.faces.length,
                projFn,
            );
            if (allZBuckets[this.faceIdx]) this.zodiacBucket = allZBuckets[this.faceIdx];
        }

        this.draw();
    }

    draw() {
        const ctx = this.ctx;
        const W = this.canvas.width, H = this.canvas.height;
        ctx.clearRect(0, 0, W, H);

        const hasEarth = !!this.earthCanvases;
        const face = this.faces[this.faceIdx];
        const cxCanvas = W / 2;
        const halfH = hasEarth ? H / 2 : H;
        const cyStar = hasEarth ? halfH / 2 : H / 2;
        const cyEarth = halfH + halfH / 2;
        const pentSize = Math.min(W, halfH) * 0.42;

        this.drawSingleStarFace(face, cxCanvas, cyStar, pentSize);
        if (hasEarth) {
            this.drawSingleEarthFace(this.faceIdx, cxCanvas, cyEarth, pentSize);
            if (this._showElevation && this._elevationBuckets) {
                this.drawSingleElevationFace(this.faceIdx, cxCanvas, cyEarth, pentSize);
            }
        }

        ctx.fillStyle = '#cccccc';
        ctx.font = '15px sans-serif';
        ctx.fillText(`Face ${this.faceIdx} / ${this.faces.length - 1}  (${this.polyhedron.name})`, 20, 30);
        const n = face.normal;
        ctx.fillText(`normal: (${n.x.toFixed(3)}, ${n.y.toFixed(3)}, ${n.z.toFixed(3)})`, 20, 50);
        ctx.fillText(`stars on face: ${this.starBucket.length}  lines: ${this.lineBucket.length}`, 20, 70);
        ctx.fillText('< / >  cycle faces', 20, H - 20);
        if (hasEarth) {
            ctx.font = '12px sans-serif';
            ctx.fillStyle = '#7a8a9a';
            ctx.fillText('stars', cxCanvas - 16, 14);
            ctx.fillText('earth', cxCanvas - 16, halfH + 14);
        }
    }

    drawSingleStarFace(face, cx, cy, pentSize) {
        const ctx = this.ctx;
        const faceFirstAngle = Math.atan2(face.vertices2D[0].v, face.vertices2D[0].u);
        const rotation = Math.PI / 2 - faceFirstAngle;
        const cosR = Math.cos(rotation), sinR = Math.sin(rotation);
        const scale = pentSize / face.faceCircumradius;

        const corners = faceCornersAt(face, cx, cy, pentSize);

        ctx.fillStyle = '#0a1a30';
        tracePolygon(ctx, corners);
        ctx.fill();
        if (this._showFaceOutlines) {
            ctx.strokeStyle = '#3366aa';
            ctx.lineWidth = 2;
            ctx.stroke();
        }

        // Milky Way coverage map for the active face.
        if (this._showMW && this.mwCanvases && this.mwCanvases[this.faceIdx]) {
            const mw = this.mwCanvases[this.faceIdx];
            const aff = affineFromPolygons(mw.polygonCorners, corners);
            if (aff) {
                ctx.save();
                tracePolygon(ctx, corners);
                ctx.clip();
                ctx.setTransform(aff.a, aff.b, aff.c, aff.d, aff.e, aff.f);
                ctx.drawImage(mw, 0, 0);
                ctx.restore();
            }
        }

        ctx.strokeStyle = '#224466';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx - 12, cy); ctx.lineTo(cx + 12, cy);
        ctx.moveTo(cx, cy - 12); ctx.lineTo(cx, cy + 12);
        ctx.stroke();

        ctx.strokeStyle = '#6688aa';
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        for (const line of this.lineBucket) {
            const u1R = line.u1 * cosR - line.v1 * sinR;
            const v1R = line.u1 * sinR + line.v1 * cosR;
            const u2R = line.u2 * cosR - line.v2 * sinR;
            const v2R = line.u2 * sinR + line.v2 * cosR;
            ctx.moveTo(cx + scale * u1R, cy - scale * v1R);
            ctx.lineTo(cx + scale * u2R, cy - scale * v2R);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;

        ctx.strokeStyle = ZODIAC_BAND_COLOR;
        ctx.lineWidth = 1.4;
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        for (const line of this.zodiacBucket) {
            const u1R = line.u1 * cosR - line.v1 * sinR;
            const v1R = line.u1 * sinR + line.v1 * cosR;
            const u2R = line.u2 * cosR - line.v2 * sinR;
            const v2R = line.u2 * sinR + line.v2 * cosR;
            ctx.moveTo(cx + scale * u1R, cy - scale * v1R);
            ctx.lineTo(cx + scale * u2R, cy - scale * v2R);
        }
        ctx.stroke();

        ctx.strokeStyle = ECLIPTIC_COLOR;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        for (const line of this.eclipticBucket) {
            const u1R = line.u1 * cosR - line.v1 * sinR;
            const v1R = line.u1 * sinR + line.v1 * cosR;
            const u2R = line.u2 * cosR - line.v2 * sinR;
            const v2R = line.u2 * sinR + line.v2 * cosR;
            ctx.moveTo(cx + scale * u1R, cy - scale * v1R);
            ctx.lineTo(cx + scale * u2R, cy - scale * v2R);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;

        for (const star of this.starBucket) {
            const uR = star.u * cosR - star.v * sinR;
            const vR = star.u * sinR + star.v * cosR;
            const x = cx + scale * uR;
            const y = cy - scale * vR;
            ctx.globalAlpha = star.opacity;
            ctx.fillStyle = star.colorCss;
            ctx.beginPath();
            ctx.arc(x, y, Math.max(1.3, star.size * 3.0), 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }

    drawSingleElevationFace(faceIdx, cx, cy, pentSize) {
        const face = this.faces[faceIdx];
        const runs = this._elevationBuckets && this._elevationBuckets[faceIdx];
        if (!runs || runs.length === 0) return;
        const corners = faceCornersAt(face, cx, cy, pentSize);
        const aff = affineFromFace2DToDisplay(face.vertices2D, corners);
        if (!aff) return;
        // Single face is full-screen, so we want a thicker stroke than Mode B.
        drawElevationRunsOnFace(this.ctx, runs, corners, aff, 1.5, this._elevExag, this._landOnly);
    }

    drawSingleEarthFace(faceIdx, cx, cy, pentSize) {
        if (!this.earthCanvases || !this.earthCanvases[faceIdx]) return;
        const ctx = this.ctx;
        const face = this.faces[faceIdx];
        const earthCanvas = this.earthCanvases[faceIdx];

        const corners = faceCornersAt(face, cx, cy, pentSize);
        const aff = affineFromPolygons(earthCanvas.polygonCorners, corners);
        if (!aff) return;

        ctx.save();
        tracePolygon(ctx, corners);
        ctx.clip();
        if (this._tileTint != null && this._tileTint !== 0xffffff) {
            tracePolygon(ctx, corners);
            ctx.fillStyle = '#' + this._tileTint.toString(16).padStart(6, '0');
            ctx.fill();
            ctx.globalCompositeOperation = 'multiply';
        }
        if (!this._tileOpaque) ctx.globalAlpha = 0.35;
        ctx.setTransform(aff.a, aff.b, aff.c, aff.d, aff.e, aff.f);
        ctx.drawImage(earthCanvas, 0, 0);
        ctx.restore();

        if (this._showFaceOutlines) {
            ctx.strokeStyle = '#ffd700';
            ctx.lineWidth = 5;
            tracePolygon(ctx, corners);
            ctx.stroke();
        }
    }
}

// =====================================================================
// Mode D - Topological unfold (double-flower net).
// Top face + 5 edge-sharing neighbors = one flower; bottom face + its 5
// neighbors = the other flower. Each petal is placed by reflecting the
// parent's transform across the shared edge, so edges line up exactly.
// =====================================================================
class ModeD {
    constructor(canvas, polyhedron) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this._adoptPolyhedron(polyhedron);
        this.constellationLines = [];
        this.eclipticPoints = null;
        this.zodiacBands = null;
        this._showConstellations = true;
        this._showEcliptic = true;
        this._showZodiac = true;
        this._showMW = false;
        this._showFaceOutlines = true;
        this._showElevation = false;
        this._elevationBuckets = null;
        this._elevExag = 150;
        this._tileOpaque = true;
        this._landOnly = false;
        this._tileTint = 0xffffff;
        this.transforms = null;

        // Strategy controls which spanning tree of the dual graph is used.
        // 'steepest'   - Schlickenrieder 1997: per-vertex steepest edge as cuts.
        // 'random'     - random edge weights -> max spanning tree.
        // 'polar'      - van Wijk myriahedral: w = |mid_unit . axis|, max ST.
        // 'equatorial' - van Wijk myriahedral: w = 1 - |mid_unit . axis|, max ST.
        this.strategy = 'steepest';
        this.polarAxis = new THREE.Vector3(0, 1, 0); // zenith
        this.steepestDir = new THREE.Vector3(0.13, 1.0, 0.21).normalize();

        // Cached fit scale - kept stable across strategy swaps so changing
        // the spanning tree doesn't visually zoom the layout. Invalidated
        // only on resize / Earth-canvas attachment (when the available height
        // halves to accommodate the Earth twin).
        this.cachedFitScale = null;
        this.earthCanvases = null;

        this.resize();
        window.addEventListener('resize', () => this.resize());
    }

    _adoptPolyhedron(polyhedron) {
        this.polyhedron = polyhedron;
        this.faces = polyhedron.faces;
        this.R = polyhedron.R;
        this.inradius = polyhedron.inradius;
        const n = this.faces.length;
        this.starBuckets = Array.from({ length: n }, () => []);
        this.lineBuckets = Array.from({ length: n }, () => []);
        this.eclipticBuckets = Array.from({ length: n }, () => []);
        this.zodiacBuckets = Array.from({ length: n }, () => []);
        this.adjacency = this.computeAdjacency();
        this.topology = this.buildTopology();
        this.cachedFitScale = null;
    }

    setPolyhedron(polyhedron) {
        this._adoptPolyhedron(polyhedron);
        this.earthCanvases = null;
        this.transforms = this.computeLayout();
    }

    setStrategy(name) {
        this.strategy = name;
        this.transforms = this.computeLayout();
    }

    setEarthCanvases(canvases) {
        this.earthCanvases = canvases;
        this.cachedFitScale = null; // half-canvas now, refit
        this.transforms = this.computeLayout();
    }
    setMilkyWayImage(mwCanvas) {
        if (!mwCanvas) {
            this.mwCanvases = null;
            this._mwTexData = null;
            return;
        }
        try {
            this._mwTexData = extractMilkyWayTextureData(mwCanvas);
        } catch (e) {
            console.warn('Mode D Milky Way:', e.message);
            this.mwCanvases = null;
            this._mwTexData = null;
            return;
        }
        this.mwCanvases = allocateMilkyWayFaceCanvases(this.faces);
    }
    setObsToGal(m) { this._mwObsToGal = m; }
    setConstellationsVisible(v) { this._showConstellations = !!v; }
    setEclipticVisible(v) { this._showEcliptic = !!v; }
    setZodiacVisible(v) { this._showZodiac = !!v; }
    setMilkyWayVisible(v) { this._showMW = !!v; }
    setFaceOutlinesVisible(v) { this._showFaceOutlines = !!v; }
    setObsToGeographic(m) { this._obsToGeo = m || null; }

    computeAdjacency() {
        const n = this.faces.length;
        const adj = Array.from({ length: n }, () => []);
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                let shared = 0;
                for (const va of this.faces[i].vertices3D) {
                    for (const vb of this.faces[j].vertices3D) {
                        if (va.distanceToSquared(vb) < 1e-3) shared++;
                    }
                }
                if (shared === 2) { adj[i].push(j); adj[j].push(i); }
            }
        }
        return adj;
    }

    resize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
        this.cachedFitScale = null;
        this.transforms = this.computeLayout();
    }

    // Build polyhedron topology: dedup vertices, list edges (each remembers its
    // two adjacent faces and two endpoint vertex indices), and the per-vertex
    // incident-edge list. Generic for any polyhedron whose `faces[].vertices3D`
    // are populated.
    buildTopology() {
        const vertices = [];
        const vertexKeys = new Map();
        const key = v => `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`;
        const addV = v => {
            const k = key(v);
            if (vertexKeys.has(k)) return vertexKeys.get(k);
            const i = vertices.length;
            vertexKeys.set(k, i);
            vertices.push(v);
            return i;
        };

        const faceVerts = this.faces.map(f => f.vertices3D.map(addV));

        const edgeMap = new Map();
        const edges = [];
        for (let fIdx = 0; fIdx < this.faces.length; fIdx++) {
            const vs = faceVerts[fIdx];
            for (let i = 0; i < vs.length; i++) {
                const a = vs[i], b = vs[(i + 1) % vs.length];
                const lo = Math.min(a, b), hi = Math.max(a, b);
                const k = `${lo}_${hi}`;
                if (!edgeMap.has(k)) {
                    edgeMap.set(k, edges.length);
                    edges.push({ v1: lo, v2: hi, faces: [] });
                }
                edges[edgeMap.get(k)].faces.push(fIdx);
            }
        }

        const vertexEdges = vertices.map(() => []);
        for (let eIdx = 0; eIdx < edges.length; eIdx++) {
            vertexEdges[edges[eIdx].v1].push(eIdx);
            vertexEdges[edges[eIdx].v2].push(eIdx);
        }

        return { vertices, edges, vertexEdges };
    }

    // Compute the cut-edge set (and therefore the fold spanning tree) according
    // to the current strategy. Each branch returns a Set of indices into
    // this.topology.edges identifying which edges are CUT; the complement is
    // the fold tree.
    //
    //   steepest   - Schlickenrieder 1997 per-vertex steepest edge.
    //   random     - random weights -> Kruskal max spanning tree on dual.
    //   polar      - van Wijk myriahedral: w(e) = |mid_unit . axis|, max ST.
    //   equatorial - van Wijk myriahedral: w(e) = 1 - |mid_unit . axis|, max ST.
    computeCutEdges() {
        const { vertices, edges, vertexEdges } = this.topology;

        if (this.strategy === 'steepest') {
            const c = this.steepestDir;
            const cuts = new Set();
            const dirTmp = new THREE.Vector3();
            for (let vIdx = 0; vIdx < vertices.length; vIdx++) {
                let bestEdge = -1, bestDot = -Infinity;
                for (const eIdx of vertexEdges[vIdx]) {
                    const e = edges[eIdx];
                    const otherIdx = e.v1 === vIdx ? e.v2 : e.v1;
                    dirTmp.subVectors(vertices[otherIdx], vertices[vIdx]).normalize();
                    const d = dirTmp.dot(c);
                    if (d > bestDot) { bestDot = d; bestEdge = eIdx; }
                }
                if (bestEdge !== -1) cuts.add(bestEdge);
            }
            return cuts;
        }

        // For random / myriahedral strategies, work on the DUAL graph:
        // each polyhedron edge (with two adjacent faces) is a dual edge.
        const dualEdges = [];
        const midTmp = new THREE.Vector3();
        for (let eIdx = 0; eIdx < edges.length; eIdx++) {
            const e = edges[eIdx];
            if (e.faces.length !== 2) continue;
            let w;
            if (this.strategy === 'random') {
                w = Math.random();
            } else {
                midTmp.addVectors(vertices[e.v1], vertices[e.v2]).multiplyScalar(0.5).normalize();
                const align = Math.abs(midTmp.dot(this.polarAxis));
                w = (this.strategy === 'polar') ? align : (1 - align);
            }
            dualEdges.push({ fa: e.faces[0], fb: e.faces[1], edgeIdx: eIdx, weight: w });
        }
        // Max spanning tree (Kruskal) on the dual: high weight = kept = fold.
        const foldSet = kruskalMaxSpanningTree(this.faces.length, dualEdges);
        // Cut set = complement.
        const cuts = new Set();
        for (let eIdx = 0; eIdx < edges.length; eIdx++) {
            if (!foldSet.has(eIdx) && edges[eIdx].faces.length === 2) cuts.add(eIdx);
        }
        return cuts;
    }

    // BFS-unfold using the spanning tree implied by computeCutEdges().
    // Generalises to any convex polyhedron with n-gon faces; n=5 isn't assumed.
    computeLayout() {
        const W = this.canvas.width, H = this.canvas.height;
        const margin = 40;
        const { edges } = this.topology;

        const cutEdges = this.computeCutEdges();

        // Fold edges -> spanning tree of the dual.
        const treeAdj = Array.from({ length: this.faces.length }, () => []);
        for (let eIdx = 0; eIdx < edges.length; eIdx++) {
            if (cutEdges.has(eIdx)) continue;
            const e = edges[eIdx];
            if (e.faces.length !== 2) continue;
            const [fa, fb] = e.faces;
            treeAdj[fa].push(fb);
            treeAdj[fb].push(fa);
        }

        // Root: face with the largest +Y normal component (visual convention).
        let rootIdx = 0;
        for (let i = 0; i < this.faces.length; i++) {
            if (this.faces[i].normal.y > this.faces[rootIdx].normal.y) rootIdx = i;
        }

        const initialScale = Math.min(W, H) / 12;
        const transforms = new Array(this.faces.length).fill(null);
        transforms[rootIdx] = this.rootTransform(this.faces[rootIdx], 0, 0, initialScale);

        // BFS over the fold tree.
        const placed = new Set([rootIdx]);
        const queue = [rootIdx];
        while (queue.length > 0) {
            const cur = queue.shift();
            for (const n of treeAdj[cur]) {
                if (placed.has(n)) continue;
                transforms[n] = this.unfoldNeighbor(
                    this.faces[cur], transforms[cur], this.faces[n]
                );
                placed.add(n);
                queue.push(n);
            }
        }

        // Robustness: if a vertex tie left a face out of the tree, fall back
        // to placing it from any adjacent already-placed face. Logs for diagnosis.
        if (placed.size < this.faces.length) {
            console.warn(`Steepest-edge tree didn't reach all faces (${placed.size}/${this.faces.length}); falling back.`);
            for (let i = 0; i < this.faces.length; i++) {
                if (placed.has(i)) continue;
                for (const n of this.adjacency[i]) {
                    if (placed.has(n)) {
                        transforms[i] = this.unfoldNeighbor(this.faces[n], transforms[n], this.faces[i]);
                        placed.add(i);
                        break;
                    }
                }
            }
        }

        // Auto-fit. Scale is cached across strategy swaps so changing the
        // spanning tree doesn't visually zoom the layout. Each strategy's
        // own bounding box is still re-centered to the canvas (or to the
        // top half if an Earth twin is being rendered below).
        let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
        for (let i = 0; i < this.faces.length; i++) {
            const t = transforms[i];
            if (!t) continue;
            for (const { u, v } of this.faces[i].vertices2D) {
                const p = applyT(t, u, v);
                if (p.x < xmin) xmin = p.x;
                if (p.x > xmax) xmax = p.x;
                if (p.y < ymin) ymin = p.y;
                if (p.y > ymax) ymax = p.y;
            }
        }
        const lw = xmax - xmin, lh = ymax - ymin;
        const layoutW = W;
        const layoutH = this.earthCanvases ? H / 2 : H;
        let fit;
        if (this.cachedFitScale !== null) {
            fit = this.cachedFitScale;
        } else {
            fit = Math.min((layoutW - 2 * margin) / lw, (layoutH - 2 * margin) / lh);
            this.cachedFitScale = fit;
        }
        const lcx = (xmin + xmax) / 2, lcy = (ymin + ymax) / 2;
        const tcx = layoutW / 2;
        const tcy = layoutH / 2;
        for (const t of transforms) {
            if (!t) continue;
            t.a *= fit; t.b *= fit; t.c *= fit; t.d *= fit;
            t.tx = fit * (t.tx - lcx) + tcx;
            t.ty = fit * (t.ty - lcy) + tcy;
        }

        return transforms;
    }

    // Place a face with its first vertex pointing canvas-up (smaller y).
    // Matches the pentagon orientation used in modes B and C (math-style rotation
    // composed with a y-flip, which manifests as a reflection in canvas coords).
    rootTransform(face, cx, cy, scaleR) {
        const r = face.faceCircumradius;
        const S = scaleR / r;
        const u0 = face.vertices2D[0].u;
        const v0 = face.vertices2D[0].v;
        return {
            a:  S * v0 / r,
            b: -S * u0 / r,
            c: -S * u0 / r,
            d: -S * v0 / r,
            tx: cx,
            ty: cy,
        };
    }

    // Compute a child face's transform such that:
    //   - the shared edge endpoints have the same canvas position as the parent's
    //   - the child's other 3 vertices land on the OUTWARD side of that edge.
    // This is a reflection across the shared edge in canvas space, expressed as
    // an affine mapping from the child's local (u, v) to canvas.
    unfoldNeighbor(refFace, refT, myFace) {
        let i0 = -1, i1 = -1, j0 = -1, j1 = -1;
        const rN = refFace.vertices3D.length;
        const mN = myFace.vertices3D.length;
        for (let i = 0; i < rN; i++) {
            for (let j = 0; j < mN; j++) {
                if (refFace.vertices3D[i].distanceToSquared(myFace.vertices3D[j]) < 1e-3) {
                    if (i0 === -1) { i0 = i; j0 = j; }
                    else { i1 = i; j1 = j; }
                }
            }
        }
        if (i1 === -1) return null;

        const refLA = refFace.vertices2D[i0];
        const refLB = refFace.vertices2D[i1];
        const myLA = myFace.vertices2D[j0];
        const myLB = myFace.vertices2D[j1];

        const canvasA = applyT(refT, refLA.u, refLA.v);
        const canvasB = applyT(refT, refLB.u, refLB.v);

        const dlu = myLB.u - myLA.u, dlv = myLB.v - myLA.v;
        const dcx = canvasB.x - canvasA.x, dcy = canvasB.y - canvasA.y;
        const lenLocal = Math.hypot(dlu, dlv);
        const lenCanvas = Math.hypot(dcx, dcy);
        const S = lenCanvas / lenLocal;

        // Reflection M with det=-1 such that M*(dl) = dc:
        //   reflection across line through origin at angle phi where 2*phi = theta_l + theta_c
        //   M = [[cos 2phi, sin 2phi], [sin 2phi, -cos 2phi]]
        const thetaL = Math.atan2(dlv, dlu);
        const thetaC = Math.atan2(dcy, dcx);
        const twoPhi = thetaL + thetaC;
        const c2 = Math.cos(twoPhi), s2 = Math.sin(twoPhi);

        const a = S * c2;
        const b = S * s2;
        const c = S * s2;
        const d = -S * c2;
        const tx = canvasA.x - (a * myLA.u + b * myLA.v);
        const ty = canvasA.y - (c * myLA.u + d * myLA.v);

        return { a, b, c, d, tx, ty };
    }

    setConstellationLines(linePairs) { this.constellationLines = linePairs; }
    setEcliptic(xyzArray) { this.eclipticPoints = xyzArray || null; }
    setZodiacBand(bands) { this.zodiacBands = bands || null; }

    update(starMap, getStarProps) {
        for (const b of this.starBuckets) b.length = 0;
        for (const b of this.lineBuckets) b.length = 0;
        for (const b of this.eclipticBuckets) b.length = 0;
        for (const b of this.zodiacBuckets) b.length = 0;

        if (this._showMW && this.mwCanvases && this._mwTexData && this._mwObsToGal) {
            fillMilkyWayFaces(this.mwCanvases, this.faces, this._mwTexData, this._mwObsToGal);
        }

        const M = this._obsToGeo;
        const projFn = M
            ? (d) => { applyObsToGeo(M, d); return projectDirToFace(d, this.faces, this.inradius); }
            : (d) => projectDirToFace(d, this.faces, this.inradius);

        for (const star of starMap.values()) {
            if (!star.XYZ) continue;
            const props = getStarProps(star);
            if (!props || !props.visible) continue;
            _tmpDirA.copy(star.XYZ).normalize();
            const r = projFn(_tmpDirA);
            if (!r) continue;
            this.starBuckets[r.face.idx].push({
                u: r.u, v: r.v,
                colorCss: props.colorCss, size: props.size, opacity: props.opacity,
            });
        }

        if (this._showConstellations) for (const [aId, bId] of this.constellationLines) {
            const a = starMap.get(aId);
            const b = starMap.get(bId);
            if (!a || !b || !a.XYZ || !b.XYZ) continue;
            const pa = getStarProps(a);
            const pb = getStarProps(b);
            if (!pa || !pb || !pa.visible || !pb.visible) continue;
            _tmpDirA.copy(a.XYZ).normalize();
            _tmpDirB.copy(b.XYZ).normalize();
            const ra = projFn(_tmpDirA);
            const rb = projFn(_tmpDirB);
            if (!ra || !rb || ra.face.idx !== rb.face.idx) continue;
            this.lineBuckets[ra.face.idx].push({ u1: ra.u, v1: ra.v, u2: rb.u, v2: rb.v });
        }

        if (this._showEcliptic) {
            this.eclipticBuckets = bucketEcliptic(
                this.eclipticPoints,
                this.faces.length,
                projFn,
            );
        }
        if (this._showZodiac) {
            this.zodiacBuckets = bucketEclipticLines(
                this.zodiacBands,
                this.faces.length,
                projFn,
            );
        }

        this.draw();
    }

    draw() {
        const ctx = this.ctx;
        const W = this.canvas.width, H = this.canvas.height;
        ctx.clearRect(0, 0, W, H);

        ctx.fillStyle = '#cccccc';
        ctx.font = '13px sans-serif';
        ctx.fillText(`Stars - ${this.polyhedron.name} unfold  (${this.strategy})`, 16, 20);
        if (this.earthCanvases) ctx.fillText('Earth - same unfold', 16, H / 2 + 20);

        // Top half (or full canvas if no Earth): stars + constellation lines.
        for (let i = 0; i < this.faces.length; i++) {
            const t = this.transforms[i];
            if (t) this.drawStarPentagon(i, t);
        }

        // Bottom half: Earth twin using identical unfold transforms, offset Y.
        if (this.earthCanvases) {
            const yOffset = H / 2;
            for (let i = 0; i < this.faces.length; i++) {
                const t = this.transforms[i];
                if (!t) continue;
                const tBot = { a: t.a, b: t.b, c: t.c, d: t.d, tx: t.tx, ty: t.ty + yOffset };
                this.drawEarthPentagon(i, tBot);
                if (this._showElevation && this._elevationBuckets) {
                    this.drawElevationPentagon(i, tBot);
                }
            }
        }
    }

    setElevationVisible(v) { this._showElevation = !!v; }
    setElevationBuckets(buckets) { this._elevationBuckets = buckets || null; }
    setElevationExaggeration(x) { this._elevExag = +x || 150; }
    setTileOpaque(v) { this._tileOpaque = v !== false; }
    setLandOnly(v) { this._landOnly = !!v; }
    setTileTint(hex) { this._tileTint = (hex | 0) & 0xffffff; }

    drawElevationPentagon(i, t) {
        const face = this.faces[i];
        const runs = this._elevationBuckets && this._elevationBuckets[i];
        if (!runs || runs.length === 0) return;
        const corners = face.vertices2D.map(({ u, v }) => applyT(t, u, v));
        const aff = affineFromFace2DToDisplay(face.vertices2D, corners);
        if (!aff) return;
        drawElevationRunsOnFace(this.ctx, runs, corners, aff, 1.0, this._elevExag, this._landOnly);
    }

    drawStarPentagon(i, t) {
        const ctx = this.ctx;
        const face = this.faces[i];
        const corners = face.vertices2D.map(({ u, v }) => applyT(t, u, v));

        ctx.fillStyle = '#0a1a30';
        tracePolygon(ctx, corners);
        ctx.fill();
        if (this._showFaceOutlines) {
            ctx.strokeStyle = '#3366aa';
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        if (this._showMW && this.mwCanvases && this.mwCanvases[i]) {
            const mw = this.mwCanvases[i];
            const aff = affineFromPolygons(mw.polygonCorners, corners);
            if (aff) {
                ctx.save();
                tracePolygon(ctx, corners);
                ctx.clip();
                ctx.setTransform(aff.a, aff.b, aff.c, aff.d, aff.e, aff.f);
                ctx.drawImage(mw, 0, 0);
                ctx.restore();
            }
        }

        ctx.strokeStyle = '#6688aa';
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        for (const line of this.lineBuckets[i]) {
            const p1 = applyT(t, line.u1, line.v1);
            const p2 = applyT(t, line.u2, line.v2);
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;

        ctx.strokeStyle = ZODIAC_BAND_COLOR;
        ctx.lineWidth = 0.9;
        ctx.globalAlpha = 0.55;
        ctx.beginPath();
        for (const line of this.zodiacBuckets[i] || []) {
            const p1 = applyT(t, line.u1, line.v1);
            const p2 = applyT(t, line.u2, line.v2);
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
        }
        ctx.stroke();

        ctx.strokeStyle = ECLIPTIC_COLOR;
        ctx.lineWidth = 1.4;
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        for (const line of this.eclipticBuckets[i] || []) {
            const p1 = applyT(t, line.u1, line.v1);
            const p2 = applyT(t, line.u2, line.v2);
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;

        for (const star of this.starBuckets[i]) {
            const p = applyT(t, star.u, star.v);
            ctx.globalAlpha = star.opacity;
            ctx.fillStyle = star.colorCss;
            ctx.beginPath();
            ctx.arc(p.x, p.y, Math.max(0.7, star.size * 1.6), 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;

        const center = applyT(t, 0, 0);
        ctx.fillStyle = '#7a8a9a';
        ctx.font = '10px sans-serif';
        ctx.fillText(`f${i}`, center.x - 6, center.y + 3);
    }

    drawEarthPentagon(i, t) {
        if (!this.earthCanvases || !this.earthCanvases[i]) return;
        const ctx = this.ctx;
        const face = this.faces[i];
        const earthCanvas = this.earthCanvases[i];
        const srcCorners = earthCanvas.polygonCorners;
        const dstCorners = face.vertices2D.map(({ u, v }) => applyT(t, u, v));

        const aff = affineFromPolygons(srcCorners, dstCorners);
        if (!aff) return;

        ctx.save();
        tracePolygon(ctx, dstCorners);
        ctx.clip();
        if (this._tileTint != null && this._tileTint !== 0xffffff) {
            tracePolygon(ctx, dstCorners);
            ctx.fillStyle = '#' + this._tileTint.toString(16).padStart(6, '0');
            ctx.fill();
            ctx.globalCompositeOperation = 'multiply';
        }
        if (!this._tileOpaque) ctx.globalAlpha = 0.35;
        ctx.setTransform(aff.a, aff.b, aff.c, aff.d, aff.e, aff.f);
        ctx.drawImage(earthCanvas, 0, 0);
        ctx.restore();

        if (this._showFaceOutlines) {
            ctx.strokeStyle = '#ffd700';
            ctx.lineWidth = 3;
            tracePolygon(ctx, dstCorners);
            ctx.stroke();
        }

        const center = applyT(t, 0, 0);
        ctx.fillStyle = '#7a8a9a';
        ctx.font = '10px sans-serif';
        ctx.fillText(`f${i}`, center.x - 6, center.y + 3);
    }
}

function applyT(t, u, v) {
    return { x: t.a * u + t.b * v + t.tx, y: t.c * u + t.d * v + t.ty };
}

// Kruskal max spanning tree on a dual graph.
// dualEdges: [{fa, fb, edgeIdx, weight}, ...]. Returns Set of edgeIdx kept.
function kruskalMaxSpanningTree(numNodes, dualEdges) {
    const sorted = [...dualEdges].sort((a, b) => b.weight - a.weight);
    const parent = new Array(numNodes);
    for (let i = 0; i < numNodes; i++) parent[i] = i;
    const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const fold = new Set();
    for (const e of sorted) {
        const ra = find(e.fa), rb = find(e.fb);
        if (ra !== rb) {
            parent[ra] = rb;
            fold.add(e.edgeIdx);
            if (fold.size === numNodes - 1) break;
        }
    }
    return fold;
}

// =====================================================================
// Mode E - AuthaGraph-style (Imago tetrahedron projection into a 6 x 2sqrt(3)
// rectangle). Whole celestial sphere on one rectangle; same projection used
// for stars (top) and Earth (bottom). NOT dodecahedron-based - it's its own
// projection geometry.
// =====================================================================
class ModeE {
    constructor(canvas, R) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.R = R;
        this.constellationLines = [];
        this.eclipticPoints = null;
        this.zodiacBands = null;
        this.starProj = [];
        this.lineProj = [];
        this.eclipticProj = [];
        this.zodiacProj = [];   // array of projected polylines (one per band line)
        this.earthImg = null;
        this.earthCanvases = { basic: null, wide: null };
        this.k = 0.68;
        this.variant = 'wide';
        this.observerLat = 0; // radians; set via setObserverLatitude
        // Milky Way state: source pixels cached once, output canvas + its
        // ImageData allocated once per variant change, refilled every frame.
        this._mwTexData = null;
        this._mwObsToGal = null;
        this._mwOutCanvas = null;
        this._mwOutImgData = null;
        this._showConstellations = true;
        this._showEcliptic = true;
        this._showZodiac = true;
        this._showMW = false;
        this._showFaceOutlines = true;
        this.applyVariant();
        this.resize();
        window.addEventListener('resize', () => this.resize());
    }

    setObserverLatitude(latRad) {
        this.observerLat = latRad;
        // Earth canvases depend on observer latitude (it rotates the sample
        // direction so geographic north lands at the celestial pole in
        // observer frame), so we need a re-render.
        if (this.earthImg) this.renderEarthCanvases();
    }

    applyVariant() {
        if (this.variant === 'wide') {
            this.forward = imagoWideForward;
            this.inverse = imagoWideInverse;
            this.rectSize = imagoWideRectSize;
        } else {
            this.forward = imagoForward;
            this.inverse = imagoInverse;
            this.rectSize = imagoRectSize;
        }
        // Polyhedron / subdivision overlay depend on which forward we use, so
        // recompute their projected polylines here. (Cheap: dozens of arcs, not
        // per-frame.)
        this.tetraProj = this.computeTetraEdges();
        this.subdivisionProj = this.computeSubdivisionEdges();
        // The Milky Way output canvas's aspect follows the variant's rect.
        if (this._mwTexData) this._allocateMwOutCanvas();
    }

    setVariant(name) {
        if (name !== 'basic' && name !== 'wide') return;
        this.variant = name;
        this.applyVariant();
    }

    resize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
    }

    setConstellationLines(lines) { this.constellationLines = lines; }
    setEcliptic(xyzArray) { this.eclipticPoints = xyzArray || null; }
    setZodiacBand(bands) { this.zodiacBands = bands || null; }
    setMilkyWayImage(mwCanvas) {
        if (!mwCanvas) {
            this._mwTexData = null;
            this._mwOutCanvas = null;
            this._mwOutImgData = null;
            return;
        }
        try {
            this._mwTexData = extractMilkyWayTextureData(mwCanvas);
        } catch (e) {
            console.warn('Mode E Milky Way:', e.message);
            this._mwTexData = null;
            return;
        }
        this._allocateMwOutCanvas();
    }
    setObsToGal(m) { this._mwObsToGal = m; }
    setConstellationsVisible(v) { this._showConstellations = !!v; }
    setEclipticVisible(v) { this._showEcliptic = !!v; }
    setZodiacVisible(v) { this._showZodiac = !!v; }
    setMilkyWayVisible(v) { this._showMW = !!v; }
    setFaceOutlinesVisible(v) { this._showFaceOutlines = !!v; }
    setObsToGeographic(m) { this._obsToGeo = m || null; }

    // Allocate the imago-shaped output canvas (and its reusable ImageData)
    // sized to the active variant's aspect. ~320 wide keeps per-frame cost
    // tractable since fill must run every frame to track the rotating sky.
    _allocateMwOutCanvas() {
        const rect = this.rectSize();
        const W = 320;
        const H = Math.max(64, Math.round(W * rect.height / rect.width));
        const c = document.createElement('canvas');
        c.width = W;
        c.height = H;
        this._mwOutCanvas = c;
        this._mwOutImgData = c.getContext('2d').createImageData(W, H);
    }

    setEarthImage(img) {
        this.earthImg = img;
        this.renderEarthCanvases();
    }

    renderEarthCanvases() {
        if (!this.earthImg) return;
        this.earthCanvases.basic = this.renderEarthCanvasFor('basic');
        this.earthCanvases.wide  = this.renderEarthCanvasFor('wide');
    }

    renderEarthCanvasFor(variant) {
        const isWide = variant === 'wide';
        const inverse = isWide ? imagoWideInverse : imagoInverse;
        const rect = isWide ? imagoWideRectSize() : imagoRectSize();
        const renderW = 640;
        const renderH = Math.max(100, Math.round(renderW * rect.height / rect.width));

        const c = document.createElement('canvas');
        c.width = renderW;
        c.height = renderH;
        const ctx = c.getContext('2d');
        const imgData = ctx.createImageData(renderW, renderH);

        const tex = document.createElement('canvas');
        tex.width = this.earthImg.naturalWidth;
        tex.height = this.earthImg.naturalHeight;
        const tctx = tex.getContext('2d');
        tctx.drawImage(this.earthImg, 0, 0);
        let texData;
        try { texData = tctx.getImageData(0, 0, tex.width, tex.height); }
        catch (e) { console.warn('Mode E Earth CORS-tainted'); return null; }
        const texPixels = texData.data;
        const tw = texData.width, th = texData.height;

        // The projection runs in observer frame (so stars in star.XYZ project
        // directly). For Earth to align, we rotate the sampled direction from
        // observer frame to geographic frame before looking it up in the
        // equirectangular texture. The rotation is around X by (pi/2 - lat),
        // mapping observer-frame celestial pole = (0, sin lat, -cos lat)
        // onto geographic-frame +Y = (0, 1, 0).
        const angle = Math.PI / 2 - this.observerLat;
        const ca = Math.cos(angle), sa = Math.sin(angle);

        for (let py = 0; py < renderH; py++) {
            for (let px = 0; px < renderW; px++) {
                const xN = (px + 0.5) / renderW - 0.5;
                const yN = -((py + 0.5) / renderH - 0.5);
                const x = xN * rect.width;
                const y = yN * rect.height;
                let lonLat;
                try { lonLat = inverse(x, y, this.k); }
                catch (e) { continue; }
                if (!lonLat) {
                    imgData.data[(py * renderW + px) * 4 + 3] = 0;
                    continue;
                }
                // lonLat is in observer frame. Convert to unit vector.
                const lonO = lonLat[0], latO = lonLat[1];
                const cosLatO = Math.cos(latO);
                const dxo = cosLatO * Math.cos(lonO);
                const dyo = Math.sin(latO);
                const dzo = cosLatO * Math.sin(lonO);
                // Rotate around X by angle to get geographic direction.
                const dxg = dxo;
                const dyg = dyo * ca - dzo * sa;
                const dzg = dyo * sa + dzo * ca;
                const latG = Math.asin(dyg < -1 ? -1 : (dyg > 1 ? 1 : dyg));
                const lonG = Math.atan2(dzg, dxg);
                let tx = (lonG / (2 * Math.PI) + 0.5) * tw;
                let ty = (0.5 - latG / Math.PI) * th;
                if (tx < 0) tx = 0; else if (tx >= tw) tx = tw - 1; else tx |= 0;
                if (ty < 0) ty = 0; else if (ty >= th) ty = th - 1; else ty |= 0;
                const ti = (ty * tw + tx) * 4;
                const j = (py * renderW + px) * 4;
                imgData.data[j]     = texPixels[ti];
                imgData.data[j + 1] = texPixels[ti + 1];
                imgData.data[j + 2] = texPixels[ti + 2];
                imgData.data[j + 3] = 255;
            }
        }
        ctx.putImageData(imgData, 0, 0);
        return c;
    }

    // Re-fill the Milky Way imago canvas using the current observer-to-
    // galactic rotation. Per pixel: imago inverse -> observer (lon,lat) ->
    // unit vector -> galactic -> equirectangular texture sample.
    _fillMilkyWayCanvas() {
        if (!this._showMW) return;
        if (!this._mwTexData || !this._mwObsToGal || !this._mwOutCanvas) return;
        const M = this._mwObsToGal;
        const rect = this.rectSize();
        const inverse = this.inverse;
        const c = this._mwOutCanvas;
        const W = c.width, H = c.height;
        const imgData = this._mwOutImgData;
        const pixels = imgData.data;
        const tw = this._mwTexData.width, th = this._mwTexData.height;
        const texPixels = this._mwTexData.data;

        for (let py = 0; py < H; py++) {
            for (let px = 0; px < W; px++) {
                const j = (py * W + px) * 4;
                const xN = (px + 0.5) / W - 0.5;
                const yN = -((py + 0.5) / H - 0.5);
                const x = xN * rect.width;
                const y = yN * rect.height;
                let lonLat;
                try { lonLat = inverse(x, y, this.k); }
                catch (e) { pixels[j + 3] = 0; continue; }
                if (!lonLat) { pixels[j + 3] = 0; continue; }

                const lonO = lonLat[0], latO = lonLat[1];
                const cosLatO = Math.cos(latO);
                const ox = cosLatO * Math.cos(lonO);
                const oy = Math.sin(latO);
                const oz = cosLatO * Math.sin(lonO);

                const gx = M[0] * ox + M[1] * oy + M[2] * oz;
                const gy = M[3] * ox + M[4] * oy + M[5] * oz;
                const gz = M[6] * ox + M[7] * oy + M[8] * oz;

                const lat = Math.asin(gy < -1 ? -1 : (gy > 1 ? 1 : gy));
                const lon = Math.atan2(gz, gx);
                let tx = (lon / (2 * Math.PI) + 0.5) * tw;
                let ty = (0.5 - lat / Math.PI) * th;
                if (tx < 0) tx = 0; else if (tx >= tw) tx = tw - 1; else tx |= 0;
                if (ty < 0) ty = 0; else if (ty >= th) ty = th - 1; else ty |= 0;
                const ti = (ty * tw + tx) * 4;
                pixels[j]     = texPixels[ti];
                pixels[j + 1] = texPixels[ti + 1];
                pixels[j + 2] = texPixels[ti + 2];
                pixels[j + 3] = texPixels[ti + 3];
            }
        }
        c.getContext('2d').putImageData(imgData, 0, 0);
    }

    update(starMap, getStarProps) {
        // Mode E projects in observer frame (so the sky moves with sim time).
        // Earth's per-pixel render rotates observer->geographic so geographic
        // north sits at the celestial pole direction (under Polaris), keeping
        // the stars and the Earth aligned without the Earth having to spin.
        this._fillMilkyWayCanvas();

        this.starProj.length = 0;
        for (const star of starMap.values()) {
            if (!star.XYZ) continue;
            const props = getStarProps(star);
            if (!props || !props.visible) continue;
            const x = star.XYZ.x, y = star.XYZ.y, z = star.XYZ.z;
            const len = Math.sqrt(x * x + y * y + z * z);
            if (len < 1e-9) continue;
            const nx = x / len, ny = y / len, nz = z / len;
            const lat = Math.asin(ny < -1 ? -1 : (ny > 1 ? 1 : ny));
            const lon = Math.atan2(nz, nx);
            const xy = this.forward(lon, lat, this.k);
            this.starProj.push({
                px: xy[0], py: xy[1],
                color: props.colorCss, size: props.size, opacity: props.opacity,
            });
        }

        // Constellation lines via slerp + polyline; no drops (draw-time break on jump).
        this.lineProj.length = 0;
        const N = 16;
        if (this._showConstellations) for (const [aId, bId] of this.constellationLines) {
            const a = starMap.get(aId), b = starMap.get(bId);
            if (!a || !b || !a.XYZ || !b.XYZ) continue;
            const pa = getStarProps(a), pb = getStarProps(b);
            if (!pa || !pb || !pa.visible || !pb.visible) continue;
            const ax = a.XYZ.x, ay = a.XYZ.y, az = a.XYZ.z;
            const bx = b.XYZ.x, by = b.XYZ.y, bz = b.XYZ.z;
            const la = Math.sqrt(ax * ax + ay * ay + az * az);
            const lb = Math.sqrt(bx * bx + by * by + bz * bz);
            const nax = ax / la, nay = ay / la, naz = az / la;
            const nbx = bx / lb, nby = by / lb, nbz = bz / lb;
            const dot = Math.max(-1, Math.min(1, nax * nbx + nay * nby + naz * nbz));
            const omega = Math.acos(dot);
            const sinO = Math.sin(omega);
            const pts = [];
            for (let i = 0; i <= N; i++) {
                const t = i / N;
                let dx, dy, dz;
                if (sinO < 1e-9) {
                    dx = nax; dy = nay; dz = naz;
                } else {
                    const s0 = Math.sin((1 - t) * omega) / sinO;
                    const s1 = Math.sin(t * omega) / sinO;
                    dx = nax * s0 + nbx * s1;
                    dy = nay * s0 + nby * s1;
                    dz = naz * s0 + nbz * s1;
                }
                const lat = Math.asin(dy < -1 ? -1 : (dy > 1 ? 1 : dy));
                const lon = Math.atan2(dz, dx);
                const xy = this.forward(lon, lat, this.k);
                pts.push([xy[0], xy[1]]);
            }
            this.lineProj.push(pts);
        }

        this.eclipticProj.length = 0;
        if (this._showEcliptic && this.eclipticPoints) {
            for (const v of this.eclipticPoints) {
                const len = Math.hypot(v.x, v.y, v.z) || 1;
                const nx = v.x / len, ny = v.y / len, nz = v.z / len;
                const lat = Math.asin(ny < -1 ? -1 : (ny > 1 ? 1 : ny));
                const lon = Math.atan2(nz, nx);
                const xy = this.forward(lon, lat, this.k);
                this.eclipticProj.push([xy[0], xy[1]]);
            }
        }

        this.zodiacProj.length = 0;
        if (this._showZodiac && this.zodiacBands) {
            for (const band of this.zodiacBands) {
                const pts = [];
                for (const v of band) {
                    const len = Math.hypot(v.x, v.y, v.z) || 1;
                    const nx = v.x / len, ny = v.y / len, nz = v.z / len;
                    const lat = Math.asin(ny < -1 ? -1 : (ny > 1 ? 1 : ny));
                    const lon = Math.atan2(nz, nx);
                    const xy = this.forward(lon, lat, this.k);
                    pts.push([xy[0], xy[1]]);
                }
                this.zodiacProj.push(pts);
            }
        }

        // (tetraProj and subdivisionProj are recomputed in applyVariant().)
        this.draw();
    }

    // Tetrahedron vertices for the Imago orientation: antipodes of the 4 centrums
    // (south pole + 3 in upper hemisphere at lon=180,-60,60). Mutual dot products
    // = -1/3, i.e. 109.47 deg apart (regular tetrahedron inscribed in unit sphere).
    tetraVertices() {
        const asinThird = Math.asin(1 / 3);
        return [
            [-Math.PI / 2, 0],
            [asinThird, Math.PI],
            [asinThird, -Math.PI / 3],
            [asinThird, Math.PI / 3],
        ].map(([lat, lon]) => [
            Math.cos(lat) * Math.cos(lon),
            Math.sin(lat),
            Math.cos(lat) * Math.sin(lon),
        ]);
    }

    // Sample a great-circle arc between unit vectors A and B at N+1 points,
    // project each through the current Imago variant. Returns Array<[x,y]>.
    sampleProjectedArc(A, B, N) {
        const dot = Math.max(-1, Math.min(1, A[0]*B[0] + A[1]*B[1] + A[2]*B[2]));
        const omega = Math.acos(dot);
        const sinO = Math.sin(omega);
        const pts = [];
        for (let n = 0; n <= N; n++) {
            const t = n / N;
            let dx, dy, dz;
            if (sinO < 1e-9) {
                dx = A[0]; dy = A[1]; dz = A[2];
            } else {
                const s0 = Math.sin((1 - t) * omega) / sinO;
                const s1 = Math.sin(t * omega) / sinO;
                dx = A[0]*s0 + B[0]*s1;
                dy = A[1]*s0 + B[1]*s1;
                dz = A[2]*s0 + B[2]*s1;
            }
            const lat = Math.asin(dy < -1 ? -1 : (dy > 1 ? 1 : dy));
            const lon = Math.atan2(dz, dx);
            const xy = this.forward(lon, lat, this.k);
            pts.push([xy[0], xy[1]]);
        }
        return pts;
    }

    computeTetraEdges() {
        const verts = this.tetraVertices();
        const edges = [[0,1],[0,2],[0,3],[1,2],[1,3],[2,3]];
        return edges.map(([i, j]) => this.sampleProjectedArc(verts[i], verts[j], 32));
    }

    // Subdivide each tetrahedron face into N x N geodesic sub-triangles via
    // barycentric interpolation + sphere normalization. Emit every interior +
    // boundary edge of the resulting triangular grid as a great-circle arc
    // projected through the current Imago variant. With N=5 we get 4 x 25 = 100
    // sub-faces (Narukawa's quoted "96 triangles", subject to integer factoring).
    computeSubdivisionEdges() {
        const SUB_N = 5;
        const ARC_SAMPLES = 8;
        const verts = this.tetraVertices();
        // 4 tetrahedron faces, vertex indices CCW from outside. Particular ordering
        // doesn't matter for edge enumeration since we draw every grid edge.
        const faces = [[1,2,3],[0,3,2],[0,1,3],[0,2,1]];
        const out = [];
        for (const [ia, ib, ic] of faces) {
            const A = verts[ia], B = verts[ib], C = verts[ic];
            // (SUB_N+1) rows of vertices; row i has (SUB_N - i + 1) entries.
            const grid = [];
            for (let i = 0; i <= SUB_N; i++) {
                grid.push([]);
                for (let j = 0; j <= SUB_N - i; j++) {
                    const k = SUB_N - i - j;
                    const x = (i * A[0] + j * B[0] + k * C[0]) / SUB_N;
                    const y = (i * A[1] + j * B[1] + k * C[1]) / SUB_N;
                    const z = (i * A[2] + j * B[2] + k * C[2]) / SUB_N;
                    const len = Math.sqrt(x*x + y*y + z*z);
                    grid[i].push([x/len, y/len, z/len]);
                }
            }
            // Three families of grid lines; emit each as an arc.
            for (let i = 0; i <= SUB_N; i++) {
                for (let j = 0; j <= SUB_N - i; j++) {
                    // To right neighbour in same row.
                    if (j < SUB_N - i) {
                        out.push(this.sampleProjectedArc(grid[i][j], grid[i][j+1], ARC_SAMPLES));
                    }
                    // To same-j vertex in next row.
                    if (i < SUB_N && j <= SUB_N - i - 1) {
                        out.push(this.sampleProjectedArc(grid[i][j], grid[i+1][j], ARC_SAMPLES));
                    }
                    // To prev-j vertex in next row (completes the up-triangle hat).
                    if (i < SUB_N && j > 0) {
                        out.push(this.sampleProjectedArc(grid[i][j], grid[i+1][j-1], ARC_SAMPLES));
                    }
                }
            }
        }
        return out;
    }

    draw() {
        const ctx = this.ctx;
        const W = this.canvas.width, H = this.canvas.height;
        const rect = this.rectSize();
        const margin = 30;
        const headerH = 30;

        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#000814';
        ctx.fillRect(0, 0, W, H);

        const earthCanvas = this.earthCanvases[this.variant];
        const hasEarth = !!earthCanvas;
        const halfH = hasEarth ? H / 2 : H;
        const aspect = rect.width / rect.height;
        let mapW, mapH;
        const availW = W - 2 * margin;
        const availH = halfH - margin - headerH;
        if (availW / availH > aspect) {
            mapH = availH;
            mapW = mapH * aspect;
        } else {
            mapW = availW;
            mapH = mapW / aspect;
        }
        const mapCx = W / 2;
        const mapCyStar = headerH + availH / 2;
        const mapCyEarth = halfH + headerH + availH / 2;

        ctx.fillStyle = '#cccccc';
        ctx.font = '13px sans-serif';
        ctx.fillText(`Stars - Imago ${this.variant} (k=${this.k})`, 16, 20);
        if (hasEarth) ctx.fillText('Earth - same projection', 16, halfH + 20);

        this.drawStarMap(mapCx, mapCyStar, mapW, mapH);
        if (hasEarth) this.drawEarthMap(mapCx, mapCyEarth, mapW, mapH, earthCanvas);
    }

    drawStarMap(mapCx, mapCy, mapW, mapH) {
        const ctx = this.ctx;
        const rect = this.rectSize();
        const sx = mapW / rect.width;
        const sy = mapH / rect.height;
        const x0 = mapCx - mapW / 2;
        const y0 = mapCy - mapH / 2;

        ctx.fillStyle = '#0a1a30';
        ctx.fillRect(x0, y0, mapW, mapH);

        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, y0, mapW, mapH);
        ctx.clip();

        // Milky Way coverage layer (stretched from its 320-wide source to the
        // map rectangle; canvas2d does bilinear interpolation by default).
        if (this._showMW && this._mwOutCanvas) {
            ctx.drawImage(this._mwOutCanvas, x0, y0, mapW, mapH);
        }

        const maxJump = mapW * 0.4;
        this.strokeSubdivisionEdges(mapCx, mapCy, sx, sy, maxJump);
        this.strokeTetraEdges(mapCx, mapCy, sx, sy, maxJump);

        // Polyline constellation lines, broken on big jumps (face-boundary wraps).
        ctx.strokeStyle = '#6688aa';
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        for (const pts of this.lineProj) {
            let lastX = null, lastY = null;
            for (const p of pts) {
                const x = mapCx + p[0] * sx;
                const y = mapCy - p[1] * sy;
                if (lastX === null || Math.hypot(x - lastX, y - lastY) > maxJump) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
                lastX = x; lastY = y;
            }
        }
        ctx.stroke();
        ctx.globalAlpha = 1;

        if (this.zodiacProj.length > 0) {
            ctx.strokeStyle = ZODIAC_BAND_COLOR;
            ctx.lineWidth = 1;
            ctx.globalAlpha = 0.55;
            ctx.beginPath();
            for (const band of this.zodiacProj) {
                let lastX = null, lastY = null;
                const n = band.length;
                for (let i = 0; i <= n; i++) {
                    const p = band[i % n];
                    const x = mapCx + p[0] * sx;
                    const y = mapCy - p[1] * sy;
                    if (lastX === null || Math.hypot(x - lastX, y - lastY) > maxJump) {
                        ctx.moveTo(x, y);
                    } else {
                        ctx.lineTo(x, y);
                    }
                    lastX = x; lastY = y;
                }
            }
            ctx.stroke();
            ctx.globalAlpha = 1;
        }

        if (this.eclipticProj.length > 1) {
            ctx.strokeStyle = ECLIPTIC_COLOR;
            ctx.lineWidth = 1.4;
            ctx.globalAlpha = 0.9;
            ctx.beginPath();
            let lastX = null, lastY = null;
            const n = this.eclipticProj.length;
            for (let i = 0; i <= n; i++) {
                const p = this.eclipticProj[i % n];
                const x = mapCx + p[0] * sx;
                const y = mapCy - p[1] * sy;
                if (lastX === null || Math.hypot(x - lastX, y - lastY) > maxJump) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
                lastX = x; lastY = y;
            }
            ctx.stroke();
            ctx.globalAlpha = 1;
        }

        for (const s of this.starProj) {
            ctx.globalAlpha = s.opacity;
            ctx.fillStyle = s.color;
            ctx.beginPath();
            ctx.arc(mapCx + s.px * sx, mapCy - s.py * sy,
                    Math.max(0.7, s.size * 1.6), 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.restore();

        if (this._showFaceOutlines) {
            ctx.strokeStyle = '#3366aa';
            ctx.lineWidth = 1;
            ctx.strokeRect(x0, y0, mapW, mapH);
        }
    }

    drawEarthMap(mapCx, mapCy, mapW, mapH, earthCanvas) {
        if (!earthCanvas) return;
        const ctx = this.ctx;
        const rect = this.rectSize();
        const sx = mapW / rect.width;
        const sy = mapH / rect.height;
        const x0 = mapCx - mapW / 2;
        const y0 = mapCy - mapH / 2;
        ctx.drawImage(earthCanvas, x0, y0, mapW, mapH);

        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, y0, mapW, mapH);
        ctx.clip();
        this.strokeSubdivisionEdges(mapCx, mapCy, sx, sy, mapW * 0.4);
        this.strokeTetraEdges(mapCx, mapCy, sx, sy, mapW * 0.4);
        ctx.restore();

        if (this._showFaceOutlines) {
            ctx.strokeStyle = '#3366aa';
            ctx.lineWidth = 1;
            ctx.strokeRect(x0, y0, mapW, mapH);
        }
    }

    strokeTetraEdges(mapCx, mapCy, sx, sy, maxJump) {
        if (!this._showFaceOutlines) return;
        this.strokePolylineSet(this.tetraProj, mapCx, mapCy, sx, sy, maxJump, '#e6b85c', 1.4, 0.85);
    }

    strokeSubdivisionEdges(mapCx, mapCy, sx, sy, maxJump) {
        if (!this._showFaceOutlines) return;
        this.strokePolylineSet(this.subdivisionProj, mapCx, mapCy, sx, sy, maxJump, '#a07a3a', 0.5, 0.4);
    }

    strokePolylineSet(set, mapCx, mapCy, sx, sy, maxJump, color, width, alpha) {
        if (!set) return;
        const ctx = this.ctx;
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        for (const pts of set) {
            let lastX = null, lastY = null;
            for (const p of pts) {
                const x = mapCx + p[0] * sx;
                const y = mapCy - p[1] * sy;
                if (lastX === null || Math.hypot(x - lastX, y - lastY) > maxJump) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
                lastX = x; lastY = y;
            }
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
    }
}

// =====================================================================
// Mode F - Waterman butterfly with detached Antarctica.
//
// This replaces the failed subdivided-tetra experiment. The geometry follows
// the Waterman W5 / truncated-octahedron family: the sphere is split into 8
// octants, each octant gets a central hexagonal facet, and each original
// octahedron vertex contributes small triangular truncation facets. The four
// facets touching the south pole are cut from the butterfly and reassembled as
// a detached island below the main net.
// =====================================================================
const WATERMAN_OCTA_FACES = [
    [0, 2, 1], [0, 3, 2], [5, 1, 2], [5, 2, 3],
    [0, 1, 4], [0, 4, 3], [5, 4, 1], [5, 3, 4],
];
const WATERMAN_HEX_PARENTS = [-1, 0, 0, 1, 0, 1, 4, 5];
const WATERMAN_TIP_A = 3 / Math.sqrt(10);
const WATERMAN_TIP_B = 1 / Math.sqrt(10);
const WATERMAN_EARTH_RENDER_SIZE = 192;

function buildWatermanButterfly(R) {
    const base = [
        new THREE.Vector3(0, R, 0),   // north pole
        new THREE.Vector3(0, 0, -R),  // lon -90
        new THREE.Vector3(R, 0, 0),   // lon 0
        new THREE.Vector3(0, 0, R),   // lon +90
        new THREE.Vector3(-R, 0, 0),  // lon 180
        new THREE.Vector3(0, -R, 0),  // south pole
    ];

    const faces = [];
    const parents = [];
    const hexFaces = [];
    const tipFaces = [];
    const southTipIndices = [];

    for (let j = 0; j < WATERMAN_OCTA_FACES.length; j++) {
        const oct = WATERMAN_OCTA_FACES[j].map(i => base[i]);
        const hexVerts = [];
        let a = oct[oct.length - 1];
        for (let i = 0; i < oct.length; i++) {
            const b = oct[i];
            hexVerts.push(new THREE.Vector3(
                a.x * WATERMAN_TIP_A + b.x * WATERMAN_TIP_B,
                a.y * WATERMAN_TIP_A + b.y * WATERMAN_TIP_B,
                a.z * WATERMAN_TIP_A + b.z * WATERMAN_TIP_B,
            ));
            hexVerts.push(new THREE.Vector3(
                b.x * WATERMAN_TIP_A + a.x * WATERMAN_TIP_B,
                b.y * WATERMAN_TIP_A + a.y * WATERMAN_TIP_B,
                b.z * WATERMAN_TIP_A + a.z * WATERMAN_TIP_B,
            ));
            a = b;
        }
        const face = finishWatermanFace(hexVerts, faces.length, null, R);
        face.kind = 'hex';
        face.octant = j;
        faces.push(face);
        hexFaces.push(face);
        parents.push(WATERMAN_HEX_PARENTS[j]);
    }

    for (let j = 0; j < WATERMAN_OCTA_FACES.length; j++) {
        const octBaseIdx = WATERMAN_OCTA_FACES[j];
        const oct = octBaseIdx.map(i => base[i]);
        const hexFace = hexFaces[j];
        for (let i = 0; i < oct.length; i++) {
            const face = finishWatermanFace([
                oct[i],
                hexFace._hexSource[(i * 2 + 2) % 6],
                hexFace._hexSource[(i * 2 + 1) % 6],
            ], faces.length, oct[i], R);
            face.kind = 'tip';
            face.octant = j;
            face.baseVertexIndex = octBaseIdx[i];
            face.detachedSouthTip = octBaseIdx[i] === 5;
            faces.push(face);
            tipFaces.push(face);
            parents.push(j);
            if (face.detachedSouthTip) southTipIndices.push(face.idx);
        }
    }

    for (const f of hexFaces) delete f._hexSource;

    return {
        type: 'watermanW5',
        name: 'Waterman Butterfly W5',
        R,
        faces,
        hexFaces,
        tipFaces,
        parents,
        southTipIndices,
        northVertex: base[0],
        southVertex: base[5],
    };
}

function finishWatermanFace(onFace, idx, projectionCenter = null, R = 100) {
    let cx = 0, cy = 0, cz = 0;
    for (const v of onFace) { cx += v.x; cy += v.y; cz += v.z; }
    cx /= onFace.length; cy /= onFace.length; cz /= onFace.length;
    const facetCenter = new THREE.Vector3(cx, cy, cz);

    const e1 = new THREE.Vector3().subVectors(onFace[1], onFace[0]);
    const e2 = new THREE.Vector3().subVectors(onFace[2], onFace[0]);
    const facetNormal = new THREE.Vector3().crossVectors(e1, e2).normalize();
    if (facetNormal.dot(facetCenter) < 0) facetNormal.negate();
    const facetPlaneDist = onFace[0].dot(facetNormal);

    // D3's Waterman variant uses the octant vertex as the projection center
    // for truncation triangles. Keep that projection plane separate from the
    // physical facet plane used for face selection.
    const normal = projectionCenter
        ? projectionCenter.clone().normalize()
        : facetNormal.clone();
    const center = normal.clone().multiplyScalar(R);
    const projectionPlaneDist = R;

    const helper = Math.abs(normal.y) < 0.95
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(1, 0, 0);
    // East-pointing basisU (see comment in polyhedra.js finishFace for why).
    const basisU = new THREE.Vector3().crossVectors(normal, helper).normalize();
    const basisV = new THREE.Vector3().crossVectors(basisU, normal).normalize();

    const indexed = onFace.map(v => {
        const dir = v.clone().normalize();
        const denom = dir.dot(normal);
        const point = dir.multiplyScalar(projectionPlaneDist / Math.max(denom, 1e-9));
        const off = new THREE.Vector3().subVectors(point, center);
        const u = off.dot(basisU);
        const w = off.dot(basisV);
        return { v, u, w, angle: Math.atan2(w, u) };
    });
    indexed.sort((a, b) => a.angle - b.angle);

    const vertices3D = indexed.map(s => s.v);
    const vertices2D = indexed.map(s => ({ u: s.u, v: s.w }));
    let faceCircumradius = 0;
    for (const v of vertices2D) {
        const r = Math.hypot(v.u, v.v);
        if (r > faceCircumradius) faceCircumradius = r;
    }

    return {
        idx,
        normal,
        center,
        projectionPlaneDist,
        facetCenter,
        facetNormal,
        facetPlaneDist,
        basisU,
        basisV,
        vertices3D,
        vertices2D,
        faceCircumradius,
        _hexSource: onFace,
    };
}

function pointInWatermanPolygon(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].u, yi = poly[i].v;
        const xj = poly[j].u, yj = poly[j].v;
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}

class ModeF {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.polyhedron = buildWatermanButterfly(100);
        this.faces = this.polyhedron.faces;
        this.parents = this.polyhedron.parents;
        this.southTipIndices = this.polyhedron.southTipIndices;
        this.starBuckets = Array.from({ length: this.faces.length }, () => []);
        this.lineBuckets = Array.from({ length: this.faces.length }, () => []);
        this.eclipticBuckets = Array.from({ length: this.faces.length }, () => []);
        this.zodiacBuckets = Array.from({ length: this.faces.length }, () => []);
        this.constellationLines = [];
        this.eclipticPoints = null;
        this.zodiacBands = null;
        this._showConstellations = true;
        this._showEcliptic = true;
        this._showZodiac = true;
        this._showMW = false;
        this._showFaceOutlines = true;
        this._antarcticaDetached = true;
        this.earthImg = null;
        this.earthCanvases = null;
        this.observerLat = 0;
        this.earthMode = 'atlantic';
        this.profileRadians = {
            atlantic: -20 * Math.PI / 180,
            pacific: 160 * Math.PI / 180,
            zero: 0,
        };
        this.profileLabels = {
            atlantic: 'Atlantic profile, central meridian 20W',
            pacific: 'Pacific profile, central meridian 160E',
            zero: 'Zero-meridian profile',
        };
        this.transforms = null;
        this.resize();
        window.addEventListener('resize', () => this.resize());
    }

    setEarthMode(mode) {
        const valid = (mode === 'pacific' || mode === 'zero') ? mode : 'atlantic';
        if (this.earthMode === valid) return;
        this.earthMode = valid;
        if (this.earthImg) this.renderEarthCanvases();
    }

    profileRad() {
        return this.profileRadians[this.earthMode] || this.profileRadians.atlantic;
    }

    resize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
        this.transforms = this.computeLayout();
    }

    setConstellationLines(lines) { this.constellationLines = lines; }
    setEcliptic(xyzArray) { this.eclipticPoints = xyzArray || null; }
    setZodiacBand(bands) { this.zodiacBands = bands || null; }
    setMilkyWayImage(mwCanvas) {
        if (!mwCanvas) {
            this.mwCanvases = null;
            this._mwTexData = null;
            return;
        }
        try {
            this._mwTexData = extractMilkyWayTextureData(mwCanvas);
        } catch (e) {
            console.warn('Mode F Milky Way:', e.message);
            this.mwCanvases = null;
            this._mwTexData = null;
            return;
        }
        this.mwCanvases = allocateMilkyWayFaceCanvases(this.faces);
    }
    setObsToGal(m) { this._mwObsToGal = m; }
    setObsToGeographic(m) { this._obsToGeo = m || null; }
    setSphereOrientation(R) {
        this._sphereOrientation = R || null;
        if (this.earthImg) this.renderEarthCanvases();
    }
    setConstellationsVisible(v) { this._showConstellations = !!v; }
    setEclipticVisible(v) { this._showEcliptic = !!v; }
    setZodiacVisible(v) { this._showZodiac = !!v; }
    setMilkyWayVisible(v) { this._showMW = !!v; }
    setFaceOutlinesVisible(v) { this._showFaceOutlines = !!v; }
    setAntarcticaDetached(v) {
        this._antarcticaDetached = !!v;
        this.transforms = this.computeLayout();
    }

    setObserverLatitude(latRad) {
        this.observerLat = latRad;
        // Used by projectUnitDir to tilt observer-frame star directions onto
        // the geographic-frame polyhedron so the cel pole lands at +Y.
    }

    setEarthImage(img) {
        this.earthImg = img;
        this.renderEarthCanvases();
    }

    applyProfileRotation(v) {
        const c = this.profileRad();
        const cosC = Math.cos(c), sinC = Math.sin(c);
        const x = v.x, z = v.z;
        v.x = x * cosC + z * sinC;
        v.z = z * cosC - x * sinC;
        return v;
    }

    computeLayout() {
        const W = this.canvas.width, H = this.canvas.height;
        if (!W || !H) return null;

        const rawScale = Math.min(W, H) / 12;
        const raw = new Array(this.faces.length).fill(null);
        raw[0] = this.rootTransform(this.faces[0], 0, 0, rawScale);
        for (let i = 1; i < this.faces.length; i++) {
            const p = this.parents[i];
            if (p == null || p < 0 || !raw[p]) continue;
            raw[i] = this.unfoldNeighbor(this.faces[p], raw[p], this.faces[i]);
        }

        // Re-orient the whole net so the line from the south pole to the north
        // pole points up on the canvas (canvas -Y). The unfold-from-root gives
        // an arbitrary rotation; we want north pole at top, wings outstretched
        // horizontally. Average each pole's 2D position across every face that
        // contains it; for tree-disconnected faces the positions may differ,
        // but the average is a stable orientation reference.
        this._reorientUpright(raw);

        const sectionH = this.earthCanvases ? H / 2 : H;
        const margin = 40;
        // When Antarctica is attached, the south-pole tips ride along with
        // their parent hex in the natural unfold - no separate island to
        // reserve, and the fit must include their vertices in the bounds.
        const islandReserve = this._antarcticaDetached
            ? Math.min(160, Math.max(84, sectionH * 0.24))
            : 0;
        const mainTop = 34;
        const mainBottom = Math.max(mainTop + 60, sectionH - islandReserve - 12);

        let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
        for (let i = 0; i < this.faces.length; i++) {
            if (!raw[i]) continue;
            if (this._antarcticaDetached && this.faces[i].detachedSouthTip) continue;
            for (const { u, v } of this.faces[i].vertices2D) {
                const p = applyT(raw[i], u, v);
                if (p.x < xmin) xmin = p.x;
                if (p.x > xmax) xmax = p.x;
                if (p.y < ymin) ymin = p.y;
                if (p.y > ymax) ymax = p.y;
            }
        }
        const lw = xmax - xmin, lh = ymax - ymin;
        const fit = Math.min((W - 2 * margin) / lw, (mainBottom - mainTop) / lh);
        const lcx = (xmin + xmax) / 2, lcy = (ymin + ymax) / 2;
        const tcx = W / 2, tcy = (mainTop + mainBottom) / 2;

        const out = raw.map(t => {
            if (!t) return null;
            return {
                a: t.a * fit,
                b: t.b * fit,
                c: t.c * fit,
                d: t.d * fit,
                tx: fit * (t.tx - lcx) + tcx,
                ty: fit * (t.ty - lcy) + tcy,
            };
        });
        if (this._antarcticaDetached) {
            this.placeDetachedSouthTips(out, sectionH, islandReserve, margin);
        }
        return out;
    }

    placeDetachedSouthTips(transforms, sectionH, islandReserve, margin) {
        if (!transforms) return;
        let radiusSum = 0, radiusCount = 0;
        for (const idx of this.southTipIndices) {
            const face = this.faces[idx], t = transforms[idx];
            const sIdx = this.southLocalIndex(face);
            if (!t || sIdx < 0) continue;
            const sp = applyT(t, face.vertices2D[sIdx].u, face.vertices2D[sIdx].v);
            for (let i = 0; i < face.vertices3D.length; i++) {
                if (i === sIdx) continue;
                const p = applyT(t, face.vertices2D[i].u, face.vertices2D[i].v);
                radiusSum += Math.hypot(p.x - sp.x, p.y - sp.y);
                radiusCount++;
            }
        }
        let radius = radiusCount ? radiusSum / radiusCount : 28;
        radius = Math.max(16, Math.min(radius, islandReserve * 0.34, (this.canvas.width - 2 * margin) * 0.12));

        const center = {
            x: this.canvas.width / 2,
            y: sectionH - Math.max(18, radius + 10),
        };
        const south = this.polyhedron.southVertex;
        // Translate each tip outward by gapOffset along its bisector so the
        // 4 spoke-folds become visible as separate edges and the outline is
        // an octagon (4 outer hex-edges + 4 inner gap edges) rather than a
        // diamond. With apex = 90 deg each, flush tips share spoke endpoints
        // at the cardinals and the spokes vanish inside a square outline.
        const gapOffset = radius * 0.18;
        for (const idx of this.southTipIndices) {
            const face = this.faces[idx];
            let bx = 0, bz = 0, n = 0;
            for (const v of face.vertices3D) {
                if (v.distanceToSquared(south) < 1e-6) continue;
                bx += v.x; bz += v.z; n++;
            }
            const blen = Math.hypot(bx, bz) || 1;
            const ox = gapOffset * bx / blen;
            const oz = gapOffset * bz / blen;
            const dst = face.vertices3D.map(v => {
                if (v.distanceToSquared(south) < 1e-6) {
                    return { x: center.x + ox, y: center.y - oz };
                }
                const len = Math.hypot(v.x, v.z) || 1;
                return {
                    x: center.x + (radius * v.x / len) + ox,
                    y: center.y - (radius * v.z / len) - oz,
                };
            });
            transforms[idx] = affine3Pt(
                face.vertices2D[0], face.vertices2D[1], face.vertices2D[2],
                dst[0], dst[1], dst[2],
            );
        }
    }

    southLocalIndex(face) {
        const south = this.polyhedron.southVertex;
        return face.vertices3D.findIndex(v => v.distanceToSquared(south) < 1e-6);
    }

    rootTransform(face, cx, cy, scaleR) {
        const r = face.faceCircumradius;
        const S = scaleR / r;
        const u0 = face.vertices2D[0].u;
        const v0 = face.vertices2D[0].v;
        return {
            a:  S * v0 / r,
            b: -S * u0 / r,
            c: -S * u0 / r,
            d: -S * v0 / r,
            tx: cx,
            ty: cy,
        };
    }

    unfoldNeighbor(refFace, refT, myFace) {
        let i0 = -1, i1 = -1, j0 = -1, j1 = -1;
        for (let i = 0; i < refFace.vertices3D.length; i++) {
            for (let j = 0; j < myFace.vertices3D.length; j++) {
                if (refFace.vertices3D[i].distanceToSquared(myFace.vertices3D[j]) < 1e-3) {
                    if (i0 === -1) { i0 = i; j0 = j; }
                    else { i1 = i; j1 = j; }
                }
            }
        }
        if (i1 === -1) return null;

        const refLA = refFace.vertices2D[i0], refLB = refFace.vertices2D[i1];
        const myLA = myFace.vertices2D[j0], myLB = myFace.vertices2D[j1];
        const canvasA = applyT(refT, refLA.u, refLA.v);
        const canvasB = applyT(refT, refLB.u, refLB.v);

        const dlu = myLB.u - myLA.u, dlv = myLB.v - myLA.v;
        const dcx = canvasB.x - canvasA.x, dcy = canvasB.y - canvasA.y;
        const S = Math.hypot(dcx, dcy) / Math.hypot(dlu, dlv);
        const thetaL = Math.atan2(dlv, dlu);
        const thetaC = Math.atan2(dcy, dcx);
        const twoPhi = thetaL + thetaC;
        const c2 = Math.cos(twoPhi), s2 = Math.sin(twoPhi);

        const a = S * c2, b = S * s2, c = S * s2, d = -S * c2;
        return {
            a, b, c, d,
            tx: canvasA.x - (a * myLA.u + b * myLA.v),
            ty: canvasA.y - (c * myLA.u + d * myLA.v),
        };
    }

    // Rotate every raw transform in-place so the unfolded net's south->north
    // pole axis aligns with canvas-up (-Y). Called once per computeLayout
    // between the unfold and the fit-to-canvas pass.
    _reorientUpright(raw) {
        const north = this.polyhedron.northVertex;
        const south = this.polyhedron.southVertex;
        let Nx = 0, Ny = 0, Ncnt = 0;
        let Sx = 0, Sy = 0, Scnt = 0;
        for (let i = 0; i < this.faces.length; i++) {
            if (!raw[i]) continue;
            const face = this.faces[i];
            for (let j = 0; j < face.vertices3D.length; j++) {
                const v3 = face.vertices3D[j];
                if (v3.distanceToSquared(north) < 1e-6) {
                    const p = applyT(raw[i], face.vertices2D[j].u, face.vertices2D[j].v);
                    Nx += p.x; Ny += p.y; Ncnt++;
                } else if (v3.distanceToSquared(south) < 1e-6) {
                    const p = applyT(raw[i], face.vertices2D[j].u, face.vertices2D[j].v);
                    Sx += p.x; Sy += p.y; Scnt++;
                }
            }
        }
        if (Ncnt === 0 || Scnt === 0) return;
        Nx /= Ncnt; Ny /= Ncnt;
        Sx /= Scnt; Sy /= Scnt;
        // Current angle of S->N vector; target is -pi/2 so it points up on canvas.
        const currentAngle = Math.atan2(Ny - Sy, Nx - Sx);
        const rot = -Math.PI / 2 - currentAngle;
        if (Math.abs(rot) < 1e-6) return;
        const cosR = Math.cos(rot), sinR = Math.sin(rot);
        for (const t of raw) {
            if (!t) continue;
            const a  = cosR * t.a  - sinR * t.c;
            const b  = cosR * t.b  - sinR * t.d;
            const c  = sinR * t.a  + cosR * t.c;
            const d  = sinR * t.b  + cosR * t.d;
            const tx = cosR * t.tx - sinR * t.ty;
            const ty = sinR * t.tx + cosR * t.ty;
            t.a = a; t.b = b; t.c = c; t.d = d; t.tx = tx; t.ty = ty;
        }
    }

    renderEarthCanvases() {
        if (!this.earthImg) return;
        const tex = document.createElement('canvas');
        tex.width = this.earthImg.naturalWidth;
        tex.height = this.earthImg.naturalHeight;
        const tctx = tex.getContext('2d');
        tctx.drawImage(this.earthImg, 0, 0);
        let texData;
        try { texData = tctx.getImageData(0, 0, tex.width, tex.height); }
        catch (e) {
            console.warn('Mode F Earth CORS-tainted');
            this.earthCanvases = null;
            return;
        }
        this.earthCanvases = this.faces.map(face => this.renderEarthFace(face, texData));
        this.transforms = this.computeLayout();
    }

    renderEarthFace(face, texData) {
        const size = WATERMAN_EARTH_RENDER_SIZE;
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const ctx = c.getContext('2d');
        const imgData = ctx.createImageData(size, size);
        const half = size / 2;
        const sphereR = this._sphereOrientation;
        const pxRadius = half * 0.92;

        const faceFirstAngle = Math.atan2(face.vertices2D[0].v, face.vertices2D[0].u);
        const rotation = Math.PI / 2 - faceFirstAngle;
        const cosR = Math.cos(rotation), sinR = Math.sin(rotation);
        const scale = pxRadius / face.faceCircumradius;
        const pixels = imgData.data;
        const texPixels = texData.data;
        const tw = texData.width, th = texData.height;
        const centerLon = this.profileRad();
        const cosLon = Math.cos(centerLon), sinLon = Math.sin(centerLon);

        for (let py = 0; py < size; py++) {
            for (let px = 0; px < size; px++) {
                const uR = (px - half) / scale;
                const vR = (half - py) / scale;
                const u = uR * cosR + vR * sinR;
                const v = -uR * sinR + vR * cosR;
                const outIdx = (py * size + px) * 4;
                if (!pointInWatermanPolygon(u, v, face.vertices2D)) {
                    pixels[outIdx + 3] = 0;
                    continue;
                }

                const xx = face.center.x + u * face.basisU.x + v * face.basisV.x;
                const yy = face.center.y + u * face.basisU.y + v * face.basisV.y;
                const zz = face.center.z + u * face.basisU.z + v * face.basisV.z;
                const len = Math.sqrt(xx * xx + yy * yy + zz * zz);
                const nx = xx / len, ny = yy / len, nz = zz / len;

                // Invert the profile rotation into geographic coordinates.
                // Waterman's standard Atlantic map uses geographic north/south
                // directly with the central meridian at 20W; no observer-frame
                // horizon tilt is applied to the Earth preview.
                const dxo = nx * cosLon - nz * sinLon;
                const dzo = nx * sinLon + nz * cosLon;
                let dxg = dxo;
                let dyg = ny;
                let dzg = dzo;

                // Sphere-orientation rotation (matches the matrix pre-composed
                // onto obsToGeo for stars), so Earth + stars stay aligned.
                if (sphereR) {
                    const rx = sphereR[0]*dxg + sphereR[1]*dyg + sphereR[2]*dzg;
                    const ry = sphereR[3]*dxg + sphereR[4]*dyg + sphereR[5]*dzg;
                    const rz = sphereR[6]*dxg + sphereR[7]*dyg + sphereR[8]*dzg;
                    dxg = rx; dyg = ry; dzg = rz;
                }

                const latG = Math.asin(dyg < -1 ? -1 : (dyg > 1 ? 1 : dyg));
                const lonG = Math.atan2(dzg, dxg);
                let tx = (lonG / (2 * Math.PI) + 0.5) * tw;
                let ty = (0.5 - latG / Math.PI) * th;
                if (tx < 0) tx = 0; else if (tx >= tw) tx = tw - 1; else tx |= 0;
                if (ty < 0) ty = 0; else if (ty >= th) ty = th - 1; else ty |= 0;
                const ti = (ty * tw + tx) * 4;
                pixels[outIdx]     = texPixels[ti];
                pixels[outIdx + 1] = texPixels[ti + 1];
                pixels[outIdx + 2] = texPixels[ti + 2];
                pixels[outIdx + 3] = 255;
            }
        }
        ctx.putImageData(imgData, 0, 0);
        c.polygonCorners = face.vertices2D.map(({ u, v }) => {
            const uR = u * cosR - v * sinR;
            const vR = u * sinR + v * cosR;
            return { x: half + scale * uR, y: half - scale * vR };
        });
        return c;
    }

    projectUnitDir(unitDir) {
        // Observer XYZ -> geographic XYZ (3x3 matrix supplied via setObsToGeographic).
        // After this rotation, the polyhedron's +Y is the geographic NP and
        // the cel pole / Polaris / sub-stellar points line up with the
        // geographic frame the Earth half is sampled in.
        if (this._obsToGeo) applyObsToGeo(this._obsToGeo, unitDir);
        this.applyProfileRotation(unitDir);
        let bestIdx = -1, bestT = Infinity;
        for (let i = 0; i < this.faces.length; i++) {
            const face = this.faces[i];
            const dot = unitDir.dot(face.facetNormal);
            if (dot <= 0) continue;
            const t = face.facetPlaneDist / dot;
            if (t < bestT) { bestT = t; bestIdx = i; }
        }
        if (bestIdx < 0) return null;
        const face = this.faces[bestIdx];
        const dot = unitDir.dot(face.normal);
        if (dot <= 0) return null;
        const point3D = new THREE.Vector3().copy(unitDir).multiplyScalar(face.projectionPlaneDist / dot);
        const off = new THREE.Vector3().subVectors(point3D, face.center);
        return { face, point3D, u: off.dot(face.basisU), v: off.dot(face.basisV) };
    }

    update(starMap, getStarProps) {
        for (const b of this.starBuckets) b.length = 0;
        for (const b of this.lineBuckets) b.length = 0;
        for (const b of this.eclipticBuckets) b.length = 0;
        for (const b of this.zodiacBuckets) b.length = 0;

        if (this._showMW && this.mwCanvases && this._mwTexData && this._mwObsToGal) {
            fillMilkyWayFaces(this.mwCanvases, this.faces, this._mwTexData, this._mwObsToGal);
        }

        for (const star of starMap.values()) {
            if (!star.XYZ) continue;
            const props = getStarProps(star);
            if (!props || !props.visible) continue;
            _tmpDirA.copy(star.XYZ).normalize();
            const r = this.projectUnitDir(_tmpDirA);
            if (!r) continue;
            this.starBuckets[r.face.idx].push({
                u: r.u, v: r.v,
                colorCss: props.colorCss, size: props.size, opacity: props.opacity,
            });
        }

        const N = 24;
        const interpDir = new THREE.Vector3();
        let prev = null;
        if (this._showConstellations) for (const [aId, bId] of this.constellationLines) {
            const a = starMap.get(aId), b = starMap.get(bId);
            if (!a || !b || !a.XYZ || !b.XYZ) continue;
            const pa = getStarProps(a), pb = getStarProps(b);
            if (!pa || !pb || !pa.visible || !pb.visible) continue;
            _tmpDirA.copy(a.XYZ).normalize();
            _tmpDirB.copy(b.XYZ).normalize();
            const dot = Math.max(-1, Math.min(1, _tmpDirA.dot(_tmpDirB)));
            const omega = Math.acos(dot);
            const sinO = Math.sin(omega);
            prev = null;
            for (let i = 0; i <= N; i++) {
                const t = i / N;
                if (sinO < 1e-9) {
                    interpDir.copy(_tmpDirA);
                } else {
                    const s0 = Math.sin((1 - t) * omega) / sinO;
                    const s1 = Math.sin(t * omega) / sinO;
                    interpDir.copy(_tmpDirA).multiplyScalar(s0).addScaledVector(_tmpDirB, s1);
                }
                interpDir.normalize();
                const r = this.projectUnitDir(interpDir);
                if (prev && r && prev.face.idx === r.face.idx) {
                    this.lineBuckets[r.face.idx].push({
                        u1: prev.u, v1: prev.v, u2: r.u, v2: r.v,
                    });
                }
                prev = r;
            }
        }

        if (this._showEcliptic) {
            this.eclipticBuckets = bucketEcliptic(
                this.eclipticPoints,
                this.faces.length,
                d => this.projectUnitDir(d),
            );
        }
        if (this._showZodiac) {
            this.zodiacBuckets = bucketEclipticLines(
                this.zodiacBands,
                this.faces.length,
                d => this.projectUnitDir(d),
            );
        }

        this.draw();
    }

    draw() {
        const ctx = this.ctx;
        const W = this.canvas.width, H = this.canvas.height;
        ctx.clearRect(0, 0, W, H);

        ctx.fillStyle = '#cccccc';
        ctx.font = '13px sans-serif';
        ctx.fillText(`Stars - Waterman butterfly (${this.profileLabels[this.earthMode]})`, 16, 20);
        if (this.earthCanvases) {
            const suffix = this._antarcticaDetached ? ', Antarctica detached' : '';
            ctx.fillText('Earth - same projection' + suffix, 16, H / 2 + 20);
        }

        this.drawAllFaces(0, 'stars');
        if (this.earthCanvases) this.drawAllFaces(H / 2, 'earth');
    }

    drawAllFaces(yOffset, content) {
        for (let i = 0; i < this.faces.length; i++) {
            if (this._antarcticaDetached && this.faces[i].detachedSouthTip) continue;
            this.drawFace(i, yOffset, content);
        }
        if (this._antarcticaDetached) {
            for (const i of this.southTipIndices) this.drawFace(i, yOffset, content);
        }
    }

    drawFace(i, yOffset, content) {
        const t = this.transforms && this.transforms[i];
        if (!t) return;
        const tDraw = yOffset ? { a: t.a, b: t.b, c: t.c, d: t.d, tx: t.tx, ty: t.ty + yOffset } : t;
        if (content === 'earth') this.drawEarthFace(i, tDraw);
        else this.drawStarFace(i, tDraw);
    }

    drawStarFace(i, t) {
        const ctx = this.ctx;
        const face = this.faces[i];
        const corners = face.vertices2D.map(({ u, v }) => applyT(t, u, v));
        if (corners.length < 3) return;
        ctx.fillStyle = face.detachedSouthTip ? '#10213c' : (face.kind === 'hex' ? '#0a1a30' : '#0d1730');
        ctx.strokeStyle = face.detachedSouthTip ? '#5f7fb0' : '#3366aa';
        ctx.lineWidth = face.detachedSouthTip ? 1.2 : 0.9;
        tracePolygon(ctx, corners);
        ctx.fill();

        if (this._showMW && this.mwCanvases && this.mwCanvases[i]) {
            const mw = this.mwCanvases[i];
            const aff = affineFromPolygons(mw.polygonCorners, corners);
            if (aff) {
                ctx.save();
                tracePolygon(ctx, corners);
                ctx.clip();
                ctx.setTransform(aff.a, aff.b, aff.c, aff.d, aff.e, aff.f);
                ctx.drawImage(mw, 0, 0);
                ctx.restore();
            }
        }

        ctx.save();
        tracePolygon(ctx, corners);
        ctx.clip();

        ctx.strokeStyle = '#6688aa';
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        for (const line of this.lineBuckets[i]) {
            const p1 = applyT(t, line.u1, line.v1);
            const p2 = applyT(t, line.u2, line.v2);
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;

        ctx.strokeStyle = ZODIAC_BAND_COLOR;
        ctx.lineWidth = 0.9;
        ctx.globalAlpha = 0.55;
        ctx.beginPath();
        for (const line of this.zodiacBuckets[i] || []) {
            const p1 = applyT(t, line.u1, line.v1);
            const p2 = applyT(t, line.u2, line.v2);
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
        }
        ctx.stroke();

        ctx.strokeStyle = ECLIPTIC_COLOR;
        ctx.lineWidth = 1.4;
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        for (const line of this.eclipticBuckets[i] || []) {
            const p1 = applyT(t, line.u1, line.v1);
            const p2 = applyT(t, line.u2, line.v2);
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;

        for (const star of this.starBuckets[i]) {
            const p = applyT(t, star.u, star.v);
            ctx.globalAlpha = star.opacity;
            ctx.fillStyle = star.colorCss;
            ctx.beginPath();
            ctx.arc(p.x, p.y, Math.max(0.7, star.size * 1.6), 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.restore();

        if (this._showFaceOutlines) {
            ctx.strokeStyle = face.detachedSouthTip ? '#5f7fb0' : '#3366aa';
            ctx.lineWidth = face.detachedSouthTip ? 1.2 : 0.9;
            tracePolygon(ctx, corners);
            ctx.stroke();
        }
    }

    drawEarthFace(i, t) {
        if (!this.earthCanvases || !this.earthCanvases[i]) return;
        const ctx = this.ctx;
        const face = this.faces[i];
        const earthCanvas = this.earthCanvases[i];
        const srcCorners = earthCanvas.polygonCorners;
        const dstCorners = face.vertices2D.map(({ u, v }) => applyT(t, u, v));
        if (dstCorners.length < 3) return;
        const aff = affineFromPolygons(srcCorners, dstCorners);
        if (!aff) return;

        ctx.save();
        tracePolygon(ctx, dstCorners);
        ctx.clip();
        ctx.setTransform(aff.a, aff.b, aff.c, aff.d, aff.e, aff.f);
        ctx.drawImage(earthCanvas, 0, 0);
        ctx.restore();

        if (this._showFaceOutlines) {
            ctx.strokeStyle = face.detachedSouthTip ? '#caa86c' : '#ffd700';
            ctx.lineWidth = face.detachedSouthTip ? 2.5 : 2.5;
            tracePolygon(ctx, dstCorners);
            ctx.stroke();
        }
    }

}

// =====================================================================
// Manager
// =====================================================================
// =====================================================================
// Mode G - Waterman butterfly. Built on the TRUNCATED OCTAHEDRON (8
// hexagonal faces + 6 square faces). Each celestial-sphere octant maps to
// one regular hexagonal face; the 6 squares at the +/-X/Y/Z axis points
// are hidden in the unfold. Polyhedron selector does NOT apply -
// truncated-octahedron only.
//
// Layout: TWO wings, one per X-axis hemisphere. Each wing has a +X (or -X)
// square laid flat as a "hub diamond" at the wing center, with the 4
// hexagonal octants attached to the 4 sides of the diamond, fanning
// outward. 2 of the 4 hexes per wing extend toward the outer side of the
// canvas; the other 2 fold inward into the gap between the two wings.
// =====================================================================
class ModeG {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.polyhedron = buildPolyhedron('truncOcta', 100);
        this.hexFaces = this.polyhedron.hexFaces;     // 8 hexagonal octants
        this.sqFaces = this.polyhedron.sqFaces;       // 6 axis-aligned squares (hidden)
        this.faces = this.hexFaces;                   // Mode G works with hexes only
        const n = this.hexFaces.length;
        this.starBuckets = Array.from({ length: n }, () => []);
        this.lineBuckets = Array.from({ length: n }, () => []);
        this.eclipticBuckets = Array.from({ length: n }, () => []);
        this.zodiacBuckets = Array.from({ length: n }, () => []);
        this.constellationLines = [];
        this.eclipticPoints = null;
        this.zodiacBands = null;
        this._showConstellations = true;
        this._showEcliptic = true;
        this._showZodiac = true;
        this._showMW = false;
        this._showFaceOutlines = true;
        this.earthCanvases = null;
        this.transforms = null;
        // Map from hex face index -> slot index 0..7 in this.hexFaces, for
        // bucketing. Each hex has an octantSigns property set by the builder.
        this._hexBySign = new Map();
        for (let i = 0; i < this.hexFaces.length; i++) {
            const [sx, sy, sz] = this.hexFaces[i].octantSigns;
            this._hexBySign.set(`${sx},${sy},${sz}`, i);
        }
        this.resize();
        window.addEventListener('resize', () => this.resize());
    }

    resize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
        this.transforms = this.computeLayout();
    }

    setConstellationLines(lines) { this.constellationLines = lines; }
    setEcliptic(xyzArray) { this.eclipticPoints = xyzArray || null; }
    setZodiacBand(bands) { this.zodiacBands = bands || null; }
    setMilkyWayImage(mwCanvas) {
        if (!mwCanvas) {
            this.mwCanvases = null;
            this._mwTexData = null;
            return;
        }
        try {
            this._mwTexData = extractMilkyWayTextureData(mwCanvas);
        } catch (e) {
            console.warn('Mode G Milky Way:', e.message);
            this.mwCanvases = null;
            this._mwTexData = null;
            return;
        }
        this.mwCanvases = allocateMilkyWayFaceCanvases(this.hexFaces);
    }
    setObsToGal(m) { this._mwObsToGal = m; }
    setConstellationsVisible(v) { this._showConstellations = !!v; }
    setEclipticVisible(v) { this._showEcliptic = !!v; }
    setZodiacVisible(v) { this._showZodiac = !!v; }
    setMilkyWayVisible(v) { this._showMW = !!v; }
    setFaceOutlinesVisible(v) { this._showFaceOutlines = !!v; }
    setObsToGeographic(m) { this._obsToGeo = m || null; }
    setSphereOrientation(R) {
        this._sphereOrientation = R || null;
        if (this._earthImg) this.setEarthImage(this._earthImg);
    }

    setEarthImage(img) {
        this._earthImg = img;
        try {
            this.earthCanvases = preRenderEarthFaces(this.hexFaces, img, this._sphereOrientation);
        } catch (e) {
            console.warn('Mode G Earth pre-render failed:', e);
            this.earthCanvases = null;
        }
        this.transforms = this.computeLayout();
    }

    // For a unit direction, find which hexagonal octant contains it (by sign
    // of each coord) and return {face, u, v} of the gnomonic projection onto
    // that hex face plane. Replaces the generic projectDirToFace because the
    // squares are hidden - directions on the axes are routed to one of the
    // 4 adjacent hexes by treating 0 as +1.
    _projectToHex(unitDir) {
        const sx = unitDir.x < 0 ? -1 : +1;
        const sy = unitDir.y < 0 ? -1 : +1;
        const sz = unitDir.z < 0 ? -1 : +1;
        const idx = this._hexBySign.get(`${sx},${sy},${sz}`);
        if (idx === undefined) return null;
        const face = this.hexFaces[idx];
        const dot = unitDir.dot(face.normal);
        if (dot <= 0) return null;
        const t = face.planeDist / dot;
        const point3D = new THREE.Vector3().copy(unitDir).multiplyScalar(t);
        const off = new THREE.Vector3().subVectors(point3D, face.center);
        return { face, point3D, u: off.dot(face.basisU), v: off.dot(face.basisV) };
    }

    // Locate a hex face by its octant sign triple. The vertex indices for
    // the two named "axis-square edge" verts (each given as [xRaw, yRaw, zRaw]
    // in pre-scale coordinates) are also returned, for affine fitting.
    _findHexAndEdgeVerts(signs, edge1Raw, edge2Raw) {
        const idx = this._hexBySign.get(`${signs[0]},${signs[1]},${signs[2]}`);
        if (idx === undefined) return null;
        const face = this.hexFaces[idx];
        const s = this.polyhedron.R / Math.sqrt(5);  // raw -> scaled
        const match = (v, raw) =>
            Math.abs(v.x - raw[0] * s) < 1e-4 * this.polyhedron.R &&
            Math.abs(v.y - raw[1] * s) < 1e-4 * this.polyhedron.R &&
            Math.abs(v.z - raw[2] * s) < 1e-4 * this.polyhedron.R;
        const e1Idx = face.vertices3D.findIndex(v => match(v, edge1Raw));
        const e2Idx = face.vertices3D.findIndex(v => match(v, edge2Raw));
        if (e1Idx < 0 || e2Idx < 0) return null;
        return { face, e1Idx, e2Idx };
    }

    computeLayout() {
        const W = this.canvas.width, H = this.canvas.height;
        const margin = 40;
        const hasEarth = !!this.earthCanvases;
        const sectionH = hasEarth ? H / 2 : H;

        // Each wing = one axis-square laid flat as a 2D diamond (half-diag
        // `scale`), with 4 hexagonal octant faces attached to its 4 sides
        // and folded outward. A hexagon's centroid sits at distance
        // (1 + sqrt(3))/2 * scale from the diamond center; its farthest
        // corner reaches (3 + sqrt(3))/2 * scale ~= 2.37*scale.
        // Total horizontal extent (two wings, no overlap):
        //   wing half-width = 2.37*scale, wing-to-wing gap = max(0.5*scale, 0).
        //   total width = 2 * 2.37 + 0.5 + 2 * 2.37 = ~9.6*scale.
        //   ... actually with wings centered cxR/cxL apart by 4.73*scale + gap.
        // Total vertical extent: 2 * 2.37*scale = ~4.73*scale.
        const figW = 9.6;
        const figH = 4.73;
        const scaleByW = (W - 2 * margin) / figW;
        const scaleByH = (sectionH - 2 * margin) / figH;
        const scale = Math.max(20, Math.min(scaleByW, scaleByH));

        const cx = W / 2;
        const cy = sectionH / 2;
        const wingOffset = 2.4 * scale;  // distance from cx to each wing center
        const cxR = cx + wingOffset;
        const cxL = cx - wingOffset;

        // Right-wing diamond (the +X square laid flat). The 4 +X-square
        // verts map to the 4 diamond positions.
        const RT = { x: cxR,         y: cy - scale };  // (2, 0, +1)
        const RR = { x: cxR + scale, y: cy };          // (2, +1, 0)
        const RB = { x: cxR,         y: cy + scale };  // (2, 0, -1)
        const RL = { x: cxR - scale, y: cy };          // (2, -1, 0)

        // Left-wing diamond (the -X square). To make the LEFT wing mirror
        // the right wing's layout, we map the -X square verts with the y
        // signs FLIPPED: (-2, +1, 0) goes to the diamond's LEFT side (the
        // outward direction), (-2, -1, 0) to the inward RIGHT side.
        const LT = { x: cxL,         y: cy - scale };  // (-2, 0, +1)
        const LL = { x: cxL - scale, y: cy };          // (-2, +1, 0)  <- outward
        const LB = { x: cxL,         y: cy + scale };  // (-2, 0, -1)
        const LR = { x: cxL + scale, y: cy };          // (-2, -1, 0)  <- inward

        // Hex apothem in canvas units. The hex's edge matches the diamond's
        // side, which has length sqrt(2)*scale, so apothem = sqrt(2)*scale *
        // sqrt(3)/2 = sqrt(6)/2 * scale.
        const apothem = Math.sqrt(6) / 2 * scale;

        // One entry per hexagonal octant. The two edge verts on the axis
        // square get mapped to two adjacent diamond positions; outward
        // direction (perpendicular to the edge, pointing away from the
        // diamond center) gives the third dest for the affine fit.
        const slots = [
            // ----- right wing (4 hexes around +X diamond) -----
            // (+,+,+): edge (2,0,1)-(2,1,0) on UR side -> extends UR.
            { signs: [+1,+1,+1], e1: [2,0,1], e2: [2,1,0], e1Pos: RT, e2Pos: RR, outward: [+1, -1] },
            // (+,+,-): edge (2,1,0)-(2,0,-1) on DR side -> extends DR.
            { signs: [+1,+1,-1], e1: [2,1,0], e2: [2,0,-1], e1Pos: RR, e2Pos: RB, outward: [+1, +1] },
            // (+,-,-): edge (2,0,-1)-(2,-1,0) on DL side -> extends DL (inward toward canvas center).
            { signs: [+1,-1,-1], e1: [2,0,-1], e2: [2,-1,0], e1Pos: RB, e2Pos: RL, outward: [-1, +1] },
            // (+,-,+): edge (2,-1,0)-(2,0,1) on UL side -> extends UL (inward).
            { signs: [+1,-1,+1], e1: [2,-1,0], e2: [2,0,1], e1Pos: RL, e2Pos: RT, outward: [-1, -1] },
            // ----- left wing (4 hexes around -X diamond, mirrored) -----
            // (-,+,+): edge (-2,0,1)-(-2,1,0) -> diamond LT-LL = UL side -> extends UL (outward).
            { signs: [-1,+1,+1], e1: [-2,0,1], e2: [-2,1,0], e1Pos: LT, e2Pos: LL, outward: [-1, -1] },
            // (-,+,-): edge (-2,1,0)-(-2,0,-1) -> diamond LL-LB = DL side -> extends DL.
            { signs: [-1,+1,-1], e1: [-2,1,0], e2: [-2,0,-1], e1Pos: LL, e2Pos: LB, outward: [-1, +1] },
            // (-,-,-): edge (-2,0,-1)-(-2,-1,0) -> diamond LB-LR = DR side -> extends DR (inward).
            { signs: [-1,-1,-1], e1: [-2,0,-1], e2: [-2,-1,0], e1Pos: LB, e2Pos: LR, outward: [+1, +1] },
            // (-,-,+): edge (-2,-1,0)-(-2,0,1) -> diamond LR-LT = UR side -> extends UR (inward).
            { signs: [-1,-1,+1], e1: [-2,-1,0], e2: [-2,0,1], e1Pos: LR, e2Pos: LT, outward: [+1, -1] },
        ];

        const transforms = new Array(this.hexFaces.length).fill(null);
        for (const slot of slots) {
            const found = this._findHexAndEdgeVerts(slot.signs, slot.e1, slot.e2);
            if (!found) continue;
            const { face, e1Idx, e2Idx } = found;
            const s1 = face.vertices2D[e1Idx];
            const s2 = face.vertices2D[e2Idx];
            const s3 = { u: 0, v: 0 };  // face centroid is at (0,0) in face local
            const eMid = {
                x: (slot.e1Pos.x + slot.e2Pos.x) / 2,
                y: (slot.e1Pos.y + slot.e2Pos.y) / 2,
            };
            const oLen = Math.hypot(slot.outward[0], slot.outward[1]);
            const d3 = {
                x: eMid.x + apothem * slot.outward[0] / oLen,
                y: eMid.y + apothem * slot.outward[1] / oLen,
            };
            // Map this hex's slot in the per-face transforms array. Note we
            // use face.idx since hexFaces[i].idx may not equal i.
            const hexSlot = this.hexFaces.indexOf(face);
            transforms[hexSlot] = affine3Pt(s1, s2, s3, slot.e1Pos, slot.e2Pos, d3);
        }
        return transforms;
    }

    update(starMap, getStarProps) {
        for (const b of this.starBuckets) b.length = 0;
        for (const b of this.lineBuckets) b.length = 0;
        for (const b of this.eclipticBuckets) b.length = 0;
        for (const b of this.zodiacBuckets) b.length = 0;

        if (this._showMW && this.mwCanvases && this._mwTexData && this._mwObsToGal) {
            fillMilkyWayFaces(this.mwCanvases, this.hexFaces, this._mwTexData, this._mwObsToGal);
        }

        // Bucket per hex-face slot index (0..7), NOT face.idx (which is the
        // global face id in the truncated octahedron's faces array).
        const slotOfFace = new Map();
        for (let i = 0; i < this.hexFaces.length; i++) slotOfFace.set(this.hexFaces[i], i);

        const M = this._obsToGeo;
        const projFn = M
            ? (d) => { applyObsToGeo(M, d); return this._projectToHex(d); }
            : (d) => this._projectToHex(d);

        for (const star of starMap.values()) {
            if (!star.XYZ) continue;
            const props = getStarProps(star);
            if (!props || !props.visible) continue;
            _tmpDirA.copy(star.XYZ).normalize();
            const r = projFn(_tmpDirA);
            if (!r) continue;
            const slot = slotOfFace.get(r.face);
            if (slot === undefined) continue;
            this.starBuckets[slot].push({
                u: r.u, v: r.v,
                colorCss: props.colorCss, size: props.size, opacity: props.opacity,
            });
        }

        if (this._showConstellations) for (const [aId, bId] of this.constellationLines) {
            const a = starMap.get(aId), b = starMap.get(bId);
            if (!a || !b || !a.XYZ || !b.XYZ) continue;
            const pa = getStarProps(a), pb = getStarProps(b);
            if (!pa || !pb || !pa.visible || !pb.visible) continue;
            _tmpDirA.copy(a.XYZ).normalize();
            _tmpDirB.copy(b.XYZ).normalize();
            const ra = projFn(_tmpDirA);
            const rb = projFn(_tmpDirB);
            if (!ra || !rb || ra.face !== rb.face) continue;
            const slot = slotOfFace.get(ra.face);
            if (slot === undefined) continue;
            this.lineBuckets[slot].push({ u1: ra.u, v1: ra.v, u2: rb.u, v2: rb.v });
        }

        if (this._showEcliptic) {
            this.eclipticBuckets = bucketEcliptic(
                this.eclipticPoints,
                this.hexFaces.length,
                projFn,
                face => slotOfFace.get(face) ?? -1,
            );
        }
        if (this._showZodiac) {
            this.zodiacBuckets = bucketEclipticLines(
                this.zodiacBands,
                this.hexFaces.length,
                projFn,
                face => slotOfFace.get(face) ?? -1,
            );
        }

        this.draw();
    }

    draw() {
        const ctx = this.ctx;
        const W = this.canvas.width, H = this.canvas.height;
        ctx.clearRect(0, 0, W, H);

        ctx.fillStyle = '#cccccc';
        ctx.font = '13px sans-serif';
        ctx.fillText('Stars - Waterman butterfly (truncated octahedron)', 16, 20);
        if (this.earthCanvases) ctx.fillText('Earth - same unfold', 16, H / 2 + 20);

        for (let i = 0; i < this.hexFaces.length; i++) {
            const t = this.transforms[i];
            if (t) this._drawStarFace(i, t);
        }
        if (this.earthCanvases) {
            const yOffset = H / 2;
            for (let i = 0; i < this.hexFaces.length; i++) {
                const t = this.transforms[i];
                if (!t) continue;
                const tBot = { a: t.a, b: t.b, c: t.c, d: t.d, tx: t.tx, ty: t.ty + yOffset };
                this._drawEarthFace(i, tBot);
            }
        }
    }

    _drawStarFace(i, t) {
        const ctx = this.ctx;
        const face = this.hexFaces[i];
        const corners = face.vertices2D.map(({ u, v }) => applyT(t, u, v));

        ctx.fillStyle = '#0a1a30';
        tracePolygon(ctx, corners);
        ctx.fill();
        if (this._showFaceOutlines) {
            ctx.strokeStyle = '#3366aa';
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        if (this._showMW && this.mwCanvases && this.mwCanvases[i]) {
            const mw = this.mwCanvases[i];
            const aff = affineFromPolygons(mw.polygonCorners, corners);
            if (aff) {
                ctx.save();
                tracePolygon(ctx, corners);
                ctx.clip();
                ctx.setTransform(aff.a, aff.b, aff.c, aff.d, aff.e, aff.f);
                ctx.drawImage(mw, 0, 0);
                ctx.restore();
            }
        }

        ctx.strokeStyle = '#6688aa';
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        for (const line of this.lineBuckets[i]) {
            const p1 = applyT(t, line.u1, line.v1);
            const p2 = applyT(t, line.u2, line.v2);
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;

        ctx.strokeStyle = ZODIAC_BAND_COLOR;
        ctx.lineWidth = 0.9;
        ctx.globalAlpha = 0.55;
        ctx.beginPath();
        for (const line of this.zodiacBuckets[i] || []) {
            const p1 = applyT(t, line.u1, line.v1);
            const p2 = applyT(t, line.u2, line.v2);
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
        }
        ctx.stroke();

        ctx.strokeStyle = ECLIPTIC_COLOR;
        ctx.lineWidth = 1.4;
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        for (const line of this.eclipticBuckets[i] || []) {
            const p1 = applyT(t, line.u1, line.v1);
            const p2 = applyT(t, line.u2, line.v2);
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;

        for (const star of this.starBuckets[i]) {
            const p = applyT(t, star.u, star.v);
            ctx.globalAlpha = star.opacity;
            ctx.fillStyle = star.colorCss;
            ctx.beginPath();
            ctx.arc(p.x, p.y, Math.max(0.7, star.size * 1.6), 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;

        const center = applyT(t, 0, 0);
        ctx.fillStyle = '#7a8a9a';
        ctx.font = '10px sans-serif';
        ctx.fillText(`f${i}`, center.x - 6, center.y + 3);
    }

    _drawEarthFace(i, t) {
        if (!this.earthCanvases || !this.earthCanvases[i]) return;
        const ctx = this.ctx;
        const face = this.hexFaces[i];
        const earthCanvas = this.earthCanvases[i];
        const srcCorners = earthCanvas.polygonCorners;
        const dstCorners = face.vertices2D.map(({ u, v }) => applyT(t, u, v));

        const aff = affineFromPolygons(srcCorners, dstCorners);
        if (!aff) return;

        ctx.save();
        tracePolygon(ctx, dstCorners);
        ctx.clip();
        ctx.setTransform(aff.a, aff.b, aff.c, aff.d, aff.e, aff.f);
        ctx.drawImage(earthCanvas, 0, 0);
        ctx.restore();

        if (this._showFaceOutlines) {
            ctx.strokeStyle = '#ffd700';
            ctx.lineWidth = 3;
            tracePolygon(ctx, dstCorners);
            ctx.stroke();
        }
    }
}

// Mode H — Globe-wrapped elevation ridgelines.
// Reads a pre-computed elevation-curve binary (built from ETOPO 2022 60" Ice
// Surface NetCDF by tools/build_elevation_curves.py) and draws one closed
// polyline per latitude band wrapped around a 3D globe. Each vertex's radius
// is offset from the globe surface by the area-averaged elevation at that
// (lat, lon) bin, with a user-tunable vertical exaggeration.
//
// Coordinate convention matches the Earth pipeline in earth.js: geographic
// frame with +Y = north pole, +X = lon 0, +Z = lon +90 (so a point at lat L,
// lon Lng is (cos L cos Lng, sin L, cos L sin Lng) * radius). No observer
// tilt — Mode H is a pure Earth visualization, not coupled to the celestial
// sphere.
class ModeH {
    constructor(scene, sphereRadius) {
        this.scene = scene;
        this.R_sphere = sphereRadius;
        this.R_globe = 50;                   // matches Mode A's Earth radius
        this.EARTH_R_METERS = 6378137.0;     // WGS84 semi-major axis (matches source CRS)
        this._exaggeration = 100;
        this._latStepDeg = 3;
        this._landOnly = false;
        this._curves = null;
        this._curvesMeta = null;
        this._lineSegments = null;
        this._sphereMesh = null;

        this.group = new THREE.Group();
        this.group.visible = false;
        scene.add(this.group);

        // Optional faint backing sphere to anchor the curves visually.
        const sphereGeom = new THREE.SphereGeometry(this.R_globe, 64, 32);
        const sphereMat = new THREE.MeshBasicMaterial({
            color: 0x0a1830,
            transparent: true,
            opacity: 0.55,
            depthWrite: true,
        });
        this._sphereMesh = new THREE.Mesh(sphereGeom, sphereMat);
        this.group.add(this._sphereMesh);

        this._loadAndBuild();
    }

    async _loadAndBuild() {
        const slug = elevationStepSlug(this._latStepDeg);
        try {
            const [binResp, jsonResp] = await Promise.all([
                fetch(`./data/elevation_curves_${slug}deg.bin`),
                fetch(`./data/elevation_curves_${slug}deg.json`),
            ]);
            if (!binResp.ok)  throw new Error(`elevation curves bin (${slug}deg): HTTP ${binResp.status}`);
            if (!jsonResp.ok) throw new Error(`elevation curves json (${slug}deg): HTTP ${jsonResp.status}`);
            const buf = await binResp.arrayBuffer();
            this._curvesMeta = await jsonResp.json();
            this._curves = new Float32Array(buf);
            const [nBand, nLon] = this._curvesMeta.shape;
            if (this._curves.length !== nBand * nLon) {
                throw new Error(`Mode H: bin length ${this._curves.length} != ${nBand}*${nLon}`);
            }
            this._buildCurves();
        } catch (e) {
            console.warn('Mode H elevation data load failed:', e);
        }
    }

    setLatStepDeg(step) {
        const valid = [0.5, 1, 2, 3, 5];
        if (!valid.includes(step)) return;
        if (step === this._latStepDeg) return;
        this._latStepDeg = step;
        this._curves = null;
        this._curvesMeta = null;
        if (this._lineSegments) {
            this.group.remove(this._lineSegments);
            this._lineSegments.geometry.dispose();
            this._lineSegments.material.dispose();
            this._lineSegments = null;
        }
        this._loadAndBuild();
    }

    setLandOnly(v) {
        const next = !!v;
        if (next === this._landOnly) return;
        this._landOnly = next;
        if (this._curves) this._buildCurves();
    }

    _buildCurves() {
        if (this._lineSegments) {
            this.group.remove(this._lineSegments);
            this._lineSegments.geometry.dispose();
            this._lineSegments.material.dispose();
            this._lineSegments = null;
        }
        const meta = this._curvesMeta;
        const [nBand, nLon] = meta.shape;
        const data = this._curves;
        const latFirst = meta.lat_first_deg;
        const latStep  = meta.lat_step_deg;
        const lonFirst = meta.lon_first_deg;
        const lonStep  = meta.lon_step_deg;
        const D2R = Math.PI / 180;
        const elevScale = (this.R_globe / this.EARTH_R_METERS) * this._exaggeration;

        // One LineSegments buffer holding 2 verts per segment * nLon segments per band * nBand bands.
        const totalSegs = nBand * nLon;
        const positions = new Float32Array(totalSegs * 6);
        const colors    = new Float32Array(totalSegs * 6);

        let segIdx = 0;
        for (let bi = 0; bi < nBand; bi++) {
            const lat = (latFirst + bi * latStep) * D2R;
            const sinLat = Math.sin(lat);
            const cosLat = Math.cos(lat);
            // Pre-place all 720 vertices for this band so wraparound segment uses the right cached point.
            const vx = new Float64Array(nLon);
            const vy = new Float64Array(nLon);
            const vz = new Float64Array(nLon);
            const ve = new Float32Array(nLon);
            for (let li = 0; li < nLon; li++) {
                const lon = (lonFirst + li * lonStep) * D2R;
                const elev = data[bi * nLon + li];
                ve[li] = elev;
                const elevDisp = this._landOnly ? landOnlyElev(elev) : elev;
                const r = this.R_globe + elevDisp * elevScale;
                vx[li] =  r * cosLat * Math.cos(lon);
                vy[li] =  r * sinLat;
                // -sin(lon) on z matches Three.js SphereGeometry / Mode A-2's
                // shader convention (atan(z, -x) for longitude), where lon +90E
                // sits at -Z and lon -90W sits at +Z. Without the minus sign the
                // globe reads with east/west swapped relative to Mode A/A-2.
                vz[li] = -r * cosLat * Math.sin(lon);
            }
            for (let li = 0; li < nLon; li++) {
                const li2 = (li + 1) % nLon;
                // Land Only: collapse any fully-underwater segment to origin
                // so the globe shows just the continents' relief.
                if (this._landOnly && ve[li] <= 0 && ve[li2] <= 0) {
                    positions[segIdx * 6 + 0] = positions[segIdx * 6 + 1] = positions[segIdx * 6 + 2] = 0;
                    positions[segIdx * 6 + 3] = positions[segIdx * 6 + 4] = positions[segIdx * 6 + 5] = 0;
                    colors[segIdx * 6 + 0] = colors[segIdx * 6 + 1] = colors[segIdx * 6 + 2] = 0;
                    colors[segIdx * 6 + 3] = colors[segIdx * 6 + 4] = colors[segIdx * 6 + 5] = 0;
                    segIdx++;
                    continue;
                }
                positions[segIdx * 6 + 0] = vx[li];
                positions[segIdx * 6 + 1] = vy[li];
                positions[segIdx * 6 + 2] = vz[li];
                positions[segIdx * 6 + 3] = vx[li2];
                positions[segIdx * 6 + 4] = vy[li2];
                positions[segIdx * 6 + 5] = vz[li2];
                const c1 = colorForElev(ve[li]);
                const c2 = colorForElev(ve[li2]);
                colors[segIdx * 6 + 0] = c1[0];
                colors[segIdx * 6 + 1] = c1[1];
                colors[segIdx * 6 + 2] = c1[2];
                colors[segIdx * 6 + 3] = c2[0];
                colors[segIdx * 6 + 4] = c2[1];
                colors[segIdx * 6 + 5] = c2[2];
                segIdx++;
            }
        }

        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geom.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
        this._lineSegments = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({
            vertexColors: true,
            transparent: true,
            opacity: 0.95,
        }));
        this.group.add(this._lineSegments);
    }

    setExaggeration(x) {
        const next = Math.max(1, Math.min(2000, +x || 100));
        if (next === this._exaggeration) return;
        this._exaggeration = next;
        if (this._curves) this._buildCurves();
    }

    setVisible(v) { this.group.visible = !!v; }

    update() { /* static visualization — no per-frame work */ }
}

// Map a signed elevation (meters) to an RGB triple in [0,1]. Bathymetry shades
// from teal (shallow) to deep navy (~-10km); land shades from pale green (sea
// level) through tan (~2km) to white (~5km+). Color encodes elevation so the
// ridgelines remain interpretable even when stacked densely.
// Match Python tools/build_elevation_curves.py step_slug(): 0.5 -> '0p5',
// 1 -> '1', 3 -> '3' etc., so the elevation binary filenames line up.
function elevationStepSlug(step) {
    if (Number.isInteger(step)) return String(step);
    return String(step).replace('.', 'p');
}

// "Land only" elevation transform. Clamps anything deeper than 500 m below
// sea level to -500 m and shifts the visual baseline to -500 m so the result
// is always >= 0 — oceans flatten to the baseline and only land relief sticks
// up. Returns elevation in meters (still). Used by every elevation-rendering
// mode when their `_landOnly` flag is set.
const LAND_ONLY_FLOOR_M = -500;
function landOnlyElev(elev) {
    return Math.max(elev, LAND_ONLY_FLOOR_M) - LAND_ONLY_FLOOR_M;
}

// Module-level elevation-curves cache. Mode A-2, Mode H, and all the unfolded
// modes share this loader so the same ETOPO 60" binary doesn't get fetched
// or parsed more than once per density.
const _elevCurvesCache = new Map();
async function loadElevationCurves(latStepDeg) {
    if (_elevCurvesCache.has(latStepDeg)) return _elevCurvesCache.get(latStepDeg);
    const slug = elevationStepSlug(latStepDeg);
    const [binResp, jsonResp] = await Promise.all([
        fetch(`./data/elevation_curves_${slug}deg.bin`),
        fetch(`./data/elevation_curves_${slug}deg.json`),
    ]);
    if (!binResp.ok)  throw new Error(`elev bin  (${slug}deg): HTTP ${binResp.status}`);
    if (!jsonResp.ok) throw new Error(`elev json (${slug}deg): HTTP ${jsonResp.status}`);
    const buf = await binResp.arrayBuffer();
    const meta = await jsonResp.json();
    const curves = new Float32Array(buf);
    const [nBand, nLon] = meta.shape;
    if (curves.length !== nBand * nLon) {
        throw new Error(`elev bin length ${curves.length} != ${nBand}*${nLon}`);
    }
    const result = { curves, meta };
    _elevCurvesCache.set(latStepDeg, result);
    return result;
}

// Project each elevation-curve vertex through R^T (= sphereOrientation^-1 for
// orthogonal R) into the polyhedron's natural frame, find which face contains
// it, and group the per-vertex (face-local u, v, elev) into runs of contiguous
// same-face points. Two consecutive band points whose faces differ start a new
// run. For each band the first and last runs are merged if they're on the same
// face so the wraparound from lon=+180 back to lon=-180 closes the loop.
//
// Result: buckets[faceIdx] = Array<{ faceIdx, points: [{u, v, elev}] }>.
function bucketElevationCurves(curves, meta, faces, sphereOrientation, inradius) {
    const [nBand, nLon] = meta.shape;
    const latFirst = meta.lat_first_deg, latStep = meta.lat_step_deg;
    const lonFirst = meta.lon_first_deg, lonStep = meta.lon_step_deg;
    const D2R = Math.PI / 180;
    const buckets = Array.from({ length: faces.length }, () => []);
    const tmpDir = new THREE.Vector3();
    const R = sphereOrientation;

    for (let bi = 0; bi < nBand; bi++) {
        const lat = (latFirst + bi * latStep) * D2R;
        const sinLat = Math.sin(lat);
        const cosLat = Math.cos(lat);

        // Project each band vertex (geographic frame -> R^T -> polyhedron-local)
        // and find its face.
        const verts = [];
        for (let li = 0; li < nLon; li++) {
            const lon = (lonFirst + li * lonStep) * D2R;
            const elev = curves[bi * nLon + li];
            // Geographic-frame direction matching earth.js renderEarthFace's
            // convention: lat = asin(y), lon = atan2(z, x), so +Y = NP,
            // +X = lon 0, +Z = lon +90E. This is what the per-face Earth
            // canvases used by Modes B/C/D sample with, so the contour
            // overlay must use the SAME +Z = east convention (NOT Mode A-2's
            // shader, which uses atan(z, -x) and puts east at -Z).
            let dx = cosLat * Math.cos(lon);
            let dy = sinLat;
            let dz = cosLat * Math.sin(lon);
            if (R) {
                // R^T * v: result_i = sum_j R[j*3+i] * v_j
                const x = R[0] * dx + R[3] * dy + R[6] * dz;
                const y = R[1] * dx + R[4] * dy + R[7] * dz;
                const z = R[2] * dx + R[5] * dy + R[8] * dz;
                dx = x; dy = y; dz = z;
            }
            tmpDir.set(dx, dy, dz);
            const r = projectDirToFace(tmpDir, faces, inradius);
            if (!r) { verts.push(null); continue; }
            verts.push({ u: r.u, v: r.v, elev, faceIdx: r.face.idx });
        }

        // Split into runs (contiguous same-face).
        const runs = [];
        let curRun = null;
        let curFaceIdx = -1;
        for (let i = 0; i < verts.length; i++) {
            const v = verts[i];
            if (!v) {
                if (curRun) { runs.push(curRun); curRun = null; }
                curFaceIdx = -1;
                continue;
            }
            if (v.faceIdx !== curFaceIdx) {
                if (curRun) runs.push(curRun);
                curRun = { faceIdx: v.faceIdx, points: [] };
                curFaceIdx = v.faceIdx;
            }
            curRun.points.push({ u: v.u, v: v.v, elev: v.elev });
        }
        if (curRun) runs.push(curRun);

        // Merge first and last runs if they're on the same face (closes the
        // band's loop across the lon=±180 wraparound).
        if (runs.length > 1 && runs[0].faceIdx === runs[runs.length - 1].faceIdx) {
            runs[runs.length - 1].points.push(...runs[0].points);
            runs.shift();
        }

        for (const run of runs) buckets[run.faceIdx].push(run);
    }

    return buckets;
}

// 2x3 affine that maps each face's natural (u, v) corners to its display
// (x, y) corners on the 2D canvas of one of the unfolded modes. Used to push
// per-face elevation runs through the same transform the face's Earth canvas
// uses.
function affineFromFace2DToDisplay(faceVertices2D, displayCorners) {
    if (!faceVertices2D || faceVertices2D.length < 3) return null;
    if (!displayCorners || displayCorners.length < 3) return null;
    const srcPts = faceVertices2D.slice(0, 3).map(({ u, v }) => ({ x: u, y: v }));
    return affineFromPolygons(srcPts, displayCorners.slice(0, 3));
}

// Draw a set of elevation runs onto the unfolded-mode 2D canvas. The face is
// flat-to-screen in these modes, so without any vertical relief you're looking
// straight down at the contours and they read as featureless lines. To make
// elevation visible we lift each vertex's screen Y by `elev * elevYFactor`,
// producing a ridge profile per latitude band: peaks bump up, trenches dip
// down. The conversion uses the face's *display* circumradius (mean distance
// from displayCorners to their centroid) so the same `elevExag` parameter
// produces visually-equivalent tilt across modes of different face sizes
// (Mode B's small grid cells vs Mode C's full-screen single face).
function drawElevationRunsOnFace(ctx, runs, displayCorners, aff, lineWidthPx, elevExag, landOnly) {
    if (!runs || runs.length === 0 || !aff) return;
    const lw   = lineWidthPx == null ? 1.0 : lineWidthPx;
    const exag = elevExag == null ? 150 : elevExag;

    // Per-face display scale: average distance from the face's display centroid
    // to its display vertices.
    let cxd = 0, cyd = 0;
    for (const c of displayCorners) { cxd += c.x; cyd += c.y; }
    cxd /= displayCorners.length;
    cyd /= displayCorners.length;
    let faceScale = 0;
    for (const c of displayCorners) faceScale += Math.hypot(c.x - cxd, c.y - cyd);
    faceScale /= displayCorners.length;

    const EARTH_R_METERS = 6378137.0;
    // elev_pixels = (elev_m / earth_radius_m) * face_radius_px * exaggeration.
    // Negative sign: canvas Y increases downward, so subtracting moves up.
    const elevYFactor = faceScale / EARTH_R_METERS * exag;

    ctx.save();
    ctx.lineWidth = lw;
    ctx.lineJoin = 'round';
    ctx.lineCap  = 'round';
    for (const run of runs) {
        const pts = run.points;
        if (pts.length < 2) continue;
        for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1];
            const b = pts[i];
            // Land Only: skip any segment that's entirely under water so the
            // contour completely disappears across oceans (instead of just
            // flattening to the baseline).
            if (landOnly && a.elev <= 0 && b.elev <= 0) continue;
            const aE = landOnly ? landOnlyElev(a.elev) : a.elev;
            const bE = landOnly ? landOnlyElev(b.elev) : b.elev;
            const ax = aff.a * a.u + aff.c * a.v + aff.e;
            const ay = aff.b * a.u + aff.d * a.v + aff.f - aE * elevYFactor;
            const bx = aff.a * b.u + aff.c * b.v + aff.e;
            const by = aff.b * b.u + aff.d * b.v + aff.f - bE * elevYFactor;
            const elevMid = 0.5 * (a.elev + b.elev);
            const c = colorForElev(elevMid);
            ctx.strokeStyle = `rgb(${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0})`;
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(bx, by);
            ctx.stroke();
        }
    }
    ctx.restore();
}

function colorForElev(m) {
    if (m <= 0) {
        // Flat deep navy for the entire ocean: the previous depth-gradient
        // version made shelves / ridges / abyssal plains read as visibly
        // different shades along a single contour, which was distracting.
        return [10 / 255, 20 / 255, 55 / 255];
    } else {
        // Land: 0m -> pale green (140,200,140), 2500m -> tan (200,170,120),
        // 5000m+ -> white (250,250,250).
        if (m < 2500) {
            const t = m / 2500;
            const r = (140 + (200 - 140) * t) / 255;
            const g = (200 + (170 - 200) * t) / 255;
            const b = (140 + (120 - 140) * t) / 255;
            return [r, g, b];
        } else {
            const t = Math.max(0, Math.min(1, (m - 2500) / 2500));
            const r = (200 + (250 - 200) * t) / 255;
            const g = (170 + (250 - 170) * t) / 255;
            const b = (120 + (250 - 120) * t) / 255;
            return [r, g, b];
        }
    }
}

// 2x3 affine in Mode D format ({a, b, c, d, tx, ty} for applyT) that maps
// three source (u, v) points to three destination (x, y) points exactly.
// Returns null on a degenerate (collinear) source triple.
function affine3Pt(s0, s1, s2, d0, d1, d2) {
    const du1 = s1.u - s0.u, dv1 = s1.v - s0.v;
    const du2 = s2.u - s0.u, dv2 = s2.v - s0.v;
    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-10) return null;
    const dx1 = d1.x - d0.x, dx2 = d2.x - d0.x;
    const dy1 = d1.y - d0.y, dy2 = d2.y - d0.y;
    const a = (dx1 * dv2 - dx2 * dv1) / det;
    const b = (du1 * dx2 - du2 * dx1) / det;
    const c = (dy1 * dv2 - dy2 * dv1) / det;
    const d = (du1 * dy2 - du2 * dy1) / det;
    const tx = d0.x - a * s0.u - b * s0.v;
    const ty = d0.y - c * s0.u - d * s0.v;
    return { a, b, c, d, tx, ty };
}

// =====================================================================
// Mode I — Animated fold / unfold of the polyhedron.
//
// Builds a spanning tree over the polyhedron's dual graph (BFS from face 0)
// and for every non-root face records the hinge with its parent: pivot
// (midpoint of the shared edge), axis (unit direction along that edge), and
// fold angle (π − dihedral, so at t=1 the child is coplanar with its parent).
//
// Per-frame animation: walk the tree in BFS order, and for each face f
// compose worldMat[f] = (T(pivot) · R(axis_world, t · foldAngle) · T(−pivot))
// · worldMat[parent], where pivot and axis are transformed into the
// parent's current world frame (so the hinge moves with the parent). The
// face mesh has its vertices in the original polyhedron coordinate system
// and matrixAutoUpdate=false; we set mesh.matrix = worldMat[f] directly.
//
// At t=0 every worldMat is identity → the polyhedron looks like Mode A-2.
// At t=1 every face has been rotated through its hinge so the whole net
// lies flat in the root face's plane — matching the spirit of Mode D's
// unfolded layout but expressed rigidly in 3D space.
// =====================================================================
function modeIFacesForPolyhedron(polyhedron) {
    if (polyhedron && polyhedron.type === 'dymaxionIcosa') {
        return buildModeIDymaxionFaces(polyhedron);
    }
    if (!polyhedron || polyhedron.type !== 'waterman5') return polyhedron.faces;
    return buildModeIWatermanButterflyFaces(polyhedron.faces);
}

function buildModeIDymaxionFaces(polyhedron) {
    const verts = polyhedron.dymaxionVertices;
    const triplets = polyhedron.dymaxionFaceTriplets;
    if (!verts || !triplets || triplets.length !== 20) return polyhedron.faces;

    const out = [];
    const pushTri = (ids, idx, sourceFaceIdx = idx) => {
        const tri = finishModeIFace(ids.map(id =>
            typeof id === 'number' ? verts[id].clone() : id.clone()
        ), idx);
        tri.sourceFaceIdx = sourceFaceIdx;
        tri.dymaxionPartOf = sourceFaceIdx;
        out[idx] = tri;
    };

    for (let i = 0; i < 20; i++) {
        if (i === 14 || i === 15 || i === 19) continue;
        pushTri(triplets[i], i);
    }

    // d3-geo-polygon's AirOcean tree splits three facets before connecting
    // the net. Keep the split coplanar with the original icosahedron facets
    // so Mode I still unfolds rigidly, but expose the same 24 nodes that the
    // AirOcean parent table expects.
    const c15 = polyhedron.faces[15].center.clone();
    pushTri([c15, 2, 4], 15, 15);
    pushTri([1, c15, 4], 20, 15);
    pushTri([1, 2, c15], 21, 15);

    const mid = new THREE.Vector3()
        .addVectors(verts[2], verts[10])
        .multiplyScalar(0.5);
    pushTri([11, mid, 10], 14, 14);
    pushTri([11, 2, mid], 22, 14);
    pushTri([1, mid, 2], 19, 19);
    pushTri([mid, 1, 10], 23, 19);

    return out;
}

function buildModeIWatermanButterflyFaces(sourceFaces) {
    const out = [];
    for (const face of sourceFaces) {
        if (face.vertices3D.length !== 4) {
            const cloned = cloneModeIFace(face, out.length);
            cloned.watermanKind = 'hex';
            cloned.watermanOctant = watermanOctantFromNormal(cloned.normal);
            out.push(cloned);
            continue;
        }

        const center = face.center.clone();
        for (let i = 0; i < face.vertices3D.length; i++) {
            const tri = finishModeIFace([
                center.clone(),
                face.vertices3D[i].clone(),
                face.vertices3D[(i + 1) % face.vertices3D.length].clone(),
            ], out.length);
            tri.watermanKind = 'squareTri';
            tri.sourceFaceIdx = face.idx;
            out.push(tri);
        }
    }
    return out;
}

function cloneModeIFace(face, idx) {
    return {
        ...face,
        idx,
        sourceFaceIdx: face.idx,
        vertices3D: face.vertices3D.map(v => v.clone()),
        vertices2D: face.vertices2D.map(p => ({ u: p.u, v: p.v })),
    };
}

function finishModeIFace(onFace, idx) {
    let cx = 0, cy = 0, cz = 0;
    for (const v of onFace) { cx += v.x; cy += v.y; cz += v.z; }
    cx /= onFace.length; cy /= onFace.length; cz /= onFace.length;
    const centroid = new THREE.Vector3(cx, cy, cz);

    const e1 = new THREE.Vector3().subVectors(onFace[1], onFace[0]);
    const e2 = new THREE.Vector3().subVectors(onFace[2], onFace[0]);
    const normal = new THREE.Vector3().crossVectors(e1, e2).normalize();
    if (normal.dot(centroid) < 0) normal.negate();
    const planeDist = onFace[0].dot(normal);

    const helper = Math.abs(normal.y) < 0.95
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(1, 0, 0);
    const basisU = new THREE.Vector3().crossVectors(normal, helper).normalize();
    const basisV = new THREE.Vector3().crossVectors(basisU, normal).normalize();

    const indexed = onFace.map(v => {
        const off = new THREE.Vector3().subVectors(v, centroid);
        const u = off.dot(basisU);
        const w = off.dot(basisV);
        return { v, u, w, angle: Math.atan2(w, u) };
    });
    indexed.sort((a, b) => a.angle - b.angle);

    const vertices3D = indexed.map(s => s.v);
    const vertices2D = indexed.map(s => ({ u: s.u, v: s.w }));
    let faceCircumradius = 0;
    for (const v of vertices2D) faceCircumradius = Math.max(faceCircumradius, Math.hypot(v.u, v.v));

    return {
        idx,
        normal,
        center: centroid,
        planeDist,
        basisU, basisV,
        vertices3D, vertices2D,
        faceCircumradius,
    };
}

function watermanOctantFromNormal(normal) {
    const sx = normal.x >= 0 ? 1 : -1;
    const sy = normal.y >= 0 ? 1 : -1;
    const sz = normal.z >= 0 ? 1 : -1;
    const key = `${sx},${sy},${sz}`;
    const map = new Map([
        ['1,1,-1', 0],
        ['1,1,1', 1],
        ['1,-1,-1', 2],
        ['1,-1,1', 3],
        ['-1,1,-1', 4],
        ['-1,1,1', 5],
        ['-1,-1,-1', 6],
        ['-1,-1,1', 7],
    ]);
    return map.has(key) ? map.get(key) : -1;
}

export class ModeI {
    constructor(scene, polyhedron, starCapacity = 0) {
        this.scene = scene;
        this.group = new THREE.Group();
        // Inner group hosting every faceGroup. Sits between this.group
        // (latitude rotation) and the faceGroups (per-face unfold rotations),
        // so the centering/scaling math in _updateAnimation can drive it
        // independently of orientation. With _fitMode on (default), each
        // frame translates the inner group so the unfolded shape's bbox
        // center stays at the origin and scales it down so the shape stays
        // within the original polyhedron's radius.
        this._faceParent = new THREE.Group();
        this.group.add(this._faceParent);
        this._fitMode = true;

        // Backing card (togglable): a warm parchment-coloured plane that
        // sits flush behind the unfolded net so the map "rests" on it.
        // Rendered as an OPAQUE textured mesh (same parchment + procedural
        // grain as the opaque face tiles), sized + positioned per-frame
        // from the root face's basis so it tracks the net through the
        // fold animation.
        // Backing tile under the unfolded net. Texture is selected via
        // _backingStyle (default 'parchmentCloudsLight') and lazy-baked on
        // first display so PolyhedralProjection construction stays fast.
        // _backingEnabled is a user override exposed through
        // setBackingVisible; the backing only appears when both the
        // animation reaches t = 1 AND _backingEnabled is true.
        this._backingEnabled = true;
        this._backingStyle = 'parchmentCloudsLight';
        this.backingMaterial = new THREE.MeshBasicMaterial({
            color: 0xffffff,                 // texture supplies the colour
            side: THREE.DoubleSide,
        });
        this.backingTexture = null;
        // Per-instance cache for converted parchment ImageData canvases
        // (cartographer / cottonRag / etc. live as ImageData per-instance).
        this._backingPngCanvasCache = new Map();
        this.backingMesh = new THREE.Mesh(
            new THREE.PlaneGeometry(1, 1),
            this.backingMaterial,
        );
        this.backingMesh.visible = false;
        this._faceParent.add(this.backingMesh);
        // World-space direction from origin to camera. Used by _applyFit to
        // rotate the unfolded shape so the root face's outward normal ends up
        // pointing at the camera at t=1 → the user sees the flat net face-on.
        // Updated per-frame by main.js when Mode I is active; default matches
        // the page's initial camera at (0, 60, 280).
        this._cameraDir = new THREE.Vector3(0, 60, 280).normalize();

        // Per-face structure: each face's mesh + (per-face) gold-edge
        // wireframe + (optional) elevation contour LineSegments live inside
        // their own faceGroup. The animation drives faceGroups[i].matrix, so
        // every per-face child unfolds together (no per-child math).
        this.faceGroups = [];
        this._faceMeshTex = [];      // textured face mesh (child of faceGroups[i])
        this._faceEdgeMesh = [];     // per-face gold edges group (child)
        this._faceContour = [];      // per-face elevation LineSegments (child)

        // Animation: t ∈ [0, 1] interpolates folded (0) ↔ unfolded (1).
        // targetT is what the animation is moving toward; setPlayDirection()
        // toggles it. Speed is per-second.
        this.t = 0;
        this.targetT = 0;
        this.speed = 0.4;
        this._lastUpdateMs = null;
        // Unfold strategy — selects which spanning tree of the dual graph
        // is used. Same options as Mode D plus Mode I's fixed icosahedron-only
        // 'dymaxion' tree. Default matches Mode D.
        this._strategy = 'steepest';
        this._steepestDir = new THREE.Vector3(0.13, 1.0, 0.21).normalize();
        this._polarAxis = new THREE.Vector3(0, 1, 0);
        // Animation mode: 'simultaneous' (every hinge moves in lock-step,
        // each at angle = t · foldAngle) or 'sequential' (hinges unfold one
        // at a time in BFS order — preceding hinges fully open, current
        // hinge animating its 1/N slice of t, following hinges still 0).
        this._foldMode = 'simultaneous';
        // Easing applied to each face's local fraction before turning it into
        // a rotation angle. Same curve is applied to every hinge regardless
        // of fold-mode, so e.g. ease-in + wave = each layer eases in within
        // its slice of t.
        this._easing = 'linear';

        // Per-face Earth pipeline (mirrors Mode A-2). When SVG paths or a
        // raster image are set, each face gets its own offscreen canvas of
        // the Earth, used as a texture map on the face mesh. With both
        // disabled, faces fall back to a parchment-colored MeshPhongMaterial
        // so the geometry is still legible.
        this._earthImage = null;
        this._earthSvgPaths = null;
        this._earthStyle = null;
        this._faceCanvases = [];
        this._faceTextures = [];
        this._faceCanvasSize = 1024;
        this._faceMeshesDirty = false;
        this._facesOpaque = true;
        this._tileTint = 0xffffff;
        // Procedural noise (hash grain + two smooth-noise blobs) painted on
        // top of the plain bg colour fill, matching the Mode I WebGL
        // backdrop. Togglable from the UI; cache invalidated when flipped.
        this._grainEnabled = true;
        // Cache of per-polyhedron Earth-textured face canvases. Skips the
        // SVG country-path stroking step when re-visiting a polyhedron
        // with the same Earth preset (~1 s rebuild → ~30 ms reuse).
        this._earthCanvasCache = new Map();
        this._earthCanvasWarmJobs = new Map();

        // Pre-baked parchment sphere maps (equirectangular). Keyed by preset
        // slug ('cartographer' | 'cottonRag'). Loaded by main.js from
        // parchment-*.png files; gnomonically resampled into per-face
        // background canvases the first time each (polyhedron, preset) pair
        // is rendered.
        this._parchmentImageData = new Map();  // slug → ImageData
        this._parchmentFaceCache = new Map();  // polyType|slug → canvas[]
        this._faceBgMode = 'plain';             // 'plain' | 'cartographer' | 'cottonRag'

        // Per-face elevation contour pipeline. Contours follow each face
        // through the fold/unfold animation by being parented to that face's
        // group. Cross-face segments are skipped so an unfolded face never
        // drags a contour line across the gap to its (now-detached) neighbour.
        this._elevCurves = null;
        this._elevCurvesMeta = null;
        this._elevLoadSeq = 0;
        this._elevExag = 150;
        this._elevLatStepDeg = 3;
        this._showElev = false;
        this._landOnly = false;
        this.EARTH_R_METERS = 6378137.0;
        // Cache of (polyhedron-type, density, exag, land-only) → per-face
        // {facePos, faceCol} arrays from _computeFaceContourArrays. Skips
        // the expensive per-face ray-vs-polygon projection when the user
        // returns to a previously-visited (shape, density) pair — e.g.
        // toggling back to W5 + 0.5° after a detour through dodec.
        this._contourCache = new Map();

        // Per-face gold-edge wireframe params (mirror Mode A-2). The same
        // MeshPhongMaterial is shared across every cylinder/sphere across
        // every face so a single preset/slider change updates them all.
        this._edgeRadiusFactor = 0.004;
        this._edgeParams = {
            color: 0xffd700, specular: 0xfff4cc, shininess: 90,
            emissive: 0x4a3500, emissiveIntensity: 0.45,
        };
        this._edgeMat = null;
        this._showFaceOutlines = true;

        // Stable-transparent-sort direction. 'root-last' = root paints last
        // (appears on top in the default folded view); 'root-first' = leaves
        // paint last (appears on top in unfolded fan-out views). See
        // _faceRenderOrder for how the depth-to-order mapping changes.
        this._renderOrderDir = 'root-last';

        // Translucent blend mode for the face mesh material.
        //   'alpha'    — standard 0.4-opacity alpha blending. Order-dependent
        //                (sum is non-commutative), so the same back face can
        //                look different through different panes.
        //   'multiply' — multiplicative blending (framebuffer *= face). Order-
        //                independent; each pane acts as a filter on what's
        //                behind. The back face looks consistent through any
        //                front pane, modulated only by each pane's outlines.
        this._translucentBlend = 'multiply';

        // User override of the spanning-tree root face. null means "auto"
        // (pick the face with the largest +Y normal). Once set, polyhedron
        // swaps reset to null so the default root logic re-applies for the
        // new face count.
        this._userRootIdx = null;

        // Per-face index labels (Three.js Sprites, parented to each face
        // group so they unfold with the face). The current root is drawn
        // in inverted gold for at-a-glance recognition.
        this._faceLabels = [];
        this._showFaceLabels = true;

        // User drag-rotation (mouse drag in Mode I/J orbits the polyhedron
        // instead of the camera). Composed with the latitude tilt via
        // _applyGroupRotation. Initialised to identity so the first
        // _applyGroupRotation call applies pure latitude.
        this._userRotation = new THREE.Quaternion();
        this._observerLat = 0;

        this._adoptPolyhedron(polyhedron);

        this.group.visible = false;
        scene.add(this.group);
        this._applyGroupRotation();

        // Camera-following star sphere overlay. Stars sit on a sphere of
        // radius this.polyhedron.R; each frame the overlay group is
        // repositioned so the sphere centre lies on the camera→origin line
        // at distance R+eps from the camera — the camera ends up just
        // outside the sphere looking through its centre, with the star
        // field wrapping the view like a planetarium shell that rides
        // along as the user orbits. Mode J inherits this directly.
        this._starOverlayR = polyhedron.R || polyhedron.faceCircumradius || 100;
        this._starOverlayEps = 0.5;
        this._cameraPos = new THREE.Vector3();
        this._cameraPosSet = false;
        if (starCapacity > 0) this._initStarOverlay(starCapacity, scene);
    }

    _initStarOverlay(starCapacity, scene) {
        this._starCapacity = starCapacity;
        this._starPositions = new Float32Array(starCapacity * 3);
        this._starColors    = new Float32Array(starCapacity * 3);
        this._starSizes     = new Float32Array(starCapacity);
        const fixed = fillTwinkleStarAttribs(starCapacity);
        this._starPhases = fixed.phases;
        this._starSpeeds = fixed.speeds;

        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(this._starPositions, 3));
        geom.setAttribute('color',    new THREE.BufferAttribute(this._starColors,    3));
        geom.setAttribute('aPhase',   new THREE.BufferAttribute(this._starPhases,    1));
        geom.setAttribute('aSpeed',   new THREE.BufferAttribute(this._starSpeeds,    1));
        geom.setAttribute('aSize',    new THREE.BufferAttribute(this._starSizes,     1));
        this._starGeom = geom;
        // Custom material: same astroid+twinkle fragment shader as Mode K
        // but the vertex shader pushes gl_Position.z to gl_Position.w so
        // every star fragment ends up at NDC depth 1 (the far plane).
        // Combined with depthFunc=LessEqualDepth that means the stars are
        // hidden everywhere the polyhedron / edges / labels have written a
        // depth value < 1 (i.e. the polyhedron's silhouette on screen),
        // and they paint normally over the cleared-depth=1 background.
        // Solves the distance-dependent see-through the user reported:
        // the camera-pinned sphere sits BETWEEN the camera and the
        // polyhedron, so the far hemisphere stars geometrically pass the
        // GL_LESS depth test against the tile and blend over it; pushing
        // every star to depth 1 sidesteps the geometry and guarantees the
        // polyhedron always tests as closer.
        this._starMaterial = new THREE.ShaderMaterial({
            uniforms: {
                uTime:      _twinkleStarSharedTime,
                uDim:       { value: 1.0 },
                uSizeBase:  { value: 22.0 },
                uSizeFloor: { value: 5.0 },
            },
            vertexShader: TWINKLE_STAR_VS_FAR_PLANE,
            fragmentShader: TWINKLE_STAR_FS,
            transparent: true,
            depthWrite: false,
            depthFunc: THREE.LessEqualDepth,
        });
        this._starPoints = new THREE.Points(geom, this._starMaterial);
        // Camera sits on the bounding-sphere boundary — frustum culling
        // misfires on points clouds in that case.
        this._starPoints.frustumCulled = false;

        this.starOverlay = new THREE.Group();
        this.starOverlay.visible = false;
        this.starOverlay.add(this._starPoints);
        scene.add(this.starOverlay);

        this._getStarProps = null;
    }

    setStarPropsFn(fn) { this._getStarProps = fn; }

    _adoptPolyhedron(polyhedron) {
        this.polyhedron = polyhedron;
        if (this._strategy === 'dymaxion' && polyhedron.type !== 'dymaxionIcosa') {
            this._strategy = 'steepest';
        }
        // Reset the user root override on polyhedron swap — face count and
        // indices changed, so an old index would point at the wrong face or
        // out of range. Falls back to the auto pick (highest +Y normal).
        this.faces = modeIFacesForPolyhedron(polyhedron);
        this._watermanButterflyFaces = polyhedron.type === 'waterman5';
        this._userRootIdx = null;
        this._disposeFaceContent();
        this._buildTopology();
        this._buildSpanningTree();
        this._computeHingeData();
        this._buildEdgeMaterial();
        this._buildFaceGroups();
        // Polyhedron swap clears _faceCanvases — _buildFaceGroups just made
        // parchment-fallback meshes. If Earth data is present and we're
        // visible, re-render the per-face canvases now (which swaps each
        // face's parchment mesh for a textured one). Hidden Mode I marks
        // dirty so the rebuild fires on first show, matching Mode A-2's
        // defer-until-visible approach.
        if (this._earthSvgPaths || this._earthImage) {
            if (this.group.visible) this._rebuildFaceCanvases();
            else this._faceMeshesDirty = true;
        }
        // Polyhedron swap: keep the existing _faceParentTargetAtT1 so the
        // new shape appears in the same world orientation as the old one
        // (no snap on shape change). The slerp at t = 1 uses the old F
        // applied to the new shape — its root face won't be face-on to
        // the camera until the user either clicks Root or arrow-tunes,
        // which re-capture F against the new rootNormal.
        this._updateAnimation();
        if (this._elevCurves) this._rebuildAllFaceContours();
    }

    setPolyhedron(polyhedron) { this._adoptPolyhedron(polyhedron); }

    setObserverLatitude(latRad) {
        // Match Mode A-2 — tilt around X so geographic NP points at celestial pole.
        this._observerLat = latRad;
        this._applyGroupRotation();
    }

    // Composite this.group.quaternion = userRotation * latitudeRotation. The
    // latitude tilt comes from setObserverLatitude; the user rotation is
    // accumulated by applyUserRotation each frame the user drags. Splitting
    // them lets each be updated independently without clobbering the other.
    _applyGroupRotation() {
        if (!this._latRotQuat) {
            this._latRotQuat = new THREE.Quaternion();
            this._latAxis = new THREE.Vector3(1, 0, 0);
        }
        const lat = this._observerLat || 0;
        this._latRotQuat.setFromAxisAngle(this._latAxis, -(Math.PI / 2 - lat));
        this.group.quaternion.multiplyQuaternions(this._userRotation, this._latRotQuat);
    }

    // Drag-rotate the polyhedron in world frame. dx/dy are mouse-delta pixels
    // since last call; dx → yaw around world Y, dy → pitch around world X.
    // Premultiply so successive drag deltas compose in world frame, matching
    // the standard 3D-viewer feel where right-drag always yaws right.
    applyUserRotation(dx, dy) {
        const sens = 0.005;
        if (!this._userRotTmp) {
            this._userRotTmp = new THREE.Quaternion();
            this._userAxisX = new THREE.Vector3(1, 0, 0);
            this._userAxisY = new THREE.Vector3(0, 1, 0);
        }
        this._userRotTmp.setFromAxisAngle(this._userAxisY, dx * sens);
        this._userRotation.premultiply(this._userRotTmp);
        this._userRotTmp.setFromAxisAngle(this._userAxisX, dy * sens);
        this._userRotation.premultiply(this._userRotTmp);
        this._applyGroupRotation();
        // Do NOT re-fit here — drag at rest should rotate the polyhedron
        // visually. _applyFit would recompute faceParent to keep
        // group * faceParent locked to the captured world target, which
        // cancels the drag. Once the faceParent target is captured at
        // play()/arrow-key time, the at-rest world rotation = group *
        // faceParent_captured, so a drag (= group change) directly maps to
        // a polyhedron rotation. The captured target gets refreshed on
        // the next play / arrow tune / strategy change.
    }

    // Set the accumulated user rotation to an absolute quaternion, then
    // recompose. Used by the presentation page to pin the globe's polar axis
    // to a screen-fixed tilt before auto-spin begins. (Unused by the main app.)
    setUserRotation(quat) {
        this._userRotation.copy(quat);
        this._applyGroupRotation();
    }

    getUserRotation() {
        return this._userRotation.clone();
    }

    getFaceParentTarget() {
        return this._faceParentTargetAtT1 ? this._faceParentTargetAtT1.clone() : null;
    }

    setFaceParentTarget(quat) {
        this._faceParentTargetAtT1 = quat ? quat.clone() : null;
        this._applyFit();
    }

    // Spin the polyhedron about a FIXED world-space axis by angleRad, composing
    // the increment into the accumulated user rotation (same premultiply path
    // as applyUserRotation) so it survives drags and re-fits. Lets the
    // presentation page auto-rotate the closed globe about a screen-fixed axis
    // without _applyGroupRotation ever clobbering it. (Unused by the main app.)
    applyWorldSpin(axis, angleRad) {
        if (!this._worldSpinTmp) this._worldSpinTmp = new THREE.Quaternion();
        this._worldSpinTmp.setFromAxisAngle(axis, angleRad);
        this._userRotation.premultiply(this._worldSpinTmp);
        this._userRotation.normalize();   // guard against drift over long spins
        this._applyGroupRotation();
    }

    _disposeFaceContent() {
        // Tear down every face group and all of its children — face meshes,
        // edge wireframes, contour LineSegments, label sprites. Skip
        // disposing the shared gold MeshPhongMaterial (lives on
        // this._edgeMat and is reused). Sprite materials own their own
        // CanvasTexture (the label canvas), which needs explicit disposal
        // since material.dispose() doesn't cascade to map.
        for (let i = 0; i < this.faceGroups.length; i++) {
            const g = this.faceGroups[i];
            if (!g) continue;
            this._faceParent.remove(g);
            g.traverse((obj) => {
                if (obj.geometry) obj.geometry.dispose();
                const m = obj.material;
                if (m && m !== this._edgeMat) {
                    if (obj.isSprite && m.map) m.map.dispose();
                    if (Array.isArray(m)) for (const x of m) x.dispose();
                    else m.dispose();
                }
            });
        }
        this.faceGroups = [];
        this._faceMeshTex = [];
        this._faceEdgeMesh = [];
        this._faceContour = [];
        this._faceLabels = [];
        for (const t of this._faceTextures) t.dispose();
        this._faceTextures = [];
        this._faceCanvases = [];
    }

    _buildTopology() {
        // Dedup vertices + build edges with their two adjacent faces and
        // per-vertex incident-edge lists. Matches Mode D's buildTopology()
        // so the cut-edge / steepest-edge strategies can be reused.
        const vertices = [];
        const vertexKeys = new Map();
        const key = (v) => `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`;
        const addV = (v) => {
            const k = key(v);
            if (vertexKeys.has(k)) return vertexKeys.get(k);
            const i = vertices.length;
            vertexKeys.set(k, i);
            vertices.push(v.clone());
            return i;
        };
        const faceVerts = this.faces.map((f) => f.vertices3D.map(addV));

        const edgeMap = new Map();
        const edges = [];
        for (let fIdx = 0; fIdx < this.faces.length; fIdx++) {
            const vs = faceVerts[fIdx];
            for (let i = 0; i < vs.length; i++) {
                const a = vs[i], b = vs[(i + 1) % vs.length];
                const lo = Math.min(a, b), hi = Math.max(a, b);
                const k = `${lo}_${hi}`;
                if (!edgeMap.has(k)) {
                    edgeMap.set(k, edges.length);
                    edges.push({ v1: lo, v2: hi, faces: [] });
                }
                edges[edgeMap.get(k)].faces.push(fIdx);
            }
        }

        const vertexEdges = vertices.map(() => []);
        for (let eIdx = 0; eIdx < edges.length; eIdx++) {
            vertexEdges[edges[eIdx].v1].push(eIdx);
            vertexEdges[edges[eIdx].v2].push(eIdx);
        }

        this._topology = { vertices, edges, faceVerts, vertexEdges };
    }

    // Choose which polyhedron edges to CUT (the rest form the dual-graph
    // spanning tree used by _buildSpanningTree). Same set of strategies
    // Mode D offers, plus Mode I's fixed icosahedron-only Dymaxion tree:
    //   dymaxion   - Fuller/AirOcean icosahedral net.
    //   steepest   - Schlickenrieder 1997 per-vertex steepest edge.
    //   random     - random weights -> Kruskal max spanning tree on dual.
    //   polar      - van Wijk myriahedral: w(e) = |mid_unit · axis|, max ST.
    //   equatorial - van Wijk myriahedral: w(e) = 1 − |mid_unit · axis|, max ST.
    //   fish       - for the rhombic dodecahedron, an explicit Hamiltonian
    //                ribbon; otherwise a lowest-Y BFS tree whose edges become
    //                hinges.
    _computeCutEdges() {
        const { vertices, edges, vertexEdges } = this._topology;

        if (this._strategy === 'butterfly' && this._watermanButterflyFaces) {
            const cuts = this._computeWatermanButterflyCuts();
            if (cuts) return cuts;
        }

        if (this._strategy === 'dymaxion' && this.polyhedron.type === 'dymaxionIcosa') {
            const cuts = this._computeDymaxionIcosaCuts();
            if (cuts) return cuts;
        }

        if (this.polyhedron.type === 'rhombicDodec') {
            const cuts = this._computeRhombicDodecCuts();
            if (cuts) return cuts;
        }

        if (this._strategy === 'steepest' || this._strategy === 'dymaxion') {
            const c = this._steepestDir;
            const cuts = new Set();
            const dirTmp = new THREE.Vector3();
            for (let vIdx = 0; vIdx < vertices.length; vIdx++) {
                let bestEdge = -1, bestDot = -Infinity;
                for (const eIdx of vertexEdges[vIdx]) {
                    const e = edges[eIdx];
                    const otherIdx = e.v1 === vIdx ? e.v2 : e.v1;
                    dirTmp.subVectors(vertices[otherIdx], vertices[vIdx]).normalize();
                    const d = dirTmp.dot(c);
                    if (d > bestDot) { bestDot = d; bestEdge = eIdx; }
                }
                if (bestEdge !== -1) cuts.add(bestEdge);
            }
            return cuts;
        }

        // fish: pick the lowest-Y face as the head (root), then BFS through
        // the dual graph, at each step preferring the unvisited neighbour
        // with the SMALLEST centroid Y (so the layout grows monotonically
        // upward). The BFS tree's edges become hinges; everything else is
        // cut. For the rhombic dodec the 1→4→6→1 BFS-distance distribution
        // produces a tapered head ▸ broad body ▸ tail-tip silhouette —
        // an elongated, vaguely fish-shaped unfold. Works for any
        // polyhedron, but the rhombic dodec's symmetry is what makes the
        // shape read as deliberately piscine.
        if (this._strategy === 'fish') {
            const numFaces = this.faces.length;
            // Face centroids in polyhedron-local frame.
            const centroids = new Array(numFaces);
            for (let fi = 0; fi < numFaces; fi++) {
                const c = new THREE.Vector3();
                const vIdx = this.faces[fi].vertexIndices;
                for (let k = 0; k < vIdx.length; k++) c.add(vertices[vIdx[k]]);
                c.divideScalar(vIdx.length);
                centroids[fi] = c;
            }
            let headIdx = 0;
            for (let fi = 1; fi < numFaces; fi++) {
                if (centroids[fi].y < centroids[headIdx].y) headIdx = fi;
            }
            const faceAdj = new Array(numFaces);
            for (let i = 0; i < numFaces; i++) faceAdj[i] = [];
            for (let eIdx = 0; eIdx < edges.length; eIdx++) {
                const e = edges[eIdx];
                if (e.faces.length !== 2) continue;
                faceAdj[e.faces[0]].push({ neighbor: e.faces[1], edgeIdx: eIdx });
                faceAdj[e.faces[1]].push({ neighbor: e.faces[0], edgeIdx: eIdx });
            }
            const visited = new Array(numFaces).fill(false);
            const treeEdges = new Set();
            const queue = [headIdx];
            visited[headIdx] = true;
            while (queue.length > 0) {
                const cur = queue.shift();
                // Sort unvisited neighbours by ascending Y centroid so the
                // BFS fans out symmetrically and continues "upward".
                const sorted = faceAdj[cur].slice().sort((a, b) =>
                    centroids[a.neighbor].y - centroids[b.neighbor].y
                );
                for (const adj of sorted) {
                    if (visited[adj.neighbor]) continue;
                    visited[adj.neighbor] = true;
                    treeEdges.add(adj.edgeIdx);
                    queue.push(adj.neighbor);
                }
            }
            const cuts = new Set();
            for (let eIdx = 0; eIdx < edges.length; eIdx++) {
                if (!treeEdges.has(eIdx) && edges[eIdx].faces.length === 2) cuts.add(eIdx);
            }
            return cuts;
        }

        // random / polar / equatorial / butterfly: weight every shared edge,
        // Kruskal max-spanning-tree on the dual, cuts = edges NOT in the tree.

        // For 'butterfly': pre-label every FACE with a wing (0..3, by XZ
        // quadrant of the face normal) or -1 = body (axis-aligned with Y).
        // The body holds the polar caps; the four wings each hold one quarter
        // of the equator + corresponding hemispheres' faces. Same-wing edges
        // get the highest weight (always kept = each wing folds as one
        // connected sub-net), body↔wing edges get a middling weight (kept
        // just enough to attach each wing to the body), and wing↔wing edges
        // get zero weight (always cut → wings separate visually).
        let wings = null;
        if (this._strategy === 'butterfly') {
            // Two-wing split (Cahill/Waterman butterfly): the polyhedron is
            // cleaved into two halves along a MERIDIAN great circle (the
            // x=0 plane), and the two halves unfold as the butterfly's
            // left and right wings, joined at a single hinge. Faces on the
            // x=0 boundary (±Y polar squares and ±Z equatorial squares)
            // are assigned to a wing by sign of (n.y + n.z), giving each
            // wing exactly 7 faces.
            wings = new Array(this.faces.length);
            for (let fi = 0; fi < this.faces.length; fi++) {
                const n = this.faces[fi].normal;
                if (n.x >  0.3)      wings[fi] = 0;      // right wing
                else if (n.x < -0.3) wings[fi] = 1;      // left wing
                else                  wings[fi] = (n.y + n.z >= 0) ? 0 : 1;
            }
        }

        const dualEdges = [];
        const midTmp = new THREE.Vector3();
        for (let eIdx = 0; eIdx < edges.length; eIdx++) {
            const e = edges[eIdx];
            if (e.faces.length !== 2) continue;
            let w;
            if (this._strategy === 'random') {
                w = Math.random();
            } else if (this._strategy === 'butterfly') {
                // Two-wing split: same-wing edges are folds (all kept),
                // inter-wing edges are cuts (only one survives — the
                // Kruskal max-ST will keep exactly the single highest-
                // priority inter-wing edge needed to splice the two wing
                // sub-trees together). That single surviving inter-wing
                // edge is the hinge the butterfly opens around.
                const wa = wings[e.faces[0]];
                const wb = wings[e.faces[1]];
                w = (wa === wb) ? 2.0 : 0.0;
            } else {
                midTmp.addVectors(vertices[e.v1], vertices[e.v2])
                      .multiplyScalar(0.5).normalize();
                const align = Math.abs(midTmp.dot(this._polarAxis));
                w = (this._strategy === 'polar') ? align : (1 - align);
            }
            dualEdges.push({ fa: e.faces[0], fb: e.faces[1], edgeIdx: eIdx, weight: w });
        }
        const foldSet = kruskalMaxSpanningTree(this.faces.length, dualEdges);
        const cuts = new Set();
        for (let eIdx = 0; eIdx < edges.length; eIdx++) {
            if (!foldSet.has(eIdx) && edges[eIdx].faces.length === 2) cuts.add(eIdx);
        }
        return cuts;
    }

    _computeCutsFromKeptFacePairs(facePairs) {
        const { edges } = this._topology;
        const pairKey = (a, b) => a < b ? `${a}_${b}` : `${b}_${a}`;
        const keepPairs = new Set(facePairs.map(([a, b]) => pairKey(a, b)));
        let kept = 0;
        const cuts = new Set();
        for (let eIdx = 0; eIdx < edges.length; eIdx++) {
            const e = edges[eIdx];
            if (e.faces.length !== 2) continue;
            const k = pairKey(e.faces[0], e.faces[1]);
            if (keepPairs.has(k)) kept++;
            else cuts.add(eIdx);
        }
        return kept === keepPairs.size && kept === this.faces.length - 1 ? cuts : null;
    }

    _computeRhombicDodecCuts() {
        if (this.faces.length !== 12) return null;

        // Rhombic dodecahedron specials. The face graph is the cuboctahedron:
        // 12 degree-4 nodes, small enough that explicit trees are clearer than
        // trying to coerce the generic weighted MST into attractive nets.
        const trees = {
            // A true Hamiltonian strip: eleven hinges, no branching. This is
            // the "fish"/ribbon idea, matching the known single paper-strip
            // construction of a rhombic dodecahedron.
            fish: [
                [6, 2], [2, 8], [8, 0], [0, 4], [4, 10], [10, 3],
                [3, 7], [7, 9], [9, 5], [5, 1], [1, 11],
            ],
            // Two long wings joined through a short waist.
            butterfly: [
                [8, 0], [0, 4], [4, 1], [1, 10], [10, 6],
                [0, 9],
                [9, 2], [2, 7], [7, 3], [3, 11], [11, 5],
            ],
            // Four-armed rosette, useful when the user wants a compact net.
            polar: [
                [9, 0], [0, 4], [4, 8],
                [9, 2], [2, 6], [6, 10],
                [9, 5], [5, 1], [1, 11],
                [9, 7], [7, 3],
            ],
            // A tighter asymmetric cluster with one central rhombus.
            equatorial: [
                [0, 4], [0, 5], [0, 8], [0, 9],
                [4, 1], [5, 11], [8, 2], [9, 7],
                [1, 10], [11, 3], [2, 6],
            ],
        };

        const pairs = trees[this._strategy];
        return pairs ? this._computeCutsFromKeptFacePairs(pairs) : null;
    }

    _computeDymaxionIcosaCuts() {
        const { edges } = this._topology;
        if (!edges || (this.faces.length !== 20 && this.faces.length !== 24)) return null;
        if (this.polyhedron.type !== 'dymaxionIcosa') return null;

        // d3-geo-polygon airocean.js parent table (Fuller's 1954 fold).
        // d3 publishes a 24-entry table for the SPLIT version that cuts
        // faces 14, 15, 19 into pieces 20..23. For the unsplit 20-face
        // icosa we truncate to indices 0..19 and reroute parent[19] from
        // 21 (a split-derived piece of face 15) to face 15 itself — both
        // share the {v1, v2} edge so the same hinge applies. Every other
        // entry is verbatim from d3.
        //
        //   north cap (0..4)  : -1, 0, 1, 11, 13
        //   equator   (5..14) :  6, 7, 1, 7, 8, 9, 10, 11, 12, 13
        //   south cap (15..19):  6, 8, 10, 17, 15
        const parents = this.faces.length === 24
            ? [
                -1, 0, 1, 11, 13,
                 6, 7, 1,  7,  8,  9, 10, 11, 12, 13,
                 6, 8, 10, 17, 21, 16, 15, 19, 19,
            ]
            : [
                -1, 0, 1, 11, 13,
                 6, 7, 1,  7,  8,  9, 10, 11, 12, 13,
                 6, 8, 10, 17, 15,
            ];

        const pairKey = (a, b) => a < b ? `${a}_${b}` : `${b}_${a}`;
        const keepPairs = new Set();
        for (let f = 0; f < parents.length; f++) {
            if (parents[f] >= 0) keepPairs.add(pairKey(f, parents[f]));
        }

        let kept = 0;
        const cuts = new Set();
        for (let eIdx = 0; eIdx < edges.length; eIdx++) {
            const e = edges[eIdx];
            if (e.faces.length !== 2) continue;
            const k = pairKey(e.faces[0], e.faces[1]);
            if (keepPairs.has(k)) kept++;
            else cuts.add(eIdx);
        }
        return kept === parents.length - 1 ? cuts : null;
    }

    _watermanHexByOctant() {
        const out = new Array(8).fill(-1);
        for (let i = 0; i < this.faces.length; i++) {
            const f = this.faces[i];
            if (f.watermanKind === 'hex' && f.watermanOctant >= 0) out[f.watermanOctant] = i;
        }
        return out;
    }

    _computeWatermanButterflyCuts() {
        const { edges } = this._topology;
        const hexByOctant = this._watermanHexByOctant();
        if (hexByOctant.some(i => i < 0)) return null;

        const parents = [-1, 0, 0, 1, 0, 1, 4, 5];
        const pairKey = (a, b) => a < b ? `${a}_${b}` : `${b}_${a}`;
        const keepHexPair = new Set();
        for (let oct = 0; oct < parents.length; oct++) {
            const p = parents[oct];
            if (p >= 0) keepHexPair.add(pairKey(hexByOctant[oct], hexByOctant[p]));
        }

        const cuts = new Set();
        for (let eIdx = 0; eIdx < edges.length; eIdx++) {
            const e = edges[eIdx];
            if (e.faces.length !== 2) continue;
            const [fa, fb] = e.faces;
            const a = this.faces[fa], b = this.faces[fb];
            const aHex = a.watermanKind === 'hex';
            const bHex = b.watermanKind === 'hex';
            const aTri = a.watermanKind === 'squareTri';
            const bTri = b.watermanKind === 'squareTri';

            let keep = false;
            if (aHex && bHex) {
                keep = keepHexPair.has(pairKey(fa, fb));
            } else if ((aHex && bTri) || (bHex && aTri)) {
                // Each square has been split into four right triangles. The
                // Waterman butterfly attaches every triangle to the hex across
                // its outer square edge and cuts the radial triangle-triangle
                // spokes, yielding the 8-hex + 24-triangle butterfly net.
                keep = true;
            }
            if (!keep) cuts.add(eIdx);
        }
        return cuts;
    }

    setStrategy(name) {
        const valid = [
            'steepest', 'random', 'polar', 'equatorial', 'butterfly', 'dymaxion',
            'fish',
        ];
        if (!valid.includes(name)) return;
        if (name === 'dymaxion' && this.polyhedron.type !== 'dymaxionIcosa') return;
        if (name === this._strategy) return;
        this._strategy = name;
        // Rebuild spanning tree + hinge data; preserve current animation t.
        this._buildSpanningTree();
        this._computeHingeData();
        // Depth values changed → re-stamp face / contour renderOrders so the
        // stable paint order tracks the new tree (root still paints last).
        this._refreshRenderOrders();
        // Keep the existing _faceParentTargetAtT1 — strategy change re-builds
        // the spanning tree but doesn't move the polyhedron's faces in world,
        // so the visible orientation should persist. setRoot / setFinalTwistRad
        // are the explicit re-capture hooks.
        this._updateAnimation();
    }

    getStrategy() { return this._strategy; }

    // Change which face is the spanning-tree root (i.e. the face that stays
    // put through the entire fold/unfold; everything else hinges off it).
    // Pass null to fall back to the auto pick (largest +Y normal). Triggers
    // a tree rebuild + render-order refresh + animation update; t is preserved.
    setRoot(idx) {
        const n = this.faces.length;
        const oldRoot = this.getRoot();
        if (idx === null) {
            if (this._userRootIdx === null) return;
            this._userRootIdx = null;
        } else if (typeof idx === 'number' && idx >= 0 && idx < n) {
            if (this._userRootIdx === idx) return;
            this._userRootIdx = idx | 0;
        } else {
            return;
        }
        this._buildSpanningTree();
        this._computeHingeData();
        this._refreshRenderOrders();
        const newRoot = this.getRoot();
        if (oldRoot !== newRoot) {
            // Move the gold highlight from the old root to the new one.
            this._refreshLabel(oldRoot);
            this._refreshLabel(newRoot);
            // New root → new rootNormal → captured target is stale. Re-capture
            // so the unfold lands oriented around the new root.
            this._captureFaceParentTarget();
        }
        this._updateAnimation();
    }

    cycleRoot(delta) {
        const n = this.faces.length;
        if (!n) return;
        const cur = this.getRoot();
        const next = ((cur + (delta | 0)) % n + n) % n;
        this.setRoot(next);
    }

    getRoot() {
        return (this._spanningTree && typeof this._spanningTree.root === 'number')
            ? this._spanningTree.root
            : 0;
    }

    _buildSpanningTree() {
        const n = this.faces.length;
        const { edges } = this._topology;
        const cuts = this._computeCutEdges();

        // Face adjacency through fold (non-cut) edges only.
        const foldAdj = Array.from({ length: n }, () => []);
        for (let eIdx = 0; eIdx < edges.length; eIdx++) {
            if (cuts.has(eIdx)) continue;
            const e = edges[eIdx];
            if (e.faces.length !== 2) continue;
            const [fa, fb] = e.faces;
            foldAdj[fa].push({ face: fb, edge: e });
            foldAdj[fb].push({ face: fa, edge: e });
        }

        // Root: user override if set (via setRoot / cycleRoot), else strategy-
        // specific auto-pick. For butterfly the spanning tree's two halves
        // need to splay symmetrically from a face on the equator (n.y ≈ 0),
        // so N and S hemispheres extend equally to either side of the root.
        // Every other strategy uses the historical "highest +Y normal" pick
        // so the visible top face becomes the anchor.
        let root;
        if (this._userRootIdx !== null && this._userRootIdx >= 0 && this._userRootIdx < n) {
            root = this._userRootIdx;
        } else if (this._strategy === 'butterfly' && this._watermanButterflyFaces) {
            const hexByOctant = this._watermanHexByOctant();
            root = hexByOctant[0] >= 0 ? hexByOctant[0] : 0;
        } else if (this._strategy === 'dymaxion' && this.polyhedron.type === 'dymaxionIcosa') {
            // d3-geo-polygon's airocean parent table has parent[0] = -1, so
            // face 0 is the canonical AirOcean root. Anchoring the unfold
            // there yields Fuller's iconic horizontal map.
            root = 0;
        } else if (this.polyhedron.type === 'rhombicDodec') {
            const roots = {
                fish: 6,
                butterfly: 0,
                polar: 9,
                equatorial: 0,
            };
            if (roots[this._strategy] !== undefined) root = roots[this._strategy];
            else {
                root = 0;
                for (let i = 1; i < n; i++) {
                    if (this.faces[i].normal.y > this.faces[root].normal.y) root = i;
                }
            }
        } else if (this._strategy === 'butterfly') {
            // The cut is along x=0; both wings need the root on that plane
            // so the butterfly opens symmetrically. Prefer min |n.x| (on
            // the cut plane), then min |n.y| (equator → hinge at equator),
            // then +Z so the pick is deterministic.
            root = 0;
            let bestScore = -Infinity;
            for (let i = 0; i < n; i++) {
                const f = this.faces[i];
                const s = -Math.abs(f.normal.x)
                       - 0.5 * Math.abs(f.normal.y)
                       + 0.001 * f.normal.z;
                if (s > bestScore) { bestScore = s; root = i; }
            }
        } else {
            root = 0;
            for (let i = 1; i < n; i++) {
                if (this.faces[i].normal.y > this.faces[root].normal.y) root = i;
            }
        }

        const visited = new Array(n).fill(false);
        const parent = new Array(n).fill(-1);
        const parentEdge = new Array(n).fill(null);
        const depth = new Array(n).fill(0);
        const order = [];
        visited[root] = true;
        const queue = [root];
        order.push(root);
        while (queue.length) {
            const u = queue.shift();
            for (const { face: v, edge } of foldAdj[u]) {
                if (visited[v]) continue;
                visited[v] = true;
                parent[v] = u;
                parentEdge[v] = edge;
                depth[v] = depth[u] + 1;
                order.push(v);
                queue.push(v);
            }
        }

        // Robustness: any face left disconnected (vertex tie made the tree
        // miss it) — fall back to connecting via *any* shared edge.
        if (order.length < n) {
            const allAdj = Array.from({ length: n }, () => []);
            for (const e of edges) {
                if (e.faces.length !== 2) continue;
                const [fa, fb] = e.faces;
                allAdj[fa].push({ face: fb, edge: e });
                allAdj[fb].push({ face: fa, edge: e });
            }
            for (let i = 0; i < n; i++) {
                if (visited[i]) continue;
                for (const { face: v, edge } of allAdj[i]) {
                    if (visited[v]) {
                        parent[i] = v;
                        parentEdge[i] = edge;
                        depth[i] = depth[v] + 1;
                        visited[i] = true;
                        order.push(i);
                        break;
                    }
                }
            }
        }
        let maxDepth = 0;
        for (let i = 0; i < n; i++) if (depth[i] > maxDepth) maxDepth = depth[i];
        this._spanningTree = { root, parent, parentEdge, depth, maxDepth, order };

        // Capture the cut-edge bridge data so _updateCutEdgeLines can draw a
        // 3-line dashed bridge across each cut as the unfold separates the
        // two adjacent faces. For each cut edge, store the two face indices
        // and the edge's endpoints in polyhedron-local frame; per frame
        // we'll project the endpoints through faceGroups[fA].matrix and
        // faceGroups[fB].matrix to get the divergent world positions.
        this._cutEdgeData = [];
        for (const eIdx of cuts) {
            const e = edges[eIdx];
            if (!e.faces || e.faces.length < 2) continue;
            this._cutEdgeData.push({
                fA: e.faces[0],
                fB: e.faces[1],
                v1: this._topology.vertices[e.v1].clone(),
                v2: this._topology.vertices[e.v2].clone(),
            });
        }
        // Topology changed -> instance count on the chain mesh is now wrong.
        // Drop it and let _updateCutEdgeLines rebuild lazily.
        if (this._cutEdgeLines) {
            if (this._faceParent) this._faceParent.remove(this._cutEdgeLines);
            this._cutEdgeLines.geometry.dispose();
            this._cutEdgeLines.material.dispose();
            this._cutEdgeLines = null;
        }
    }

    // Two dashed bridges per cut edge — one per shared CORNER (the edge's
    // two endpoints). Each bridge is a quadratic Bezier whose control
    // point sits ~50% of the chord length beneath the AB midpoint in the
    // -rootNormal direction, so the line "drops" under the unfold plane
    // instead of crossing through it. SEGMENTS_PER_BRIDGE LineSegments
    // subsegments approximate the curve; linewidth + opacity are bumped
    // a notch over the original so the dashes read with a bit more weight
    // without becoming a solid stripe.
    _updateCutEdgeLines() {
        if (!this._cutEdgeData || this._cutEdgeData.length === 0) return;
        if (this._cutEdgesEnabled === false) {
            if (this._cutEdgeLines) this._cutEdgeLines.visible = false;
            return;
        }

        // Tick the fade state every call so the dashes can fade out once
        // the polyhedron settles at fully-unfolded AND snap back in fast
        // when folding resumes. The "fully unfolded at rest" check is
        // t≈1 AND targetT≈1; anything else (mid-animation, scrubbed, or
        // about to fold) drives the fade target to 1. update() calls
        // this function on rest frames so the fade keeps animating even
        // when t isn't moving.
        const BASE_OPACITY = 0.85;
        const FADE_IN_K  = 30;          // ~0.15s settle to full opacity
        const FADE_OUT_K = 7;           // ~0.65s settle to invisible
        const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        if (this._cutEdgeFadeLastMs == null) {
            this._cutEdgeFadeLastMs = now;
            this._cutEdgeFade = 1.0;
        }
        const fadeDt = Math.min(0.1, (now - this._cutEdgeFadeLastMs) / 1000);
        this._cutEdgeFadeLastMs = now;
        const fullyUnfolded = this.t >= 0.999 && this.targetT >= 0.999;
        // Bridge-fade toggle (default ON). When OFF, the dashes stay at full
        // opacity once the polyhedron settles at t=1 instead of disappearing.
        const fadeOnRest = (this._bridgeFadeEnabled !== false);
        const targetFade = (fullyUnfolded && fadeOnRest) ? 0 : 1;
        const k = (targetFade > this._cutEdgeFade) ? FADE_IN_K : FADE_OUT_K;
        this._cutEdgeFade += (targetFade - this._cutEdgeFade) * (1 - Math.exp(-k * fadeDt));
        if (Math.abs(this._cutEdgeFade - targetFade) < 0.001) this._cutEdgeFade = targetFade;

        if (this.t < 0.02) {
            if (this._cutEdgeLines) this._cutEdgeLines.visible = false;
            return;
        }
        const SEGMENTS_PER_BRIDGE = 16;
        const BRIDGES_PER_CUT = 2;       // corner-only: 0% and 100% along the edge
        const FLOATS_PER_BRIDGE = SEGMENTS_PER_BRIDGE * 2 * 3;

        if (!this._cutEdgeLines) {
            const totalFloats = this._cutEdgeData.length * BRIDGES_PER_CUT * FLOATS_PER_BRIDGE;
            const positions = new Float32Array(totalFloats);
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            const mat = new THREE.LineDashedMaterial({
                color: 0xb8862a,            // slightly deeper gold for visual weight
                dashSize: 2.0,
                gapSize: 1.4,
                linewidth: 2,                // honoured on Win/Linux GL drivers; harmless elsewhere
                transparent: true,
                opacity: BASE_OPACITY,
            });
            this._cutEdgeLines = new THREE.LineSegments(geom, mat);
            this._cutEdgeLines.frustumCulled = false;
            this._faceParent.add(this._cutEdgeLines);
        }

        // Drive opacity from the fade. If we're effectively invisible,
        // skip the per-frame bezier rebuild — alpha=0 makes the buffer
        // contents irrelevant, so we save the work while sitting at t=1.
        this._cutEdgeLines.material.opacity = BASE_OPACITY * this._cutEdgeFade;
        if (this._cutEdgeFade < 0.005) {
            this._cutEdgeLines.visible = false;
            return;
        }
        this._cutEdgeLines.visible = true;

        const rootIdx = this.getRoot();
        const rootNormal = this.faces[rootIdx].normal;
        const sagDir = _scratchCutSagDir.copy(rootNormal).multiplyScalar(-1);

        const positions = this._cutEdgeLines.geometry.attributes.position.array;
        let pos = 0;
        const endpoints = [
            [_scratchCutA0, _scratchCutB0],   // v1 on face A → v1 on face B
            [_scratchCutA2, _scratchCutB2],   // v2 on face A → v2 on face B
        ];
        for (const data of this._cutEdgeData) {
            const fgA = this.faceGroups[data.fA];
            const fgB = this.faceGroups[data.fB];
            if (!fgA || !fgB) continue;
            _scratchCutA0.copy(data.v1).applyMatrix4(fgA.matrix);
            _scratchCutA2.copy(data.v2).applyMatrix4(fgA.matrix);
            _scratchCutB0.copy(data.v1).applyMatrix4(fgB.matrix);
            _scratchCutB2.copy(data.v2).applyMatrix4(fgB.matrix);

            for (let li = 0; li < BRIDGES_PER_CUT; li++) {
                const A = endpoints[li][0];
                const B = endpoints[li][1];
                // Deeper sag (~50% of chord) so each line dangles like a
                // chain hanging between its two endpoints rather than
                // stretching across as a taut arc.
                const sag = A.distanceTo(B) * 0.5;
                _scratchCutMid.copy(A).add(B).multiplyScalar(0.5);
                _scratchCutCtrl.copy(_scratchCutMid).addScaledVector(sagDir, sag);

                _bezierPoint(_scratchCutP1, A, _scratchCutCtrl, B, 0);
                for (let s = 1; s <= SEGMENTS_PER_BRIDGE; s++) {
                    _bezierPoint(_scratchCutP2, A, _scratchCutCtrl, B, s / SEGMENTS_PER_BRIDGE);
                    positions[pos++] = _scratchCutP1.x; positions[pos++] = _scratchCutP1.y; positions[pos++] = _scratchCutP1.z;
                    positions[pos++] = _scratchCutP2.x; positions[pos++] = _scratchCutP2.y; positions[pos++] = _scratchCutP2.z;
                    _scratchCutP1.copy(_scratchCutP2);
                }
            }
        }
        this._cutEdgeLines.geometry.attributes.position.needsUpdate = true;
        this._cutEdgeLines.geometry.computeBoundingSphere();
        this._cutEdgeLines.computeLineDistances();
    }

    _computeHingeData() {
        const n = this.faces.length;
        const { vertices } = this._topology;
        const { parent, parentEdge } = this._spanningTree;
        this._hingePivot = new Array(n);
        this._hingeAxis = new Array(n);
        this._foldAngle = new Array(n);

        for (let f = 0; f < n; f++) {
            if (parent[f] === -1) continue;
            const edge = parentEdge[f];
            const va = vertices[edge.v1];
            const vb = vertices[edge.v2];
            const pivot = new THREE.Vector3().addVectors(va, vb).multiplyScalar(0.5);
            const axis = new THREE.Vector3().subVectors(vb, va).normalize();
            this._hingePivot[f] = pivot;
            this._hingeAxis[f] = axis;

            // Fold angle = arccos(n_parent · n_child) — the angle between the
            // OUTWARD-pointing normals, which is exactly how much we have to
            // rotate the child around the hinge so the two faces become
            // coplanar (n_child parallel to n_parent). Picking the right sign
            // is handled by the test below: try +angle first and flip if the
            // rotated normal doesn't end up on top of the parent's.
            //
            // (Earlier version used π − dihedral, which is the *interior*
            // dihedral angle, not the angle between outward normals. That
            // happened to be right for cubes — α = β = π/2 — but stopped
            // every other polyhedron short of coplanar, so children landed
            // mid-fold and overlapped.)
            const pn = this.faces[parent[f]].normal;
            const cn = this.faces[f].normal;
            const cosAlpha = Math.max(-1, Math.min(1, pn.dot(cn)));
            let foldAngle = Math.acos(cosAlpha);
            const q = new THREE.Quaternion().setFromAxisAngle(axis, foldAngle);
            const test = cn.clone().applyQuaternion(q);
            if (test.dot(pn) < 0.99) foldAngle = -foldAngle;
            this._foldAngle[f] = foldAngle;
        }
    }

    _buildEdgeMaterial() {
        if (this._edgeMat) this._edgeMat.dispose();
        this._edgeMat = new THREE.MeshPhongMaterial({
            color: this._edgeParams.color,
            specular: this._edgeParams.specular,
            shininess: this._edgeParams.shininess,
            emissive: this._edgeParams.emissive,
            emissiveIntensity: this._edgeParams.emissiveIntensity,
        });
    }

    _buildFaceGroups() {
        // Per-face tree:
        //   faceGroups[i]                  (matrixAutoUpdate = false)
        //     ├─ _faceMeshTex[i]           (textured Earth mesh or parchment fallback)
        //     ├─ _faceEdgeMesh[i]          (sub-Group of cylinder edges + sphere joints)
        //     └─ _faceContour[i]           (elevation LineSegments, when loaded)
        // _updateAnimation() rotates each faceGroups[i] around its hinge; the
        // three children inherit that transform automatically.
        for (let i = 0; i < this.faces.length; i++) {
            const face = this.faces[i];
            const corners3D = face.vertices3D;
            if (!corners3D || corners3D.length < 3) {
                this.faceGroups.push(null);
                this._faceMeshTex.push(null);
                this._faceEdgeMesh.push(null);
                this._faceContour.push(null);
                continue;
            }
            const fg = new THREE.Group();
            fg.matrixAutoUpdate = false;
            fg.matrix.identity();
            fg.matrixWorldNeedsUpdate = true;

            const mesh = this._buildFaceMeshFor(face, i);
            if (mesh) fg.add(mesh);

            const edges = this._buildFaceEdgesFor(face);
            if (edges) {
                edges.visible = this._showFaceOutlines;
                fg.add(edges);
            }

            const label = this._buildFaceLabel(i);
            if (label) fg.add(label);

            this.faceGroups.push(fg);
            this._faceMeshTex.push(mesh);
            this._faceEdgeMesh.push(edges);
            this._faceContour.push(null);
            this._faceLabels.push(label);
            this._faceParent.add(fg);
        }
    }

    // Build the per-face index label as a Three.js Sprite. The sprite is
    // parented to the face group so it unfolds with the face; it uses
    // depthTest:false + a high renderOrder so the digit stays readable even
    // when the face is behind another (the user can still see "face 7" if
    // it's currently on the far side of the polyhedron).
    _buildFaceLabel(idx) {
        const face = this.faces[idx];
        if (!face) return null;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 128;
        const ctx = canvas.getContext('2d');
        this._drawLabelCanvas(ctx, idx, idx === this.getRoot());

        const tex = new THREE.CanvasTexture(canvas);
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        const mat = new THREE.SpriteMaterial({
            map: tex,
            transparent: true,
            depthTest: false,
            depthWrite: false,
        });
        const sprite = new THREE.Sprite(mat);
        const R = this.polyhedron.R || 100;
        // Position slightly outside the face's centroid so the label always
        // sits in front of the face surface even after the polygonOffset.
        sprite.position.copy(face.center).multiplyScalar(1.02);
        const sz = R * 0.12;
        sprite.scale.set(sz, sz, 1);
        sprite.visible = this._showFaceLabels;
        sprite.renderOrder = 9999;
        // Squirrel the canvas + ctx on the sprite so _refreshLabel can repaint
        // them without rebuilding the texture from scratch.
        sprite.userData.canvas = canvas;
        sprite.userData.ctx = ctx;
        sprite.userData.faceIdx = idx;
        return sprite;
    }

    _drawLabelCanvas(ctx, idx, isRoot) {
        ctx.clearRect(0, 0, 128, 128);
        if (isRoot) {
            // Inverted gold disk for the spanning-tree root face.
            ctx.fillStyle = '#ffd700';
            ctx.beginPath(); ctx.arc(64, 64, 52, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = '#4a3500';
            ctx.lineWidth = 5;
            ctx.beginPath(); ctx.arc(64, 64, 52, 0, Math.PI * 2); ctx.stroke();
            ctx.fillStyle = '#1a1a1a';
        } else {
            // Dim disk with gold ring + gold numeral for every other face.
            ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.beginPath(); ctx.arc(64, 64, 48, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = 'rgba(255, 215, 0, 0.7)';
            ctx.lineWidth = 3;
            ctx.beginPath(); ctx.arc(64, 64, 48, 0, Math.PI * 2); ctx.stroke();
            ctx.fillStyle = '#ffd700';
        }
        ctx.font = 'bold 60px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(idx), 64, 64);
    }

    _refreshLabel(idx) {
        if (idx < 0 || idx >= this._faceLabels.length) return;
        const sp = this._faceLabels[idx];
        if (!sp || !sp.userData.ctx) return;
        this._drawLabelCanvas(sp.userData.ctx, idx, idx === this.getRoot());
        if (sp.material && sp.material.map) sp.material.map.needsUpdate = true;
    }

    setFaceLabelsVisible(v) {
        this._showFaceLabels = !!v;
        for (const sp of this._faceLabels) {
            if (sp) sp.visible = this._showFaceLabels;
        }
    }
    getFaceLabelsVisible() { return this._showFaceLabels; }

    // Stable transparent paint order. Without this, Three.js sorts translucent
    // objects by camera-distance per frame, and faces whose centers cross in
    // distance (typically right when an unfolding edge completes) flip in the
    // sort — causing a visible step in the alpha-blended colors. Locking
    // renderOrder to a deterministic depth-based value means the order never
    // changes across frames, so no flip and no step.
    //
    // Order chosen: root paints LAST (depth=0 → highest renderOrder), leaves
    // paint first. Within each face, the elevation contour paints one step
    // after the face mesh so contour lines stay readable over their own face.
    _faceRenderOrder(idx) {
        const st = this._spanningTree;
        if (!st) return 0;
        const d = st.depth[idx] | 0;
        const D = st.maxDepth | 0;
        // 'root-last' (default): root depth=0 → highest renderOrder → root
        //   paints last. Reads naturally for the folded polyhedron viewed
        //   from above (root is the top face).
        // 'root-first': inverse — leaves paint last. Reads naturally for the
        //   fully-unfolded flower view where leaves splay outward.
        return this._renderOrderDir === 'root-first' ? d * 2 : (D - d) * 2;
    }

    setRenderOrderDirection(dir) {
        if (dir !== 'root-last' && dir !== 'root-first') return;
        if (dir === this._renderOrderDir) return;
        this._renderOrderDir = dir;
        this._refreshRenderOrders();
    }
    getRenderOrderDirection() { return this._renderOrderDir; }

    _refreshRenderOrders() {
        for (let i = 0; i < this.faces.length; i++) {
            const ro = this._faceRenderOrder(i);
            const mesh = this._faceMeshTex[i];
            if (mesh) mesh.renderOrder = ro;
            const contour = this._faceContour[i];
            if (contour) contour.renderOrder = ro + 1;
        }
    }

    // Build the flat face mesh for face `idx`. If a per-face Earth canvas is
    // available (set up by setEarthSvgPaths / setEarthImage), use a UV-mapped
    // MeshBasicMaterial so the Earth texture sits on the face. Otherwise fall
    // back to a parchment-tinted MeshPhongMaterial so empty Mode I still reads.
    _buildFaceMeshFor(face, idx) {
        const corners3D = face.vertices3D;
        if (!corners3D || corners3D.length < 3) return null;
        const N = corners3D.length;
        const positions = new Float32Array(N * 3);
        for (let k = 0; k < N; k++) {
            positions[k * 3]     = corners3D[k].x;
            positions[k * 3 + 1] = corners3D[k].y;
            positions[k * 3 + 2] = corners3D[k].z;
        }
        const indices = [];
        for (let k = 1; k < N - 1; k++) indices.push(0, k + 1, k);

        const canvas = this._faceCanvases[idx];
        const texture = this._faceTextures[idx];

        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        if (canvas && texture) {
            const uvs = new Float32Array(N * 2);
            const sizeX = canvas.width, sizeY = canvas.height;
            for (let k = 0; k < N; k++) {
                const c = canvas.polygonCorners[k];
                uvs[k * 2]     = c.x / sizeX;
                uvs[k * 2 + 1] = 1 - c.y / sizeY;
            }
            geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        }
        geom.setIndex(indices);
        geom.computeVertexNormals();

        let mat;
        if (canvas && texture) {
            // Opaque tiles: standard alpha-blended MeshBasicMaterial, opacity
            //   1.0, depthWrite on. Reads as a solid Earth-textured polyhedron.
            // Translucent tiles: two flavors selectable via _translucentBlend:
            //   'alpha'    — NormalBlending at opacity 0.4. Order-dependent,
            //                so the same back face looks different through
            //                different front panes (alpha blending is NOT
            //                commutative).
            //   'multiply' — MultiplyBlending at opacity 1.0. framebuffer *=
            //                face_color, which is commutative — back face
            //                looks consistent through any front pane.
            const trans = !this._facesOpaque;
            const useMul = trans && this._translucentBlend === 'multiply';
            mat = new THREE.MeshBasicMaterial({
                map: texture,
                color: this._tileTint,
                side: THREE.DoubleSide,
                transparent: trans,
                opacity: trans && !useMul ? 0.4 : 1.0,
                blending: useMul ? THREE.MultiplyBlending : THREE.NormalBlending,
                depthWrite: this._facesOpaque,
                // No polygonOffset here. The previous factor/units=2 pushed
                // each tile's depth back enough that — at far camera
                // distances where depth precision is poorer — the
                // camera-pinned star sphere's BACK-side stars (which sit
                // behind the polyhedron geometrically) ended up at a
                // SMALLER depth value than the offset tile and passed the
                // GL_LESS depth test, showing through the tile face. The
                // distance-dependence the user reported (close = opaque,
                // far = see-through) is the signature of this offset
                // shifting more stars across the depth boundary as
                // precision falls. Elevation contours are drawn on top
                // via their own renderOrder + depthTest already.
            });
            // Force gl_FragColor.a = 1.0 in the fragment shader when the
            // tile is in opaque mode. Without this, sub-1 alpha anywhere
            // along the texture / MSAA edge / framebuffer-clear path
            // leaks into the canvas's alpha channel — the HTML backdrop
            // behind the WebGL canvas then composes through tiny edge
            // gaps that grow more visible as the polygon shrinks on
            // screen (distance-dependent "see-through"). The uniform
            // lets _applyFaceBlendState toggle the override at runtime
            // without recompiling the shader.
            mat.userData.forceOpaque = { value: this._facesOpaque ? 1.0 : 0.0 };
            mat.onBeforeCompile = (shader) => {
                shader.uniforms.uForceOpaque = mat.userData.forceOpaque;
                shader.fragmentShader =
                    'uniform float uForceOpaque;\n' +
                    shader.fragmentShader.replace(
                        /}\s*$/,
                        '\tgl_FragColor.a = mix(gl_FragColor.a, 1.0, uForceOpaque);\n}',
                    );
            };
        } else {
            mat = new THREE.MeshPhongMaterial({
                color: 0xf2e6c7,
                specular: 0x444444,
                shininess: 24,
                side: THREE.DoubleSide,
            });
        }
        const mesh = new THREE.Mesh(geom, mat);
        mesh.renderOrder = this._faceRenderOrder(idx);
        return mesh;
    }

    // Per-face gold-edge wireframe: one cylinder per polygon edge + a sphere
    // joint at each vertex, all sharing this._edgeMat so a material change
    // propagates everywhere. Lives inside the face's group so it unfolds with
    // its face. Shared polyhedron vertices end up with two coincident spheres
    // (one per adjacent face), which is invisible folded and intentional-
    // looking unfolded — each polygon gets its own rounded corners.
    _buildFaceEdgesFor(face) {
        const verts = face.vertices3D;
        if (!verts || verts.length < 2) return null;
        const N = verts.length;
        const R = this.polyhedron.R || 100;
        const tubeRadius = R * (this._edgeRadiusFactor || 0.004);
        const radialSegments = 16;

        const group = new THREE.Group();
        const yAxis = new THREE.Vector3(0, 1, 0);
        const dir = new THREE.Vector3();
        const quat = new THREE.Quaternion();

        for (let i = 0; i < N; i++) {
            const a = verts[i];
            const b = verts[(i + 1) % N];
            const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (len < 1e-6) continue;
            const geom = new THREE.CylinderGeometry(tubeRadius, tubeRadius, len, radialSegments);
            const mesh = new THREE.Mesh(geom, this._edgeMat);
            mesh.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
            dir.set(dx / len, dy / len, dz / len);
            quat.setFromUnitVectors(yAxis, dir);
            mesh.quaternion.copy(quat);
            group.add(mesh);
        }

        const sphereWidthSeg = radialSegments;
        const sphereHeightSeg = Math.max(8, radialSegments / 2);
        for (let i = 0; i < N; i++) {
            const v = verts[i];
            const geom = new THREE.SphereGeometry(tubeRadius, sphereWidthSeg, sphereHeightSeg);
            const mesh = new THREE.Mesh(geom, this._edgeMat);
            mesh.position.set(v.x, v.y, v.z);
            group.add(mesh);
        }

        return group;
    }

    _rebuildAllFaceEdges() {
        // Re-create just the gold edge wireframe inside each face group
        // (called from setEdgeRadiusFactor — the face meshes + contours stay).
        for (let i = 0; i < this.faces.length; i++) {
            const fg = this.faceGroups[i];
            if (!fg) continue;
            const old = this._faceEdgeMesh[i];
            if (old) {
                fg.remove(old);
                old.traverse((obj) => { if (obj.geometry) obj.geometry.dispose(); });
            }
            const edges = this._buildFaceEdgesFor(this.faces[i]);
            if (edges) {
                edges.visible = this._showFaceOutlines;
                fg.add(edges);
            }
            this._faceEdgeMesh[i] = edges;
        }
    }

    setEdgeRadiusFactor(f) {
        const next = Math.max(0.0005, Math.min(0.03, +f || 0.004));
        if (Math.abs(next - this._edgeRadiusFactor) < 1e-6) return;
        this._edgeRadiusFactor = next;
        this._rebuildAllFaceEdges();
    }

    // Live-update the shared gold MeshPhongMaterial. No geometry rebuild —
    // every tube/sphere across every face picks up the change automatically.
    setEdgeParams(params) {
        if (!params) return;
        if (params.color !== undefined) this._edgeParams.color = params.color;
        if (params.specular !== undefined) this._edgeParams.specular = params.specular;
        if (params.shininess !== undefined) this._edgeParams.shininess = params.shininess;
        if (params.emissive !== undefined) this._edgeParams.emissive = params.emissive;
        if (params.emissiveIntensity !== undefined) this._edgeParams.emissiveIntensity = params.emissiveIntensity;
        if (this._edgeMat) {
            if (params.color !== undefined) this._edgeMat.color.setHex(params.color);
            if (params.specular !== undefined) this._edgeMat.specular.setHex(params.specular);
            if (params.shininess !== undefined) this._edgeMat.shininess = params.shininess;
            if (params.emissive !== undefined) this._edgeMat.emissive.setHex(params.emissive);
            if (params.emissiveIntensity !== undefined) this._edgeMat.emissiveIntensity = params.emissiveIntensity;
            this._edgeMat.needsUpdate = true;
        }
    }

    setFaceOutlinesVisible(v) {
        this._showFaceOutlines = !!v;
        for (const e of this._faceEdgeMesh) {
            if (e) e.visible = this._showFaceOutlines;
        }
    }

    // ---- Earth pipeline (mirror Mode A-2) ------------------------------

    setEarthImage(img) {
        this._earthImage = img || null;
        this._earthCanvasWarmJobs.clear();
        if (this._earthSvgPaths && this._earthStyle) return;   // SVG pipeline owns it
        if (this.group.visible) this._rebuildFaceCanvases();
        else this._faceMeshesDirty = true;
    }

    setEarthSvgPaths(pathData, style) {
        this._earthSvgPaths = pathData || null;
        this._earthStyle = style || null;
        this._earthCanvasWarmJobs.clear();
        if (this.group.visible) this._rebuildFaceCanvases();
        else this._faceMeshesDirty = true;
    }

    // Rebuild every face's offscreen Earth canvas, then swap each faceGroup's
    // face-mesh child (the gold edges and contour LineSegments stay put). We
    // tear down the old MeshBasicMaterial/Texture before creating the new mesh
    // so GPU memory doesn't grow with every preset change.
    // Synchronous rebuild + per-polyhedron canvas cache. On first visit to
    // a (polyhedron-type, SVG-paths, style) combo, every face's Earth canvas
    // is stroked from the country paths (~30-50 ms × N faces, blocks the UI
    // briefly). The resulting canvases are cached keyed by polyhedron type,
    // with the paths + style references on the entry so a preset switch
    // invalidates correctly. Returning to a previously-visited polyhedron
    // skips the render entirely and just builds fresh textures + meshes
    // from the cached canvases — typically <30 ms total.
    _rebuildFaceCanvases() {
        for (const t of this._faceTextures) { if (t) t.dispose(); }
        this._faceTextures = [];
        this._faceCanvases = [];

        if (!this._earthSvgPaths && !this._earthImage) return;

        const polyType = this.polyhedron && this.polyhedron.type;
        const bgMode = this._faceBgMode;
        const entry = polyType ? this._earthCanvasCache.get(polyType) : null;
        let canvases;
        if (entry
            && entry.paths === this._earthSvgPaths
            && entry.style === this._earthStyle
            && entry.image === this._earthImage
            && entry.bgMode === bgMode
            && entry.grainEnabled === this._grainEnabled
            && entry.canvases.length === this.faces.length) {
            canvases = entry.canvases;
        } else {
            // Per-face parchment backgrounds, when the user has selected a
            // parchment preset and the PNG has been loaded. nullable.
            const parchmentCanvases = (bgMode !== 'plain' && this._parchmentImageData.has(bgMode))
                ? this._getParchmentFaceCanvases(polyType, bgMode)
                : null;
            canvases = [];
            for (let i = 0; i < this.faces.length; i++) {
                const face = this.faces[i];
                const bg = parchmentCanvases ? parchmentCanvases[i] : null;
                let canvas;
                if (this._earthSvgPaths && this._earthStyle) {
                    canvas = renderEarthFaceFromSvgPaths(
                        face, this.faces, this._earthSvgPaths, this._earthStyle,
                        this._faceCanvasSize, bg, this._grainEnabled,
                    );
                } else if (this._earthImage) {
                    canvas = renderEarthFaceFromRaster(
                        face, this.faces, this._earthImage, this._faceCanvasSize, bg,
                    );
                }
                canvases.push(canvas);
            }
            if (polyType) {
                this._earthCanvasCache.set(polyType, {
                    paths: this._earthSvgPaths,
                    style: this._earthStyle,
                    image: this._earthImage,
                    bgMode,
                    grainEnabled: this._grainEnabled,
                    canvases,
                });
            }
        }

        this._faceCanvases = canvases.slice();
        for (const c of this._faceCanvases) {
            const tex = new THREE.Texture(c);
            tex.minFilter = THREE.LinearFilter;
            tex.magFilter = THREE.LinearFilter;
            tex.needsUpdate = true;
            this._faceTextures.push(tex);
        }

        for (let i = 0; i < this.faces.length; i++) {
            const fg = this.faceGroups[i];
            if (!fg) continue;
            const old = this._faceMeshTex[i];
            if (old) {
                fg.remove(old);
                if (old.geometry) old.geometry.dispose();
                if (old.material) old.material.dispose();
            }
            const mesh = this._buildFaceMeshFor(this.faces[i], i);
            if (mesh) fg.add(mesh);
            this._faceMeshTex[i] = mesh;
        }
    }

    warmEarthCanvasCacheFor(polyhedron, maxFaces = 1) {
        if (!polyhedron || (!this._earthSvgPaths && !this._earthImage)) return true;
        const polyType = polyhedron.type;
        const faces = modeIFacesForPolyhedron(polyhedron);
        if (!polyType || !faces || !faces.length) return true;

        const bgMode = this._faceBgMode;
        const cached = this._earthCanvasCache.get(polyType);
        if (cached
            && cached.paths === this._earthSvgPaths
            && cached.style === this._earthStyle
            && cached.image === this._earthImage
            && cached.bgMode === bgMode
            && cached.grainEnabled === this._grainEnabled
            && cached.canvases.length === faces.length) {
            return true;
        }

        if (bgMode !== 'plain') return true;

        let job = this._earthCanvasWarmJobs.get(polyType);
        if (!job
            || job.paths !== this._earthSvgPaths
            || job.style !== this._earthStyle
            || job.image !== this._earthImage
            || job.bgMode !== bgMode
            || job.grainEnabled !== this._grainEnabled
            || job.faces.length !== faces.length) {
            job = {
                paths: this._earthSvgPaths,
                style: this._earthStyle,
                image: this._earthImage,
                bgMode,
                grainEnabled: this._grainEnabled,
                faces,
                canvases: [],
                next: 0,
            };
            this._earthCanvasWarmJobs.set(polyType, job);
        }

        const limit = Math.max(1, maxFaces | 0);
        let count = 0;
        while (job.next < job.faces.length && count < limit) {
            const face = job.faces[job.next];
            let canvas = null;
            if (job.paths && job.style) {
                canvas = renderEarthFaceFromSvgPaths(
                    face, job.faces, job.paths, job.style,
                    this._faceCanvasSize, null, job.grainEnabled,
                );
            } else if (job.image) {
                canvas = renderEarthFaceFromRaster(
                    face, job.faces, job.image, this._faceCanvasSize, null,
                );
            }
            job.canvases[job.next] = canvas;
            job.next += 1;
            count += 1;
        }

        if (job.next >= job.faces.length) {
            this._earthCanvasCache.set(polyType, {
                paths: job.paths,
                style: job.style,
                image: job.image,
                bgMode: job.bgMode,
                grainEnabled: job.grainEnabled,
                canvases: job.canvases,
            });
            this._earthCanvasWarmJobs.delete(polyType);
            return true;
        }
        return false;
    }

    setFacesOpaque(v) {
        this._facesOpaque = !!v;
        this._applyFaceBlendState();
    }

    // Stash a baked equirect parchment PNG (loaded by main.js) as ImageData
    // so per-face gnomonic resampling can read it pixel-by-pixel. Called
    // once per preset slug ('cartographer' | 'cottonRag') after the PNG
    // finishes loading.
    setParchmentImage(slug, img) {
        if (!img) {
            this._parchmentImageData.delete(slug);
            for (const k of this._parchmentFaceCache.keys()) {
                if (k.endsWith('|' + slug)) this._parchmentFaceCache.delete(k);
            }
            return;
        }
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        const tmp = document.createElement('canvas');
        tmp.width = w; tmp.height = h;
        const tctx = tmp.getContext('2d');
        tctx.drawImage(img, 0, 0);
        try {
            this._parchmentImageData.set(slug, tctx.getImageData(0, 0, w, h));
            console.log(`[parchment] loaded ${slug} (${w}x${h})`);
        } catch (e) {
            console.warn(`[parchment] could not read ${slug} pixels (CORS?):`, e.message);
            return;
        }
        // Invalidate any cached per-face parchment canvases for this slug —
        // a fresh image means stale samples.
        for (const k of [...this._parchmentFaceCache.keys()]) {
            if (k.endsWith('|' + slug)) this._parchmentFaceCache.delete(k);
        }
        if (this._faceBgMode === slug && this.group.visible) {
            const polyType = this.polyhedron && this.polyhedron.type;
            if (polyType) this._earthCanvasCache.delete(polyType);
            this._rebuildFaceCanvases();
        }
    }

    // Build (or fetch from cache) the per-face parchment background canvases
    // for the current polyhedron + selected parchment preset. One canvas per
    // face, with the equirect texture gnomonically resampled into the face's
    // 2D frame at the configured _faceCanvasSize.
    _getParchmentFaceCanvases(polyType, slug) {
        const key = `${polyType}|${slug}`;
        let cached = this._parchmentFaceCache.get(key);
        if (cached && cached.length === this.faces.length) return cached;
        const imgData = this._parchmentImageData.get(slug);
        if (!imgData) return null;
        cached = this.faces.map(face =>
            renderParchmentFaceBackground(face, imgData, this._faceCanvasSize));
        this._parchmentFaceCache.set(key, cached);
        return cached;
    }

    setGrainEnabled(v) {
        const next = !!v;
        if (this._grainEnabled === next) return;
        this._grainEnabled = next;
        this._earthCanvasWarmJobs.clear();
        const polyType = this.polyhedron && this.polyhedron.type;
        if (polyType) this._earthCanvasCache.delete(polyType);
        if (this.group.visible) this._rebuildFaceCanvases();
        // Backing texture is the parchment-clouds-light bake which already
        // carries the cloud + grain noise — the grain toggle doesn't apply.
    }
    getGrainEnabled() { return this._grainEnabled; }

    // Set the face background mode: 'plain' uses style.bgColor (current
    // behaviour); 'cartographer' or 'cottonRag' resamples the baked
    // parchment sphere map per face. Rebuilds the canvases on switch.
    setFaceBackgroundMode(mode) {
        const VALID = new Set(['plain', 'cartographer', 'cottonRag', 'whiteWash', 'shaderPaper', 'parchmentClouds', 'parchmentCloudsLight']);
        if (!VALID.has(mode)) return;
        if (mode === this._faceBgMode) return;
        this._faceBgMode = mode;
        this._earthCanvasWarmJobs.clear();
        const polyType = this.polyhedron && this.polyhedron.type;
        if (polyType) this._earthCanvasCache.delete(polyType);
        if (mode !== 'plain' && !this._parchmentImageData.has(mode)) {
            console.warn(`[parchment] bg mode '${mode}' set but the PNG hasn't loaded yet — falling back to plain until it arrives.`);
        }
        if (this.group.visible) this._rebuildFaceCanvases();
    }
    getFaceBackgroundMode() { return this._faceBgMode; }

    setTranslucentBlend(mode) {
        if (mode !== 'alpha' && mode !== 'multiply') return;
        if (mode === this._translucentBlend) return;
        this._translucentBlend = mode;
        this._applyFaceBlendState();
    }
    getTranslucentBlend() { return this._translucentBlend; }

    // Push the current (opaque, blend-mode) state onto every face mesh's
    // material. Splitting this out of setFacesOpaque means setTranslucentBlend
    // can update the materials without re-stepping any opacity state.
    _applyFaceBlendState() {
        const trans = !this._facesOpaque;
        const useMul = trans && this._translucentBlend === 'multiply';
        for (const mesh of this._faceMeshTex) {
            if (!mesh || !mesh.material) continue;
            mesh.material.transparent = trans;
            mesh.material.opacity = trans && !useMul ? 0.4 : 1.0;
            mesh.material.blending = useMul ? THREE.MultiplyBlending : THREE.NormalBlending;
            mesh.material.depthWrite = this._facesOpaque;
            // Keep the shader-level alpha-override uniform in sync with the
            // material's opacity intent — without this the once-compiled
            // shader keeps the alpha clamp it had at build time.
            if (mesh.material.userData && mesh.material.userData.forceOpaque) {
                mesh.material.userData.forceOpaque.value = this._facesOpaque ? 1.0 : 0.0;
            }
            mesh.material.needsUpdate = true;
        }
    }

    // Tile tint: applied to the MeshBasicMaterial.color, which multiplies the
    // white-bg Earth canvas texture. White (0xffffff) is "no tint".
    setTileTint(hex) {
        this._tileTint = (hex | 0) & 0xffffff;
        for (const mesh of this._faceMeshTex) {
            if (mesh && mesh.material && mesh.material.color) {
                mesh.material.color.setHex(this._tileTint);
                mesh.material.needsUpdate = true;
            }
        }
        // Backing tile follows the same tint so it reads as a slab of
        // the same parchment cream as the faces.
        if (this.backingMaterial && this.backingMaterial.color) {
            this.backingMaterial.color.setHex(this._tileTint);
            this.backingMaterial.needsUpdate = true;
        }
    }

    // ---- Elevation pipeline -------------------------------------------

    setElevationCurvesVisible(v) {
        this._showElev = !!v;
        let any = false;
        for (const c of this._faceContour) {
            if (c) { c.visible = this._showElev; any = true; }
        }
        if (this._showElev && !this._elevCurves && !any) this._loadElevationData();
    }

    setElevationCurvesExaggeration(x) {
        const next = Math.max(1, Math.min(2000, +x || 150));
        if (next === this._elevExag) return;
        this._elevExag = next;
        if (this._elevCurves) this._rebuildAllFaceContours();
    }

    setLandOnly(v) {
        const next = !!v;
        if (next === this._landOnly) return;
        this._landOnly = next;
        if (this._elevCurves) this._rebuildAllFaceContours();
    }

    setElevationLatStepDeg(step) {
        const valid = [0.5, 1, 2, 3, 5];
        if (!valid.includes(step)) return;
        if (step === this._elevLatStepDeg) {
            if (this._showElev && !this._elevCurves) this._loadElevationData();
            return;
        }
        this._elevLatStepDeg = step;
        this._elevLoadSeq += 1;
        this._elevCurves = null;
        this._elevCurvesMeta = null;
        this._clearAllFaceContours();
        if (this._showElev) this._loadElevationData();
    }

    async _loadElevationData() {
        if (this._elevCurves) return;
        const requestedStep = this._elevLatStepDeg;
        const seq = ++this._elevLoadSeq;
        const slug = elevationStepSlug(requestedStep);
        try {
            const [binResp, jsonResp] = await Promise.all([
                fetch(`./data/elevation_curves_${slug}deg.bin`),
                fetch(`./data/elevation_curves_${slug}deg.json`),
            ]);
            if (!binResp.ok)  throw new Error(`elev bin (${slug}deg): HTTP ${binResp.status}`);
            if (!jsonResp.ok) throw new Error(`elev json (${slug}deg): HTTP ${jsonResp.status}`);
            const buf = await binResp.arrayBuffer();
            const meta = await jsonResp.json();
            const curves = new Float32Array(buf);
            const [nBand, nLon] = meta.shape;
            if (curves.length !== nBand * nLon) {
                throw new Error(`Mode I elev bin length ${curves.length} != ${nBand}*${nLon}`);
            }
            if (seq !== this._elevLoadSeq || this._elevLatStepDeg !== requestedStep) return;
            this._elevCurvesMeta = meta;
            this._elevCurves = curves;
            this._rebuildAllFaceContours();
        } catch (e) {
            if (seq !== this._elevLoadSeq || this._elevLatStepDeg !== requestedStep) return;
            console.warn('Mode I elevation data load failed:', e);
        }
    }

    _clearAllFaceContours() {
        for (let i = 0; i < this._faceContour.length; i++) {
            const ls = this._faceContour[i];
            if (!ls) continue;
            const fg = this.faceGroups[i];
            if (fg) fg.remove(ls);
            if (ls.geometry) ls.geometry.dispose();
            if (ls.material) ls.material.dispose();
            this._faceContour[i] = null;
        }
    }

    // Per-face contour build. Each ETOPO contour vertex is gnomonically
    // projected onto whichever face the radial ray hits first; a segment is
    // drawn ONLY when both endpoints land on the same face. Cross-face
    // segments are dropped (they used to leap over polyhedron edges and would
    // stretch across thin air after unfolding).
    _contourCacheKey() {
        const type = this.polyhedron && this.polyhedron.type;
        return `${type}|${this._elevLatStepDeg}|${this._elevExag}|${this._landOnly ? 1 : 0}`;
    }

    // Cache probe for an arbitrary (polyType, density) — callers can ask
    // "is the target density already cached for the polyhedron I'm about
    // to switch to?" without first having to set polyhedron + density.
    hasContourCacheFor(polyType, density) {
        const key = `${polyType}|${density}|${this._elevExag}|${this._landOnly ? 1 : 0}`;
        return this._contourCache.has(key);
    }

    _rebuildAllFaceContours() {
        this._clearAllFaceContours();
        if (!this._elevCurves || !this._elevCurvesMeta) return;
        const key = this._contourCacheKey();
        let cached = this._contourCache.get(key);
        if (!cached) {
            cached = this._computeFaceContourArrays();
            if (cached) this._contourCache.set(key, cached);
        }
        if (!cached) return;
        this._buildFaceContourMeshes(cached.facePos, cached.faceCol);
    }

    _buildFaceContourMeshes(facePos, faceCol) {
        const nFaces = this.faces.length;
        for (let i = 0; i < nFaces; i++) {
            const fg = this.faceGroups[i];
            if (!fg) continue;
            const pos = facePos[i];
            if (!pos || pos.length === 0) continue;
            const positions = new Float32Array(pos);
            const colors = new Float32Array(faceCol[i]);
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geom.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
            const ls = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({
                vertexColors: true,
                transparent: true,
                opacity: 0.95,
            }));
            ls.visible = this._showElev;
            ls.renderOrder = this._faceRenderOrder(i) + 1;
            fg.add(ls);
            this._faceContour[i] = ls;
        }
    }

    _computeFaceContourArrays() {
        if (!this._elevCurves || !this._elevCurvesMeta) return null;
        const meta = this._elevCurvesMeta;
        const [nBand, nLon] = meta.shape;
        const data = this._elevCurves;
        const latFirst = meta.lat_first_deg;
        const latStep  = meta.lat_step_deg;
        const lonFirst = meta.lon_first_deg;
        const lonStep  = meta.lon_step_deg;
        const D2R = Math.PI / 180;
        const polyR = this.polyhedron.R;
        const elevScale = (polyR / this.EARTH_R_METERS) * this._elevExag;
        const BIAS = 1.005;

        // Sub-divide each 0.5° lon interval to keep chord length within a
        // single face — otherwise the segment connecting two raw vertices on
        // the same face still dips into the polyhedron interior visibly.
        const SUB_N = this._watermanButterflyFaces ? 8 : 4;
        const nVertSub = nLon * SUB_N;
        const nFaces = this.faces.length;
        const facePos = new Array(nFaces);
        const faceCol = new Array(nFaces);
        for (let i = 0; i < nFaces; i++) {
            facePos[i] = [];
            faceCol[i] = [];
        }

        // Scratch buffers (reused band-to-band).
        const vx = new Float64Array(nVertSub);
        const vy = new Float64Array(nVertSub);
        const vz = new Float64Array(nVertSub);
        const ve = new Float32Array(nVertSub);
        const vf = new Int32Array(nVertSub);

        for (let bi = 0; bi < nBand; bi++) {
            const lat = (latFirst + bi * latStep) * D2R;
            const sinLat = Math.sin(lat);
            const cosLat = Math.cos(lat);

            for (let i = 0; i < nVertSub; i++) {
                const li = Math.floor(i / SUB_N);
                const sub = i - li * SUB_N;
                const tFrac = sub / SUB_N;
                const li2 = (li + 1) % nLon;
                const lon = (lonFirst + (li + tFrac) * lonStep) * D2R;
                const e0 = data[bi * nLon + li];
                const e1 = data[bi * nLon + li2];
                const elev = e0 + tFrac * (e1 - e0);
                ve[i] = elev;
                const elevDisp = this._landOnly ? landOnlyElev(elev) : elev;

                // Inline ray-vs-face intersection so we can record the face
                // index. Prefer the nearest face whose 2D polygon contains the
                // hit, which keeps coplanar split square triangles from all
                // claiming the same elevation vertices.
                const dx = cosLat * Math.cos(lon);
                const dy = sinLat;
                const dz = -cosLat * Math.sin(lon);
                let bestIdx = -1, bestT = Infinity, bestPx = 0, bestPy = 0, bestPz = 0;
                let bestInsideIdx = -1, bestInsideT = Infinity, bestInsidePx = 0, bestInsidePy = 0, bestInsidePz = 0;
                for (let fi = 0; fi < nFaces; fi++) {
                    const face = this.faces[fi];
                    const dot = dx * face.normal.x + dy * face.normal.y + dz * face.normal.z;
                    if (dot <= 0) continue;
                    const t = face.planeDist / dot;
                    if (!Number.isFinite(t) || t <= 0) continue;
                    const px = dx * t;
                    const py = dy * t;
                    const pz = dz * t;
                    if (t < bestT) {
                        bestT = t;
                        bestIdx = fi;
                        bestPx = px;
                        bestPy = py;
                        bestPz = pz;
                    }

                    const ox = px - face.center.x;
                    const oy = py - face.center.y;
                    const oz = pz - face.center.z;
                    const u = ox * face.basisU.x + oy * face.basisU.y + oz * face.basisU.z;
                    const v = ox * face.basisV.x + oy * face.basisV.y + oz * face.basisV.z;
                    if (face.vertices2D && _faceCanvas_pointInPolygonOrEdge(u, v, face.vertices2D, _faceCanvas_faceHitTolerance(face)) && t < bestInsideT) {
                        bestInsideT = t;
                        bestInsideIdx = fi;
                        bestInsidePx = px;
                        bestInsidePy = py;
                        bestInsidePz = pz;
                    }
                }
                const useInside = bestInsideIdx >= 0;
                const hitIdx = useInside ? bestInsideIdx : bestIdx;
                if (hitIdx < 0) {
                    vf[i] = -1;
                    continue;
                }
                vf[i] = hitIdx;
                const px = useInside ? bestInsidePx : bestPx;
                const py = useInside ? bestInsidePy : bestPy;
                const pz = useInside ? bestInsidePz : bestPz;
                const len = Math.sqrt(px * px + py * py + pz * pz);
                const factor = BIAS * (len + elevDisp * elevScale) / len;
                vx[i] = px * factor;
                vy[i] = py * factor;
                vz[i] = pz * factor;
            }

            for (let i = 0; i < nVertSub; i++) {
                const i2 = (i + 1) % nVertSub;
                if (vf[i] < 0 || vf[i2] < 0 || vf[i] !== vf[i2]) continue;
                const skipOcean = this._landOnly && ve[i] <= 0 && ve[i2] <= 0;
                if (skipOcean) continue;
                const fIdx = vf[i];
                const pos = facePos[fIdx];
                const col = faceCol[fIdx];
                pos.push(vx[i], vy[i], vz[i], vx[i2], vy[i2], vz[i2]);
                const c1 = colorForElev(ve[i]);
                const c2 = colorForElev(ve[i2]);
                col.push(c1[0], c1[1], c1[2], c2[0], c2[1], c2[2]);
            }
        }

        return { facePos, faceCol };
    }

    _updateAnimation() {
        const t = this.t;
        const n = this.faces.length;
        const { root, parent, order, depth, maxDepth } = this._spanningTree;
        const numHinges = Math.max(1, order.length - 1);
        const D = Math.max(1, maxDepth);

        const worldMats = new Array(n);
        worldMats[root] = new THREE.Matrix4().identity();
        if (this.faceGroups[root]) {
            this.faceGroups[root].matrix.identity();
            this.faceGroups[root].matrixWorldNeedsUpdate = true;
        }

        const pivotWorld = new THREE.Vector3();
        const axisWorld = new THREE.Vector3();
        const tmpQuat = new THREE.Quaternion();
        const T1 = new THREE.Matrix4();
        const T2 = new THREE.Matrix4();
        const R = new THREE.Matrix4();
        const localR = new THREE.Matrix4();

        for (let k = 0; k < order.length; k++) {
            const f = order[k];
            if (f === root) continue;
            const pW = worldMats[parent[f]];
            pivotWorld.copy(this._hingePivot[f]).applyMatrix4(pW);
            axisWorld.copy(this._hingeAxis[f]).transformDirection(pW);

            // Per-hinge local fraction:
            //   simultaneous : every hinge uses global t directly.
            //   sequential   : hinges 1..N share global t in BFS order, one
            //                  at a time (each gets a 1/N slice).
            //   wave         : hinges at the same BFS depth fire together;
            //                  the polyhedron unfolds in D concentric rings
            //                  outward from the root, each ring animating
            //                  during global t ∈ [(d-1)/D, d/D].
            let localT;
            if (this._foldMode === 'sequential') {
                const hingeIdx = k - 1;
                localT = Math.max(0, Math.min(1, t * numHinges - hingeIdx));
            } else if (this._foldMode === 'wave') {
                const d = depth[f];     // >= 1 for non-root
                localT = Math.max(0, Math.min(1, t * D - (d - 1)));
            } else {
                localT = t;
            }
            const eased = this._ease(localT);
            const angle = eased * this._foldAngle[f];

            T1.makeTranslation(pivotWorld.x, pivotWorld.y, pivotWorld.z);
            T2.makeTranslation(-pivotWorld.x, -pivotWorld.y, -pivotWorld.z);
            tmpQuat.setFromAxisAngle(axisWorld, angle);
            R.makeRotationFromQuaternion(tmpQuat);
            localR.multiplyMatrices(T1, R).multiply(T2);

            const fW = new THREE.Matrix4().multiplyMatrices(localR, pW);
            worldMats[f] = fW;
            if (this.faceGroups[f]) {
                this.faceGroups[f].matrix.copy(fW);
                this.faceGroups[f].matrixWorldNeedsUpdate = true;
            }
        }

        this._applyFit();
        // Update the dashed bridge lines that visualise where cut edges
        // would have met before the unfold separated them.
        this._updateCutEdgeLines();
    }

    // Re-center / re-scale / re-orient the unfolded shape so it stays within
    // the original polyhedron's bounds AND ends up face-on to the camera at
    // t=1. Composition (Three.js applies T·R·S to local point P → world):
    //   1. R  — slerp(identity, rotation_aligning_root_normal_with_camera, t).
    //           At t=0 no extra rotation; at t=1 the root face's outward
    //           normal points at the camera, so the flat net is seen
    //           top-down. The target direction is converted to this.group's
    //           local frame so latitude tilt is respected.
    //   2. S  — uniform scale chosen so the largest local half-extent of the
    //           current (rotated-by-faceGroup-matrices) bbox maps to the
    //           original polyhedron R. Capped at 1 so the folded state is
    //           untouched.
    //   3. T  — set to -S·R·(bbox-center) so the bbox center lands at the
    //           world origin regardless of where the unfolding spread it.
    // When _fitMode is off, every part resets to identity.
    _applyFit() {
        if (!this._fitMode) {
            this._faceParent.scale.set(1, 1, 1);
            this._faceParent.position.set(0, 0, 0);
            this._faceParent.quaternion.identity();
            this._faceParent.updateMatrix();
            this._fitScale = 1;
            return;
        }
        // Local-frame bbox (pre-rotation, pre-scale).
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        const tmp = new THREE.Vector3();
        for (let f = 0; f < this.faces.length; f++) {
            const fg = this.faceGroups[f];
            if (!fg) continue;
            const verts = this.faces[f].vertices3D;
            for (let i = 0; i < verts.length; i++) {
                tmp.copy(verts[i]).applyMatrix4(fg.matrix);
                if (tmp.x < minX) minX = tmp.x;
                if (tmp.y < minY) minY = tmp.y;
                if (tmp.z < minZ) minZ = tmp.z;
                if (tmp.x > maxX) maxX = tmp.x;
                if (tmp.y > maxY) maxY = tmp.y;
                if (tmp.z > maxZ) maxZ = tmp.z;
            }
        }
        if (!isFinite(minX)) return;

        // Slerp _faceParent from identity at t=0 to a CAPTURED target
        // quaternion at t=1. The target is captured (via
        // _captureFaceParentTarget) when the user starts an animation
        // (play()), tunes the twist (setFinalTwistRad), changes the root,
        // changes strategy, or first builds the polyhedron — and is *not*
        // recomputed every frame. That way:
        //   - During animation the slerp gives a smooth path from the
        //     drag-rotated natural state (t=0 → group * I = group) to the
        //     camera-locked target (t=1 → group_at_capture * target = the
        //     qWorldTarget that was captured).
        //   - At rest after animation, _applyFit no longer runs each
        //     frame, so this.group changes from a drag flow straight into
        //     world = group * faceParent — the polyhedron actually
        //     rotates instead of being clamped back to qWorldTarget.
        //   - Arrow-key tuning refreshes the captured target so the user
        //     can still snap to a known angle.
        if (!this._faceParentTargetAtT1) {
            this._captureFaceParentTarget();
        }
        const easedT = this._ease(this.t);
        const qFaceParent = (this._faceParentTargetAtT1)
            ? new THREE.Quaternion().slerp(this._faceParentTargetAtT1, easedT)
            : new THREE.Quaternion();
        this._faceParent.quaternion.copy(qFaceParent);
        const qFinal = qFaceParent;

        // Uniform scale to fit the local bbox within the polyhedron R.
        const halfMax = Math.max((maxX - minX) * 0.5, (maxY - minY) * 0.5, (maxZ - minZ) * 0.5);
        const targetHalf = this.polyhedron.R;
        const sFit = (halfMax > 1e-6) ? Math.min(1, targetHalf / halfMax) : 1;
        this._fitScale = sFit;
        const s = sFit * (this._presentationScale || 1);   // extra map-only size factor
        this._faceParent.scale.set(s, s, s);

        // Translate so the (scaled+rotated) bbox center sits at the origin.
        // world_center = T + R(S·c)  ⇒  T = -R(S·c).
        const center = new THREE.Vector3(
            (minX + maxX) * 0.5,
            (minY + maxY) * 0.5,
            (minZ + maxZ) * 0.5,
        );
        center.multiplyScalar(s).applyQuaternion(qFinal);
        this._faceParent.position.copy(center).negate();
        this._faceParent.updateMatrix();

        // Backing plane lives inside _faceParent, so it inherits the
        // rotation/scale/centring. Refresh its bbox-fit + fade each tick.
        this._updateBackingPlane();
    }

    setFitMode(v) {
        const next = !!v;
        if (next === this._fitMode) return;
        this._fitMode = next;
        this._applyFit();
    }

    // Extra uniform scale on the map (faceParent only — the star sphere and
    // backdrop are siblings, so they're unaffected). Lets the presentation size
    // the folded globe / unfolded net per state without a global camera zoom.
    setPresentationScale(s) {
        const v = (s > 0) ? s : 1;
        if (this._presentationScale === v) return;
        this._presentationScale = v;
        this._applyFit();
    }

    // Show/hide the dashed cut-edge "bridges" that span each cut as the net
    // separates (the hanging chains). Off → none drawn. Default on, so the
    // main app is unaffected.
    setCutEdgesVisible(v) {
        this._cutEdgesEnabled = !!v;
        if (!this._cutEdgesEnabled && this._cutEdgeLines) this._cutEdgeLines.visible = false;
    }
    getFitMode() { return this._fitMode; }
    getFitScale() { return this._fitScale || 1; }

    // Runtime tuning hook for the final in-plane twist applied at t = 1.
    // The override is keyed by the current `${type}:${strategy}` so each
    // shape/strategy combo can be dialled in independently. Used by the
    // arrow-key adjustment in main.js.
    getFinalTwistRad() {
        return _getFinalTwistRad(
            this.polyhedron && this.polyhedron.type,
            this._strategy,
        );
    }
    setFinalTwistRad(rad) {
        _setFinalTwistRad(
            this.polyhedron && this.polyhedron.type,
            this._strategy,
            rad,
        );
        // Recapture the faceParent target so the new twist actually changes
        // the visible orientation. _applyFit will then snap toward it.
        this._captureFaceParentTarget();
        this._applyFit();
    }

    computeFinalPoleAxisTwistRad(extraTwistRad = 0) {
        const finalMats = this._computeFinalFaceMatrices();
        if (!finalMats) return null;

        const south = this._projectDirectionToFinalNetPoint(
            new THREE.Vector3(0, -1, 0),
            finalMats,
        );
        const north = this._projectDirectionToFinalNetPoint(
            new THREE.Vector3(0, 1, 0),
            finalMats,
        );
        if (!south || !north) return null;

        const axisLocal = new THREE.Vector3().subVectors(north, south);
        if (axisLocal.lengthSq() < 1e-10) return null;

        const qNoTwist = this._computeWorldTargetForTwist(0);
        if (!qNoTwist) return null;

        const worldForward = this._cameraDir.clone().normalize();
        let worldUpHint = new THREE.Vector3(0, 1, 0);
        if (Math.abs(worldForward.dot(worldUpHint)) > 0.95) worldUpHint.set(0, 0, 1);
        const worldRight = new THREE.Vector3().crossVectors(worldUpHint, worldForward).normalize();
        const worldUp = new THREE.Vector3().crossVectors(worldForward, worldRight).normalize();

        const axisWorld = axisLocal.applyQuaternion(qNoTwist);
        axisWorld.addScaledVector(worldForward, -axisWorld.dot(worldForward));
        if (axisWorld.lengthSq() < 1e-10) return null;
        axisWorld.normalize();

        const theta = Math.atan2(axisWorld.dot(worldUp), axisWorld.dot(worldRight));
        const extraTwist = Number.isFinite(extraTwistRad) ? extraTwistRad : 0;
        const twist = Math.PI / 2 - theta + extraTwist;
        return Math.atan2(Math.sin(twist), Math.cos(twist));
    }

    setFinalPoleAxisVertical(extraTwistRad = 0) {
        const twist = this.computeFinalPoleAxisTwistRad(extraTwistRad);
        if (Number.isFinite(twist)) {
            this.setFinalTwistRad(twist);
            return twist;
        }
        this.captureFaceParentTarget();
        return null;
    }

    captureFaceParentTarget() {
        this._captureFaceParentTarget();
        this._applyFit();
    }

    _computeFinalFaceMatrices() {
        if (!this._spanningTree || !this._hingePivot || !this._hingeAxis || !this._foldAngle) {
            return null;
        }
        const n = this.faces.length;
        const { root, parent, order } = this._spanningTree;
        const worldMats = new Array(n);
        worldMats[root] = new THREE.Matrix4().identity();

        const pivotWorld = new THREE.Vector3();
        const axisWorld = new THREE.Vector3();
        const tmpQuat = new THREE.Quaternion();
        const T1 = new THREE.Matrix4();
        const T2 = new THREE.Matrix4();
        const R = new THREE.Matrix4();
        const localR = new THREE.Matrix4();

        for (let k = 0; k < order.length; k++) {
            const f = order[k];
            if (f === root) continue;
            const pW = worldMats[parent[f]];
            if (!pW) continue;

            pivotWorld.copy(this._hingePivot[f]).applyMatrix4(pW);
            axisWorld.copy(this._hingeAxis[f]).transformDirection(pW);

            T1.makeTranslation(pivotWorld.x, pivotWorld.y, pivotWorld.z);
            T2.makeTranslation(-pivotWorld.x, -pivotWorld.y, -pivotWorld.z);
            tmpQuat.setFromAxisAngle(axisWorld, this._foldAngle[f] || 0);
            R.makeRotationFromQuaternion(tmpQuat);
            localR.multiplyMatrices(T1, R).multiply(T2);

            worldMats[f] = new THREE.Matrix4().multiplyMatrices(localR, pW);
        }

        return worldMats;
    }

    _projectDirectionToFinalNetPoint(unitDir, finalMats) {
        if (!unitDir || !finalMats) return null;
        const dir = unitDir.clone().normalize();
        const hit = projectDirToFace(dir, this.faces, this.polyhedron && this.polyhedron.inradius);
        if (!hit || !hit.face || !hit.point3D) return null;

        let faceIdx = hit.face.idx;
        if (typeof faceIdx !== 'number' || !finalMats[faceIdx]) {
            faceIdx = this.faces.indexOf(hit.face);
        }
        const mat = finalMats[faceIdx];
        if (!mat) return null;

        return hit.point3D.clone().applyMatrix4(mat);
    }

    // Compute the world-frame target orientation at t=1: rootNormal lines up
    // with the camera direction, the polyhedron's local up projects onto
    // world-up in the camera-perpendicular plane, and the final twist rotates
    // inside that plane. Independent of this.group.quaternion.
    _computeWorldTarget() {
        const polyType = this.polyhedron && this.polyhedron.type;
        return this._computeWorldTargetForTwist(_getFinalTwistRad(polyType, this._strategy));
    }

    _computeWorldTargetForTwist(twistRad = 0) {
        if (!this.faces || !this.faces.length) return null;
        const rootIdx = this.getRoot();
        const face = this.faces[rootIdx];
        if (!face || !face.normal) return null;
        const rootNormal = face.normal;

        const worldForward = this._cameraDir.clone().normalize();
        let worldUpHint = new THREE.Vector3(0, 1, 0);
        if (Math.abs(worldForward.dot(worldUpHint)) > 0.95) worldUpHint.set(0, 0, 1);
        let worldRight = new THREE.Vector3().crossVectors(worldUpHint, worldForward).normalize();
        let worldUp = new THREE.Vector3().crossVectors(worldForward, worldRight).normalize();

        const twist = Number.isFinite(twistRad) ? twistRad : 0;
        if (twist !== 0) {
            const c = Math.cos(twist), s = Math.sin(twist);
            const newR = worldRight.clone().multiplyScalar(c).addScaledVector(worldUp,  s);
            const newU = worldUp.clone()   .multiplyScalar(c).addScaledVector(worldRight, -s);
            worldRight = newR;
            worldUp = newU;
        }

        let localUpHint = new THREE.Vector3(0, 1, 0);
        if (Math.abs(rootNormal.dot(localUpHint)) > 0.95) localUpHint.set(0, 0, 1);
        const localRight = new THREE.Vector3().crossVectors(localUpHint, rootNormal).normalize();
        const localUp    = new THREE.Vector3().crossVectors(rootNormal,  localRight).normalize();

        const matWorld = new THREE.Matrix4().makeBasis(worldRight, worldUp, worldForward);
        const matLocalT = new THREE.Matrix4().makeBasis(localRight, localUp, rootNormal.clone()).transpose();
        return new THREE.Quaternion().setFromRotationMatrix(matWorld.multiply(matLocalT));
    }

    // Capture (group^-1 * qWorldTarget) for the current state. This is the
    // faceParent quaternion that, applied at t=1, makes world rotation equal
    // qWorldTarget. By NOT recomputing it every frame, drag at rest after
    // animation gets to rotate world = group * faceParent freely.
    _captureFaceParentTarget() {
        const qWorldTarget = this._computeWorldTarget();
        if (!qWorldTarget) {
            this._faceParentTargetAtT1 = null;
            return;
        }
        this._faceParentTargetAtT1 = this.group.quaternion
            .clone().conjugate().multiply(qWorldTarget);
    }

    setBackingVisible(v) {
        this._backingEnabled = !!v;
        this._updateBackingPlane();
    }
    getBackingVisible() { return this._backingEnabled; }

    // Bridge-fade toggle: when true, the dashed cut-edge bridges fade out
    // once the polyhedron reaches fully-unfolded (t≈1, at rest); when
    // false they stay at full opacity. Default true. _updateCutEdgeLines
    // reads this each frame, so flipping it takes effect immediately.
    setBridgeFadeEnabled(v) { this._bridgeFadeEnabled = !!v; }
    getBridgeFadeEnabled() { return this._bridgeFadeEnabled !== false; }

    // SVG export for pen-plotter printing. Emits the CURRENTLY-VISIBLE 2D
    // projection as stroke-only Inkscape layers (vpype/AxiCLI conventions):
    //
    //   "outlines"          — black, 0.4mm  — per-face polyhedron boundary
    //
    // Contour layers depend on the mode flags:
    //   default               — one layer per elevation band:
    //     "contours-sea"      — navy,  0.3mm  — ocean (only when not land-only)
    //     "contours-lowland"  — green, 0.3mm  — 0–1250m
    //     "contours-mid"      — olive, 0.3mm  — 1250–2500m
    //     "contours-high"     — rust,  0.3mm  — 2500–3750m
    //     "contours-peak"     — gold,  0.3mm  — 3750m+
    //   simpleColors          — one layer total:
    //     "contours"          — sepia, 0.3mm  — every contour run
    //   seaLandSplit          — two layers:
    //     "contours-sea"      — navy,  0.3mm  — below sea level
    //     "contours-land"     — sepia, 0.3mm  — everything above sea level
    //   "stars-blue"        — filled #3a78ff   — cool stars (B-V < 0)
    //   "stars-white"       — filled #f5f5f5   — sun-like (B-V ≈ 0–0.8)
    //   "stars-red"         — filled #ff5a3a   — warm stars (B-V > 0.8)
    //   Each star is a symmetric filled astroid sized from _starSizes,
    //   with a per-bucket radius multiplier (white = 1.7×, blue/red =
    //   1×) so the dominant sun-likes read larger on plot.
    //
    // Contour band is decided from the per-vertex colour the GL render
    // already paints (colorForElev): R channel monotonic with elevation
    // for land (140@0m → 200@2500m → 250@5000m), so a few R thresholds
    // recover the band. Polylines are stitched so each contour line is
    // one stroke per band rather than thousands of 1-segment fragments.
    // Empty bands are omitted so vpype's --layer split sees only the
    // bands actually present in the current view.
    //
    // Hidden-line removal: for every 3D segment, sample SAMPLES_PER_SEG
    // points along its world-space path and raycast each from the camera
    // against the textured face meshes (_faceMeshTex). A sample is
    // "visible" iff the first hit's distance is within ε of the sample's
    // distance from the camera (or there's no hit at all). Runs of
    // consecutive visible samples become one <polyline>; runs broken by
    // occlusion split into multiple polylines.
    //
    // Coordinates are output in MILLIMETRES (viewBox + width/height all
    // in mm). The viewport is scaled so the longer canvas dimension maps
    // to 200 mm; stroke widths are absolute mm, so they survive any
    // later rescale done in vpype / Inkscape / the plotter's slicer.
    //
    // Returns: SVG string. Throws Error if no camera has been registered
    // via setCameraPos() yet (Mode I must have been rendered at least
    // once for the export to know where the viewpoint is).
    exportSvg({ viewportWidth, viewportHeight, sampleCount = 12, pageMaxMm = 200, simpleColors = false, seaLandSplit = false } = {}) {
        if (!this._camera) throw new Error('exportSvg: no camera registered (call setCameraPos first)');
        if (!viewportWidth || !viewportHeight) {
            throw new Error('exportSvg: viewportWidth and viewportHeight are required');
        }
        const camera = this._camera;
        camera.updateMatrixWorld(true);

        // Raycast targets: the per-face textured meshes. These ARE the
        // visible polyhedron from the camera's POV, so hits against them
        // are the source of truth for what occludes what.
        const targets = [];
        for (let f = 0; f < this.faces.length; f++) {
            const m = this._faceMeshTex && this._faceMeshTex[f];
            if (m && m.visible !== false) {
                m.updateMatrixWorld(true);
                targets.push(m);
            }
        }
        const raycaster = new THREE.Raycaster();
        // Keep occlusion-test scratch outside hot loops.
        const _tmpDir   = new THREE.Vector3();
        const _tmpWorld = new THREE.Vector3();
        const OCCLUSION_EPS = 0.25;  // world units of slack — same scale as polyhedron R

        // mm-per-px so the longer side of the canvas fits in pageMaxMm.
        const mmPerPx = pageMaxMm / Math.max(viewportWidth, viewportHeight);
        const wMm = viewportWidth  * mmPerPx;
        const hMm = viewportHeight * mmPerPx;

        // Project a world-space point → mm coords (with .inside flag for
        // frustum culling and the .dist used by the occlusion test).
        const _projTmp = new THREE.Vector3();
        const projectMm = (worldVec3) => {
            _projTmp.copy(worldVec3).project(camera);
            const insideX = _projTmp.x >= -1 && _projTmp.x <= 1;
            const insideY = _projTmp.y >= -1 && _projTmp.y <= 1;
            const insideZ = _projTmp.z >= -1 && _projTmp.z <= 1;
            return {
                x: (_projTmp.x * 0.5 + 0.5) * wMm,
                // SVG y grows downward; flip ndc.y.
                y: (1 - (_projTmp.y * 0.5 + 0.5)) * hMm,
                z: _projTmp.z,
                inside: insideX && insideY && insideZ,
            };
        };

        const isVisible = (worldVec3) => {
            _tmpDir.subVectors(worldVec3, this._cameraPos);
            const targetDist = _tmpDir.length();
            if (targetDist < 1e-6) return true;
            _tmpDir.divideScalar(targetDist);  // normalize in place
            raycaster.set(this._cameraPos, _tmpDir);
            raycaster.far = targetDist + OCCLUSION_EPS + 1;
            const hits = raycaster.intersectObjects(targets, false);
            if (hits.length === 0) return true;
            return hits[0].distance >= targetDist - OCCLUSION_EPS;
        };

        // Star-specific visibility. Stars sit on a camera-pinned sphere
        // only ~R units in front of the camera — geometrically MUCH
        // closer than the polyhedron (which is ~280u out). The GL
        // render fakes "at infinity" by forcing gl_Position.z = w +
        // LessEqualDepth, so any polyhedron pixel occludes the star.
        // Reproduce that here: cast in the star's screen direction
        // and treat ANY face hit (at any distance) as an occlusion.
        const isStarVisible = (worldStarPos) => {
            _tmpDir.subVectors(worldStarPos, this._cameraPos);
            const d = _tmpDir.length();
            if (d < 1e-6) return false;
            _tmpDir.divideScalar(d);
            raycaster.set(this._cameraPos, _tmpDir);
            raycaster.far = 1e6;
            return raycaster.intersectObjects(targets, false).length === 0;
        };

        // Walk a 3D world-space segment, sampling sampleCount intervals
        // and pushing one or more visible 2D runs into outRuns. A run is
        // a list of [xMm, yMm] points.
        const processSegment = (worldA, worldB, outRuns) => {
            const samples = [];
            for (let i = 0; i <= sampleCount; i++) {
                const t = i / sampleCount;
                _tmpWorld.copy(worldA).lerp(worldB, t);
                const p = projectMm(_tmpWorld);
                const vis = p.inside && isVisible(_tmpWorld);
                samples.push({ x: p.x, y: p.y, vis });
            }
            let runStart = -1;
            for (let i = 0; i < samples.length; i++) {
                if (samples[i].vis) {
                    if (runStart === -1) runStart = i;
                } else if (runStart !== -1) {
                    if (i - runStart >= 2) {
                        outRuns.push(samples.slice(runStart, i).map(s => [s.x, s.y]));
                    }
                    runStart = -1;
                }
            }
            if (runStart !== -1 && samples.length - runStart >= 2) {
                outRuns.push(samples.slice(runStart).map(s => [s.x, s.y]));
            }
        };

        // 1) Polyhedron face-boundary outlines. Walk each face's polygon
        //    vertices in order; the i→i+1 edges + the closing edge form
        //    the outline. Use faceGroups[f].matrixWorld so the edges
        //    track the unfold.
        const outlineRuns = [];
        const _vWorldA = new THREE.Vector3();
        const _vWorldB = new THREE.Vector3();
        for (let f = 0; f < this.faces.length; f++) {
            const face = this.faces[f];
            const fg = this.faceGroups[f];
            if (!fg) continue;
            fg.updateMatrixWorld(true);
            const verts = face.vertices3D || face.vertices;
            if (!verts || verts.length < 2) continue;
            for (let i = 0; i < verts.length; i++) {
                _vWorldA.copy(verts[i]).applyMatrix4(fg.matrixWorld);
                _vWorldB.copy(verts[(i + 1) % verts.length]).applyMatrix4(fg.matrixWorld);
                processSegment(_vWorldA, _vWorldB, outlineRuns);
            }
        }

        // 2) Elevation contours, classified into elevation bands by
        //    vertex color. _faceContour[f]'s `color` attribute stores
        //    the per-vertex RGB written by colorForElev(elev); the R
        //    channel is monotonic with elevation on land (140@0m ->
        //    200@2500m -> 250@5000m), so we band by R thresholds and
        //    detect ocean as low-R/high-B. Each band emits a separate
        //    Inkscape layer with a distinct stroke colour, ready for a
        //    multi-pen pass. Polylines are first stitched (consecutive
        //    pairs that share an endpoint join into one polyline) so
        //    each band-run is a single stroke rather than thousands of
        //    1-segment fragments — that's what was rendering as blobs.
        const CONTOUR_BANDS = [
            // Order matters: classifyBand walks these top-down and picks
            // the first whose minR is met, so peak must precede high etc.
            // Labels use Unicode ≤ / ≥ so they're safe in XML attributes
            // (raw < / > would need escaping).
            { name: 'sea',     stroke: '#1a3a7a', label: 'sea (≤ 0m)',          rMax: 0.10, isOcean: true },
            { name: 'lowland', stroke: '#2a6a2a', label: 'lowland (0–1250m)',    rMin: 0.0   },
            { name: 'mid',     stroke: '#6e6a26', label: 'mid (1250–2500m)',     rMin: 0.667 },
            { name: 'high',    stroke: '#8a4a1a', label: 'high (2500–3750m)',    rMin: 0.784 },
            { name: 'peak',    stroke: '#c9a032', label: 'peak (≥ 3750m)',       rMin: 0.882 },
        ];
        const classifyBand = (r, g, b) => {
            // Ocean = the deep-navy (10,20,55)/255 from colorForElev's m<=0 branch.
            if (r < 0.10 && b > 0.15) return 'sea';
            // Land: pick the highest-rMin band whose threshold the R clears.
            let pick = 'lowland';
            for (const d of CONTOUR_BANDS) {
                if (d.isOcean) continue;
                if (r >= d.rMin) pick = d.name;
            }
            return pick;
        };
        const contourRunsByBand = {};
        for (const d of CONTOUR_BANDS) contourRunsByBand[d.name] = [];

        if (this._showElev && this._faceContour) {
            const EQ_TOL = 1e-4;
            const same = (ax, ay, az, bx, by, bz) =>
                Math.abs(ax - bx) < EQ_TOL && Math.abs(ay - by) < EQ_TOL && Math.abs(az - bz) < EQ_TOL;
            const _vW = new THREE.Vector3();
            for (let f = 0; f < this._faceContour.length; f++) {
                const seg = this._faceContour[f];
                if (!seg || seg.visible === false) continue;
                seg.updateMatrixWorld(true);
                const pAttr = seg.geometry && seg.geometry.attributes && seg.geometry.attributes.position;
                const cAttr = seg.geometry && seg.geometry.attributes && seg.geometry.attributes.color;
                if (!pAttr) continue;
                const M = seg.matrixWorld;

                // Pass 1 — stitch ALL pairs into long polylines without
                // checking band membership. Earlier the band check split
                // the polyline at every threshold crossing, so contours
                // hovering near 1250m (or 2500m, etc.) shattered into
                // hundreds of 2-vertex polylines that the plotter then
                // rendered as a field of dots. Track running color sums
                // so we can pick the band once per polyline below.
                const polylines = []; // { pts: [[lx,ly,lz]…], rSum, gSum, bSum, count }
                let current = null;
                for (let i = 0; i + 1 < pAttr.count; i += 2) {
                    const ax = pAttr.getX(i),     ay = pAttr.getY(i),     az = pAttr.getZ(i);
                    const bx = pAttr.getX(i + 1), by = pAttr.getY(i + 1), bz = pAttr.getZ(i + 1);
                    const ar = cAttr ? cAttr.getX(i)     : 0.5;
                    const ag = cAttr ? cAttr.getY(i)     : 0.5;
                    const ab = cAttr ? cAttr.getZ(i)     : 0.5;
                    const br = cAttr ? cAttr.getX(i + 1) : 0.5;
                    const bg = cAttr ? cAttr.getY(i + 1) : 0.5;
                    const bb = cAttr ? cAttr.getZ(i + 1) : 0.5;
                    if (current) {
                        const last = current.pts[current.pts.length - 1];
                        if (same(last[0], last[1], last[2], ax, ay, az)) {
                            current.pts.push([bx, by, bz]);
                            current.rSum += br; current.gSum += bg; current.bSum += bb;
                            current.count += 1;
                            continue;
                        }
                        polylines.push(current);
                    }
                    current = {
                        pts: [[ax, ay, az], [bx, by, bz]],
                        rSum: ar + br, gSum: ag + bg, bSum: ab + bb,
                        count: 2,
                    };
                }
                if (current) polylines.push(current);

                // Pass 2 — classify each whole stitched polyline by the
                // AVERAGE colour of its vertices (stable against threshold
                // chatter), then hidden-line removal at the vertices and
                // emit visible runs into the band's bucket.
                for (const pl of polylines) {
                    const avgR = pl.rSum / pl.count;
                    const avgG = pl.gSum / pl.count;
                    const avgB = pl.bSum / pl.count;
                    const band = classifyBand(avgR, avgG, avgB);
                    const bucket = contourRunsByBand[band] || contourRunsByBand.lowland;
                    const samples = new Array(pl.pts.length);
                    for (let i = 0; i < pl.pts.length; i++) {
                        _vW.set(pl.pts[i][0], pl.pts[i][1], pl.pts[i][2]).applyMatrix4(M);
                        const p = projectMm(_vW);
                        samples[i] = {
                            x: p.x, y: p.y,
                            vis: p.inside && isVisible(_vW),
                        };
                    }
                    let runStart = -1;
                    for (let i = 0; i < samples.length; i++) {
                        if (samples[i].vis) {
                            if (runStart === -1) runStart = i;
                        } else if (runStart !== -1) {
                            if (i - runStart >= 2) {
                                bucket.push(samples.slice(runStart, i).map(s => [s.x, s.y]));
                            }
                            runStart = -1;
                        }
                    }
                    if (runStart !== -1 && samples.length - runStart >= 2) {
                        bucket.push(samples.slice(runStart).map(s => [s.x, s.y]));
                    }
                }
            }
        }
        const contourTotal = CONTOUR_BANDS.reduce(
            (s, d) => s + contourRunsByBand[d.name].length, 0);

        // 3) Stars. Compute the polyhedron's screen-space bbox first,
        //    then for each star within (bbox + 8% margin) test if its
        //    screen pixel is occluded by a face. Occluded stars sit
        //    "behind" the polyhedron silhouette and are skipped — what's
        //    left is the surrounding star field around the unfold.
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        const _bbW = new THREE.Vector3();
        for (let f = 0; f < this.faces.length; f++) {
            const face = this.faces[f];
            const fg = this.faceGroups[f];
            if (!fg) continue;
            const verts = face.vertices3D || face.vertices;
            if (!verts) continue;
            for (let i = 0; i < verts.length; i++) {
                _bbW.copy(verts[i]).applyMatrix4(fg.matrixWorld);
                const p = projectMm(_bbW);
                if (p.inside) {
                    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
                    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
                }
            }
        }
        const margin = Math.min(wMm, hMm) * 0.08;
        minX -= margin; maxX += margin; minY -= margin; maxY += margin;

        // The catalogued count tells us how many star slots are LIVE
        // (capacity may be larger). Falls back to position-array length
        // if the geometry's drawRange isn't pinned.
        const liveStarCount = (this._starGeom && this._starGeom.attributes && this._starGeom.attributes.position)
            ? Math.min(this._starGeom.drawRange.count, this._starGeom.attributes.position.count)
            : Math.floor((this._starPositions ? this._starPositions.length : 0) / 3);

        // Three-bucket spectral classifier — uses the per-vertex RGB the
        // GL render computed from each star's B-V index. The hue ramp
        // SPECTRAL_TABLE goes blue (B-V<0) → white (B-V≈0.5) → orange/red
        // (B-V>1.4), so comparing R vs B picks the dominant side. Each
        // bucket also gets a radius multiplier so the white (sun-like)
        // stars print larger and read as the dominant tier on plot.
        const BUCKET_RADIUS_MULT = { blue: 1.0, white: 1.7, red: 1.0 };
        const bucketOf = (r, g, b) => {
            if (b > r + 0.05) return 'blue';
            if (r > b + 0.05) return 'red';
            return 'white';
        };

        const starItems = [];
        if (this._starPositions && this.starOverlay && liveStarCount > 0) {
            this.starOverlay.updateMatrixWorld(true);
            const sp = this._starPositions;
            const sz = this._starSizes;
            const cz = this._starColors;
            const _sw = new THREE.Vector3();
            for (let i = 0; i < liveStarCount; i++) {
                const offs = i * 3;
                _sw.set(sp[offs], sp[offs + 1], sp[offs + 2]).applyMatrix4(this.starOverlay.matrixWorld);
                const p = projectMm(_sw);
                if (!p.inside) continue;
                if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) continue;
                // Star-specific: behind any face = hidden (stars are
                // visually pinned to the far plane by the GL shader, so
                // any polyhedron pixel covering the same screen position
                // hides the star regardless of geometric depth).
                if (!isStarVisible(_sw)) continue;
                // Per-star size, conservative mm scale, clamped. White
                // bucket gets boosted via BUCKET_RADIUS_MULT below.
                const rawSize = sz ? sz[i] : 0.7;
                const cr = cz ? cz[offs]     : 1;
                const cg = cz ? cz[offs + 1] : 1;
                const cb = cz ? cz[offs + 2] : 1;
                const bucket = bucketOf(cr, cg, cb);
                const rMm = Math.max(0.25, Math.min(2.4, rawSize * 1.2)) * BUCKET_RADIUS_MULT[bucket];
                starItems.push({ cx: p.x, cy: p.y, r: rMm, bucket });
            }
        }

        // -- Build the SVG document. mm everywhere; strokes only. --
        const fmt = (n) => Number.isFinite(n) ? n.toFixed(3) : '0';
        const xmlAttr = (s) => String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
        const polyline = (run) =>
            `<polyline points="${run.map(p => `${fmt(p[0])},${fmt(p[1])}`).join(' ')}"/>`;

        const out = [];
        out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
        out.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" `
               + `width="${fmt(wMm)}mm" height="${fmt(hMm)}mm" viewBox="0 0 ${fmt(wMm)} ${fmt(hMm)}">`);
        out.push(`<desc>Polyhedral fold pen-plot export — ${this.faces.length} faces, `
               + `${outlineRuns.length} outline runs, ${contourTotal} contour runs across `
               + `${CONTOUR_BANDS.filter(d => contourRunsByBand[d.name].length).length} elevation bands, `
               + `${starItems.length} stars.</desc>`);

        // Contours emission. Three exclusive modes:
        //   seaLandSplit  — only TWO layers: contours-sea (navy, depths)
        //                   + contours-land (sepia, everything above sea
        //                   level merged). Useful with "show all" on,
        //                   where the user wants ocean depths visually
        //                   separated from continental contours but
        //                   without spending pens on five land bands.
        //   simpleColors  — every contour run in one sepia layer.
        //   default       — one layer per elevation band (sea + 4 land
        //                   tiers), each with a distinct stroke colour.
        // Empty layers are dropped so vpype's --layer split sees only
        // the layers actually present in this view.
        const emitContourLayer = (label, runs, stroke) => {
            const usable = runs.filter(r => r.length >= 2);
            if (usable.length === 0) return;
            out.push(`<g inkscape:groupmode="layer" inkscape:label="${xmlAttr(label)}" stroke="${stroke}" stroke-width="0.3" fill="none" stroke-linecap="round" stroke-linejoin="round">`);
            for (const r of usable) out.push('  ' + polyline(r));
            out.push(`</g>`);
        };
        if (seaLandSplit) {
            const seaRuns = contourRunsByBand.sea || [];
            const landRuns = [];
            for (const d of CONTOUR_BANDS) {
                if (d.isOcean) continue;
                const r = contourRunsByBand[d.name];
                if (r) landRuns.push(...r);
            }
            emitContourLayer('contours-sea',  seaRuns,  '#1a3a7a');  // navy
            emitContourLayer('contours-land', landRuns, '#5a4521');  // sepia
        } else if (simpleColors) {
            const allRuns = [];
            for (const d of CONTOUR_BANDS) {
                const runs = contourRunsByBand[d.name];
                if (runs) allRuns.push(...runs);
            }
            emitContourLayer('contours', allRuns, '#5a4521');
        } else {
            for (const d of CONTOUR_BANDS) {
                const runs = contourRunsByBand[d.name];
                if (!runs || runs.length === 0) continue;
                out.push(`<g inkscape:groupmode="layer" inkscape:label="contours-${xmlAttr(d.name)}" data-band="${xmlAttr(d.label)}" stroke="${d.stroke}" stroke-width="0.3" fill="none" stroke-linecap="round" stroke-linejoin="round">`);
                for (const r of runs) if (r.length >= 2) out.push('  ' + polyline(r));
                out.push(`</g>`);
            }
        }

        out.push(`<g inkscape:groupmode="layer" inkscape:label="outlines" stroke="#000000" stroke-width="0.4" fill="none" stroke-linecap="round" stroke-linejoin="round">`);
        for (const r of outlineRuns) if (r.length >= 2) out.push('  ' + polyline(r));
        out.push(`</g>`);

        // Each star is a symmetric 4-cusped astroid: x = r cos^3 t,
        // y = r sin^3 t — sharp cusps on ±x/±y axes, concave sides
        // between. 24 samples gives a clean curve at all sizes we emit.
        // Filled <polygon> (closes automatically) with a thin
        // matching-darker outline so the cusp edges stay crisp on plot.
        const ASTROID_SAMPLES = 24;
        const _astCos = new Array(ASTROID_SAMPLES + 1);
        const _astSin = new Array(ASTROID_SAMPLES + 1);
        for (let i = 0; i <= ASTROID_SAMPLES; i++) {
            const t = (i / ASTROID_SAMPLES) * Math.PI * 2;
            const c = Math.cos(t), s = Math.sin(t);
            _astCos[i] = c * c * c;
            _astSin[i] = s * s * s;
        }
        const STAR_BUCKETS = [
            { name: 'blue',  fill: '#3a78ff', stroke: '#1a3a8a' },
            { name: 'white', fill: '#f5f5f5', stroke: '#999999' },
            { name: 'red',   fill: '#ff5a3a', stroke: '#a02a1a' },
        ];
        // OUTLINE-ONLY astroids. Earlier revisions used <polygon fill="…">,
        // but pen-plot pre-processors (vpype, AxiDraw driver, etc.) can't
        // physically fill — they fall back to a stippling / hatching
        // algorithm, which is what was rasterising every star as a
        // patch of dots on the plotter. Stroke-only polygons with
        // fill="none" plot as smooth astroid curves. Stroke uses the
        // bucket's bright colour at 0.3mm so the visual identity of
        // each star type is preserved without the fill.
        const emitStars = (items, layerLabel, color) => {
            if (items.length === 0) return;
            out.push(`<g inkscape:groupmode="layer" inkscape:label="${xmlAttr(layerLabel)}" fill="none" stroke="${color}" stroke-width="0.3" stroke-linejoin="round" stroke-linecap="round">`);
            for (const s of items) {
                const pts = new Array(ASTROID_SAMPLES + 1);
                for (let i = 0; i <= ASTROID_SAMPLES; i++) {
                    pts[i] = `${fmt(s.cx + s.r * _astCos[i])},${fmt(s.cy + s.r * _astSin[i])}`;
                }
                out.push(`  <polygon points="${pts.join(' ')}"/>`);
            }
            out.push(`</g>`);
        };
        if (simpleColors) {
            // Single gold layer for every star regardless of spectral
            // bucket. Three-pen plot pair to the sepia contours + black
            // outlines.
            emitStars(starItems, 'stars', '#c9a032');
        } else {
            for (const b of STAR_BUCKETS) {
                const items = starItems.filter(s => s.bucket === b.name);
                emitStars(items, `stars-${b.name}`, b.fill);
            }
        }

        out.push(`</svg>`);
        return out.join('\n');
    }

    // Pick the texture style for the backing tile. Accepted slugs match the
    // face-appearance pipeline: parchmentClouds / parchmentCloudsLight for
    // baked palettes, cartographer / cottonRag / whiteWash / shaderPaper for
    // the PNG-loaded variants (which need the corresponding parchment image
    // to have been pushed in via setParchmentImage).
    setBackingTileStyle(slug) {
        const VALID = new Set([
            'parchmentClouds', 'parchmentCloudsLight',
            'cartographer', 'cottonRag', 'whiteWash', 'shaderPaper',
        ]);
        if (!VALID.has(slug)) return;
        if (slug === this._backingStyle && this.backingTexture) return;
        this._backingStyle = slug;
        // Drop the current texture so _refreshBackingTexture rebakes on
        // next backing-visible frame. If the backing is already visible,
        // refresh now so the user sees the swap immediately.
        if (this.backingTexture) {
            this.backingTexture.dispose();
            this.backingTexture = null;
            this.backingMaterial.map = null;
        }
        if (this._backingEnabled && this.t >= 1.0) {
            this._refreshBackingTexture();
        }
    }
    getBackingTileStyle() { return this._backingStyle; }

    // Build / fetch the canvas to use for the current _backingStyle. For
    // the baked styles (parchmentClouds / Light) this hits the module-level
    // canvas cache. For PNG styles it converts the per-instance ImageData
    // into a canvas, cached per-instance.
    _getBackingCanvasForCurrentStyle() {
        const slug = this._backingStyle;
        if (slug === 'parchmentClouds' || slug === 'parchmentCloudsLight') {
            return _getModeIBackingCanvasBaked(slug);
        }
        if (this._backingPngCanvasCache.has(slug)) {
            return this._backingPngCanvasCache.get(slug);
        }
        const imgData = this._parchmentImageData && this._parchmentImageData.get(slug);
        if (!imgData) return null;
        const c = document.createElement('canvas');
        c.width = imgData.width;
        c.height = imgData.height;
        c.getContext('2d').putImageData(imgData, 0, 0);
        this._backingPngCanvasCache.set(slug, c);
        return c;
    }

    // Re-render the backing's canvas texture from the chosen tile style.
    _refreshBackingTexture() {
        const canvas = this._getBackingCanvasForCurrentStyle();
        if (!canvas) return;          // PNG not loaded yet — try again later
        if (this.backingTexture) this.backingTexture.dispose();
        const tex = new THREE.Texture(canvas);
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.needsUpdate = true;
        this.backingTexture = tex;
        this.backingMaterial.map = tex;
        // Tint the backing with the same tile-tint the face meshes use, so
        // the cloud parchment underneath the net matches the warm cream
        // currently colouring the tiles.
        if (this._tileTint != null) this.backingMaterial.color.setHex(this._tileTint);
        this.backingMaterial.needsUpdate = true;
    }

    // Position + size the backing plane so it sits flush behind the
    // unfolded net. Re-projects each face's vertices through its faceGroup
    // matrix onto the root face's (basisU, basisV) so the rectangle hugs
    // the actual extent of the net; the depth (along root.normal) is set
    // to the backmost vertex so the backing is genuinely behind every
    // face in the current pose, not just the root.
    _updateBackingPlane() {
        if (!this.backingMesh || !this.faces || !this.faces.length) return;
        // Auto-show: backing only appears once the unfold animation has
        // reached t = 1 AND the user hasn't toggled it off via the
        // "Backing" UI button (setBackingVisible → _backingEnabled).
        const fullyUnfolded = this.t >= 1.0;
        if (!fullyUnfolded || !this._backingEnabled) {
            this.backingMesh.visible = false;
            return;
        }
        // Lazy-bake / pull the texture for the chosen style on first show.
        if (!this.backingTexture) this._refreshBackingTexture();
        if (!this.backingTexture) {
            // Style PNG not loaded yet; leave backing hidden this frame
            // and try again on the next call (e.g. once the image
            // finishes loading and pushes via setParchmentImage).
            this.backingMesh.visible = false;
            return;
        }
        const rootIdx = this.getRoot();
        const root = this.faces[rootIdx];
        if (!root || !root.basisU || !root.basisV || !root.normal) {
            this.backingMesh.visible = false;
            return;
        }
        const bU = root.basisU, bV = root.basisV, bN = root.normal;
        let uMin = Infinity, uMax = -Infinity;
        let vMin = Infinity, vMax = -Infinity;
        let wMin = Infinity;          // backmost extent along root.normal
        const tmp = new THREE.Vector3();
        for (let f = 0; f < this.faces.length; f++) {
            const fg = this.faceGroups[f];
            if (!fg) continue;
            const verts = this.faces[f].vertices3D;
            for (let i = 0; i < verts.length; i++) {
                tmp.copy(verts[i]).applyMatrix4(fg.matrix);
                const u = tmp.dot(bU);
                const v = tmp.dot(bV);
                const w = tmp.dot(bN);
                if (u < uMin) uMin = u;
                if (u > uMax) uMax = u;
                if (v < vMin) vMin = v;
                if (v > vMax) vMax = v;
                if (w < wMin) wMin = w;
            }
        }
        if (!isFinite(uMin)) {
            this.backingMesh.visible = false;
            return;
        }
        // 10% padding on each side -> 1.20 total bbox scale. The user wanted
        // a clear margin around the unfolded net so the backing tile
        // visibly extends past the leaves of the fan.
        const margin = 1.20;
        const w = (uMax - uMin) * margin;
        const h = (vMax - vMin) * margin;
        const uC = (uMin + uMax) * 0.5;
        const vC = (vMin + vMax) * 0.5;
        // Drop the backing a fraction of a face-radius below the deepest
        // face — small but enough to read as a tile-thick slab the
        // unfolded map sits on. Scales with polyhedron size so the gap
        // looks consistent across tetra → icosa → emerald cut, etc.
        const tileThickness = (root.faceCircumradius != null)
            ? root.faceCircumradius * 0.05
            : (this.polyhedron && this.polyhedron.R != null ? this.polyhedron.R * 0.025 : 1);
        const depth = wMin - tileThickness;
        this.backingMesh.position.set(
            uC * bU.x + vC * bV.x + depth * bN.x,
            uC * bU.y + vC * bV.y + depth * bN.y,
            uC * bU.z + vC * bV.z + depth * bN.z,
        );
        // PlaneGeometry +Z normal → root.normal. Plane lies parallel to
        // the unfolded face plane.
        const q = new THREE.Quaternion().setFromUnitVectors(
            new THREE.Vector3(0, 0, 1), bN,
        );
        this.backingMesh.quaternion.copy(q);
        this.backingMesh.scale.set(w, h, 1);
        this.backingMesh.visible = true;
    }

    // Main.js passes the live camera position so the "top-down at t=1"
    // rotation tracks the camera if the user orbits during/after unfold.
    // The full position (not just direction) is also stashed for the
    // camera-following star sphere overlay; if the live Camera object is
    // passed as a second arg, its quaternion is stashed too so the
    // overlay can pin its orientation to the camera's view.
    setCameraPos(pos, camera) {
        if (!pos) return;
        this._cameraDir.copy(pos).normalize();
        this._cameraPos.copy(pos);
        this._cameraPosSet = true;
        if (camera && camera.quaternion) {
            if (!this._cameraQuat) this._cameraQuat = new THREE.Quaternion();
            this._cameraQuat.copy(camera.quaternion);
        }
        // Keep the camera reference around for offline operations like the
        // SVG pen-plot export, which needs full projection + matrices.
        if (camera) this._camera = camera;
    }

    setFoldMode(mode) {
        if (mode !== 'simultaneous' && mode !== 'sequential' && mode !== 'wave') return;
        if (mode === this._foldMode) return;
        this._foldMode = mode;
        this._updateAnimation();
    }
    getFoldMode() { return this._foldMode; }

    // Easing curves applied to each hinge's local fraction in [0, 1] before
    // it becomes a rotation amount. Linear is the identity; the cubic
    // variants are the standard "Quad" curves doubled in dramatic-ness.
    _ease(t) {
        if (t <= 0) return 0;
        if (t >= 1) return 1;
        switch (this._easing) {
            case 'easeIn':    return t * t * t;
            case 'easeOut':   { const u = 1 - t; return 1 - u * u * u; }
            case 'easeInOut': return t < 0.5
                ? 4 * t * t * t
                : 1 - Math.pow(-2 * t + 2, 3) / 2;
            default: return t;
        }
    }

    setEasing(name) {
        const valid = ['linear', 'easeIn', 'easeOut', 'easeInOut'];
        if (!valid.includes(name)) return;
        if (name === this._easing) return;
        this._easing = name;
        this._updateAnimation();
    }
    getEasing() { return this._easing; }

    setT(t) {
        this.t = Math.max(0, Math.min(1, t));
        this._updateAnimation();
    }

    play() {
        // Toggle direction — if currently mostly folded, play unfold; else fold.
        // Do NOT re-capture the faceParent target here. Recapturing would
        // overwrite the existing F with group^-1 * qWorldTarget at this
        // moment, which strips the user's accumulated drag rotation (world
        // would snap from drag*qWorldTarget back to qWorldTarget). Leaving
        // F alone lets the slerp run between the current pose and the
        // already-captured target, preserving any drag the user applied
        // between the previous capture and now.
        this.targetT = this.t > 0.5 ? 0 : 1;
    }

    setVisible(v) {
        const wasVisible = this.group.visible;
        this.group.visible = !!v;
        if (this.starOverlay) this.starOverlay.visible = !!v;
        if (!wasVisible && this.group.visible) {
            // Reset frame timer so the first update step is sane.
            this._lastUpdateMs = null;
            // Lazy: per-face Earth canvases are big (12 × 1024²) — only render
            // them on first show, matching Mode A-2's defer-until-visible.
            if (this._faceMeshesDirty) {
                this._faceMeshesDirty = false;
                this._rebuildFaceCanvases();
            }
            // Same for elevation contours — fetch the binary on first show
            // so a hidden Mode I doesn't trigger a network request.
            if (this._showElev && !this._elevCurves) this._loadElevationData();
        }
    }

    update(starMap) {
        const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        let dt = 0;
        if (this._lastUpdateMs == null) {
            this._lastUpdateMs = now;
        } else {
            dt = Math.min(0.1, (now - this._lastUpdateMs) / 1000);
            this._lastUpdateMs = now;
            if (this.t !== this.targetT) {
                const dir = Math.sign(this.targetT - this.t);
                const step = Math.min(this.speed * dt, Math.abs(this.targetT - this.t));
                this.setT(this.t + dir * step);
            } else {
                // At rest — setT/_updateAnimation are NOT called this frame,
                // so the cut-edge bridge fade would freeze. Tick it here so
                // the dashes can fade out after fully-unfolded settles in.
                this._updateCutEdgeLines();
            }
        }
        this._updateStarOverlay(starMap, dt);
    }

    _updateStarOverlay(starMap, dt) {
        if (!this.starOverlay || !this.starOverlay.visible) return;
        if (!this._getStarProps || !starMap) return;

        // Fill star buffers (same logic as ModeK.update — stylized B-V
        // palette, size from per-star MAG, draw range = visible count).
        let n = 0;
        for (const star of starMap.values()) {
            const props = this._getStarProps(star);
            if (!props || !props.visible) continue;
            if (n >= this._starCapacity) break;
            this._starPositions[n * 3]     = star.XYZ.x;
            this._starPositions[n * 3 + 1] = star.XYZ.y;
            this._starPositions[n * 3 + 2] = star.XYZ.z;
            const rgb = modeKColorFromBV(star.BV);
            this._starColors[n * 3]     = rgb[0] / 255;
            this._starColors[n * 3 + 1] = rgb[1] / 255;
            this._starColors[n * 3 + 2] = rgb[2] / 255;
            this._starSizes[n] = star.size != null ? star.size : 0.7;
            n++;
        }
        this._starGeom.attributes.position.needsUpdate = true;
        this._starGeom.attributes.color.needsUpdate    = true;
        this._starGeom.attributes.aSize.needsUpdate    = true;
        this._starGeom.setDrawRange(0, n);

        if (!this._cameraPosSet || !this._cameraQuat) return;

        // Sphere centre = camera + camera_forward * (R + eps), where
        // camera_forward = camera_quat * (0, 0, -1). Using the quaternion-
        // derived forward (not camera-to-origin) keeps the overlay correct
        // even if the user pans the OrbitControls target away from origin.
        if (!this._forwardVec) this._forwardVec = new THREE.Vector3();
        this._forwardVec.set(0, 0, -1).applyQuaternion(this._cameraQuat);
        this.starOverlay.position.copy(this._cameraPos)
            .addScaledVector(this._forwardVec, this._starOverlayR + this._starOverlayEps);

        // Orientation = world_Y_rotation * camera_quat.
        // - camera_quat half pins the sphere to the camera's orientation
        //   so the constellation pattern stays fixed in the user's view
        //   as they orbit (no apparent motion from camera movement).
        // - world_Y_rotation slowly spins the whole pinned sphere around
        //   the world vertical axis, mimicking "true sky" precession —
        //   the only relative motion the user sees vs the sphere.
        if (this._autoRotationAngle == null) this._autoRotationAngle = 0;
        this._autoRotationAngle -= dt * 0.018;  // ~6 min per full rotation
        if (!this._autoRotationQuat) this._autoRotationQuat = new THREE.Quaternion();
        if (!this._worldYAxis) this._worldYAxis = new THREE.Vector3(0, 1, 0);
        this._autoRotationQuat.setFromAxisAngle(this._worldYAxis, this._autoRotationAngle);
        this.starOverlay.quaternion.multiplyQuaternions(this._autoRotationQuat, this._cameraQuat);
    }
}

// =====================================================================
// Mode J — AuthaGraph-inspired 96-triangle rigid fold.
//
// This is deliberately a two-reference construction:
//   - vertices3D is an open, developable 96-triangle physical surface whose
//     edge lengths exactly match the rectangle mesh.
//   - projectionFace/sampleSphereVerts describe the flat AuthaGraph rectangle
//     used to sample Earth imagery.
//
// The animation is inherited from Mode I and only rotates whole panels around
// shared hinges; no face geometry is interpolated during the unfold.
// =====================================================================
function _modeJOrderedFace(vertices, idx) {
    const verts = vertices.map(v => v.clone());
    const center = new THREE.Vector3();
    for (const v of verts) center.add(v);
    center.multiplyScalar(1 / verts.length);

    const e1 = new THREE.Vector3().subVectors(verts[1], verts[0]);
    const e2 = new THREE.Vector3().subVectors(verts[2], verts[0]);
    const normal = new THREE.Vector3().crossVectors(e1, e2).normalize();
    if (normal.dot(center) < 0) normal.negate();
    const planeDist = verts[0].dot(normal);

    let basisU = new THREE.Vector3().subVectors(verts[0], center);
    if (basisU.lengthSq() < 1e-12) {
        const helper = Math.abs(normal.y) < 0.95
            ? new THREE.Vector3(0, 1, 0)
            : new THREE.Vector3(1, 0, 0);
        basisU.crossVectors(normal, helper);
    }
    basisU.normalize();
    const basisV = new THREE.Vector3().crossVectors(normal, basisU).normalize();
    const vertices2D = verts.map(v => {
        const off = new THREE.Vector3().subVectors(v, center);
        return { u: off.dot(basisU), v: off.dot(basisV) };
    });
    let faceCircumradius = 0;
    for (const p of vertices2D) faceCircumradius = Math.max(faceCircumradius, Math.hypot(p.u, p.v));

    return {
        idx,
        normal,
        center,
        planeDist,
        basisU,
        basisV,
        vertices3D: verts,
        vertices2D,
        faceCircumradius,
    };
}

function _modeJBuildAuthaGraph96Polyhedron(R) {
    const rect = imagoWideRectSize();
    const cols = 12;
    const rows = 4;
    const rectScale = (2.7 * R) / rect.width;
    const rectVertex = (i, j) => {
        const x = -rect.width / 2 + (i / cols) * rect.width;
        const y = -rect.height / 2 + (j / rows) * rect.height;
        return { x, y };
    };
    const flatVertex = (p) => new THREE.Vector3(p.x * rectScale, p.y * rectScale, 0);
    const sampleVertex = (p) => {
        const lonLat = imagoWideInverse(p.x, p.y, 0.68);
        const lon = lonLat ? lonLat[0] : 0;
        const lat = lonLat ? lonLat[1] : 0;
        const cosLat = Math.cos(lat);
        return new THREE.Vector3(
            R * cosLat * Math.cos(lon),
            R * Math.sin(lat),
           -R * cosLat * Math.sin(lon),
        );
    };

    const gridPts = [];
    const gridFlat = [];
    for (let j = 0; j <= rows; j++) {
        for (let i = 0; i <= cols; i++) {
            const p = rectVertex(i, j);
            gridPts.push(p);
            gridFlat.push(flatVertex(p));
        }
    }
    const vid = (i, j) => j * (cols + 1) + i;

    const specs = [];
    const addRectTriangle = (ids) => {
        const flatVerts = ids.map(id => gridFlat[id].clone());
        const sampleVerts = ids.map(id => sampleVertex(gridPts[id]));
        const center = sampleVerts.reduce((acc, v) => acc.add(v), new THREE.Vector3())
            .multiplyScalar(1 / sampleVerts.length);
        const desiredNormal = center.lengthSq() > 1e-12
            ? center.clone().normalize()
            : new THREE.Vector3(0, 0, 1);
        specs.push({
            idx: specs.length,
            ids,
            flatVerts,
            sampleVerts,
            desiredNormal,
            flatCentroid: flatVerts.reduce((acc, v) => acc.add(v), new THREE.Vector3())
                .multiplyScalar(1 / flatVerts.length),
        });
    };

    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
            const p00 = vid(i, j);
            const p10 = vid(i + 1, j);
            const p01 = vid(i, j + 1);
            const p11 = vid(i + 1, j + 1);
            addRectTriangle([p00, p10, p11]);
            addRectTriangle([p00, p11, p01]);
        }
    }

    const edgeKey = (a, b) => a < b ? `${a}_${b}` : `${b}_${a}`;
    const edgeMap = new Map();
    for (const spec of specs) {
        for (let k = 0; k < 3; k++) {
            const a = spec.ids[k];
            const b = spec.ids[(k + 1) % 3];
            const key = edgeKey(a, b);
            if (!edgeMap.has(key)) edgeMap.set(key, []);
            edgeMap.get(key).push(spec.idx);
        }
    }
    const adj = specs.map(() => []);
    for (const [key, fs] of edgeMap.entries()) {
        if (fs.length !== 2) continue;
        const ids = key.split('_').map(Number);
        adj[fs[0]].push({ face: fs[1], ids });
        adj[fs[1]].push({ face: fs[0], ids });
    }

    let rootIdx = 0;
    for (let i = 1; i < specs.length; i++) {
        if (specs[i].flatCentroid.lengthSq() < specs[rootIdx].flatCentroid.lengthSq()) {
            rootIdx = i;
        }
    }

    const parent = new Array(specs.length).fill(-1);
    const parentEdgeIds = new Array(specs.length).fill(null);
    const order = [rootIdx];
    parent[rootIdx] = rootIdx;
    for (let q = 0; q < order.length; q++) {
        const f = order[q];
        const next = adj[f].slice().sort((a, b) => {
            const da = specs[a.face].flatCentroid.distanceToSquared(specs[rootIdx].flatCentroid);
            const db = specs[b.face].flatCentroid.distanceToSquared(specs[rootIdx].flatCentroid);
            return da - db;
        });
        for (const item of next) {
            if (parent[item.face] !== -1) continue;
            parent[item.face] = f;
            parentEdgeIds[item.face] = item.ids;
            order.push(item.face);
        }
    }

    const transforms = new Array(specs.length);
    const rootSpec = specs[rootIdx];
    const rootQuat = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        rootSpec.desiredNormal,
    );
    const rootRot = new THREE.Matrix4().makeRotationFromQuaternion(rootQuat);
    const rootPre = new THREE.Matrix4().makeTranslation(
        -rootSpec.flatCentroid.x,
        -rootSpec.flatCentroid.y,
        -rootSpec.flatCentroid.z,
    );
    const rootPost = new THREE.Matrix4().makeTranslation(
        rootSpec.desiredNormal.x * R,
        rootSpec.desiredNormal.y * R,
        rootSpec.desiredNormal.z * R,
    );
    transforms[rootIdx] = new THREE.Matrix4().multiplyMatrices(rootPost, rootRot).multiply(rootPre);

    const zAxis = new THREE.Vector3(0, 0, 1);
    const n0 = new THREE.Vector3();
    const nA = new THREE.Vector3();
    const nB = new THREE.Vector3();
    const cross = new THREE.Vector3();
    const tmpAxis = new THREE.Vector3();
    const hingeA = new THREE.Vector3();
    const hingeB = new THREE.Vector3();
    const rotQ = new THREE.Quaternion();
    const rotM = new THREE.Matrix4();
    const tTo = new THREE.Matrix4();
    const tBack = new THREE.Matrix4();
    const hingeM = new THREE.Matrix4();
    const baseM = new THREE.Matrix4();

    for (const f of order) {
        if (f === rootIdx) continue;
        const p = parent[f];
        const pM = transforms[p];
        const edgeIds = parentEdgeIds[f];
        hingeA.copy(gridFlat[edgeIds[0]]).applyMatrix4(pM);
        hingeB.copy(gridFlat[edgeIds[1]]).applyMatrix4(pM);
        tmpAxis.subVectors(hingeB, hingeA).normalize();
        n0.copy(zAxis).transformDirection(pM).normalize();

        nA.copy(n0).addScaledVector(tmpAxis, -n0.dot(tmpAxis));
        nB.copy(specs[f].desiredNormal).addScaledVector(tmpAxis, -specs[f].desiredNormal.dot(tmpAxis));
        let theta = 0;
        if (nA.lengthSq() > 1e-10 && nB.lengthSq() > 1e-10) {
            nA.normalize();
            nB.normalize();
            cross.crossVectors(nA, nB);
            theta = Math.atan2(tmpAxis.dot(cross), nA.dot(nB));
        }

        rotQ.setFromAxisAngle(tmpAxis, theta);
        rotM.makeRotationFromQuaternion(rotQ);
        tTo.makeTranslation(hingeA.x, hingeA.y, hingeA.z);
        tBack.makeTranslation(-hingeA.x, -hingeA.y, -hingeA.z);
        hingeM.multiplyMatrices(tTo, rotM).multiply(tBack);
        baseM.copy(pM);
        transforms[f] = new THREE.Matrix4().multiplyMatrices(hingeM, baseM);
    }

    const faces = specs.map(spec => {
        const foldedVerts = spec.flatVerts.map(v => v.clone().applyMatrix4(transforms[spec.idx]));
        const face = _modeJOrderedFace(foldedVerts, spec.idx);
        face.projectionFace = _modeJOrderedFace(spec.flatVerts, spec.idx);
        face.sampleSphereVerts = spec.sampleVerts.map(v => v.clone());
        face.autha96 = true;
        return face;
    });

    let inradius = Infinity;
    for (const f of faces) inradius = Math.min(inradius, Math.abs(f.planeDist));
    return {
        type: 'authagraph96',
        name: 'AuthaGraph split-edge 96-panel fold',
        R,
        inradius,
        vertsPerFace: 3,
        faces,
        modeJRootIdx: rootIdx,
    };
}

function _modeJBarycentric2D(x, y, a, b, c) {
    const den = (b.v - c.v) * (a.u - c.u) + (c.u - b.u) * (a.v - c.v);
    if (Math.abs(den) < 1e-12) return null;
    const l0 = ((b.v - c.v) * (x - c.u) + (c.u - b.u) * (y - c.v)) / den;
    const l1 = ((c.v - a.v) * (x - c.u) + (a.u - c.u) * (y - c.v)) / den;
    return [l0, l1, 1 - l0 - l1];
}

function _modeJStampPolygonCorners(canvas, refFace) {
    const size = canvas.width;
    const half = size / 2;
    const pxRadius = half * 0.95;
    const first = refFace.vertices2D[0];
    const rotation = Math.PI / 2 - Math.atan2(first.v, first.u);
    const cosR = Math.cos(rotation), sinR = Math.sin(rotation);
    const scale = pxRadius / refFace.faceCircumradius;
    canvas.polygonCorners = refFace.vertices2D.map(({ u, v }) => {
        const uR = u * cosR - v * sinR;
        const vR = u * sinR + v * cosR;
        return { x: half + scale * uR, y: half - scale * vR };
    });
    return { half, scale, cosR, sinR };
}

function _modeJBlankFaceCanvas(refFace, size) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    // alpha:false — opaque backing store so the upload to a WebGL texture
    // never carries sub-1 alpha pixels (same reasoning as the Mode I face
    // canvases above).
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#f8f5ec';
    ctx.fillRect(0, 0, size, size);
    _modeJStampPolygonCorners(canvas, refFace);
    return canvas;
}

function renderModeJAuthaFaceFromRaster(face, earthImage, size) {
    const refFace = face.projectionFace || face;
    if (!earthImage || refFace.vertices2D.length !== 3 || !face.sampleSphereVerts) {
        return _modeJBlankFaceCanvas(refFace, size);
    }
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d', { alpha: false });
    // Paint the parchment fallback first so outside-triangle pixels keep
    // a sensible colour at alpha=255 — without this the loop below writes
    // alpha=0 outside the triangle and bilinear filtering bleeds the
    // transparency into the polygon edges.
    ctx.fillStyle = '#f8f5ec';
    ctx.fillRect(0, 0, size, size);
    const bgPixels = ctx.getImageData(0, 0, size, size).data;
    const { half, scale, cosR, sinR } = _modeJStampPolygonCorners(canvas, refFace);

    const sw = earthImage.naturalWidth || earthImage.width;
    const sh = earthImage.naturalHeight || earthImage.height;
    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = sw;
    sourceCanvas.height = sh;
    const sctx = sourceCanvas.getContext('2d');
    sctx.drawImage(earthImage, 0, 0);
    let texData;
    try {
        texData = sctx.getImageData(0, 0, sw, sh);
    } catch (e) {
        return _modeJBlankFaceCanvas(refFace, size);
    }

    const verts = refFace.vertices2D;
    const sv = face.sampleSphereVerts;
    const tw = texData.width, th = texData.height;
    const texPixels = texData.data;
    const imgData = ctx.createImageData(size, size);
    const pixels = imgData.data;
    const eps = -1e-4;

    for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
            const uR = (px + 0.5 - half) / scale;
            const vR = (half - (py + 0.5)) / scale;
            const u = uR * cosR + vR * sinR;
            const v = -uR * sinR + vR * cosR;
            const bc = _modeJBarycentric2D(u, v, verts[0], verts[1], verts[2]);
            const j = (py * size + px) * 4;
            if (!bc || bc[0] < eps || bc[1] < eps || bc[2] < eps) {
                // Outside the triangle: keep the parchment fallback we
                // painted above (read from bgPixels) at full alpha.
                pixels[j]     = bgPixels[j];
                pixels[j + 1] = bgPixels[j + 1];
                pixels[j + 2] = bgPixels[j + 2];
                pixels[j + 3] = 255;
                continue;
            }

            const dx = sv[0].x * bc[0] + sv[1].x * bc[1] + sv[2].x * bc[2];
            const dy = sv[0].y * bc[0] + sv[1].y * bc[1] + sv[2].y * bc[2];
            const dz = sv[0].z * bc[0] + sv[1].z * bc[1] + sv[2].z * bc[2];
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
            const nx = dx / len, ny = dy / len, nz = dz / len;
            const lat = Math.asin(ny < -1 ? -1 : (ny > 1 ? 1 : ny));
            const lon = Math.atan2(-nz, nx);
            let tx = (lon / (2 * Math.PI) + 0.5) * tw;
            let ty = (0.5 - lat / Math.PI) * th;
            if (tx < 0) tx = 0; else if (tx >= tw) tx = tw - 1; else tx |= 0;
            if (ty < 0) ty = 0; else if (ty >= th) ty = th - 1; else ty |= 0;
            const ti = (ty * tw + tx) * 4;
            pixels[j]     = texPixels[ti];
            pixels[j + 1] = texPixels[ti + 1];
            pixels[j + 2] = texPixels[ti + 2];
            pixels[j + 3] = 255;
        }
    }
    ctx.putImageData(imgData, 0, 0);
    return canvas;
}

class ModeJ extends ModeI {
    constructor(scene, R, starCapacity) {
        const polyhedron = _modeJBuildAuthaGraph96Polyhedron(R);
        super(scene, polyhedron, starCapacity);
        this._faceCanvasSize = 384;
        this._strategy = 'authagraph';
        this._userRootIdx = polyhedron.modeJRootIdx || 0;
        this._earthCanvasCache = new Map();
        this._buildSpanningTree();
        this._computeHingeData();
        this._refreshRenderOrders();
        this._updateAnimation();
    }
    _computeCutEdges() {
        if (this._strategy !== 'authagraph') return super._computeCutEdges();
        return new Set();
    }

    setStrategy(name) {
        if (name === 'authagraph') {
            if (this._strategy === name) return;
            this._strategy = name;
            this._buildSpanningTree();
            this._computeHingeData();
            this._refreshRenderOrders();
            this._updateAnimation();
            return;
        }
        super.setStrategy(name);
    }

    setObserverLatitude(latRad) {
        this._observerLat = latRad;
    }

    _buildFaceLabel(idx) {
        return null;
    }

    _updateAnimation() {
        super._updateAnimation();
    }

    _rebuildFaceCanvases() {
        for (const t of this._faceTextures) { if (t) t.dispose(); }
        this._faceTextures = [];
        this._faceCanvases = [];
        if (!this._earthImage) return;

        const key = `${this.polyhedron.type}:${this._faceCanvasSize}`;
        const entry = this._earthCanvasCache.get(key);
        let canvases;
        if (entry && entry.image === this._earthImage && entry.canvases.length === this.faces.length) {
            canvases = entry.canvases;
        } else {
            canvases = this.faces.map(face =>
                renderModeJAuthaFaceFromRaster(face, this._earthImage, this._faceCanvasSize));
            this._earthCanvasCache.set(key, { image: this._earthImage, canvases });
        }

        this._faceCanvases = canvases.slice();
        for (const c of this._faceCanvases) {
            const tex = new THREE.Texture(c);
            tex.minFilter = THREE.LinearFilter;
            tex.magFilter = THREE.LinearFilter;
            tex.needsUpdate = true;
            this._faceTextures.push(tex);
        }

        for (let i = 0; i < this.faces.length; i++) {
            const fg = this.faceGroups[i];
            if (!fg) continue;
            const old = this._faceMeshTex[i];
            if (old) {
                fg.remove(old);
                if (old.geometry) old.geometry.dispose();
                if (old.material) old.material.dispose();
            }
            const mesh = this._buildFaceMeshFor(this.faces[i], i);
            if (mesh) fg.add(mesh);
            this._faceMeshTex[i] = mesh;
        }
    }
}

// =====================================================================
// Twinkling-astroid star shader (shared between Mode K and Mode A).
// Lifted out so any Three.js star-point in the scene can adopt the same
// look — astroid sprite, per-star twinkle (axis swap), per-star shimmer
// (brightness pulse) — with per-material knobs for size and overall
// brightness so the same shader serves a foreground field and a dimmer
// celestial-sphere field.
//
// `uTime` is a SHARED reference (every material built by
// makeTwinkleStarMaterial points at the same `{value: …}` object), so a
// single update site per frame drives every twinkling sprite in lockstep.
// `uSizeBase` and `uDim` are per-material; everything else is per-star
// vertex attributes (aPhase, aSpeed, aSize).
// =====================================================================
const _twinkleStarSharedTime = { value: 0 };

const TWINKLE_STAR_VS = `
    attribute vec3 color;
    attribute float aPhase;
    attribute float aSpeed;
    attribute float aSize;
    uniform float uSizeBase;
    uniform float uSizeFloor;
    varying vec3 vColor;
    varying float vPhase;
    varying float vSpeed;
    void main() {
        vColor = color;
        vPhase = aPhase;
        vSpeed = aSpeed;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = max(uSizeFloor, uSizeBase * aSize);
        gl_Position = projectionMatrix * mv;
    }
`;

// Same shader as TWINKLE_STAR_VS but with gl_Position.z forced to
// gl_Position.w, which sends NDC z to 1.0 — the far plane. Combined with
// depthFunc=LessEqualDepth on the material, this makes the star points
// fail the depth test against any geometry that has actually written to
// the depth buffer (every tile/edge has depth < 1) so the stars are
// hidden inside the polyhedron's silhouette no matter where they sit
// geometrically. In cleared-depth pixels (depth_buffer == 1) the LEQUAL
// test 1 <= 1 passes, so the stars still draw across the sky background.
const TWINKLE_STAR_VS_FAR_PLANE = `
    attribute vec3 color;
    attribute float aPhase;
    attribute float aSpeed;
    attribute float aSize;
    uniform float uSizeBase;
    uniform float uSizeFloor;
    varying vec3 vColor;
    varying float vPhase;
    varying float vSpeed;
    void main() {
        vColor = color;
        vPhase = aPhase;
        vSpeed = aSpeed;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = max(uSizeFloor, uSizeBase * aSize);
        gl_Position = projectionMatrix * mv;
        gl_Position.z = gl_Position.w;
    }
`;

const TWINKLE_STAR_FS = `
    uniform float uTime;
    uniform float uDim;
    varying vec3 vColor;
    varying float vPhase;
    varying float vSpeed;
    void main() {
        vec2 c = (gl_PointCoord - vec2(0.5)) * 2.0;
        // pow(pulse, 4) reshapes the symmetric sin into a curve that lingers
        // near 0 and only briefly peaks near 1 — paceMod sits at the slow
        // end (~0.20–0.5) for ~80% of each cycle and only spikes up toward
        // 2.0 for ~20%, so each star spends most of its time near-still
        // with short flickering windows. (n=2 was 50/50, n=4 is ~18/82.)
        float pulse = 0.5 + 0.5 * sin(uTime * 0.22 + vPhase * 11.0);
        float paceMod = 0.20 + 1.80 * pow(pulse, 4.0);
        float effSpeed = vSpeed * paceMod;
        float tw = sin(uTime * effSpeed + vPhase * 6.2831853);
        float swap = step(0.0, tw);
        vec2 ext = mix(vec2(0.55, 0.95), vec2(0.95, 0.55), swap);
        vec2 d = abs(c) / ext;
        float r = pow(d.x, 0.5) + pow(d.y, 0.5);
        float mask = 1.0 - smoothstep(0.92, 1.0, r);
        if (mask < 0.01) discard;
        float shimFreq = vSpeed * 2.5 * paceMod;
        float shimAmp = 0.08 + 0.12 * smoothstep(0.5, 10.0, vSpeed);
        float shim = (1.0 - shimAmp) + shimAmp * sin(uTime * shimFreq + vPhase * 31.0);
        gl_FragColor = vec4(vColor * shim * uDim, mask);
    }
`;

function makeTwinkleStarMaterial(opts = {}) {
    return new THREE.ShaderMaterial({
        uniforms: {
            uTime:      _twinkleStarSharedTime,
            uDim:       { value: opts.dim ?? 1.0 },
            uSizeBase:  { value: opts.sizeBase ?? 22.0 },
            uSizeFloor: { value: opts.sizeFloor ?? 5.0 },
        },
        vertexShader: TWINKLE_STAR_VS,
        fragmentShader: TWINKLE_STAR_FS,
        transparent: true,
        depthWrite: false,
    });
}

// Deterministic per-star phase + speed buffers — fixed at construction
// from the slot index so a given star always has the same twinkle timing
// regardless of which mode is active.
function fillTwinkleStarAttribs(starCapacity) {
    const phases = new Float32Array(starCapacity);
    const speeds = new Float32Array(starCapacity);
    for (let i = 0; i < starCapacity; i++) {
        const h1 = Math.sin((i + 1) * 12.9898) * 43758.5453;
        const h2 = Math.sin((i + 1) * 39.3467 + 7.13) * 91241.7211;
        phases[i] = h1 - Math.floor(h1);
        const r = h2 - Math.floor(h2);
        speeds[i] = 0.25 + Math.pow(r, 6) * 13.75;
    }
    return { phases, speeds };
}

// Stylized B-V → RGB ramp used by every twinkle-shader star (Mode K and
// Mode A's starPoints + sphereStars). The standard `colorFromBV` in
// main.js follows the physical CIE response (mostly white/yellow with
// subtle blue/red tints — accurate but visually muted). This palette
// keeps the same B-V ordering but pushes chroma so the spectrum reads as
// a clear red → orange → white → blue → purple band. Stops are listed in DESCENDING
// B-V so high-BV (cool, red) stars hit the first entry, low-BV (hot, blue/
// purple) stars hit the last. Linear interp between adjacent stops.
const MODEK_PALETTE = [
    [ 1.80, 255,  92,  72],   // deep red (very cool M-type)
    [ 1.20, 255, 150, 100],   // orange
    [ 0.70, 255, 222, 188],   // warm white
    [ 0.30, 250, 248, 240],   // neutral white
    [ 0.00, 188, 218, 255],   // cool blue-white
    [-0.20, 128, 168, 255],   // blue
    [-0.50, 188, 120, 255],   // purple (rare hot O/B-type tail)
];
function modeKColorFromBV(bv) {
    if (bv == null) return [255, 255, 255];
    const t = MODEK_PALETTE;
    if (bv >= t[0][0]) return [t[0][1], t[0][2], t[0][3]];
    if (bv <= t[t.length - 1][0]) {
        const e = t[t.length - 1]; return [e[1], e[2], e[3]];
    }
    for (let i = 0; i < t.length - 1; i++) {
        const a = t[i], b = t[i + 1];   // a[0] > b[0]
        if (bv <= a[0] && bv >= b[0]) {
            const f = (a[0] - bv) / (a[0] - b[0]);
            return [
                a[1] + f * (b[1] - a[1]),
                a[2] + f * (b[2] - a[2]),
                a[3] + f * (b[3] - a[3]),
            ];
        }
    }
    return [255, 255, 255];
}

// =====================================================================
// Mode K — pure shader-driven star field on the celestial sphere.
//
// No polyhedron, no Earth, no constellation lines — just the same star
// catalog projected to 3D on the celestial sphere (same as the rest of
// the modes use), drawn with a custom ShaderMaterial that:
//   • SIZES each astroid from the catalog's visual magnitude (star.size
//     in main.js maps MAG -1 → 1.4 down to MAG MAX → 0.25), so the
//     brightest catalog stars dominate the field at ~31 px and faint
//     ones sit around ~5 px,
//   • COLORS each star via a stylized red → orange → white → blue →
//     purple palette anchored on the same B-V color index the catalog
//     ships (modeKColorFromBV above), boosting chroma vs the physical
//     CIE response colorFromBV uses elsewhere,
//   • renders each star as a sharp 4-cusped star shape (|x/a|^0.5 +
//     |y/b|^0.5 ≤ 1 — pointier than the textbook 2/3-power astroid),
//   • TWINKLES by hard-swapping which axis (x or y) is elongated, with
//     a per-star SPEED drawn from a heavily power-biased distribution
//     (pow(r,6) — only ~1% of stars exceed 7 rad/s, the long-tail few
//     swap a couple of times per second; the rest sit near 0.3 rad/s),
//   • OSCILLATES each star's twinkle pace on a slow per-star secondary
//     phase (paceMod ∈ [0.20, 2.00] over ~28 s) so a single star
//     genuinely drifts between fast and slow phases — a normally still
//     star briefly speeds up, a fast star briefly hushes,
//   • SHIMMERS brightness on the same per-star vSpeed (× 2.5) so each
//     star's pulse rate matches its own twinkle rhythm. Amplitude
//     capped: slow stars fluctuate ~0.84→1.0 (barely visible), fast
//     stars ~0.60→1.0 (clearly pulsing, never going black).
// =====================================================================
class ModeK {
    constructor(scene, starCapacity, sphereRadius) {
        this.scene = scene;
        this.starCapacity = starCapacity;
        this.R = sphereRadius;

        this.group = new THREE.Group();
        this.group.visible = false;

        this.positions = new Float32Array(starCapacity * 3);
        this.colors    = new Float32Array(starCapacity * 3);
        this.phases    = new Float32Array(starCapacity);
        this.speeds    = new Float32Array(starCapacity);
        this.sizes     = new Float32Array(starCapacity);   // brightness multiplier from MAG

        // Deterministic per-star phase + speed buffers from the shared
        // helper (same hash any twinkle-star-using mode would compute).
        const fixed = fillTwinkleStarAttribs(starCapacity);
        this.phases.set(fixed.phases);
        this.speeds.set(fixed.speeds);

        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
        geom.setAttribute('color',    new THREE.BufferAttribute(this.colors,    3));
        geom.setAttribute('aPhase',   new THREE.BufferAttribute(this.phases,    1));
        geom.setAttribute('aSpeed',   new THREE.BufferAttribute(this.speeds,    1));
        geom.setAttribute('aSize',    new THREE.BufferAttribute(this.sizes,     1));
        this.geom = geom;

        // Astroid + twinkle + shimmer — see TWINKLE_STAR_VS/FS above for
        // the shared shader source. Default factory params suit Mode K's
        // foreground field (sizeBase 22, no dim).
        this.material = makeTwinkleStarMaterial();

        this.points = new THREE.Points(geom, this.material);
        this.group.add(this.points);

        // Togglable shimmer-gold constellation lines. Built lazily by the
        // first update() that finds both star data and a constellation list.
        // The shader shares uTime with the star material so the breathing
        // gold pulse is in time with the twinkle field.
        this.constellationLines = null;
        this._showConstellations = false;
        this.lineGeom = null;
        this.linesMesh = null;
        // WebGL ignores gl.lineWidth on most drivers, so we render the
        // constellations as a triangle-strip ribbon: each subdivision of
        // each arc becomes a quad (2 triangles), with the vertex shader
        // extruding both endpoints perpendicular to the line's screen-
        // space direction by half the desired pixel width. Result is a
        // constant-thickness gold ribbon that respects perspective depth
        // (so closer stars naturally look slightly wider in screen px).
        this.lineMaterial = new THREE.ShaderMaterial({
            uniforms: {
                uTime: _twinkleStarSharedTime,
                uColor: { value: new THREE.Color(0xe8c068) },
                uResolution: { value: new THREE.Vector2(
                    typeof window !== 'undefined' ? window.innerWidth  : 1024,
                    typeof window !== 'undefined' ? window.innerHeight : 768,
                )},
                uLinewidth: { value: 3.0 },
            },
            vertexShader: `
                attribute vec3 aTangent;
                attribute float aSide;
                attribute float aT;
                uniform vec2 uResolution;
                uniform float uLinewidth;
                varying float vT;
                void main() {
                    vT = aT;
                    vec4 clipA = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                    // A second point a small distance along the tangent —
                    // projected the same way — gives us the segment's
                    // screen-space direction.
                    vec4 clipB = projectionMatrix * modelViewMatrix * vec4(position + aTangent, 1.0);
                    vec2 ssA = (clipA.xy / clipA.w) * uResolution * 0.5;
                    vec2 ssB = (clipB.xy / clipB.w) * uResolution * 0.5;
                    vec2 dir = normalize(ssB - ssA);
                    vec2 perp = vec2(-dir.y, dir.x);
                    vec2 offsetPx = perp * aSide * uLinewidth * 0.5;
                    vec2 offsetClip = (offsetPx / uResolution) * 2.0 * clipA.w;
                    clipA.xy += offsetClip;
                    gl_Position = clipA;
                }
            `,
            fragmentShader: `
                uniform float uTime;
                uniform vec3 uColor;
                varying float vT;
                void main() {
                    // Slow breathing gold pulse + a faint travelling
                    // shimmer along each line so the constellations feel
                    // alive without distracting from the stars.
                    float breath = 0.65 + 0.25 * sin(uTime * 1.4);
                    float travel = 0.85 + 0.15 * sin(uTime * 2.3 - vT * 6.2831853);
                    float bright = breath * travel;
                    gl_FragColor = vec4(uColor * bright, 0.78);
                }
            `,
            transparent: true,
            depthWrite: false,
            // Ribbon quad winding depends on the segment tangent + which
            // side of the line each vertex is on; either face could end
            // up "front" depending on camera angle. Render both.
            side: THREE.DoubleSide,
        });

        scene.add(this.group);

        this.getStarProps = null;
    }

    setConstellationLines(linePairs) {
        this.constellationLines = linePairs;
        // Geometry is (re)built on the next update() so star XYZ positions
        // are current. Don't allocate here.
        if (this.linesMesh) {
            this.group.remove(this.linesMesh);
            if (this.lineGeom) this.lineGeom.dispose();
            this.lineGeom = null;
            this.linesMesh = null;
        }
    }

    setConstellationsVisible(v) {
        this._showConstellations = !!v;
        if (this.linesMesh) this.linesMesh.visible = this._showConstellations;
    }

    getConstellationsVisible() { return this._showConstellations; }

    _rebuildConstellationLines(starMap) {
        if (!this.constellationLines || this.constellationLines.length === 0) return;
        const SUBDIV = 18;
        const N = this.constellationLines.length;
        // Each subdivision = a quad = 4 verts + 6 indices. Triangulated
        // (A-left, A-right, B-right) + (A-left, B-right, B-left) so the
        // ribbon is solid and orientable.
        const maxQuads = N * SUBDIV;
        const positions = new Float32Array(maxQuads * 4 * 3);
        const tangents  = new Float32Array(maxQuads * 4 * 3);
        const sides     = new Float32Array(maxQuads * 4);
        const ts        = new Float32Array(maxQuads * 4);
        // 4 verts × maxQuads stays under 65535 even with all ~250 catalog
        // constellation lines (250 × 18 × 4 = 18 000), so Uint16 is safe
        // and avoids a WebGL1 extension requirement that Uint32 indices
        // would impose.
        const indices   = new Uint16Array(maxQuads * 6);
        let vIdx = 0, iIdx = 0;
        const _a = new THREE.Vector3();
        const _b = new THREE.Vector3();
        const arcPts = new Float32Array((SUBDIV + 1) * 4);   // x, y, z, t
        for (const [aId, bId] of this.constellationLines) {
            const a = starMap.get(aId);
            const b = starMap.get(bId);
            if (!a || !b || !a.XYZ || !b.XYZ) continue;
            _a.copy(a.XYZ).normalize();
            _b.copy(b.XYZ).normalize();
            const dotAB = Math.max(-1, Math.min(1, _a.dot(_b)));
            const omega = Math.acos(dotAB);
            const sinO = Math.sin(omega);
            // Slerp the great-circle arc into (SUBDIV+1) points.
            for (let i = 0; i <= SUBDIV; i++) {
                const t = i / SUBDIV;
                let x, y, z;
                if (sinO < 1e-6) { x = _a.x; y = _a.y; z = _a.z; }
                else {
                    const fa = Math.sin((1 - t) * omega) / sinO;
                    const fb = Math.sin(t * omega) / sinO;
                    x = fa * _a.x + fb * _b.x;
                    y = fa * _a.y + fb * _b.y;
                    z = fa * _a.z + fb * _b.z;
                }
                arcPts[i * 4]     = x * this.R;
                arcPts[i * 4 + 1] = y * this.R;
                arcPts[i * 4 + 2] = z * this.R;
                arcPts[i * 4 + 3] = t;
            }
            // Build a quad per segment. All four verts share the segment
            // tangent (q - p) so the vertex-shader perpendicular offset
            // matches across the ribbon ends.
            for (let i = 0; i < SUBDIV; i++) {
                const k = i * 4;
                const pX = arcPts[k],     pY = arcPts[k + 1], pZ = arcPts[k + 2], pt = arcPts[k + 3];
                const qX = arcPts[k + 4], qY = arcPts[k + 5], qZ = arcPts[k + 6], qt = arcPts[k + 7];
                const tx = qX - pX, ty = qY - pY, tz = qZ - pZ;
                const base = vIdx;
                // 0: A-left
                positions[vIdx*3]=pX; positions[vIdx*3+1]=pY; positions[vIdx*3+2]=pZ;
                tangents [vIdx*3]=tx; tangents [vIdx*3+1]=ty; tangents [vIdx*3+2]=tz;
                sides[vIdx] = -1; ts[vIdx] = pt; vIdx++;
                // 1: A-right
                positions[vIdx*3]=pX; positions[vIdx*3+1]=pY; positions[vIdx*3+2]=pZ;
                tangents [vIdx*3]=tx; tangents [vIdx*3+1]=ty; tangents [vIdx*3+2]=tz;
                sides[vIdx] = +1; ts[vIdx] = pt; vIdx++;
                // 2: B-right
                positions[vIdx*3]=qX; positions[vIdx*3+1]=qY; positions[vIdx*3+2]=qZ;
                tangents [vIdx*3]=tx; tangents [vIdx*3+1]=ty; tangents [vIdx*3+2]=tz;
                sides[vIdx] = +1; ts[vIdx] = qt; vIdx++;
                // 3: B-left
                positions[vIdx*3]=qX; positions[vIdx*3+1]=qY; positions[vIdx*3+2]=qZ;
                tangents [vIdx*3]=tx; tangents [vIdx*3+1]=ty; tangents [vIdx*3+2]=tz;
                sides[vIdx] = -1; ts[vIdx] = qt; vIdx++;
                indices[iIdx++] = base;     indices[iIdx++] = base + 1; indices[iIdx++] = base + 2;
                indices[iIdx++] = base;     indices[iIdx++] = base + 2; indices[iIdx++] = base + 3;
            }
        }
        const newGeom = new THREE.BufferGeometry();
        newGeom.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, vIdx * 3), 3));
        newGeom.setAttribute('aTangent', new THREE.BufferAttribute(tangents .subarray(0, vIdx * 3), 3));
        newGeom.setAttribute('aSide',    new THREE.BufferAttribute(sides    .subarray(0, vIdx),     1));
        newGeom.setAttribute('aT',       new THREE.BufferAttribute(ts       .subarray(0, vIdx),     1));
        newGeom.setIndex(new THREE.BufferAttribute(indices.subarray(0, iIdx), 1));

        if (this.linesMesh) {
            this.group.remove(this.linesMesh);
            this.lineGeom.dispose();
        }
        // Bounding sphere from the unextruded positions; the shader
        // extrudes outward by at most a few px in screen space, never
        // anywhere near a sphere-radius's worth in world space, so the
        // raw-position sphere is a tight-enough cull volume. Without
        // computeBoundingSphere() Three.js bakes a degenerate one.
        newGeom.computeBoundingSphere();
        this.lineGeom = newGeom;
        this.linesMesh = new THREE.Mesh(newGeom, this.lineMaterial);
        // Belt + braces — the perpendicular extrusion can briefly push
        // pixels beyond the bounding sphere on grazing camera angles.
        this.linesMesh.frustumCulled = false;
        this.linesMesh.visible = this._showConstellations;
        this.group.add(this.linesMesh);
    }

    setStarPropsFn(fn) { this.getStarProps = fn; }

    setVisible(v) { this.group.visible = !!v; }

    update(starMap) {
        if (!this.group.visible || !this.getStarProps || !starMap) return;

        let n = 0;
        for (const star of starMap.values()) {
            const props = this.getStarProps(star);
            if (!props || !props.visible) continue;
            if (n >= this.starCapacity) break;
            this.positions[n * 3]     = star.XYZ.x;
            this.positions[n * 3 + 1] = star.XYZ.y;
            this.positions[n * 3 + 2] = star.XYZ.z;
            // Mode K uses its OWN stylized B-V palette (red-orange-white-
            // blue-purple) rather than the realistic colors in props.colorHex.
            const rgb = modeKColorFromBV(star.BV);
            this.colors[n * 3]     = rgb[0] / 255;
            this.colors[n * 3 + 1] = rgb[1] / 255;
            this.colors[n * 3 + 2] = rgb[2] / 255;
            // Star size already encodes the MAG → bigger-is-brighter mapping
            // (computed in main.js at catalog load: 1.4 brightest → 0.25
            // dimmest). The vertex shader multiplies this into gl_PointSize.
            this.sizes[n] = star.size != null ? star.size : 0.7;
            n++;
        }
        this.geom.attributes.position.needsUpdate = true;
        this.geom.attributes.color.needsUpdate    = true;
        this.geom.attributes.aSize.needsUpdate    = true;
        this.geom.setDrawRange(0, n);

        // Build / refresh the constellation-line geometry when needed. Stars
        // only move with simulated date, but it's cheap to rebuild and the
        // _showConstellations check keeps it from running when the toggle
        // is off.
        if (this._showConstellations && this.constellationLines) {
            this._rebuildConstellationLines(starMap);
        }
    }
}

export class PolyhedralProjection {
    constructor(scene, sphereRadius, starCapacity, polyhedronType = 'dodec') {
        this.scene = scene;
        this.R = sphereRadius;
        this.starCapacity = starCapacity;
        this.polyhedronType = polyhedronType;
        this.polyhedron = buildPolyhedron(polyhedronType, sphereRadius);
        this.faces = this.polyhedron.faces;
        this.inradius = this.polyhedron.inradius;

        this.modeA = new ModeA(scene, this.polyhedron, starCapacity);
        this.modeA2 = new ModeA2(scene, this.polyhedron);
        // Mode A-3 (AuthaGraph inflated tetra) always uses a tetrahedron,
        // independent of the polyhedron selector that drives Modes A/A-2/B/C/D.
        this.modeA3 = new ModeA3(scene, sphereRadius);
        // Mode H — globe-wrapped elevation ridgelines. Independent of any
        // polyhedron; loads its own ETOPO-derived data asynchronously.
        this.modeH = new ModeH(scene, sphereRadius);
        // Mode I — fold/unfold animation of the polyhedron (same set of faces
        // as Mode A-2, animated in 3D via spanning-tree rigid origami).
        // starCapacity drives the camera-following twinkling star sphere
        // overlay; Mode J inherits the same overlay through ModeJ extends ModeI.
        this.modeI = new ModeI(scene, this.polyhedron, starCapacity);
        // Mode J — fixed AuthaGraph-inspired 96-triangle rigid net.
        // starCapacity drives a Mode-K-style twinkling overlay that follows
        // the camera (sphere of stars with the camera just outside its edge).
        this.modeJ = new ModeJ(scene, sphereRadius, starCapacity);
        // Mode K — shader-only twinkling astroid starfield on the celestial
        // sphere. No polyhedron, no Earth, no constellation lines.
        this.modeK = new ModeK(scene, starCapacity, sphereRadius);
        this.modeB = null;
        this.modeC = null;
        this.modeD = null;
        this.modeE = null;
        this.modeF = null;
        this.modeG = null;

        this.currentMode = 'A';
        this.getStarProps = () => null;
        this.constellationLines = [];
        this.eclipticPoints = null;
        this.zodiacBands = null;

        // Centralized elevation-contour state, shared by every mode that
        // displays the ETOPO ridgelines (A-2, H, and the 2D unfolds B/C/D/F/G).
        // `_elevationLatStepDeg` picks which pre-built binary to load; buckets
        // are recomputed whenever the data, polyhedron, or sphere orientation
        // changes and pushed to the 2D modes for drawing.
        this._elevationLatStepDeg = 3;
        this._elevationVisible = false;
        this._elevationData = null;     // {curves, meta}
        this._elevationBuckets = null;  // per-face Array<{faceIdx, points}>
        this._sphereOrientationMatrix = null;
        this._loadAndPushElevation();
    }

    async _loadAndPushElevation() {
        try {
            this._elevationData = await loadElevationCurves(this._elevationLatStepDeg);
            this._rebucketAndPushElevation();
        } catch (e) {
            console.warn('Elevation data load failed:', e);
        }
    }

    _rebucketAndPushElevation() {
        if (!this._elevationData || !this.faces) return;
        this._elevationBuckets = bucketElevationCurves(
            this._elevationData.curves,
            this._elevationData.meta,
            this.faces,
            this._sphereOrientationMatrix,
            this.inradius,
        );
        // Feature-detect: Modes F/G don't yet implement these — calling
        // a non-existent method throws TypeError that propagates out of
        // setSphereOrientation -> applySphereOrientation, killing the Earth
        // pre-render step in setupEarthAsync (which is why B/C/D's Earth
        // slices didn't appear on initial load).
        if (this.modeB && this.modeB.setElevationBuckets) this.modeB.setElevationBuckets(this._elevationBuckets);
        if (this.modeC && this.modeC.setElevationBuckets) this.modeC.setElevationBuckets(this._elevationBuckets);
        if (this.modeD && this.modeD.setElevationBuckets) this.modeD.setElevationBuckets(this._elevationBuckets);
        if (this.modeF && this.modeF.setElevationBuckets) this.modeF.setElevationBuckets(this._elevationBuckets);
        if (this.modeG && this.modeG.setElevationBuckets) this.modeG.setElevationBuckets(this._elevationBuckets);
    }

    setElevationVisible(v) {
        this._elevationVisible = !!v;
        if (this.modeA2 && this.modeA2.setElevationCurvesVisible) this.modeA2.setElevationCurvesVisible(this._elevationVisible);
        if (this.modeI  && this.modeI.setElevationCurvesVisible)  this.modeI.setElevationCurvesVisible(this._elevationVisible);
        if (this.modeB && this.modeB.setElevationVisible) this.modeB.setElevationVisible(this._elevationVisible);
        if (this.modeC && this.modeC.setElevationVisible) this.modeC.setElevationVisible(this._elevationVisible);
        if (this.modeD && this.modeD.setElevationVisible) this.modeD.setElevationVisible(this._elevationVisible);
        if (this.modeF && this.modeF.setElevationVisible) this.modeF.setElevationVisible(this._elevationVisible);
        if (this.modeG && this.modeG.setElevationVisible) this.modeG.setElevationVisible(this._elevationVisible);
    }

    // Single exaggeration parameter shared by every elevation-displaying mode.
    // Each mode interprets it for its own geometry: Mode A-2 / Mode H use it
    // as a radial (elev * R / EARTH_R * exag) 3D displacement; the 2D
    // unfolded modes use it as a screen-Y offset with the same formula but
    // using the face's display radius. Mode I uses the same radial formula
    // as A-2 on each face plane, so the contour lifts with the face as it
    // unfolds.
    setElevationExaggeration(x) {
        const v = +x || 150;
        if (this.modeA2 && this.modeA2.setElevationCurvesExaggeration) this.modeA2.setElevationCurvesExaggeration(v);
        if (this.modeI  && this.modeI.setElevationCurvesExaggeration)  this.modeI.setElevationCurvesExaggeration(v);
        if (this.modeH  && this.modeH.setExaggeration) this.modeH.setExaggeration(v);
        if (this.modeB && this.modeB.setElevationExaggeration) this.modeB.setElevationExaggeration(v);
        if (this.modeC && this.modeC.setElevationExaggeration) this.modeC.setElevationExaggeration(v);
        if (this.modeD && this.modeD.setElevationExaggeration) this.modeD.setElevationExaggeration(v);
    }

    // Tile opacity: Mode A-2's textured polyhedron faces (3D MeshBasicMaterial)
    // and Modes B/C/D's Earth-canvas blits all darken to 35% when set to
    // translucent so elevation contours read clearly against the Earth. Mode I
    // uses the same MeshBasicMaterial as A-2, so the same opacity logic applies.
    setTileOpaque(v) {
        const opaque = v !== false;
        if (this.modeA2 && this.modeA2.setFacesOpaque) this.modeA2.setFacesOpaque(opaque);
        if (this.modeI  && this.modeI.setFacesOpaque)  this.modeI.setFacesOpaque(opaque);
        if (this.modeJ  && this.modeJ.setFacesOpaque)  this.modeJ.setFacesOpaque(opaque);
        if (this.modeB && this.modeB.setTileOpaque) this.modeB.setTileOpaque(opaque);
        if (this.modeC && this.modeC.setTileOpaque) this.modeC.setTileOpaque(opaque);
        if (this.modeD && this.modeD.setTileOpaque) this.modeD.setTileOpaque(opaque);
    }

    // Parchment sphere maps for Mode I face backgrounds. main.js loads the
    // PNGs baked from bake-parchment.html and pushes them through here.
    setParchmentImage(slug, img) {
        if (this.modeI && this.modeI.setParchmentImage) this.modeI.setParchmentImage(slug, img);
        if (this.modeJ && this.modeJ.setParchmentImage) this.modeJ.setParchmentImage(slug, img);
    }
    setFaceBackgroundMode(mode) {
        if (this.modeI && this.modeI.setFaceBackgroundMode) this.modeI.setFaceBackgroundMode(mode);
        if (this.modeJ && this.modeJ.setFaceBackgroundMode) this.modeJ.setFaceBackgroundMode(mode);
    }
    getFaceBackgroundMode() {
        return this.modeI && this.modeI.getFaceBackgroundMode
            ? this.modeI.getFaceBackgroundMode()
            : 'plain';
    }

    setModeIGrainEnabled(v) {
        if (this.modeI && this.modeI.setGrainEnabled) this.modeI.setGrainEnabled(v);
        if (this.modeJ && this.modeJ.setGrainEnabled) this.modeJ.setGrainEnabled(v);
    }
    getModeIGrainEnabled() {
        return this.modeI && this.modeI.getGrainEnabled ? this.modeI.getGrainEnabled() : true;
    }

    setModeIBackingVisible(v) {
        if (this.modeI && this.modeI.setBackingVisible) this.modeI.setBackingVisible(v);
        if (this.modeJ && this.modeJ.setBackingVisible) this.modeJ.setBackingVisible(v);
    }
    getModeIBackingVisible() {
        return this.modeI && this.modeI.getBackingVisible ? this.modeI.getBackingVisible() : false;
    }

    setModeIBridgeFade(v) {
        if (this.modeI && this.modeI.setBridgeFadeEnabled) this.modeI.setBridgeFadeEnabled(v);
        if (this.modeJ && this.modeJ.setBridgeFadeEnabled) this.modeJ.setBridgeFadeEnabled(v);
    }
    getModeIBridgeFade() {
        return this.modeI && this.modeI.getBridgeFadeEnabled ? this.modeI.getBridgeFadeEnabled() : true;
    }

    exportModeISvg(opts) {
        // Prefer the J subclass when active (its camera + matrices are
        // current); otherwise fall through to Mode I. Mode I is the
        // common case so it's first in the fallback chain.
        const target = (this.modeI && this.modeI.exportSvg) ? this.modeI
                     : (this.modeJ && this.modeJ.exportSvg) ? this.modeJ
                     : null;
        if (!target) throw new Error('exportModeISvg: Mode I is not initialised');
        return target.exportSvg(opts);
    }

    setModeIBackingTileStyle(slug) {
        if (this.modeI && this.modeI.setBackingTileStyle) this.modeI.setBackingTileStyle(slug);
        if (this.modeJ && this.modeJ.setBackingTileStyle) this.modeJ.setBackingTileStyle(slug);
    }
    getModeIBackingTileStyle() {
        return this.modeI && this.modeI.getBackingTileStyle
            ? this.modeI.getBackingTileStyle() : 'parchmentCloudsLight';
    }

    // Runtime tuning of the at-t=1 in-plane twist. main.js wires arrow keys
    // to this so the active shape/strategy's twist can be dialled in
    // visually. Returns the current effective twist (radians).
    getModeIFinalTwistRad() {
        const mode = this.getActiveFoldMode();
        return mode && mode.getFinalTwistRad ? mode.getFinalTwistRad() : 0;
    }
    setModeIFinalTwistRad(rad) {
        const mode = this.getActiveFoldMode();
        if (mode && mode.setFinalTwistRad) mode.setFinalTwistRad(rad);
    }

    // Tile tint (cool-white -> white -> warm-parchment range). Multiplied
    // with the white-bg Earth canvas: Mode A-2 / Mode I via material.color
    // (which multiplies the map texture in MeshBasicMaterial); Modes B/C/D
    // via a fill + 'multiply' composite at draw time. White (0xffffff) means
    // "no tint" — passes through.
    setTileTint(hex) {
        const v = (hex | 0) & 0xffffff;
        if (this.modeA2 && this.modeA2.setTileTint) this.modeA2.setTileTint(v);
        if (this.modeI  && this.modeI.setTileTint)  this.modeI.setTileTint(v);
        if (this.modeJ  && this.modeJ.setTileTint)  this.modeJ.setTileTint(v);
        if (this.modeB && this.modeB.setTileTint) this.modeB.setTileTint(v);
        if (this.modeC && this.modeC.setTileTint) this.modeC.setTileTint(v);
        if (this.modeD && this.modeD.setTileTint) this.modeD.setTileTint(v);
    }

    // Land-only relief: clamps elevation to >= -500 m and shifts baseline so
    // ocean depths flatten to a uniform line and only land relief sticks up.
    setLandOnly(v) {
        const land = !!v;
        if (this.modeA2 && this.modeA2.setLandOnly) this.modeA2.setLandOnly(land);
        if (this.modeI  && this.modeI.setLandOnly)  this.modeI.setLandOnly(land);
        if (this.modeH  && this.modeH.setLandOnly) this.modeH.setLandOnly(land);
        if (this.modeB && this.modeB.setLandOnly) this.modeB.setLandOnly(land);
        if (this.modeC && this.modeC.setLandOnly) this.modeC.setLandOnly(land);
        if (this.modeD && this.modeD.setLandOnly) this.modeD.setLandOnly(land);
    }

    setElevationLatStepDeg(step) {
        // Always broadcast to Mode A-2 / Mode I / Mode H so all elevation
        // displays stay in sync with a single density choice.
        if (this.modeA2) this.modeA2.setElevationLatStepDeg(step);
        if (this.modeI)  this.modeI.setElevationLatStepDeg(step);
        if (this.modeH)  this.modeH.setLatStepDeg(step);
        if (step === this._elevationLatStepDeg) return;
        this._elevationLatStepDeg = step;
        this._elevationData = null;
        this._loadAndPushElevation();
    }

    attachCanvases(canvasB, canvasC, canvasD, canvasE, canvasF, canvasG) {
        this.modeB = new ModeB(canvasB, this.polyhedron);
        this.modeC = new ModeC(canvasC, this.polyhedron);
        this.modeD = new ModeD(canvasD, this.polyhedron);
        this.modeE = new ModeE(canvasE, this.R);
        this.modeF = new ModeF(canvasF);
        if (canvasG) this.modeG = new ModeG(canvasG);
        // Push any already-bucketed elevation curves into the freshly-built
        // 2D modes (and apply current visibility).
        if (this._elevationBuckets) this._rebucketAndPushElevation();
        if (this._elevationVisible) this.setElevationVisible(true);
    }

    // Switch the active polyhedron used by Modes A-D. Modes E/F/G are
    // unaffected (they have their own fixed projection geometry).
    // Earth canvases are invalidated; the caller must re-run preRenderEarthFaces
    // and call setEarthCanvases again to restore the Earth twin in B/C/D.
    setPolyhedronType(type) {
        if (type === this.polyhedronType) return;
        this.polyhedronType = type;
        this.polyhedron = buildPolyhedron(type, this.R);
        this.faces = this.polyhedron.faces;
        this.inradius = this.polyhedron.inradius;
        if (this.modeA) this.modeA.setPolyhedron(this.polyhedron);
        if (this.modeA2) this.modeA2.setPolyhedron(this.polyhedron);
        if (this.modeB) this.modeB.setPolyhedron(this.polyhedron);
        if (this.modeC) this.modeC.setPolyhedron(this.polyhedron);
        if (this.modeD) this.modeD.setPolyhedron(this.polyhedron);
        if (this.modeI) this.modeI.setPolyhedron(this.polyhedron);
        // Re-apply constellation lines (some modes cache projected line data).
        if (this.constellationLines.length) {
            if (this.modeA) this.modeA.setConstellationLines(this.constellationLines);
        }
        // Mode A's ecliptic / zodiac-band geometry survives the polyhedron
        // swap (buffer sizing is per ecliptic-sample, not per face), but the
        // surface projection has to re-bind to the new face set next update.
        if (this.eclipticPoints && this.modeA) this.modeA.setEcliptic(this.eclipticPoints);
        if (this.zodiacBands && this.modeA) this.modeA.setZodiacBand(this.zodiacBands);
        // Milky Way per-face canvases reference the old face set; rebuild
        // for the new one (per-frame re-fill will repopulate the pixels).
        if (this._mwCanvas) {
            if (this.modeB) this.modeB.setMilkyWayImage(this._mwCanvas);
            if (this.modeC) this.modeC.setMilkyWayImage(this._mwCanvas);
            if (this.modeD) this.modeD.setMilkyWayImage(this._mwCanvas);
        }
        // Elevation buckets reference faces; rebuild for the new polyhedron.
        this._rebucketAndPushElevation();
    }

    getPolyhedronType() { return this.polyhedronType; }
    getPolyhedronName() { return this.polyhedron.name; }

    setStarPropsFn(fn) {
        this.getStarProps = fn;
        if (this.modeK) this.modeK.setStarPropsFn(fn);
        if (this.modeI) this.modeI.setStarPropsFn(fn);
        if (this.modeJ) this.modeJ.setStarPropsFn(fn);
    }

    setConstellationLines(linePairs) {
        this.constellationLines = linePairs;
        this.modeA.setConstellationLines(linePairs);
        if (this.modeB) this.modeB.setConstellationLines(linePairs);
        if (this.modeC) this.modeC.setConstellationLines(linePairs);
        if (this.modeD) this.modeD.setConstellationLines(linePairs);
        if (this.modeE) this.modeE.setConstellationLines(linePairs);
        if (this.modeF) this.modeF.setConstellationLines(linePairs);
        if (this.modeG) this.modeG.setConstellationLines(linePairs);
        if (this.modeK) this.modeK.setConstellationLines(linePairs);
    }

    setModeKConstellationsVisible(v) {
        if (this.modeK) this.modeK.setConstellationsVisible(v);
    }
    getModeKConstellationsVisible() {
        return this.modeK ? this.modeK.getConstellationsVisible() : false;
    }

    // Closed polyline of XYZ unit vectors in observer-horizon frame. The
    // vectors are mutated in place each frame by the caller, so each mode
    // re-reads them every update(). Pass null/undefined to clear.
    setEcliptic(xyzArray) {
        this.eclipticPoints = xyzArray || null;
        this.modeA.setEcliptic(xyzArray);
        if (this.modeB) this.modeB.setEcliptic(xyzArray);
        if (this.modeC) this.modeC.setEcliptic(xyzArray);
        if (this.modeD) this.modeD.setEcliptic(xyzArray);
        if (this.modeE) this.modeE.setEcliptic(xyzArray);
        if (this.modeF) this.modeF.setEcliptic(xyzArray);
        if (this.modeG) this.modeG.setEcliptic(xyzArray);
    }

    // Zodiac band boundary polylines (typically the +/- 8 deg ecliptic-lat
    // lines). Pass an array of polylines (each a closed array of mutable
    // Vector3 in observer-horizon frame).
    setZodiacBand(bands) {
        this.zodiacBands = bands || null;
        this.modeA.setZodiacBand(bands);
        if (this.modeB) this.modeB.setZodiacBand(bands);
        if (this.modeC) this.modeC.setZodiacBand(bands);
        if (this.modeD) this.modeD.setZodiacBand(bands);
        if (this.modeE) this.modeE.setZodiacBand(bands);
        if (this.modeF) this.modeF.setZodiacBand(bands);
        if (this.modeG) this.modeG.setZodiacBand(bands);
    }

    // 3x3 rotation matrix (flat 9-element row-major) taking unit vectors
    // from the celestial frame (+X vernal eq, +Y NCP, +Z RA90/Dec0) to the
    // observer-horizon frame (+X east, +Y zenith, +Z south). Recomputed each
    // frame by the caller from LST + observer latitude. Drives Mode A's
    // Milky Way sphere orientation AND the per-frame observer-to-galactic
    // rotation pushed to the 2D modes so their MW band moves with the stars.
    setSkyRotation(m) {
        this._skyRotation = m;
        this._mwObsToGal = computeObsToGal(m);
        this.modeA.setSkyRotation(m);
        if (this.modeB) this.modeB.setObsToGal(this._mwObsToGal);
        if (this.modeC) this.modeC.setObsToGal(this._mwObsToGal);
        if (this.modeD) this.modeD.setObsToGal(this._mwObsToGal);
        if (this.modeE) this.modeE.setObsToGal(this._mwObsToGal);
        if (this.modeF) this.modeF.setObsToGal(this._mwObsToGal);
        if (this.modeG) this.modeG.setObsToGal(this._mwObsToGal);
    }

    // All-sky Milky Way coverage map (equirectangular, galactic frame). Mode
    // A paints it onto the celestial sphere mesh; Modes B/C/D/F/G allocate
    // per-face canvases and re-fill them every frame in their own update()
    // using the latest observer-to-galactic matrix; Mode E renders into a
    // single rectangular imago canvas the same way. Pass null to clear.
    setMilkyWayImage(canvas) {
        this._mwCanvas = canvas || null;
        this.modeA.setMilkyWayImage(canvas);
        if (this.modeB) this.modeB.setMilkyWayImage(canvas);
        if (this.modeC) this.modeC.setMilkyWayImage(canvas);
        if (this.modeD) this.modeD.setMilkyWayImage(canvas);
        if (this.modeE) this.modeE.setMilkyWayImage(canvas);
        if (this.modeF) this.modeF.setMilkyWayImage(canvas);
        if (this.modeG) this.modeG.setMilkyWayImage(canvas);
    }

    // Visibility toggles for the three overlays. When off, each mode skips
    // the per-frame compute (most importantly, MW's per-pixel re-projection)
    // and the corresponding draw passes.
    setConstellationsVisible(v) {
        const b = !!v;
        this.modeA.setConstellationsVisible(b);
        if (this.modeB) this.modeB.setConstellationsVisible(b);
        if (this.modeC) this.modeC.setConstellationsVisible(b);
        if (this.modeD) this.modeD.setConstellationsVisible(b);
        if (this.modeE) this.modeE.setConstellationsVisible(b);
        if (this.modeF) this.modeF.setConstellationsVisible(b);
        if (this.modeG) this.modeG.setConstellationsVisible(b);
    }
    setEclipticVisible(v) {
        const b = !!v;
        this.modeA.setEclipticVisible(b);
        if (this.modeB) this.modeB.setEclipticVisible(b);
        if (this.modeC) this.modeC.setEclipticVisible(b);
        if (this.modeD) this.modeD.setEclipticVisible(b);
        if (this.modeE) this.modeE.setEclipticVisible(b);
        if (this.modeF) this.modeF.setEclipticVisible(b);
        if (this.modeG) this.modeG.setEclipticVisible(b);
    }
    setZodiacVisible(v) {
        const b = !!v;
        this.modeA.setZodiacVisible(b);
        if (this.modeB) this.modeB.setZodiacVisible(b);
        if (this.modeC) this.modeC.setZodiacVisible(b);
        if (this.modeD) this.modeD.setZodiacVisible(b);
        if (this.modeE) this.modeE.setZodiacVisible(b);
        if (this.modeF) this.modeF.setZodiacVisible(b);
        if (this.modeG) this.modeG.setZodiacVisible(b);
    }
    setMilkyWayVisible(v) {
        const b = !!v;
        this.modeA.setMilkyWayVisible(b);
        if (this.modeB) this.modeB.setMilkyWayVisible(b);
        if (this.modeC) this.modeC.setMilkyWayVisible(b);
        if (this.modeD) this.modeD.setMilkyWayVisible(b);
        if (this.modeE) this.modeE.setMilkyWayVisible(b);
        if (this.modeF) this.modeF.setMilkyWayVisible(b);
        if (this.modeG) this.modeG.setMilkyWayVisible(b);
    }
    // Mode A's "face outlines" are the 3D dodecahedron wireframe, already
    // controlled by setDodecVisible; fan out to 2D modes only so the new
    // toggle doesn't double-up on the Mode A widget controls.
    setFaceOutlinesVisible(v) {
        const b = !!v;
        if (this.modeA2) this.modeA2.setFaceOutlinesVisible(b);
        if (this.modeA3) this.modeA3.setFaceOutlinesVisible(b);
        if (this.modeI)  this.modeI.setFaceOutlinesVisible(b);
        if (this.modeJ)  this.modeJ.setFaceOutlinesVisible(b);
        if (this.modeB) this.modeB.setFaceOutlinesVisible(b);
        if (this.modeC) this.modeC.setFaceOutlinesVisible(b);
        if (this.modeD) this.modeD.setFaceOutlinesVisible(b);
        if (this.modeE) this.modeE.setFaceOutlinesVisible(b);
        if (this.modeF) this.modeF.setFaceOutlinesVisible(b);
        if (this.modeG) this.modeG.setFaceOutlinesVisible(b);
    }

    // 3x3 row-major rotation matrix taking unit vectors from observer-horizon
    // frame (+Y zenith) to geographic frame (+Y geographic NP, +X lon 0).
    // Time-independent for a fixed observer; main.js builds it from
    // OBSERVER.latitude/longitude and pushes it here once at init.
    // Modes B/C/D/F/G apply it to star directions before projecting, so the
    // stars land on the same polyhedron points that the geographic-frame
    // Earth renderer samples to. Mode A (Earth tilt) and Mode E (per-pixel
    // rotation) handle alignment differently and do not use this.
    setObsToGeographic(m) {
        this._obsToGeo = m || null;
        if (this.modeB) this.modeB.setObsToGeographic(m);
        if (this.modeC) this.modeC.setObsToGeographic(m);
        if (this.modeD) this.modeD.setObsToGeographic(m);
        if (this.modeF) this.modeF.setObsToGeographic(m);
        if (this.modeG) this.modeG.setObsToGeographic(m);
    }

    // 3x3 row-major rotation matrix: rotation FROM the polyhedron's natural
    // frame TO geographic frame. Earth pipelines apply it to face-direction
    // vectors before computing lat/lon; star pipelines see its inverse
    // pre-composed onto obsToGeographic (main.js handles that composition).
    // Two pipelines share the same matrix, so Earth and stars are always
    // aligned regardless of which preset is active.
    setSphereOrientation(R) {
        this._sphereOrientation = R || null;
        this._sphereOrientationMatrix = R || null;
        if (this.modeF) this.modeF.setSphereOrientation(R);
        if (this.modeG) this.modeG.setSphereOrientation(R);
        // Elevation buckets bake R^T into the polyhedron-local projection;
        // re-bucket when N-up/S-up flips.
        this._rebucketAndPushElevation();
    }

    setEarthCanvases(canvases) {
        if (this.modeB) this.modeB.setEarthCanvases(canvases);
        if (this.modeC) this.modeC.setEarthCanvases(canvases);
        if (this.modeD) this.modeD.setEarthCanvases(canvases);
    }

    setEarthImage(img) {
        if (this.modeA2) this.modeA2.setEarthImage(img);
        if (this.modeA3) this.modeA3.setEarthImage(img);
        if (this.modeI)  this.modeI.setEarthImage(img);
        if (this.modeJ)  this.modeJ.setEarthImage(img);
        if (this.modeE) this.modeE.setEarthImage(img);
        if (this.modeF) this.modeF.setEarthImage(img);
        if (this.modeG) this.modeG.setEarthImage(img);
    }

    setEarthMesh(mesh) {
        if (this.modeA) this.modeA.setEarthMesh(mesh);
    }

    setMode(mode) {
        this.currentMode = mode;
        this.modeA.setVisible(mode === 'A');
        if (this.modeA2) this.modeA2.setVisible(mode === 'A2');
        if (this.modeA3) this.modeA3.setVisible(mode === 'A3');
        if (this.modeH)  this.modeH.setVisible(mode === 'H');
        if (this.modeI)  this.modeI.setVisible(mode === 'I');
        if (this.modeJ)  this.modeJ.setVisible(mode === 'J');
        if (this.modeK)  this.modeK.setVisible(mode === 'K');
    }

    getActiveFoldMode() { return this.currentMode === 'J' ? this.modeJ : this.modeI; }

    setModeIPlay() { const m = this.getActiveFoldMode(); if (m) m.play(); }
    setModeIT(t)   { const m = this.getActiveFoldMode(); if (m) m.setT(t); }
    setModeIStrategy(name) { const m = this.getActiveFoldMode(); if (m) m.setStrategy(name); }
    setModeIEasing(name) {
        const m = this.getActiveFoldMode();
        if (m) m.setEasing(name);
    }

    setModeIRenderOrderDirection(dir) {
        const m = this.getActiveFoldMode();
        if (m) m.setRenderOrderDirection(dir);
    }

    setModeITranslucentBlend(mode) {
        const m = this.getActiveFoldMode();
        if (m) m.setTranslucentBlend(mode);
    }

    setModeIRoot(idx)  { const m = this.getActiveFoldMode(); if (m) m.setRoot(idx); }
    cycleModeIRoot(d)  { const m = this.getActiveFoldMode(); if (m) m.cycleRoot(d); }
    getModeIRoot()     { const m = this.getActiveFoldMode(); return m ? m.getRoot() : 0; }
    getModeIFaceCount(){ const m = this.getActiveFoldMode(); return m ? m.faces.length : 0; }
    setModeIFaceLabelsVisible(v) { const m = this.getActiveFoldMode(); if (m) m.setFaceLabelsVisible(v); }
    setModeIFitMode(v) { const m = this.getActiveFoldMode(); if (m) m.setFitMode(v); }
    setModeICameraPos(pos, camera) {
        if (this.modeI) this.modeI.setCameraPos(pos, camera);
        if (this.modeJ) this.modeJ.setCameraPos(pos, camera);
    }

    // Mouse-drag in Mode I/J rotates the polyhedron group instead of orbiting
    // the camera. Forwards to whichever fold mode is currently active.
    applyPolyhedronRotation(dx, dy) {
        const m = this.getActiveFoldMode();
        if (m && m.applyUserRotation) m.applyUserRotation(dx, dy);
    }

    setModeIFoldMode(mode) {
        const m = this.getActiveFoldMode();
        if (!m) return;
        m.setFoldMode(mode);
        // Auto-pick a play speed that gives each stage a visible window.
        // Reference: simultaneous = 0.4 (=> full unfold in 2.5s).
        const stree = m._spanningTree;
        const n = stree ? Math.max(1, stree.order.length - 1) : 1;
        const D = stree ? Math.max(1, stree.maxDepth) : 1;
        if (mode === 'sequential')      m.speed = (0.4 / n) * 6;
        else if (mode === 'wave')       m.speed = (0.4 / D) * 2.5;
        else                            m.speed = 0.4;
    }

    setModeHExaggeration(x) {
        if (this.modeH) this.modeH.setExaggeration(x);
    }

    setModeA2ElevationVisible(v) {
        if (this.modeA2) this.modeA2.setElevationCurvesVisible(v);
    }

    setModeA2ElevationExaggeration(x) {
        if (this.modeA2) this.modeA2.setElevationCurvesExaggeration(x);
        // 2D modes share the same conceptual exaggeration parameter — same
        // formula (face_radius_pixels / EARTH_R_METERS × x) just applied as
        // screen-Y offset instead of radial displacement.
        if (this.modeB) this.modeB.setElevationExaggeration(x);
        if (this.modeC) this.modeC.setElevationExaggeration(x);
        if (this.modeD) this.modeD.setElevationExaggeration(x);
    }

    setModeA2ElevationProjectionMode(mode) {
        if (this.modeA2) this.modeA2.setElevationProjectionMode(mode);
    }

    setModeA2FacesOpaque(v) {
        if (this.modeA2) this.modeA2.setFacesOpaque(v);
    }

    setModeA2EarthSvgPaths(pathData, style) {
        if (this.modeA2) this.modeA2.setEarthSvgPaths(pathData, style);
        // Mode I shares the same per-face SVG path renderer — push the same
        // path data so the unfolding faces show the same Earth as A-2.
        if (this.modeI)  this.modeI.setEarthSvgPaths(pathData, style);
        if (this.modeJ)  this.modeJ.setEarthSvgPaths(null, null);
    }

    setModeA2EdgeRadiusFactor(f) {
        if (this.modeA2 && this.modeA2.setEdgeRadiusFactor) this.modeA2.setEdgeRadiusFactor(f);
        // Mode I's per-face gold edges respect the same thickness factor.
        if (this.modeI  && this.modeI.setEdgeRadiusFactor)  this.modeI.setEdgeRadiusFactor(f);
        if (this.modeJ  && this.modeJ.setEdgeRadiusFactor)  this.modeJ.setEdgeRadiusFactor(f);
    }

    setModeA2EdgeParams(params) {
        if (this.modeA2 && this.modeA2.setEdgeParams) this.modeA2.setEdgeParams(params);
        // Same gold MeshPhongMaterial params apply to Mode I's per-face edges.
        if (this.modeI  && this.modeI.setEdgeParams)  this.modeI.setEdgeParams(params);
        if (this.modeJ  && this.modeJ.setEdgeParams)  this.modeJ.setEdgeParams(params);
    }

    setModeA2ElevationLatStepDeg(step) {
        if (this.modeA2) this.modeA2.setElevationLatStepDeg(step);
        if (this.modeI)  this.modeI.setElevationLatStepDeg(step);
    }

    setModeHLatStepDeg(step) {
        if (this.modeH) this.modeH.setLatStepDeg(step);
    }

    cycleFaceC(delta) { if (this.modeC) this.modeC.cycle(delta); }
    getModeCFaceIdx() { return this.modeC ? this.modeC.faceIdx : 0; }

    setUnfoldStrategy(name) { if (this.modeD) this.modeD.setStrategy(name); }
    getUnfoldStrategy() { return this.modeD ? this.modeD.strategy : null; }

    setImagoVariant(name) { if (this.modeE) this.modeE.setVariant(name); }
    getImagoVariant() { return this.modeE ? this.modeE.variant : null; }

    setModeFEarthMode(mode) { if (this.modeF) this.modeF.setEarthMode(mode); }
    getModeFEarthMode() { return this.modeF ? this.modeF.earthMode : null; }

    setAntarcticaDetached(v) { if (this.modeF) this.modeF.setAntarcticaDetached(!!v); }

    setObserverLatitude(latRad) {
        if (this.modeA2) this.modeA2.setObserverLatitude(latRad);
        if (this.modeA3) this.modeA3.setObserverLatitude(latRad);
        if (this.modeE) this.modeE.setObserverLatitude(latRad);
        if (this.modeF) this.modeF.setObserverLatitude(latRad);
        if (this.modeI) this.modeI.setObserverLatitude(latRad);
        if (this.modeJ) this.modeJ.setObserverLatitude(latRad);
    }

    setModeA3Inflation(t) {
        if (this.modeA3) this.modeA3.setInflation(t);
    }

    setModeA3SubdivisionVisible(v) {
        if (this.modeA3) this.modeA3.setSubdivisionVisible(v);
    }

    setEarthVisible(v)  { if (this.modeA) this.modeA.setEarthVisible(v); }
    setSphereVisible(v) { if (this.modeA) this.modeA.setSphereVisible(v); }
    setDodecVisible(v)  { if (this.modeA) this.modeA.setDodecVisible(v); }
    setDodecOpaque(v)   { if (this.modeA) this.modeA.setDodecOpaque(v); }

    update(starMap) {
        // Single source-of-truth for the twinkling-star shader's time uniform.
        // Every material built by makeTwinkleStarMaterial shares this reference,
        // so one assignment per frame drives the whole shader-star pipeline
        // (Mode A's starPoints + sphereStars, Mode K's astroid field) in sync.
        if (this._twinkleStart == null) this._twinkleStart = performance.now();
        _twinkleStarSharedTime.value = (performance.now() - this._twinkleStart) * 0.001;
        // Push window size to Mode K's thick-line shader so the perpendicular
        // pixel-offset math stays correct after window resizes. Cheap enough
        // to do every frame; only changes when the renderer is reflowed.
        if (this.modeK && this.modeK.lineMaterial && typeof window !== 'undefined') {
            this.modeK.lineMaterial.uniforms.uResolution.value.set(
                window.innerWidth, window.innerHeight);
        }
        if (this.currentMode === 'A') this.modeA.update(starMap, this.getStarProps);
        else if (this.currentMode === 'B' && this.modeB) this.modeB.update(starMap, this.getStarProps);
        else if (this.currentMode === 'C' && this.modeC) this.modeC.update(starMap, this.getStarProps);
        else if (this.currentMode === 'D' && this.modeD) this.modeD.update(starMap, this.getStarProps);
        else if (this.currentMode === 'E' && this.modeE) this.modeE.update(starMap, this.getStarProps);
        else if (this.currentMode === 'F' && this.modeF) this.modeF.update(starMap, this.getStarProps);
        else if (this.currentMode === 'G' && this.modeG) this.modeG.update(starMap, this.getStarProps);
        else if (this.currentMode === 'H' && this.modeH) this.modeH.update();
        else if (this.currentMode === 'I' && this.modeI) this.modeI.update(starMap);
        else if (this.currentMode === 'J' && this.modeJ) this.modeJ.update(starMap);
        else if (this.currentMode === 'K' && this.modeK) this.modeK.update(starMap);
    }
}

export { hexToCss, projectDirToFace };
