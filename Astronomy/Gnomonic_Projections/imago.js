// Imago projection - AuthaGraph approximation by Justin Kunimune.
// Vanilla-JS port of d3-geo-polygon's src/imago.js (BSD).
// Forward: (lon, lat in radians) -> (x, y) in [-3, 3] x [-sqrt(3), sqrt(3)].
// Inverse: (x, y) -> (lon, lat in radians) or null if outside.
//
// Recommended k for AuthaGraph-look: 0.68. For lowest angular distortion: 0.59.
// See: https://kunimune.blog/2017/11/23/the-secrets-of-the-authagraph-revealed/

const PI = Math.PI;
const HALF_PI = PI / 2;
const SQRT3 = Math.sqrt(3);
const SQRT12 = Math.sqrt(12);
const ASIN_ONE_THD = Math.asin(1 / 3);

// [lat0, lon0, tht0, planarRotation, x0, y0] for each of 4 tetrahedron face centers.
const CENTRUMS = [
    [HALF_PI, 0, 0, -HALF_PI, 0, SQRT3],
    [-ASIN_ONE_THD, 0, PI, HALF_PI, 0, -SQRT3],
    [-ASIN_ONE_THD, (2 * PI) / 3, PI, (5 * PI) / 6, 3, 0],
    [-ASIN_ONE_THD, (-2 * PI) / 3, PI, PI / 6, -3, 0],
];

const CONFIG = {
    sphereSym: 3,
    planarSym: 6,
    width: 6,
    height: 2 * SQRT3,
};

function rotateOOB(x, y, xCen) {
    if (Math.abs(x) > CONFIG.width / 2) return [2 * xCen - x, -y];
    return [-x, CONFIG.height * Math.sign(y) - y];
}

// 1D Newton solver: find x such that f(x) ~= target, given initial guess.
function solveNewton(f, target, guess, maxIter = 40, tol = 1e-10) {
    let x = guess;
    const h = 1e-7;
    for (let i = 0; i < maxIter; i++) {
        const fx = f(x);
        const err = fx - target;
        if (Math.abs(err) < tol) return x;
        const fp = (f(x + h) - f(x - h)) / (2 * h);
        if (Math.abs(fp) < 1e-14) break;
        x -= err / fp;
    }
    return x;
}

function obliquifySphc(latF, lonF, pole) {
    const lat0 = pole[0], lon0 = pole[1], tht0 = pole[2];
    let lat1, lon1;
    if (lat0 === HALF_PI) lat1 = latF;
    else lat1 = Math.asin(
        Math.sin(lat0) * Math.sin(latF) +
        Math.cos(lat0) * Math.cos(latF) * Math.cos(lon0 - lonF)
    );
    if (lat0 === HALF_PI) lon1 = lonF - lon0;
    else if (lat0 === -HALF_PI) lon1 = lon0 - lonF - PI;
    else {
        lon1 = Math.acos(
            (Math.cos(lat0) * Math.sin(latF) -
             Math.sin(lat0) * Math.cos(latF) * Math.cos(lon0 - lonF)) /
            Math.cos(lat1)
        ) - PI;
        if (isNaN(lon1)) {
            if ((Math.cos(lon0 - lonF) >= 0 && latF < lat0) ||
                (Math.cos(lon0 - lonF) < 0 && latF < -lat0)) lon1 = 0;
            else lon1 = -PI;
        } else if (Math.sin(lonF - lon0) > 0) lon1 = -lon1;
    }
    lon1 -= tht0;
    return [lat1, lon1];
}

function obliquifyPlnr(coords, pole) {
    const lat0 = pole[0], lon0 = pole[1], tht0 = pole[2];
    let lat1 = coords[0], lon1 = coords[1] + tht0;
    const latf = Math.asin(
        Math.sin(lat0) * Math.sin(lat1) -
        Math.cos(lat0) * Math.cos(lon1) * Math.cos(lat1)
    );
    let lonf;
    const innerFunc =
        Math.sin(lat1) / Math.cos(lat0) / Math.cos(latf) -
        Math.tan(lat0) * Math.tan(latf);
    if (lat0 === HALF_PI) lonf = lon1 + lon0;
    else if (lat0 === -HALF_PI) lonf = -lon1 + lon0 + PI;
    else if (Math.abs(innerFunc) > 1) {
        if ((lon1 === 0 && lat1 < -lat0) || (lon1 !== 0 && lat1 < lat0)) lonf = lon0 + PI;
        else lonf = lon0;
    } else if (Math.sin(lon1) > 0) lonf = lon0 + Math.acos(innerFunc);
    else lonf = lon0 - Math.acos(innerFunc);
    return [latf, lonf, tht0];
}

