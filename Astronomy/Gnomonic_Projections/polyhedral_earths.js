// =====================================================================
// Polyhedral Earth — presentation port.
//
// Slim, modular entry point that wraps the scratchpad-developed ModeI in
// a fixed-camera presentation:
//   - the polyhedron is tilted at Earth's axial obliquity and rotates
//     slowly around its (tilted) polar axis,
//   - tile look + animation behavior are locked to a single design pass
//     (antique gold edges, translucent multiplicative tiles, max-warm
//     tile tint, land-only elevation contours at 0.5° density with 100x
//     vertical exaggeration, continent outlines visible),
//   - exactly two affordances: Fold/Unfold (pill button) and a parchment-
//     framed shape picker showing five tilted wireframe thumbnails.
//
// Designed for extension:
//   - CONFIG below holds every tunable parameter in one place,
//   - PresentationApp.onBeforeUpdate(dt) is a no-op hook future
//     rule-injection (edge-folding constraints, conditional rotation,
//     custom transitions, …) can override,
//   - the underlying ModeI instance is exposed as `app.modeI`, so any
//     scratchpad-developed setter remains usable from the console.
// =====================================================================

import { ModeI } from './polyhedral.js';
import { buildPolyhedron, polyhedronName } from './polyhedra.js';
import { loadEarthSvgPaths, PRESET_PATH_STYLES } from './earth.js';
import {
    bakeAzureParallaxLayers,
    PAL_DEFAULT as AZURE_PAL_DEFAULT,
    P_DEFAULT as AZURE_P_DEFAULT,
} from './azureParallaxBaker.js';

// ---------------------------------------------------------------------
// Configuration. Single source of truth — every visual / animation
// decision the scratchpad converged on lives here. Tweak in place to
// re-tune the presentation without touching wiring code.
// ---------------------------------------------------------------------
const CONFIG = {
    // Visual look.
    sphereRadius: 100,                  // polyhedron R
    earthPreset: 'solid',               // solid-fill continents
    edgePreset: {                       // "antique" gold MeshPhongMaterial
        color: 0xc9a032, specular: 0xe6c878, shininess: 40,
        emissive: 0x2a1c00, emissiveIntensity: 0.40,
    },
    tileTintHex: 0xd8e4ff,              // slightly beyond #DCE6FA toward blue-white
    facesOpaque: false,                 // translucent tiles
    blendMode: 'multiply',              // commutative blend (order-independent)
    elevationVisible: true,
    elevationExag: 150,                 // 150x vertical exaggeration
    elevationLatStepDeg: 0.5,           // 0.5° density (highest)
    landOnly: true,                     // hide ocean depths
    faceOutlines: true,                 // gold per-face edges visible
    showFaceLabels: false,              // no index numbers in presentation
    fitMode: true,                      // keep shape centered + face-on at t=1

    // Star-sphere overlay capacity. Stars are loaded from starcatalogue.json
    // and laid out on a celestial sphere of radius sphereRadius; the
    // camera-pinned shader paints them behind the polyhedron tiles.
    starCapacity: 4000,

    // Animation behavior. Direction-dependent fold-mode + easing — the
    // unfold rolls out as a depth-staggered wave with smooth in-out
    // pacing, the fold collapses everything at once with an in-easing
    // pull-into-place. Setting these on each direction change only
    // affects the hinge timing; the at-t=1 orientation target is
    // captured separately so the world rotation does not snap.
    foldSpeed: 0.35,                    // ~2.9s end-to-end
    unfoldFoldMode: 'wave',
    unfoldEasing:   'easeInOut',
    foldFoldMode:   'simultaneous',
    foldEasing:     'easeOut',          // t runs backward on fold, so this closes as visual ease-in
    // Per-polyhedron unfold strategy. Each shape gets a different cut layout
    // that suits its geometry; falls back to 'steepest' if not listed.
    unfoldStrategyByType: {
        'dymaxionIcosa':       'dymaxion',
        'cube':                'steepest',
        'waterman5':           'butterfly',
        'pentagonalBipyramid': 'equatorial',
        'rhombicDodec':        'fish',
    },
    // Earth rotation: tilt around X by obliquity, then spin around the
    // tilted local Y. Three.js Euler order 'XYZ' applies X first, so
    // rotation.y rotates around the already-tilted polar axis.
    obliquityRad: 23.4 * Math.PI / 180, // Earth's axial tilt (kept — only the
                                        // continuous spin is disabled)
    dailyRotationSpeed: 0,              // main view does not rotate; only the
                                        // picker thumbnails spin (see ShapePicker)
    // Closed-globe auto-spin: rad/s about a SCREEN-FIXED axis tilted at the
    // obliquity from camera-vertical (≈1 revolution / 52s). 0 disables it.
    globeSpinSpeed: (2 * Math.PI) / 52,
    // Map scale by fold state, applied to the map faces only (ModeI's
    // presentation scale — NOT the camera, so the stars/backdrop stay fixed).
    foldedZoom: 0.577,            // folded globe default
    foldedZoomByType: {
        cube: 0.72,
        pentagonalBipyramid: 0.72,
    },
    // Per-shape unfolded-net scale — the nets differ a lot in size. Falls back
    // to unfoldedZoom for any shape not listed.
    unfoldedZoom: 1.0,
    unfoldedZoomByType: {
        dymaxionIcosa:       1.0,
        cube:                0.86,
        waterman5:           0.58,
        pentagonalBipyramid: 0.64,
    },
    // Compute the unfolded net's in-plane rotation from the final hinge
    // geometry so geographic south->north points vertically upward on screen.
    orientUnfoldedPoleAxisVertical: true,
    unfoldTwistOffsetByType: {
        waterman5: -Math.PI / 2,
    },
    initialPolyhedron: 'dymaxionIcosa',
    backgroundColor: 0x2563c8,          // scratchpad azure
    // Picker shapes in display order — the four the presentation supports.
    pickerShapes: ['dymaxionIcosa', 'cube', 'waterman5', 'pentagonalBipyramid'],

    // Progressive elevation-contour density. Polyhedron swaps used to
    // stall on the synchronous 0.5°-density contour rebuild (~600 ms);
    // now we start at coarse 5° (≈30 ms) and ladder up to 0.5° on
    // staggered timers so the shape appears immediately and the finer
    // contour lines layer in while the user is already looking at it.
    progressiveLadder:     [5, 3, 2, 1, 0.5],
    // Delay BEFORE each ladder step (ms). The first entry is unused
    // (the 5° step kicks off immediately); subsequent delays scale up
    // because finer densities take longer to rebuild — give each
    // refinement room to render before queuing the next.
    progressiveStepDelays: [0, 200, 300, 500, 700],
};

// =====================================================================
// Stars + azure backdrop helpers — kept at module scope so the
// PresentationApp methods can call them cleanly. Both pieces mirror the
// behaviour main.js wires for Mode I (camera-pinned star sphere overlay,
// pre-baked parallax cloud-lobe layers with runtime-bake fallback) but
// are slimmed down for the presentation: stars use celestial coords
// directly (no observer-time horizon rotation) since the camera doesn't
// move, and the backdrop init is local to this file.
// =====================================================================

// Mirror of main.js's stylized B-V → RGB ramp via colorFromBV without
// pulling in the whole astronomy / preset machinery.
const SPECTRAL_TABLE = [
    [-0.32, 155, 176, 255], [-0.30, 162, 184, 255], [-0.02, 185, 201, 255],
    [ 0.31, 224, 229, 255], [ 0.50, 246, 243, 255], [ 0.59, 255, 248, 252],
    [ 0.82, 255, 238, 221], [ 1.41, 255, 195, 139], [ 2.00, 255, 198, 109],
];
function _colorFromBV(bv) {
    if (bv == null) return 0xffffff;
    if (bv <= SPECTRAL_TABLE[0][0]) {
        const e = SPECTRAL_TABLE[0]; return (e[1] << 16) | (e[2] << 8) | e[3];
    }
    const last = SPECTRAL_TABLE[SPECTRAL_TABLE.length - 1];
    if (bv >= last[0]) return (last[1] << 16) | (last[2] << 8) | last[3];
    for (let i = 0; i < SPECTRAL_TABLE.length - 1; i++) {
        const a = SPECTRAL_TABLE[i], b = SPECTRAL_TABLE[i + 1];
        if (bv >= a[0] && bv <= b[0]) {
            const f = (bv - a[0]) / (b[0] - a[0]);
            const r = Math.round(a[1] + f * (b[1] - a[1]));
            const g = Math.round(a[2] + f * (b[2] - a[2]));
            const bl = Math.round(a[3] + f * (b[3] - a[3]));
            return (r << 16) | (g << 8) | bl;
        }
    }
    return 0xffffff;
}

// Build the star map directly from starcatalogue.json. Each star carries
// RA/DEC, the magnitude → size mapping, the colour, AND its celestial-
// frame XYZ (the camera-pinned overlay shader reads star.XYZ on every
// frame, so set it once here). No constellation / observer / time data —
// the presentation just shows a static sky behind the polyhedron.
const MAX_MAGNITUDE = 5.8;
async function _loadStarMap(sphereRadius) {
    const res = await fetch('./starcatalogue.json');
    if (!res.ok) throw new Error(`starcatalogue.json: ${res.status}`);
    const entries = await res.json();
    const map = new Map();
    for (const e of entries) {
        if (e.MAG >= MAX_MAGNITUDE) continue;
        const raRad  = e.RA  * Math.PI / 180;
        const decRad = e.DEC * Math.PI / 180;
        const cosDec = Math.cos(decRad);
        const star = {
            ID: e.ID,
            RA: e.RA, DEC: e.DEC, MAG: e.MAG, BV: e.BV,
            colorHex: _colorFromBV(e.BV),
            size: Math.max(0.25, Math.min(1.4,
                1.4 - (Math.min(e.MAG, MAX_MAGNITUDE) - (-1)) / (MAX_MAGNITUDE - (-1)) * (1.4 - 0.25))),
            XYZ: new THREE.Vector3(
                sphereRadius * cosDec * Math.cos(raRad),
                sphereRadius * Math.sin(decRad),
               -sphereRadius * cosDec * Math.sin(raRad),
            ),
        };
        map.set(star.ID, star);
    }
    return map;
}

function _starProps(star) {
    return { visible: true, size: star.size, colorHex: star.colorHex };
}

// ----- Azure backdrop --------------------------------------------------

function _canvasToTexture(canvas) {
    const tex = new THREE.Texture(canvas);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
}

function _loadImageAsCanvas(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const c = document.createElement('canvas');
            c.width  = img.naturalWidth  || img.width;
            c.height = img.naturalHeight || img.height;
            c.getContext('2d').drawImage(img, 0, 0);
            resolve(c);
        };
        img.onerror = () => reject(new Error(`Failed to load ${src}`));
        img.src = src;
    });
}

async function _loadBackdropAssets() {
    const paths = [
        'assets/azure-parallax-layer-0.png',
        'assets/azure-parallax-layer-1.png',
        'assets/azure-parallax-layer-2.png',
        'assets/azure-parallax-layer-3.png',
    ];
    try {
        const [l0, l1, l2, l3, grain] = await Promise.all([
            ...paths.map(_loadImageAsCanvas),
            _loadImageAsCanvas('assets/azure-parallax-grain.png'),
        ]);
        return { layers: [l0, l1, l2, l3], grain };
    } catch (e) {
        console.warn('[presentation] backdrop PNGs missing — falling back to runtime bake', e.message || e);
        const baked = bakeAzureParallaxLayers();
        return { layers: baked.layers, grain: baked.grain };
    }
}

function _hash2i(x, y, seed) {
    let h = (x * 374761393) ^ (y * 668265263) ^ (seed * 2147483647);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h = h ^ (h >>> 16);
    return ((h >>> 0) % 16777216) / 16777216;
}

function _createAzureBackdrop(scene) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        -1, -1, 0,  3, -1, 0,  -1, 3, 0,
    ]), 3));
    const empty = document.createElement('canvas');
    empty.width = empty.height = 1;
    const emptyTex = _canvasToTexture(empty);
    const PAL = AZURE_PAL_DEFAULT;
    const material = new THREE.ShaderMaterial({
        uniforms: {
            uTime:       { value: 0 },
            uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
            uTop: { value: new THREE.Color(PAL.bgTop) },
            uMid: { value: new THREE.Color(PAL.bgMid) },
            uBot: { value: new THREE.Color(PAL.bgBot) },
            uLayer0: { value: emptyTex }, uLayer1: { value: emptyTex },
            uLayer2: { value: emptyTex }, uLayer3: { value: emptyTex },
            uGrain:  { value: emptyTex },
            uLayer0Offset: { value: new THREE.Vector2() },
            uLayer1Offset: { value: new THREE.Vector2() },
            uLayer2Offset: { value: new THREE.Vector2() },
            uLayer3Offset: { value: new THREE.Vector2() },
            uLayer0Size: { value: new THREE.Vector2(1024, 1024) },
            uLayer1Size: { value: new THREE.Vector2(1024, 1024) },
            uLayer2Size: { value: new THREE.Vector2(1024, 1024) },
            uLayer3Size: { value: new THREE.Vector2(1024, 1024) },
        },
        vertexShader: `void main() { gl_Position = vec4(position.xy, 0.99999, 1.0); }`,
        fragmentShader: `
            uniform float uTime;
            uniform vec2 uResolution;
            uniform vec3 uTop, uMid, uBot;
            uniform sampler2D uLayer0, uLayer1, uLayer2, uLayer3, uGrain;
            uniform vec2 uLayer0Offset, uLayer1Offset, uLayer2Offset, uLayer3Offset;
            uniform vec2 uLayer0Size, uLayer1Size, uLayer2Size, uLayer3Size;
            vec3 baseGradient(float t) {
                return (t < 0.48)
                    ? mix(uTop, uMid, t / 0.48)
                    : mix(uMid, uBot, (t - 0.48) / 0.52);
            }
            vec3 overlayBlend(vec3 a, vec3 b) {
                return mix(2.0 * a * b, 1.0 - 2.0 * (1.0 - a) * (1.0 - b), step(vec3(0.5), a));
            }
            void main() {
                vec2 fc = gl_FragCoord.xy;
                vec2 uv = fc / uResolution;
                float t = 1.0 - uv.y;
                vec3 col = baseGradient(t);
                vec4 L;
                L = texture2D(uLayer0, fract((fc - uLayer0Offset) / uLayer0Size)); col = mix(col, L.rgb, L.a);
                L = texture2D(uLayer1, fract((fc - uLayer1Offset) / uLayer1Size)); col = mix(col, L.rgb, L.a);
                L = texture2D(uLayer2, fract((fc - uLayer2Offset) / uLayer2Size)); col = mix(col, L.rgb, L.a);
                L = texture2D(uLayer3, fract((fc - uLayer3Offset) / uLayer3Size)); col = mix(col, L.rgb, L.a);
                // Backdrop grain overlay disabled (0%) for the publishable page.
                vec4 grain = texture2D(uGrain, fract(fc / 256.0));
                col = mix(col, overlayBlend(col, grain.rgb), 0.0);
                float vA; vec3 vCol;
                if (t < 0.48) {
                    float k = t / 0.48;
                    vCol = mix(uTop, uMid, k); vA = mix(0.03, 0.045, k);
                } else {
                    float k = (t - 0.48) / 0.52;
                    vCol = mix(uMid, uBot, k); vA = mix(0.045, 0.12, k);
                }
                col = mix(col, vCol, vA);
                gl_FragColor = vec4(col, 1.0);
            }
        `,
        depthTest: false,
        depthWrite: false,
    });
    const mesh = new THREE.Mesh(geom, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = -1000;
    scene.add(mesh);

    // Lazy-load the parallax PNGs (or runtime-bake them) and slot the
    // textures into the material once ready.
    _loadBackdropAssets().then(({ layers, grain }) => {
        const u = material.uniforms;
        const slots = [u.uLayer0, u.uLayer1, u.uLayer2, u.uLayer3];
        for (let i = 0; i < 4; i++) {
            const src = layers[i] || layers[layers.length - 1];
            slots[i].value = _canvasToTexture(src);
        }
        u.uGrain.value = _canvasToTexture(grain);
    });

    const P = AZURE_P_DEFAULT;
    function updateOffsets(timeSeconds) {
        const u = material.uniforms;
        u.uTime.value = timeSeconds;
        u.uResolution.value.set(window.innerWidth, window.innerHeight);
        const h = Math.max(320, window.innerHeight || 720);
        const baseSize = h * (P.tileScale || 1);
        const seedNudge = P.seed * 0.013;
        const offU  = [u.uLayer0Offset, u.uLayer1Offset, u.uLayer2Offset, u.uLayer3Offset];
        const sizeU = [u.uLayer0Size,   u.uLayer1Size,   u.uLayer2Size,   u.uLayer3Size];
        for (let i = 0; i < 4; i++) {
            const ti = i / 3;
            const speed = (P.baseSpeed || 2) * (1 + ti * (P.speedSpread || 2.2));
            const size  = baseSize * (0.84 + ti * 0.34);
            const xPhase = _hash2i(i, 7,  P.seed) * size;
            const yPhase = (_hash2i(i, 19, P.seed) - 0.5) * size * 0.16;
            const ox = ((xPhase - timeSeconds * speed) % size + size) % size - size;
            const oy = ((yPhase + Math.sin(seedNudge + timeSeconds * 0.025 + i) * size * 0.010) % size + size) % size - size;
            offU[i].value.set(ox, oy);
            sizeU[i].value.set(size, size);
        }
    }
    return { mesh, material, updateOffsets };
}