function faceProject(lon, lat, k) {
    const tht = Math.atan(((lon - Math.asin(Math.sin(lon) / SQRT3)) / PI) * SQRT12);
    const p = (HALF_PI - lat) / Math.atan(Math.SQRT2 / Math.cos(lon));
    return [(Math.pow(p, k) * SQRT3) / Math.cos(tht), tht];
}

function faceInverse(r, th, k) {
    const lambda = solveNewton(
        (l) => Math.atan(((l - Math.asin(Math.sin(l) / SQRT3)) / PI) * SQRT12),
        th, th / 2
    );
    const R = r / (SQRT3 / Math.cos(th));
    return [HALF_PI - Math.pow(R, 1 / k) * Math.atan(Math.SQRT2 / Math.cos(lambda)), lambda];
}

export function imagoForward(lon, lat, k = 0.68) {
    const numSym = CONFIG.sphereSym;
    let latR = -Infinity, lonR = -Infinity, centrum = null;
    for (const c of CENTRUMS) {
        const [lat1, lon1] = obliquifySphc(lat, lon, c);
        if (lat1 > latR) { latR = lat1; lonR = lon1; centrum = c; }
    }
    const sec = (2 * PI) / numSym;
    const lonR0 = Math.floor((lonR + PI / numSym) / sec) * sec;
    const [r, thRel] = faceProject(lonR - lonR0, latR, k);
    const th = thRel + centrum[3] + (lonR0 * numSym) / CONFIG.planarSym;
    const x0 = centrum[4], y0 = centrum[5];
    let x = r * Math.cos(th) + x0;
    let y = r * Math.sin(th) + y0;
    if (Math.abs(x) > CONFIG.width / 2 || Math.abs(y) > CONFIG.height / 2) {
        [x, y] = rotateOOB(x, y, x0);
    }
    return [x, y];
}

export function imagoInverse(x, y, k = 0.68) {
    const numSym = CONFIG.planarSym;
    let rM = Infinity, centrum = null;
    for (const c of CENTRUMS) {
        const dr = Math.hypot(x - c[4], y - c[5]);
        if (dr < rM) { rM = dr; centrum = c; }
    }
    const th0 = centrum[3], x0 = centrum[4], y0 = centrum[5];
    const r = Math.hypot(x - x0, y - y0);
    const th = Math.atan2(y - y0, x - x0) - th0;
    const sec = (2 * PI) / numSym;
    const thBase = Math.floor((th + PI / numSym) / sec) * sec;
    const rel = faceInverse(r, th - thBase, k);
    rel[1] = (thBase * numSym) / CONFIG.sphereSym + rel[1];
    const abs = obliquifyPlnr(rel, centrum);
    if (isNaN(abs[0]) || isNaN(abs[1])) return null;
    return [abs[1], abs[0]]; // [lon, lat]
}

export function imagoRectSize() {
    return { width: CONFIG.width, height: CONFIG.height };
}

// Wide variant: rotate 90deg, reflect upper hemisphere down so the world tiles
// horizontally, apply a horizontal shift, wrap mod 2*height. Output recentered
// on origin so display code can use the same (cx, cy) + scale convention.
// Raw bounds before recentering: qx in [0, 2*height], qy in [-3, 0].
// Recentered bounds: x in [-height, height], y in [-1.5, 1.5].
// Rectangle aspect = 2*height : 3 = 4*sqrt(3) : 3 ~ 2.31:1.
export function imagoWideForward(lon, lat, k = 0.68, shift = 1.16) {
    const xy = imagoForward(lon, lat, k);
    let qx = xy[1], qy = -xy[0];
    if (qy > 0) { qx = CONFIG.height - qx; qy = -qy; }
    qx += shift;
    if (qx < 0) qx += CONFIG.height * 2;
    return [qx - CONFIG.height, qy + 1.5];
}

export function imagoWideInverse(x, y, k = 0.68, shift = 1.16) {
    const qx = x + CONFIG.height;
    const qy = y - 1.5;
    let xN = (qx - shift) / CONFIG.height;
    if (xN > 1.5) xN -= 2;
    let yN = qy;
    if (xN > 0.5) { xN = 1 - xN; yN = -yN; }
    return imagoInverse(-yN, xN * CONFIG.height, k);
}

export function imagoWideRectSize() {
    return { width: CONFIG.height * 2, height: 3 };
}