// =====================================================================
// ShapePicker — parchment-framed strip with five tilted, slowly spinning
// wireframe polyhedron thumbnails. For each thumbnail:
//   - tilt X is fixed at 30° (top leans toward viewer),
//   - rotation Y is updated per frame so the shape spins around its
//     (tilted) polar axis — gives the 3D-legibility the user asked for,
//   - thick "fat-line" (LineSegments2) edges: a solid fat-line draws every
//     edge whose adjacent face is camera-facing in the current pose; a dashed
//     fat-line draws the fully-occluded edges. Visibility is recomputed every
//     frame so the solid/dashed split tracks the rotation,
//   - hatched-ellipse Sprite sits below each as the stylistic shadow,
//   - clicking a cell triggers a damped vertical bounce in that thumbnail
//     and fires onSelect(type) for the host app.
//
// update(dt) drives spin + bounce + hidden-line recomputation + render in
// one tick; the bootstrap RAFs both the picker and the main app.
// =====================================================================
const PICKER_SPIN_SPEED      = 0.25;  // rad/sec — shared spin rate (slow & gentle)
const PICKER_BOUNCE_PEAK_FRAC = 0.08; // bounce peak as a fraction of picker height
const PICKER_BOUNCE_FREQ_HZ  = 3.0;   // bounces per second
const PICKER_BOUNCE_DECAY    = 4.0;   // exponential decay rate (1/sec)
const PICKER_BOUNCE_DURATION = 1.0;   // sec — gate after which bounce state resets
const PICKER_MAX_WIDTH = 520;         // expanded strip width cap (css px); cells = width / 4
const PICKER_COLLAPSED_SCALE = 0.74;  // collapsed square shrinks to this fraction of a cell
const PICKER_MOBILE_QUERY = '(hover: none) and (pointer: coarse)';

// Thick fat-line (LineSegments2) edges for the picker thumbnails. Straight by
// default; an optional hand-drawn wobble can be dialled in via the two knobs
// below (raise SEGMENTS and set JITTER_FRAC > 0).
const PICKER_LINE_WIDTH    = 1.9;   // visible-edge thickness (px at the picker's logical size)
const PICKER_HIDDEN_WIDTH  = 1.3;   // hidden (dashed) edges a touch thinner
const PICKER_EDGE_SEGMENTS = 1;     // 1 = perfectly straight edges
const PICKER_JITTER_FRAC   = 0.0;   // perpendicular wobble as a fraction of R (0 = none)

// Turn a straight edge (v1→v2) into a slightly wavy polyline and return it as
// flat fat-line segment pairs (x1,y1,z1, x2,y2,z2, …) in MODEL space. Interior
// points are nudged along two perpendiculars by a deterministic per-edge amount,
// tapered to zero at the ends so polygon corners still meet. Baked once per
// shape, so the wobble is stable and rotates naturally with the polyhedron.
const _jHash = (n) => { const s = Math.sin(n) * 43758.5453; return s - Math.floor(s); };
function _jitterEdge(v1, v2, amp, seed, segs) {
    const dir = new THREE.Vector3().subVectors(v2, v1);
    dir.multiplyScalar(1 / (dir.length() || 1));
    const ref = Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const perp1 = new THREE.Vector3().crossVectors(dir, ref).normalize();
    const perp2 = new THREE.Vector3().crossVectors(dir, perp1).normalize();
    const pts = [v1.clone()];
    for (let k = 1; k < segs; k++) {
        const t = k / segs;
        const taper = Math.sin(t * Math.PI);                 // 0 at ends, 1 mid-edge
        const n1 = (_jHash(seed * 7.13 + k * 3.70) * 2 - 1) * amp * taper;
        const n2 = (_jHash(seed * 11.7 + k * 5.31 + 1.7) * 2 - 1) * amp * taper;
        pts.push(new THREE.Vector3().lerpVectors(v1, v2, t)
            .addScaledVector(perp1, n1).addScaledVector(perp2, n2));
    }
    pts.push(v2.clone());
    const out = new Float32Array(segs * 6);
    let w = 0;
    for (let k = 0; k < segs; k++) {
        const a = pts[k], b = pts[k + 1];
        out[w++] = a.x; out[w++] = a.y; out[w++] = a.z;
        out[w++] = b.x; out[w++] = b.y; out[w++] = b.z;
    }
    return out;
}

// Directional "sun" for the picker thumbnails. ~30° tilt from vertical with a
// slight forward lean, so shadows cast back-left from each shape and stay
// inside their picker cells. Unit length, direction the rays travel.
const SHADOW_LIGHT_DIR = new THREE.Vector3(-0.45, -0.866, -0.22).normalize();
const SHADOW_GROUND_Y_OFFSET = -42;  // world Y of the ground plane = base + offset

// World-space hatched fragment shader: 45°-ish diagonal lines computed from
// the world XZ position so spacing stays constant across spinning shapes.
const SHADOW_VS = /* glsl */`
    varying vec3 vWorldPos;
    void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
    }
`;
// Crosshatch fragment shader: two perpendicular sets of diagonal lines in
// world-space (so the hatch spacing stays constant across spinning shapes,
// and crossing strokes naturally produce darker spots). A faint base fill
// keeps the silhouette visible everywhere — without it, between-line pixels
// would discard and the shape outline would be lost.
const SHADOW_FS = /* glsl */`
    varying vec3 vWorldPos;
    void main() {
        float d1 = vWorldPos.x + vWorldPos.z;   // +45° lines
        float d2 = vWorldPos.x - vWorldPos.z;   // -45° lines (perpendicular)
        float gap = 5.0;
        float lineWidth = 1.2;
        float p1 = mod(d1, gap);
        float p2 = mod(d2, gap);
        float onLine = step(p1, lineWidth) + step(p2, lineWidth);
        float baseFill = 0.18;       // tint inside the silhouette so it reads
        float a = baseFill + onLine * 0.30;
        gl_FragColor = vec4(0.18, 0.12, 0.02, a);
    }
`;

class ShapePicker {
    constructor(canvas, cellContainer, types, onSelect) {
        this.canvas = canvas;
        this.cellContainer = cellContainer;
        this.types = types;
        this.onSelect = onSelect;
        this.frame = canvas.closest('#shape-picker');
        this.inner = canvas.closest('#picker-inner') || canvas.parentElement;
        this._displayW = canvas.width;
        this._displayH = canvas.height;
        // Bounce amplitude scales with the picker height so the pop keeps its
        // proportion if the canvas/window is resized.
        this._bouncePeak = this._displayH * PICKER_BOUNCE_PEAK_FRAC;
        this._selected = null;
        this._selectedIdx = 0;
        this._mobileQuery = (typeof window !== 'undefined' && window.matchMedia)
            ? window.matchMedia(PICKER_MOBILE_QUERY)
            : null;
        this._mobilePicker = this._isMobilePicker();
        this._expanded = !this._mobilePicker;
        this._animating = false;
        // Per-shape state. _shapeData[i] holds everything needed to update
        // shape i in update(): the Group, the topology, pre-allocated
        // position buffers, the solid + dashed LineSegments, the base Y
        // position (for the bounce to add to), and a clone of the rotated-
        // normal scratch space.
        this._shapeData = [];
        this._spinAngle = 0;
        this._bounceStartMs = [];
        this._tiltX = Math.PI / 6;
        this._setupRenderer();
        this._setupScene();
        this._buildShapes();
        this._buildCells();
        this._layout();
        // Tap the collapsed mobile frame to expand to the full strip.
        if (this.frame) {
            this.frame.addEventListener('click', () => {
                if (this._mobilePicker && !this._expanded && !this._animating) this.expand();
            });
        }
        const syncPickerMode = () => {
            this._syncResponsiveMode();
            this._layout();
        };
        window.addEventListener('resize', syncPickerMode);
        if (this._mobileQuery) {
            if (this._mobileQuery.addEventListener) {
                this._mobileQuery.addEventListener('change', syncPickerMode);
            } else if (this._mobileQuery.addListener) {
                this._mobileQuery.addListener(syncPickerMode);
            }
        }
        // Enable the size/pan transitions only after the first layout has
        // painted, so the initial collapsed state doesn't animate in.
        requestAnimationFrame(() => { if (this.frame) this.frame.classList.add('animated'); });
        // First frame so something is on screen before update() ticks.
        this._render();
    }

    // Responsive sizing: the expanded strip width (capped) and the square cell
    // size; sets the inner strip width and applies the current geometry.
    _layout() {
        this._stripW = Math.min(PICKER_MAX_WIDTH, window.innerWidth - 32);
        this._cellPx = this._stripW / this.types.length;
        // Canvas display height (the strip is short/landscape). The collapsed
        // square's side equals it, so the collapsed frame stays a true square.
        this._squareSide = this._stripW * this._displayH / this._displayW;
        if (this.inner) this.inner.style.width = this._stripW + 'px';
        this._applyExpandState();
    }

    _isMobilePicker() {
        return !!(this._mobileQuery && this._mobileQuery.matches);
    }

    _syncResponsiveMode() {
        const mobile = this._isMobilePicker();
        if (mobile === this._mobilePicker) return;
        this._mobilePicker = mobile;
        this._expanded = !mobile;
        this._animating = false;
    }

    _syncFrameClasses() {
        if (!this.frame) return;
        this.frame.classList.toggle('expanded', this._expanded);
        this.frame.classList.toggle('collapsed', !this._expanded);
    }

    // Frame width = one cell (collapsed) or the full strip (expanded); the inner
    // strip pans so the selected cell is the one shown when collapsed.
    _applyExpandState() {
        if (!this.frame || !this.inner) return;
        this._syncFrameClasses();
        if (this._expanded) {
            this.frame.style.width = this._stripW.toFixed(1) + 'px';
            this.frame.style.transform = 'scale(1)';
            this.inner.style.transform = 'translateX(0px)';
        } else {
            // Collapsed: a square crop of the (landscape) selected cell, panned
            // so that cell's centre sits at the centre of the square.
            this.frame.style.width = this._squareSide.toFixed(1) + 'px';
            this.frame.style.transform = `scale(${PICKER_COLLAPSED_SCALE})`;
            const t = this._squareSide / 2 - (this._selectedIdx + 0.5) * this._cellPx;
            this.inner.style.transform = `translateX(${t.toFixed(1)}px)`;
        }
    }

    expand() {
        if (this._expanded) return;
        this._expanded = true;
        this._syncFrameClasses();
        this._beginAnim();
        this._applyExpandState();
    }

    collapse() {
        if (!this._mobilePicker || !this._expanded) return;
        this._expanded = false;
        this._syncFrameClasses();
        this._beginAnim();
        this._applyExpandState();
    }

    _beginAnim() {
        this._animating = true;
        clearTimeout(this._animTimer);
        this._animTimer = setTimeout(() => { this._animating = false; }, 420);
    }

    _setupRenderer() {
        // Transparent clear so the parchment HTML background shows through.
        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas, antialias: true, alpha: true,
        });
        this.renderer.setPixelRatio(window.devicePixelRatio || 1);
        this.renderer.setSize(this._displayW, this._displayH, false);
        this.renderer.setClearColor(0x000000, 0);
    }

    _setupScene() {
        this.scene = new THREE.Scene();
        // Orthographic camera with canvas pixels == world units. Lets each
        // shape sit at a known world-x and render at predictable on-canvas
        // size regardless of viewport scale.
        const w = this._displayW, h = this._displayH;
        this.camera = new THREE.OrthographicCamera(
            -w / 2, w / 2, h / 2, -h / 2, 1, 1000,
        );
        this.camera.position.set(0, 0, 300);
        this.camera.lookAt(0, 0, 0);
    }

    _buildShapes() {
        // Shape size scales with the picker window (capped by cell width so
        // neighbours never collide). yOffset + bounce + R must stay within
        // ±displayH/2 or the bounce clips the top edge, hence these fractions.
        const cellW = this._displayW / this.types.length;
        const R = Math.min(this._displayH * 0.38, cellW * 0.45);  // circumradius, px
        const yOffset = this._displayH * 0.03;   // lift to leave room for shadow

        for (let i = 0; i < this.types.length; i++) {
            const type = this.types[i];
            const poly = buildPolyhedron(type, R);
            const topology = buildEdgeTopology(poly.faces);
            const maxEdges = topology.edges.length;
            // One Group per shape, holding two LineSegments children + the
            // per-frame rotation. Position carries the per-shape x and the
            // bouncing y; rotation.y carries the spin.
            const group = new THREE.Group();
            const cellCenterX = (i + 0.5) * cellW - this._displayW / 2;
            group.position.set(cellCenterX, yOffset, 0);
            group.rotation.order = 'XYZ';
            group.rotation.x = this._tiltX;
            group.rotation.y = 0;

            // Thick fat-line (LineSegments2) edges. The geometry buffers are
            // allocated ONCE at full size and updated IN PLACE each frame —
            // only instanceCount changes. (Rebuilding the buffers per frame via
            // setPositions, off a reused/overwritten array, was making edges
            // blink in and out.) Each edge is pre-built into segment pairs
            // (straight unless the wobble knobs are raised); _updateWireframe
            // routes visible→solid, fully-occluded→dashed.
            const SEG = PICKER_EDGE_SEGMENTS;
            const amp = R * PICKER_JITTER_FRAC;
            const edgeSegs = topology.edges.map((e, ei) =>
                _jitterEdge(topology.vertices[e.v1], topology.vertices[e.v2], amp, ei + 1, SEG));
            // Per-edge cumulative arc length per sub-segment (d0,d1) for dashing.
            const edgeDist = edgeSegs.map((s) => {
                const d = new Float32Array(SEG * 2);
                let acc = 0;
                for (let k = 0; k < SEG; k++) {
                    const o = k * 6;
                    const len = Math.hypot(s[o+3]-s[o], s[o+4]-s[o+1], s[o+5]-s[o+2]);
                    d[k*2] = acc; acc += len; d[k*2+1] = acc;
                }
                return d;
            });
            const instTotal = maxEdges * SEG;

            const solidGeom  = new THREE.LineSegmentsGeometry();
            const dashedGeom = new THREE.LineSegmentsGeometry();
            solidGeom.setPositions(new Float32Array(instTotal * 6));
            dashedGeom.setPositions(new Float32Array(instTotal * 6));

            const solidMat = new THREE.LineMaterial({
                color: 0x2d1e0a, linewidth: PICKER_LINE_WIDTH,
            });
            const dashedMat = new THREE.LineMaterial({
                color: 0x2d1e0a, linewidth: PICKER_HIDDEN_WIDTH,
                dashed: true, dashSize: 4, gapSize: 3,
            });
            // examples/js LineMaterial doesn't add the dash #define from
            // `dashed:true`, so enable it explicitly (else hidden edges render
            // solid). Both materials are opaque with depth test/write OFF: the
            // wireframe is a flat overlay, so layering is by renderOrder only —
            // dashed (hidden) under, solid (visible) on top — which removes the
            // depth-fight blinking.
            dashedMat.defines = Object.assign({}, dashedMat.defines, { USE_DASH: '' });
            dashedMat.needsUpdate = true;
            solidMat.resolution.set(this._displayW, this._displayH);
            dashedMat.resolution.set(this._displayW, this._displayH);
            solidMat.depthTest = false;  solidMat.depthWrite = false;
            dashedMat.depthTest = false; dashedMat.depthWrite = false;

            const solid  = new THREE.LineSegments2(solidGeom,  solidMat);
            const dashed = new THREE.LineSegments2(dashedGeom, dashedMat);
            // computeLineDistances lives on LineSegments2 (not the geometry);
            // this allocates instanceDistanceStart/End, which we fill in place.
            dashed.computeLineDistances();
            solid.frustumCulled = false;
            dashed.frustumCulled = false;
            dashed.renderOrder = 1;
            solid.renderOrder = 2;
            group.add(dashed);
            group.add(solid);
            this.scene.add(group);

            // Projected silhouette shadow. Mesh sits in scene-space (NOT a
            // child of the shape's group) so the group's rotation + bounce
            // never deform the shadow; per-frame _updateShadow rebuilds its
            // geometry from the current pose. Custom ShaderMaterial does
            // world-space hatching so dashing stays at a constant spacing
            // regardless of which shape it's painting.
            const maxV = topology.vertices.length;
            const shadowMaxTris = Math.max(1, maxV - 2);
            const shadowPositions = new Float32Array(shadowMaxTris * 9);
            const shadowGeom = new THREE.BufferGeometry();
            shadowGeom.setAttribute('position', new THREE.BufferAttribute(shadowPositions, 3));
            shadowGeom.setDrawRange(0, 0);
            const shadowMat = new THREE.ShaderMaterial({
                vertexShader: SHADOW_VS,
                fragmentShader: SHADOW_FS,
                transparent: true,
                depthWrite: false,
                side: THREE.DoubleSide,
            });
            const shadow = new THREE.Mesh(shadowGeom, shadowMat);
            this.scene.add(shadow);

            // Cache per-face outward normals as a flat Float32Array so the
            // per-frame hidden-line recomputation can do a single matrix
            // multiply per face without re-reading Vector3 objects.
            const normals = new Float32Array(poly.faces.length * 3);
            for (let fi = 0; fi < poly.faces.length; fi++) {
                normals[fi * 3]     = poly.faces[fi].normal.x;
                normals[fi * 3 + 1] = poly.faces[fi].normal.y;
                normals[fi * 3 + 2] = poly.faces[fi].normal.z;
            }
            // Per-face Z component scratch space (camera looks down -Z, so
            // facesZ[fi] > 0 means face fi is camera-facing).
            const facesZ = new Float32Array(poly.faces.length);

            this._shapeData.push({
                group, solid, dashed, topology,
                edgeSegs, edgeDist, seg: SEG,
                normals, facesZ,
                shadow, shadowPositions,
                cellCenterX,
                baseY: yOffset,
                groundY: yOffset + SHADOW_GROUND_Y_OFFSET,
            });
            this._bounceStartMs.push(null);

            // First-frame hidden-line split + shadow for the initial pose.
            const idx = this._shapeData.length - 1;
            this._updateWireframe(idx);
            this._updateShadow(idx);
        }
    }

    // Recompute solid/dashed edge split for shape i from its current
    // rotation. Writes positions into the pre-allocated buffers and sets
    // each LineSegments' drawRange; recomputes line distances on the
    // dashed segments so the dash pattern stays consistent as the
    // geometry shifts.
    _updateWireframe(i) {
        const data = this._shapeData[i];
        const { topology, group, solid, dashed, edgeSegs, edgeDist, seg, normals, facesZ } = data;
        const rot = new THREE.Matrix4().makeRotationFromEuler(group.rotation);
        const nTmp = new THREE.Vector3();
        const nFaces = facesZ.length;
        for (let fi = 0; fi < nFaces; fi++) {
            nTmp.set(normals[fi * 3], normals[fi * 3 + 1], normals[fi * 3 + 2])
                .applyMatrix4(rot);
            facesZ[fi] = nTmp.z;
        }

        // Update the fixed-size fat-line buffers IN PLACE; instanceCount picks
        // how many sub-segments actually draw. Visible edges → solid buffer,
        // fully-occluded edges → dashed buffer (with their dash distances).
        const sPos  = solid.geometry.attributes.instanceStart.data;
        const dPos  = dashed.geometry.attributes.instanceStart.data;
        const dDist = dashed.geometry.attributes.instanceDistanceStart.data;
        const sArr = sPos.array, dArr = dPos.array, dDistArr = dDist.array;
        const edges = topology.edges;
        let si = 0, di = 0;   // sub-segment instance counts
        for (let ei = 0; ei < edges.length; ei++) {
            const edge = edges[ei];
            const fa = edge.faces[0], fb = edge.faces[1];
            const aFront = fa != null && facesZ[fa] > 0;
            const bFront = fb != null && facesZ[fb] > 0;
            if (!aFront && !bFront) {
                dArr.set(edgeSegs[ei], di * 6);
                dDistArr.set(edgeDist[ei], di * 2);
                di += seg;
            } else {
                sArr.set(edgeSegs[ei], si * 6);
                si += seg;
            }
        }
        sPos.needsUpdate = true;
        dPos.needsUpdate = true;
        dDist.needsUpdate = true;
        solid.geometry.instanceCount = si;
        dashed.geometry.instanceCount = di;
    }

    // Trigger a damped vertical bounce on shape i. Re-triggering while a
    // bounce is already running just restarts it from t=0.
    _triggerBounce(i) {
        this._bounceStartMs[i] = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    }

    // Per-frame integration: advance the shared spin angle while expanded,
    // apply spin + bounce to each shape, recompute hidden-line dashing, render.
    update(dt) {
        if (this._expanded) this._spinAngle += PICKER_SPIN_SPEED * dt;
        const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        for (let i = 0; i < this._shapeData.length; i++) {
            const data = this._shapeData[i];
            data.group.rotation.y = this._spinAngle;

            // Damped bounce: peaks at every half-cycle of sin (so each
            // bounce looks like a real ball hitting an invisible floor),
            // exponentially decaying. After PICKER_BOUNCE_DURATION the
            // bounce is settled — clear the trigger so the shape is back
            // to baseline.
            const tStart = this._bounceStartMs[i];
            let bounceY = 0;
            if (tStart != null) {
                const e = (now - tStart) / 1000;
                if (e > PICKER_BOUNCE_DURATION) {
                    this._bounceStartMs[i] = null;
                } else {
                    bounceY = this._bouncePeak
                            * Math.abs(Math.sin(e * 2 * Math.PI * PICKER_BOUNCE_FREQ_HZ))
                            * Math.exp(-PICKER_BOUNCE_DECAY * e);
                }
            }
            data.group.position.y = data.baseY + bounceY;

            this._updateWireframe(i);
            this._updateShadow(i);
        }
        this._render();
    }

    // Re-project the polyhedron's silhouette onto the ground plane via the
    // directional light, and build the triangle fan that fills it. Called
    // per frame so the shadow tracks the spin. Vertices are transformed
    // by the shape's *base* position (not the bouncing position) so the
    // shadow stays anchored to the ground while the shape pops up.
    _updateShadow(i) {
        const data = this._shapeData[i];
        const { topology, group, shadow, shadowPositions, cellCenterX, baseY, groundY } = data;
        const verts = topology.vertices;
        const rot = new THREE.Matrix4().makeRotationFromEuler(group.rotation);
        const v = new THREE.Vector3();
        const lx = SHADOW_LIGHT_DIR.x;
        const ly = SHADOW_LIGHT_DIR.y;
        const lz = SHADOW_LIGHT_DIR.z;

        // Project each unique vertex onto the ground plane along the light
        // direction; collect 2D (x, z) coords for the hull.
        const projected = new Array(verts.length);
        for (let vi = 0; vi < verts.length; vi++) {
            v.copy(verts[vi]).applyMatrix4(rot);
            const wx = v.x + cellCenterX;
            const wy = v.y + baseY;
            const wz = v.z;
            const t = (groundY - wy) / ly;   // ly < 0; t > 0 for vertices above ground
            projected[vi] = { x: wx + t * lx, z: wz + t * lz };
        }

        // 2D convex hull = the silhouette outline (convex polyhedron + parallel
        // light → projected point set is itself convex).
        const hull = convexHull2D(projected);
        let w = 0;
        for (let k = 1; k < hull.length - 1; k++) {
            const a = hull[0], b = hull[k], c = hull[k + 1];
            shadowPositions[w++] = a.x; shadowPositions[w++] = groundY; shadowPositions[w++] = a.z;
            shadowPositions[w++] = b.x; shadowPositions[w++] = groundY; shadowPositions[w++] = b.z;
            shadowPositions[w++] = c.x; shadowPositions[w++] = groundY; shadowPositions[w++] = c.z;
        }
        shadow.geometry.attributes.position.needsUpdate = true;
        shadow.geometry.setDrawRange(0, w / 3);
    }

    _buildCells() {
        // Build the click-target overlay divs. Each cell occupies 1/N of the
        // canvas width; CSS handles the hover/active visuals.
        this.cellContainer.innerHTML = '';
        for (let i = 0; i < this.types.length; i++) {
            const type = this.types[i];
            const cell = document.createElement('div');
            cell.className = 'picker-cell';
            cell.dataset.shape = type;
            cell.title = polyhedronName(type);
            cell.addEventListener('click', (e) => {
                if (this._animating || (this._mobilePicker && !this._expanded)) return;
                e.stopPropagation();   // don't let the frame's click re-expand
                if (type !== this._selected) {
                    this.setSelected(type);
                    this.onSelect(type);
                }
                this._triggerBounce(i);
                if (this._mobilePicker) this.collapse();
            });
            this.cellContainer.appendChild(cell);
        }
    }

    setSelected(type) {
        const idx = this.types.indexOf(type);
        if (idx < 0 || type === this._selected) return;
        this._selected = type;
        this._selectedIdx = idx;
        for (const cell of this.cellContainer.children) {
            cell.classList.toggle('active', cell.dataset.shape === type);
        }
        // When collapsed, re-pan so the single shown shape is the new one.
        if (!this._expanded) this._applyExpandState();
    }

    _render() {
        this.renderer.render(this.scene, this.camera);
    }
}

// Andrew's monotone-chain convex hull on (x, z) points. Returns the hull in
// counter-clockwise order. Used by ShapePicker for the projected-silhouette
// shadow: convex polyhedron + parallel light → projected vertex set is
// itself convex, so its 2D hull IS the silhouette outline.
function convexHull2D(points) {
    const p = points.slice().sort((a, b) => a.x - b.x || a.z - b.z);
    const n = p.length;
    if (n <= 2) return p;
    const cross = (O, A, B) =>
        (A.x - O.x) * (B.z - O.z) - (A.z - O.z) * (B.x - O.x);
    const lower = [];
    for (const pt of p) {
        while (lower.length >= 2 &&
               cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) {
            lower.pop();
        }
        lower.push(pt);
    }
    const upper = [];
    for (let i = n - 1; i >= 0; i--) {
        const pt = p[i];
        while (upper.length >= 2 &&
               cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) {
            upper.pop();
        }
        upper.push(pt);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
}

// Deduplicate vertices + collect edges with their up-to-2 adjacent face
// indices. Returns { vertices: [Vector3], edges: [{ v1, v2, faces: [i,j?] }] }.
// Mode I has the same routine inline (_buildTopology); kept separate here so
// ShapePicker stays standalone.
function buildEdgeTopology(faces) {
    const vertices = [];
    const vertexIdx = new Map();
    const key = v => `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`;
    const addV = v => {
        const k = key(v);
        if (vertexIdx.has(k)) return vertexIdx.get(k);
        const i = vertices.length;
        vertexIdx.set(k, i);
        vertices.push(v.clone());
        return i;
    };
    const faceVerts = faces.map(f => f.vertices3D.map(addV));
    const edgeMap = new Map();
    const edges = [];
    for (let fi = 0; fi < faces.length; fi++) {
        const vs = faceVerts[fi];
        for (let i = 0; i < vs.length; i++) {
            const a = vs[i], b = vs[(i + 1) % vs.length];
            const lo = Math.min(a, b), hi = Math.max(a, b);
            const k = `${lo}_${hi}`;
            if (!edgeMap.has(k)) {
                edgeMap.set(k, edges.length);
                edges.push({ v1: lo, v2: hi, faces: [] });
            }
            edges[edgeMap.get(k)].faces.push(fi);
        }
    }
    return { vertices, edges };
}

// =====================================================================
// PresentationApp — owns the scene + ModeI + per-frame loop.
// =====================================================================
class PresentationApp {
    constructor(host) {
        this.host = host;
        this.config = CONFIG;
        this._polyhedronType = this.config.initialPolyhedron;
        this._dailyAngle = 0;
        this._lastFrameMs = null;
        this._earthPaths = null;
        this._earthStyle = null;
        this._starMap = null;

        this._setupRenderer();
        this._setupScene();
        this._setupLights();
        // Azure parallax backdrop — fullscreen-triangle behind all geometry.
        this._backdrop = _createAzureBackdrop(this.scene);
        this._buildPolyhedronAndMode();
        this._initGlobeSpinAxis();
        this._applyAllSettings();
        this._loadEarthPaths();
        this._loadStars();
        this._setupDragControls();
        // Density ladder kicks off the contour pipeline. First step (5°)
        // fires immediately; the rest are queued on timers so the page
        // becomes interactive while the high-density binary downloads.
        this._scheduleProgressiveContours();
    }

    async _loadStars() {
        try {
            this._starMap = await _loadStarMap(this.config.sphereRadius);
            if (this.modeI && this.modeI.setStarPropsFn) {
                this.modeI.setStarPropsFn(_starProps);
            }
        } catch (e) {
            console.warn('[presentation] star catalog load failed', e);
        }
    }

    _setupDragControls() {
        // Mirror main.js's Mode I behaviour: OrbitControls left-drag is off
        // (camera stays put, which keeps the camera-pinned star sphere
        // stable), pointer drag instead rotates the polyhedron itself. A press
        // that does NOT drag (a click/tap) toggles fold/unfold — this replaces
        // the old Unfold button.
        if (this.controls) this.controls.enableRotate = false;
        const canvas = this.renderer.domElement;
        canvas.style.touchAction = 'none';
        const TAP_SLOP = 6;            // px of travel under which it counts as a tap
        const PINCH_SETTLE_MS = 90;    // ignore unstable first pinch samples
        const POST_TAP_ZOOM_LOCK_MS = 180;
        const PINCH_ZOOM_MAX_LOG_STEP = 0.035;
        const PINCH_ZOOM_RESPONSE = 0.55;
        const PINCH_ZOOM_DEADBAND_LOG = 0.0035;
        const activeTouches = new Map();
        let dragging = false, activePointerId = null;
        let lastX = 0, lastY = 0, downX = 0, downY = 0;
        let suppressTap = false;
        let pinchStartMs = 0;
        let pinchZoomSamples = 0;
        let lastTapMs = -Infinity;

        const nowMs = () => (typeof performance !== 'undefined')
            ? performance.now()
            : Date.now();

        const capturePointer = (id) => {
            if (id == null) return;
            try { canvas.setPointerCapture(id); } catch (err) {}
        };

        const captureActiveTouches = () => {
            for (const id of activeTouches.keys()) capturePointer(id);
        };

        const releasePointer = (id) => {
            if (id == null) return;
            try { canvas.releasePointerCapture(id); } catch (err) {}
        };

        const touchPair = () => {
            if (activeTouches.size !== 2) return null;
            const pts = Array.from(activeTouches.values());
            const dx = pts[1].x - pts[0].x;
            const dy = pts[1].y - pts[0].y;
            return {
                x: (pts[0].x + pts[1].x) * 0.5,
                y: (pts[0].y + pts[1].y) * 0.5,
                dist: Math.hypot(dx, dy),
                angle: Math.atan2(dy, dx),
            };
        };

        let lastTouchPair = null;
        const beginTwoFingerGesture = () => {
            suppressTap = true;
            dragging = false;
            activePointerId = null;
            captureActiveTouches();
            lastTouchPair = touchPair();
            pinchStartMs = nowMs();
            pinchZoomSamples = 0;
        };

        const applyPinchZoom = (ratio) => {
            if (!Number.isFinite(ratio) || ratio <= 0 || !this.camera) return;
            const elapsed = nowMs() - pinchStartMs;
            pinchZoomSamples += 1;
            if (pinchZoomSamples <= 1 || elapsed < PINCH_SETTLE_MS
                || nowMs() - lastTapMs < POST_TAP_ZOOM_LOCK_MS) return;
            const logRatio = Math.log(ratio);
            if (Math.abs(logRatio) < PINCH_ZOOM_DEADBAND_LOG) return;
            const clampedLog = Math.max(
                -PINCH_ZOOM_MAX_LOG_STEP,
                Math.min(PINCH_ZOOM_MAX_LOG_STEP, logRatio),
            );
            const easedRatio = Math.exp(clampedLog * PINCH_ZOOM_RESPONSE);
            const target = (this.controls && this.controls.target)
                ? this.controls.target
                : new THREE.Vector3();
            const offset = this.camera.position.clone().sub(target);
            const dist = offset.length();
            if (dist <= 1e-6) return;
            const minD = this.controls && Number.isFinite(this.controls.minDistance)
                ? this.controls.minDistance
                : 1;
            const maxD = this.controls && Number.isFinite(this.controls.maxDistance)
                ? this.controls.maxDistance
                : Infinity;
            const nextDist = Math.max(minD, Math.min(maxD, dist / easedRatio));
            offset.setLength(nextDist);
            this.camera.position.copy(target).add(offset);
            this.camera.updateMatrixWorld();
        };

        const applyPinchPan = (dx, dy) => {
            if (!this.camera || !this.controls || !this.controls.target) return;
            const h = canvas.clientHeight || window.innerHeight || 1;
            const target = this.controls.target;
            const distance = this.camera.position.distanceTo(target);
            const worldPerPixel = 2 * distance
                * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) * 0.5) / h;
            this.camera.updateMatrixWorld();
            const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
            const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
            const pan = new THREE.Vector3()
                .addScaledVector(right, -dx * worldPerPixel)
                .addScaledVector(up, dy * worldPerPixel);
            this.camera.position.add(pan);
            target.add(pan);
            this.camera.updateMatrixWorld();
        };

        const normalizedAngleDelta = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

        const applyPinchTwist = (deltaAngle) => {
            if (!Number.isFinite(deltaAngle) || Math.abs(deltaAngle) < 1e-4
                || !this.camera || !this.modeI || !this.modeI.applyWorldSpin) return;
            const axis = new THREE.Vector3();
            this.camera.getWorldDirection(axis);
            this.modeI.applyWorldSpin(axis.normalize(), deltaAngle);
        };

        const updateTwoFingerGesture = () => {
            const pair = touchPair();
            if (!pair) {
                lastTouchPair = null;
                return;
            }
            if (lastTouchPair) {
                applyPinchPan(pair.x - lastTouchPair.x, pair.y - lastTouchPair.y);
                if (lastTouchPair.dist > 1e-3) applyPinchZoom(pair.dist / lastTouchPair.dist);
                if (lastTouchPair.dist > 12 && pair.dist > 12) {
                    applyPinchTwist(normalizedAngleDelta(pair.angle, lastTouchPair.angle));
                }
            }
            lastTouchPair = pair;
        };

        canvas.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            if (e.pointerType === 'touch') {
                activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
                if (activeTouches.size > 1) {
                    beginTwoFingerGesture();
                    return;
                }
            }
            dragging = true;
            activePointerId = e.pointerId;
            suppressTap = false;
            lastX = downX = e.clientX;
            lastY = downY = e.clientY;
            capturePointer(e.pointerId);
        });
        canvas.addEventListener('pointermove', (e) => {
            if (e.pointerType === 'touch') {
                if (!activeTouches.has(e.pointerId)) return;
                activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
                if (activeTouches.size > 1) {
                    updateTwoFingerGesture();
                    return;
                }
            }
            if (!dragging || e.pointerId !== activePointerId
                || !this.modeI || !this.modeI.applyUserRotation) return;
            const dx = e.clientX - lastX;
            const dy = e.clientY - lastY;
            lastX = e.clientX;
            lastY = e.clientY;
            this.modeI.applyUserRotation(dx, dy);
        });
        canvas.addEventListener('pointerup', (e) => {
            if (e.pointerType === 'touch') activeTouches.delete(e.pointerId);
            if (activeTouches.size < 2) lastTouchPair = null;
            if (!dragging || e.pointerId !== activePointerId) {
                if (activeTouches.size === 0) suppressTap = false;
                releasePointer(e.pointerId);
                return;
            }
            dragging = false;
            activePointerId = null;
            releasePointer(e.pointerId);
            // Negligible travel since pointerdown → it's a tap: toggle the fold.
            if (!suppressTap && Math.hypot(e.clientX - downX, e.clientY - downY) <= TAP_SLOP) {
                lastTapMs = nowMs();
                this.toggleFold();
            }
            if (activeTouches.size === 0) suppressTap = false;
        });
        canvas.addEventListener('pointercancel', (e) => {
            if (e.pointerType === 'touch') activeTouches.delete(e.pointerId);
            if (activeTouches.size < 2) lastTouchPair = null;
            if (e.pointerId === activePointerId || activeTouches.size === 0) {
                dragging = false;
                activePointerId = null;
            }
            if (activeTouches.size === 0) suppressTap = false;
            releasePointer(e.pointerId);
        });
    }

    _setupRenderer() {
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio || 1);
        this.renderer.setClearColor(this.config.backgroundColor, 1);
        this.host.appendChild(this.renderer.domElement);
    }

    _setupScene() {
        this.scene = new THREE.Scene();
        // Mouse-draggable camera. OrbitControls handles left-drag = orbit,
        // right-drag = pan, wheel = zoom; damping smooths inertia. The
        // camera-facing rotation in Mode I tracks the live camera position
        // each frame (setCameraPos), so orbiting the camera while unfolded
        // keeps the flat net face-on to whichever direction is current.
        this.camera = new THREE.PerspectiveCamera(
            55, window.innerWidth / window.innerHeight, 0.1, 4000,
        );
        this.camera.position.set(0, 60, 280);
        this.camera.lookAt(0, 0, 0);
        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.minDistance = 100;
        this.controls.maxDistance = 800;
        this.controls.enablePan = false;
        // Auto-spin axis for the closed globe, in CAMERA space: "up" tilted by
        // the obliquity in the picture plane. Mapped to world in
        // _initGlobeSpinAxis(); the camera never rotates (zoom only), so the
        // axis stays fixed on screen no matter how the user spins the globe.
        const tilt = this.config.obliquityRad;
        this._spinAxisCam = new THREE.Vector3(Math.sin(tilt), Math.cos(tilt), 0);
        this._spinAxisWorld = new THREE.Vector3(0, 1, 0);
        this._spinSpeed = this.config.globeSpinSpeed || 0;
        window.addEventListener('resize', () => {
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            // Re-sync pixel ratio too: toggling the device toolbar changes
            // devicePixelRatio, and a stale ratio renders the contour lines at
            // the wrong resolution (the aliasing artifacts). Capped at 2.
            this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
            this.renderer.setSize(window.innerWidth, window.innerHeight);
        });
    }

    _setupLights() {
        // The gold edges (MeshPhongMaterial) respond to these. Mode I's
        // textured face meshes use MeshBasicMaterial and ignore them.
        this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
        const key  = new THREE.DirectionalLight(0xffffff, 0.65);
        const fill = new THREE.DirectionalLight(0xfff2c8, 0.25);
        key.position.set(80, 220, 140);
        fill.position.set(-90, -40, 120);
        this.scene.add(key);
        this.scene.add(fill);
    }

    // Build (or rebuild) the polyhedron + ModeI for the current type. On
    // first call this constructs ModeI; subsequent calls reuse the same
    // instance via setPolyhedron so animation state is preserved.
    _buildPolyhedronAndMode() {
        const poly = buildPolyhedron(this._polyhedronType, this.config.sphereRadius);
        if (!this.modeI) {
            // starCapacity > 0 wires the camera-pinned twinkle-star overlay
            // inside ModeI. _loadStars hands the catalog to setStarPropsFn
            // once it finishes; update(starMap) feeds the buffers each frame.
            this.modeI = new ModeI(this.scene, poly, this.config.starCapacity || 0);
            if (this._starMap && this.modeI.setStarPropsFn) {
                this.modeI.setStarPropsFn(_starProps);
            }
        } else {
            this.modeI.setPolyhedron(poly);
        }
        this.modeI.setVisible(true);
        // Earth-tilt is routed through ModeI.setObserverLatitude — its
        // internal _applyGroupRotation composes group.quaternion as
        // (_userRotation * latRotQuat), so any other rotation we set on
        // group.rotation.x would be overwritten the moment the user drags.
        // Picking `lat = PI/2 + obliquity` makes latRot = setFromAxisAngle(X,
        // obliquity), so the polyhedron ends up tilted at Earth's axial
        // obliquity and stays there across user drags.
        this.modeI.setObserverLatitude(Math.PI / 2 + this.config.obliquityRad);
    }

    // Re-stamp every CONFIG-driven setter on Mode I. Called after every
    // polyhedron swap so the look doesn't get lost when the topology
    // changes underneath us.
    _applyAllSettings() {
        const c = this.config;
        const m = this.modeI;
        m.setFitMode(c.fitMode);
        m.setEdgeParams(c.edgePreset);
        m.setFacesOpaque(c.facesOpaque);
        m.setTranslucentBlend(c.blendMode);
        m.setTileTint(c.tileTintHex);
        m.setLandOnly(c.landOnly);
        // NOTE: elevationLatStepDeg is intentionally NOT set here. Density
        // is owned by _scheduleProgressiveContours so polyhedron swaps
        // don't have to pay the full 0.5°-rebuild cost up front.
        m.setElevationCurvesExaggeration(c.elevationExag);
        m.setElevationCurvesVisible(c.elevationVisible);
        m.setFaceOutlinesVisible(c.faceOutlines);
        m.setFaceLabelsVisible(c.showFaceLabels);
        m.speed = c.foldSpeed;
        // Per-shape strategy lookup. Falls back to 'steepest' if the active
        // polyhedron isn't in the map.
        const strategy = (c.unfoldStrategyByType && c.unfoldStrategyByType[this._polyhedronType])
            || 'steepest';
        m.setStrategy(strategy);
        // Align the final net from its actual unfolded geometry rather than a
        // hand-tuned twist table.
        if (c.orientUnfoldedPoleAxisVertical && m.setFinalPoleAxisVertical) {
            m.setFinalPoleAxisVertical(this._unfoldTwistOffset());
        }
        // Backing tile (parchment-clouds-light slab under the unfolded net)
        // is explicitly off in the presentation — gate the auto-show with
        // the user toggle.
        if (m.setBackingVisible) m.setBackingVisible(false);
        // No dashed cut-edge "bridges" during unfold (the hanging chains).
        if (m.setCutEdgesVisible) m.setCutEdgesVisible(false);
        // Pre-arm the unfold pair so the first click after page-load (which
        // is always "Unfold" since t = 0) runs with the unfold settings.
        // fold() / unfold() flip these on every press.
        m.setFoldMode(c.unfoldFoldMode);
        m.setEasing(c.unfoldEasing);
        // Re-apply the fit (and thus the presentation scale) to the freshly
        // (re)built faceParent — setPresentationScale alone is cached and won't
        // re-run on an unchanged value after a shape swap, which left the new
        // shape unscaled (the "folded zoom not working across modes" bug).
        if (m._applyFit) m._applyFit();
    }

    // Walk the [5, 3, 2, 1, 0.5] density ladder, calling
    // setElevationLatStepDeg on each step with a setTimeout in between.
    // Each setElevationLatStepDeg call clears the previous binary and
    // fetches the new one; on completion Mode I synchronously rebuilds the
    // per-face contour LineSegments. Coarse renders are fast (a few tens of
    // ms) and complete well before the next step is queued; finer ones get
    // a longer delay so they have room to finish before being replaced.
    _scheduleProgressiveContours() {
        if (this._refineTimer) {
            clearTimeout(this._refineTimer);
            this._refineTimer = null;
        }
        const ladder = this.config.progressiveLadder;
        const target = ladder[ladder.length - 1];
        // If target density is already cached for the current polyhedron,
        // selectPolyhedron already jumped directly there — the ladder
        // would just re-flicker through intermediate densities. Bail.
        if (this.modeI.hasContourCacheFor(this._polyhedronType, target)) {
            return;
        }
        const delays = this.config.progressiveStepDelays;
        let i = 0;
        const tick = () => {
            if (i >= ladder.length) {
                this._refineTimer = null;
                return;
            }
            const step = ladder[i];
            this.modeI.setElevationLatStepDeg(step);
            i += 1;
            if (i < ladder.length) {
                this._refineTimer = setTimeout(tick, delays[i]);
            } else {
                this._refineTimer = null;
            }
        };
        tick();
    }

    async _loadEarthPaths() {
        try {
            this._earthPaths = await loadEarthSvgPaths(this.config.earthPreset);
            this._earthStyle = PRESET_PATH_STYLES[this.config.earthPreset]
                            || PRESET_PATH_STYLES.outlines;
            this._pushEarthPaths();
        } catch (e) {
            console.warn('Earth path load failed:', e);
        }
    }

    _pushEarthPaths() {
        if (!this._earthPaths || !this._earthStyle) return;
        this.modeI.setEarthSvgPaths(this._earthPaths, this._earthStyle);
    }

    // ----- Public controls -----------------------------------------------

    // Direction-specific mode + easing are applied ONLY when the animation
    // is currently at rest (this.t === this.targetT). A mid-flight click
    // just flips targetT — the in-flight hinge layout was computed under
    // the current mode/easing, and swapping them now would snap every
    // face to a new local fraction (the "instant reset" the user wants
    // to avoid). At rest the swap is safe: at t=0 or t=1 the eased
    // fraction is 0 or 1 respectively, the same under any easing/mode.
    unfold() {
        if (this.modeI.t === this.modeI.targetT) {
            this.modeI.setFoldMode(this.config.unfoldFoldMode);
            this.modeI.setEasing(this.config.unfoldEasing);
            this._prepareUnfoldTarget();
        }
        this.modeI.targetT = 1;
    }
    fold() {
        if (this.modeI.t === this.modeI.targetT) {
            this.modeI.setFoldMode(this.config.foldFoldMode);
            this.modeI.setEasing(this.config.foldEasing);
        }
        this.modeI.targetT = 0;
    }
    toggleFold() {
        if (this.isUnfolded()) this.fold(); else this.unfold();
    }

    // Direct scrub — set the unfold position immediately, no animation.
    // Pinning both t AND targetT to the same value keeps update()'s
    // `if (t !== targetT)` step from animating the polyhedron away
    // from where the slider parked it.
    scrub(t) {
        const clamped = Math.max(0, Math.min(1, t));
        this.modeI.targetT = clamped;
        this.modeI.setT(clamped);
    }

    // "Unfolded" = currently at or animating toward the flat net.
    isUnfolded() { return this.modeI.targetT > 0.5; }

    _prepareUnfoldTarget() {
        this.modeI.setCameraPos(this.camera.position, this.camera);
        if (this.config.orientUnfoldedPoleAxisVertical && this.modeI.setFinalPoleAxisVertical) {
            this.modeI.setFinalPoleAxisVertical(this._unfoldTwistOffset());
        } else if (this.modeI.captureFaceParentTarget) {
            this.modeI.captureFaceParentTarget();
        }
    }

    _unfoldTwistOffset() {
        const byType = this.config.unfoldTwistOffsetByType;
        return (byType && Number.isFinite(byType[this._polyhedronType]))
            ? byType[this._polyhedronType]
            : 0;
    }

    selectPolyhedron(type) {
        if (type === this._polyhedronType) return;
        this._polyhedronType = type;
        // Repeat-visit fast path. If the target density's contour arrays are
        // already cached for THIS polyhedron type, skip the coarse-first
        // dance and jump straight to the target density — _adoptPolyhedron's
        // contour rebuild (after the binary load) will then hit cache and
        // the user sees no progressive flicker. Otherwise drop to coarse 5°
        // so the swap proceeds without paying the 0.5°-rebuild cost up
        // front, and let _scheduleProgressiveContours ladder up.
        const ladder = this.config.progressiveLadder;
        const target = ladder[ladder.length - 1];
        const startDensity = this.modeI.hasContourCacheFor(type, target)
            ? target
            : ladder[0];
        this.modeI.setElevationLatStepDeg(startDensity);
        this._buildPolyhedronAndMode();
        this._applyAllSettings();
        this._pushEarthPaths();
        this._scheduleProgressiveContours();
    }

    getPolyhedronType() { return this._polyhedronType; }

    // Override-hook for future rules (edge-folding constraints, conditional
    // rotation, sequenced reveals, …). Receives the frame's dt in seconds.
    // Default: no-op.
    onBeforeUpdate(_dt) { /* hook */ }

    // One-time: pin the globe's polar axis onto the screen-fixed tilted spin
    // axis so the default auto-spin reads as a clean Earth rotation (pole ON
    // the axis), and cache that axis in world space for the per-frame spin.
    // Camera is fixed, so the world axis is constant.
    _initGlobeSpinAxis() {
        if (!this.modeI || !this.modeI.setUserRotation) return;
        this.camera.updateMatrixWorld();
        this._spinAxisWorld.copy(this._spinAxisCam)
            .applyQuaternion(this.camera.quaternion).normalize();
        // Globe's polar axis after the obliquity (latitude) tilt = local +Y
        // rotated about X by the obliquity. Rotate the globe so it lands on the
        // spin axis; from there, spinning about the axis keeps the pole fixed.
        const obl = this.config.obliquityRad;
        const poleAfterLat = new THREE.Vector3(0, Math.cos(obl), Math.sin(obl)).normalize();
        const base = new THREE.Quaternion().setFromUnitVectors(poleAfterLat, this._spinAxisWorld);
        this.modeI.setUserRotation(base);
    }

    // ----- Main loop ------------------------------------------------------

    // One tick. The bootstrap RAF loop drives this so it can also drive
    // the shape picker in the same frame (one RAF, two renderers).
    update(dt) {
        this.onBeforeUpdate(dt);

        // OrbitControls damping needs to be advanced each frame even when
        // there's no input — that's what produces the inertia coast.
        if (this.controls) this.controls.update();

        const m = this.modeI;

        // Auto-spin the closed globe about the screen-fixed tilted axis. The
        // spin fades IN as the earth folds up (t: 1 net → 0 globe) and runs at
        // full speed only when closed; it's off the moment an unfold begins
        // (targetT ≥ 0.5) so the unfold-orientation drive below can take over.
        // Premultiplying _userRotation keeps the axis fixed on screen.
        const foldedFrac = 1 - m.t;            // 0 = net, 1 = closed
        if (this._spinSpeed && m.targetT < 0.5 && foldedFrac > 1e-3) {
            const fade = foldedFrac * foldedFrac * (3 - 2 * foldedFrac);  // smoothstep ease
            this.modeI.applyWorldSpin(this._spinAxisWorld, this._spinSpeed * fade * dt);
        }

        // Map-ONLY sizing: scale the polyhedron faces (faceParent), never the
        // camera — so the star sphere + backdrop stay fixed. Eases between the
        // folded scale and the per-shape unfolded scale.
        const foldedByType = this.config.foldedZoomByType;
        const fz = (foldedByType && foldedByType[this._polyhedronType] != null)
            ? foldedByType[this._polyhedronType] : this.config.foldedZoom;
        const unfoldedByType = this.config.unfoldedZoomByType;
        const uz = (unfoldedByType && unfoldedByType[this._polyhedronType] != null)
            ? unfoldedByType[this._polyhedronType] : this.config.unfoldedZoom;
        const sizeFactor = fz + (uz - fz) * m.t;
        if (this.modeI.setPresentationScale) this.modeI.setPresentationScale(sizeFactor);

        // Drive the parallax cloud-lobe drift in the azure backdrop.
        if (this._backdrop && this._backdrop.updateOffsets) {
            this._backdrop.updateOffsets(performance.now() * 0.001);
        }

        // Push the live camera position + quaternion so Mode I's at-t=1
        // face-on rotation targets the current view and the camera-pinned
        // star sphere orients with the camera.
        this.modeI.setCameraPos(this.camera.position, this.camera);

        // Drive Mode I's per-frame fold/unfold integration plus the star
        // overlay update (reads star.XYZ from the catalog map below).
        this.modeI.update(this._starMap);

        this.renderer.render(this.scene, this.camera);
    }
}

// ---------------------------------------------------------------------
// Bootstrap.
// ---------------------------------------------------------------------
const host = document.getElementById('three-host');
const app  = new PresentationApp(host);

// Fold/unfold is toggled by tapping/clicking the globe itself — see the tap
// detection in PresentationApp._setupDragControls (the old button is gone).

// Shape picker bootstrap. The canvas + overlay container live in the HTML;
// the picker class fills the overlay with one cell per shape and renders
// the wireframe thumbnails into the canvas.
const pickerCanvas = document.getElementById('picker-canvas');
const pickerCells  = document.getElementById('picker-cells');
const picker = new ShapePicker(
    pickerCanvas, pickerCells, CONFIG.pickerShapes,
    (type) => app.selectPolyhedron(type),
);
picker.setSelected(app.getPolyhedronType());

// Single RAF loop driving both the main app and the picker. Sharing a
// frame's dt keeps everything in lockstep and avoids the cost of two
// independent rAF loops.
let _lastFrameMs = null;
function loop() {
    const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    if (_lastFrameMs == null) _lastFrameMs = now;
    const dt = Math.min(0.1, (now - _lastFrameMs) / 1000);
    _lastFrameMs = now;
    app.update(dt);
    picker.update(dt);
    requestAnimationFrame(loop);
}
loop();

// Expose for ad-hoc tweaking from devtools.
window.__app    = app;
window.__picker = picker;
