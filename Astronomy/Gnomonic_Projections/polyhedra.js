// Generic polyhedron builder.
//
// buildPolyhedron(type, R) returns:
//   { type, name, R, inradius, vertsPerFace, faces, threeGeometry }
//
// Each face: { idx, normal, center, basisU, basisV, vertices3D, vertices2D,
// faceCircumradius }
//
// Two-mode spec: most polyhedra are declared via { rawVertices, rawNormals,
// vertsPerFace }, and buildPolyhedron picks the top-`vertsPerFace` vertices
// (by dot product) for each face. For polyhedra where the face structure is
// hard to derive from normals alone (e.g. pentakis dodecahedron), a spec can
// provide `build(R)` directly.
//
// The 3D mesh for Mode A is always constructed from buildPolyhedron's own face
// data (not Three.js's builtin geometries) so the face partition used for
// projection always matches the rendered solid.

const PHI = (1 + Math.sqrt(5)) / 2;
const IP = 1 / PHI;          // 1/phi
const PHI2 = PHI + 1;        // phi^2

// =============================================================================
// Spec table.
// =============================================================================
const SPECS = {

    tetra: {
        name: 'Tetrahedron',
        rawVertices: [
            [1, 1, 1],
            [1, -1, -1],
            [-1, 1, -1],
            [-1, -1, 1],
        ],
        rawNormals: [
            [1, 1, -1],
            [1, -1, 1],
            [-1, 1, 1],
            [-1, -1, -1],
        ],
        vertsPerFace: 3,
    },

    cube: {
        name: 'Cube',
        rawVertices: [
            [1, 1, 1],  [1, 1, -1],  [1, -1, 1],  [1, -1, -1],
            [-1, 1, 1], [-1, 1, -1], [-1, -1, 1], [-1, -1, -1],
        ],
        rawNormals: [
            [1, 0, 0], [-1, 0, 0],
            [0, 1, 0], [0, -1, 0],
            [0, 0, 1], [0, 0, -1],
        ],
        vertsPerFace: 4,
    },

    octa: {
        name: 'Octahedron',
        rawVertices: [
            [1, 0, 0], [-1, 0, 0],
            [0, 1, 0], [0, -1, 0],
            [0, 0, 1], [0, 0, -1],
        ],
        rawNormals: [
            [1, 1, 1],  [1, 1, -1],  [1, -1, 1],  [1, -1, -1],
            [-1, 1, 1], [-1, 1, -1], [-1, -1, 1], [-1, -1, -1],
        ],
        vertsPerFace: 3,
    },

    // Regular dodecahedron in Three.js's vertex convention. The pentagon
    // face containing (0, 1/PHI, PHI) is exactly coplanar.
    dodec: {
        name: 'Dodecahedron',
        rawVertices: (() => {
            const v = [];
            for (const sx of [+1, -1]) for (const sy of [+1, -1]) for (const sz of [+1, -1]) {
                v.push([sx, sy, sz]);
            }
            for (const s1 of [+1, -1]) for (const s2 of [+1, -1]) v.push([0, s1 * IP, s2 * PHI]);
            for (const s1 of [+1, -1]) for (const s2 of [+1, -1]) v.push([s1 * IP, s2 * PHI, 0]);
            for (const s1 of [+1, -1]) for (const s2 of [+1, -1]) v.push([s1 * PHI, 0, s2 * IP]);
            return v;
        })(),
        // Dodec face center directions for the above vertex convention.
        rawNormals: (() => {
            const n = [];
            for (const s1 of [+1, -1]) for (const s2 of [+1, -1]) n.push([0, s1 * PHI, s2]);
            for (const s1 of [+1, -1]) for (const s2 of [+1, -1]) n.push([s1 * PHI, s2, 0]);
            for (const s1 of [+1, -1]) for (const s2 of [+1, -1]) n.push([s1, 0, s2 * PHI]);
            return n;
        })(),
        vertsPerFace: 5,
    },

    icosa: {
        name: 'Icosahedron',
        rawVertices: (() => {
            const v = [];
            for (const s1 of [+1, -1]) for (const s2 of [+1, -1]) v.push([0, s1, s2 * PHI]);
            for (const s1 of [+1, -1]) for (const s2 of [+1, -1]) v.push([s1, s2 * PHI, 0]);
            for (const s1 of [+1, -1]) for (const s2 of [+1, -1]) v.push([s1 * PHI, 0, s2]);
            return v;
        })(),
        // Icosa face center directions = dual dodec vertex directions in the
        // canonical golden-ratio convention.
        rawNormals: (() => {
            const n = [];
            for (const sx of [+1, -1]) for (const sy of [+1, -1]) for (const sz of [+1, -1]) {
                n.push([sx, sy, sz]);
            }
            for (const s1 of [+1, -1]) for (const s2 of [+1, -1]) n.push([0, s1 * PHI, s2 * IP]);
            for (const s1 of [+1, -1]) for (const s2 of [+1, -1]) n.push([s1 * IP, 0, s2 * PHI]);
            for (const s1 of [+1, -1]) for (const s2 of [+1, -1]) n.push([s1 * PHI, s2 * IP, 0]);
            return n;
        })(),
        vertsPerFace: 3,
    },

    // ====== Catalan & other non-Platonic, congruent-face polyhedra ======

    // Rhombic dodecahedron: 12 rhombic ("diamond-shaped") faces, 14 vertices
    // of two types - 8 of degree 3 (at cube corners) and 6 of degree 4 (along
    // the +/-axis directions, twice as far out). Dual of the cuboctahedron;
    // face centers are at cuboctahedron vertex directions.
    rhombicDodec: {
        name: 'Rhombic Dodecahedron',
        rawVertices: (() => {
            const v = [];
            for (const sx of [+1, -1]) for (const sy of [+1, -1]) for (const sz of [+1, -1]) {
                v.push([sx, sy, sz]);
            }
            v.push([2, 0, 0], [-2, 0, 0], [0, 2, 0], [0, -2, 0], [0, 0, 2], [0, 0, -2]);
            return v;
        })(),
        rawNormals: (() => {
            const n = [];
            for (const s1 of [+1, -1]) for (const s2 of [+1, -1]) n.push([s1, s2, 0]);
            for (const s1 of [+1, -1]) for (const s2 of [+1, -1]) n.push([s1, 0, s2]);
            for (const s1 of [+1, -1]) for (const s2 of [+1, -1]) n.push([0, s1, s2]);
            return n;
        })(),
        vertsPerFace: 4,
    },

    // Rhombic triacontahedron: 30 golden-ratio rhombic faces, 32 vertices
    // (20 dodec-type + 12 icosa-type). Dual of the icosidodecahedron.
    //
    // We use the dodec vertices at canonical magnitudes (sqrt(3)) and the
    // icosa vertices at full canonical magnitudes (sqrt(2+phi)) too. This
    // doesn't produce perfectly-planar rhombic faces (a true RT needs the
    // icosa verts at the dodec's inradius distance), but the face partition
    // is topologically correct - each face has 4 edge-neighbors - so the
    // dual / unfold modes work. Rendered faces are very slightly non-planar
    // and look like nearly-flat rhombi.
    rhombicTriacontahedron: {
        name: 'Rhombic Triacontahedron',
        rawVertices: (() => {
            const v = [];
            for (const sx of [+1, -1]) for (const sy of [+1, -1]) for (const sz of [+1, -1]) {
                v.push([sx, sy, sz]);
            }
            for (const s1 of [+1, -1]) for (const s2 of [+1, -1]) v.push([0, s1 * IP, s2 * PHI]);
            for (const s1 of [+1, -1]) for (const s2 of [+1, -1]) v.push([s1 * IP, s2 * PHI, 0]);
            for (const s1 of [+1, -1]) for (const s2 of [+1, -1]) v.push([s1 * PHI, 0, s2 * IP]);
            for (const s1 of [+1, -1]) for (const s2 of [+1, -1]) v.push([0, s1, s2 * PHI]);
            for (const s1 of [+1, -1]) for (const s2 of [+1, -1]) v.push([s1, s2 * PHI, 0]);
            for (const s1 of [+1, -1]) for (const s2 of [+1, -1]) v.push([s1 * PHI, 0, s2]);
            return v;
        })(),
        // 30 face center directions = icosidodecahedron vertex directions.
        // 6 axial + 24 mixed (even cyclic permutations of (1, PHI, PHI^2)).
        rawNormals: (() => {
            const n = [
                [1, 0, 0], [-1, 0, 0],
                [0, 1, 0], [0, -1, 0],
                [0, 0, 1], [0, 0, -1],
            ];
            for (const sx of [+1, -1]) for (const sy of [+1, -1]) for (const sz of [+1, -1]) {
                n.push([sx, sy * PHI, sz * PHI2]);
                n.push([sy * PHI, sz * PHI2, sx]);
                n.push([sz * PHI2, sx, sy * PHI]);
            }
            return n;
        })(),
        vertsPerFace: 4,
    },

    // Pentagonal bipyramid: two pentagonal pyramids joined base-to-base.
    // 10 isoceles triangle faces, 7 vertices.
    pentagonalBipyramid: {
        name: 'Pentagonal Bipyramid',
        build: (R) => buildPentagonalBipyramid(R),
    },

    // Pentakis dodecahedron: dual of the truncated icosahedron (soccer ball).
    // 60 isoceles triangle faces, 32 vertices.
    pentakisDodec: {
        name: 'Pentakis Dodecahedron',
        build: (R) => buildPentakisDodec(R),
    },

    truncOcta: {
        name: 'Truncated Octahedron',
        build: (R) => buildTruncOcta(R),
    },

    // Waterman polyhedron W5: convex hull of FCC lattice points (x, y, z
    // integer, x+y+z even) within x² + y² + z² ≤ 10. Steve Waterman's
    // construction — convex hull figures out the face structure.
    waterman5: {
        name: 'Waterman W5',
        build: (R) => buildWaterman5(R),
    },

    // Step-cut emerald gemstone: rectangular with chamfered corners,
    // flat table on top, widest at the girdle, tapering to a keel-line
    // along the long axis at the bottom. 18 hand-placed vertex coords;
    // convex hull derives the face structure.
    emeraldCut: {
        name: 'Emerald Cut',
        build: (R) => buildEmeraldCut(R),
    },

    // Face-at-pole icosahedron: one entire face is centred on the south
    // pole (Antarctica sits inside it, not split across 5 wedges) and
    // another on the north pole. Face indices are assigned by BFS from
    // the Arctic face with slot 13 reserved for the Antarctic face, so
    // face 13 is always the south-pole face. NOT the canonical Dymaxion
    // fold — kept as a separate option for comparison.
    faceAtPoleIcosa: {
        name: 'Face-at-Pole Icosa',
        build: (R) => buildFaceAtPoleIcosa(R),
    },

    // Fuller's 1954 AirOcean / Dymaxion icosahedron: standard golden-ratio
    // icosa rotated by the inverse of d3-geo-polygon's
    //   .rotate([-83.65929, 25.44458, -87.45184])
    // which positions the 12 vertices in oceans. Faces follow d3's exact
    // triplet list and parent-tree numbering, so the Dymaxion spanning
    // tree (parents[]) lays the net out in Fuller's iconic horizontal map.
    dymaxionIcosa: {
        name: 'Dymaxion (AirOcean)',
        build: (R) => buildDymaxionIcosa(R),
    },
};

// Ordered for the UI selector. The rhombic triacontahedron spec is in SPECS
// for future fixing but currently produces one near-degenerate face (its
// canonical construction requires icosa-type verts at the dodec inradius,
// which my top-K face-finding doesn't quite produce), so it's omitted from
// the UI list to avoid a broken-looking option.
export const POLYHEDRON_TYPES = [
    'tetra', 'cube', 'octa', 'dodec', 'icosa',
    'rhombicDodec',
    'pentagonalBipyramid', 'pentakisDodec',
    'waterman5', 'emeraldCut',
    'faceAtPoleIcosa', 'dymaxionIcosa',
];

export function polyhedronName(type) {
    return SPECS[type] ? SPECS[type].name : type;
}

export function polyhedronVertsPerFace(type) {
    return SPECS[type] ? SPECS[type].vertsPerFace : 0;
}

// =============================================================================
// Build entry point.
// =============================================================================
export function buildPolyhedron(type, R) {
    const spec = SPECS[type];
    if (!spec) throw new Error(`Unknown polyhedron type: ${type}`);
    if (spec.build) return spec.build(R);
    return buildFromRaw(spec, type, R);
}

// =============================================================================
// Default builder: rawVertices + rawNormals -> face structure.
// Vertices are scaled so the FARTHEST vertex sits on the sphere of radius R.
// =============================================================================
function buildFromRaw(spec, type, R) {
    const rawMaxMag = Math.max(...spec.rawVertices.map(v => Math.hypot(v[0], v[1], v[2])));
    const vScale = R / rawMaxMag;
    const vertices = spec.rawVertices.map(v =>
        new THREE.Vector3(v[0] * vScale, v[1] * vScale, v[2] * vScale));

    const normals = spec.rawNormals.map(n => {
        const len = Math.hypot(n[0], n[1], n[2]);
        return new THREE.Vector3(n[0] / len, n[1] / len, n[2] / len);
    });

    const faces = normals.map((normal, idx) =>
        buildFaceFromTopK(vertices, normal, spec.vertsPerFace, idx));

    const inradius = faces[0].planeDist;
    const threeGeometry = buildBufferGeometryFromFaces(faces);

    return {
        type, name: spec.name, R, inradius,
        vertsPerFace: spec.vertsPerFace,
        faces, threeGeometry,
    };
}

// For a face normal, pick the top-`vertsPerFace` vertices by v.dot(normal).
// For any convex polyhedron, the vertices on a face have the maximum
// projection in the outward normal direction, so top-K is the face.
function buildFaceFromTopK(vertices, normal, k, idx) {
    const ranked = vertices.map(v => ({ v, d: v.dot(normal) }));
    ranked.sort((a, b) => b.d - a.d);
    const onFace = ranked.slice(0, k).map(x => x.v);
    return finishFace(onFace, idx);
}

function finishFace(onFace, idx) {
    // Vertex centroid: this is the visual center of the polygon, and we use
    // it as the 2D-frame origin so face-local (u, v) is symmetric around 0 -
    // which makes drawing the polygon (or its earth-texture image) at a cell
    // center "just work" without an extra offset.
    let cx = 0, cy = 0, cz = 0;
    for (const v of onFace) { cx += v.x; cy += v.y; cz += v.z; }
    cx /= onFace.length; cy /= onFace.length; cz /= onFace.length;
    const centroid = new THREE.Vector3(cx, cy, cz);

    // True face plane normal from cross product of two edge vectors. For
    // Catalan / bipyramid faces this does not match centroid direction, so we
    // can't shortcut by using `centroid.clone().normalize()`.
    const e1 = new THREE.Vector3().subVectors(onFace[1], onFace[0]);
    const e2 = new THREE.Vector3().subVectors(onFace[2], onFace[0]);
    const normal = new THREE.Vector3().crossVectors(e1, e2).normalize();
    if (normal.dot(centroid) < 0) normal.negate(); // outward-facing

    // Distance from origin to the face plane. Used for ray-plane intersection
    // when projecting a celestial direction onto a face.
    const planeDist = onFace[0].dot(normal);

    const helper = Math.abs(normal.y) < 0.95
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(1, 0, 0);
    // basisU points geographic-east (normal x helper). basisV = basisU x normal
    // stays north-pointing. With this convention a face displayed via the
    // standard rotate+Y-flip canvas transform reads as a map with east on the
    // right and north on top, instead of mirrored. Trade-off: (basisU,basisV,
    // normal) becomes left-handed.
    const basisU = new THREE.Vector3().crossVectors(normal, helper).normalize();
    const basisV = new THREE.Vector3().crossVectors(basisU, normal).normalize();

    // 2D coords relative to centroid (so the polygon is centered on (0,0)).
    const indexed = onFace.map(v => {
        const off = new THREE.Vector3().subVectors(v, centroid);
        const u = off.dot(basisU);
        const w = off.dot(basisV);
        return { v, u, w, angle: Math.atan2(w, u) };
    });
    indexed.sort((a, b) => a.angle - b.angle);

    const vertices3D = indexed.map(s => s.v);
    const vertices2D = indexed.map(s => ({ u: s.u, v: s.w }));
    // Max-radius for proper drawing scale (vertices may sit at different
    // distances from centroid for asymmetric face shapes like bipyramids).
    let faceCircumradius = 0;
    for (const v of vertices2D) {
        const r = Math.hypot(v.u, v.v);
        if (r > faceCircumradius) faceCircumradius = r;
    }

    return {
        idx,
        normal,
        center: centroid,   // 3D centroid; serves as the 2D-frame origin
        planeDist,          // ray-plane intersection: t = planeDist / (dir.dot(normal))
        basisU, basisV,
        vertices3D, vertices2D,
        faceCircumradius,
    };
}

// Triangulate each face as a fan from vertex 0 and emit a BufferGeometry
// with flat shading. Used for Mode A's wireframe + fill mesh.
function buildBufferGeometryFromFaces(faces) {
    const positions = [];
    for (const face of faces) {
        const verts = face.vertices3D;
        for (let i = 1; i < verts.length - 1; i++) {
            positions.push(verts[0].x, verts[0].y, verts[0].z);
            positions.push(verts[i].x, verts[i].y, verts[i].z);
            positions.push(verts[i + 1].x, verts[i + 1].y, verts[i + 1].z);
        }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.computeVertexNormals();
    return geom;
}

// =============================================================================
// Custom builders.
// =============================================================================

// Pentagonal bipyramid: two pyramids glued base-to-base. We pick proportions
// so all 10 triangle faces are isoceles with side ratio ~1:1.176 (each face's
// long edge is the equatorial pentagon edge). Apex height chosen so the
// circumscribed sphere passes through both apexes.
function buildPentagonalBipyramid(R) {
    // Equatorial pentagon radius re, apex height ha (both relative to R=1).
    // For both apex and equatorial verts to be on the unit sphere: re^2 + 0 = 1
    // (equatorial in y=0) and 0 + ha^2 = 1 (apex on +/-y axis). So re=1, ha=1.
    // This gives a slightly squat bipyramid (faces are 36-72-72 isoceles
    // triangles). For a more pleasing "elongated diamond" silhouette, we
    // stretch the apexes outward by PHI/sqrt(1+PHI^2) - the canonical
    // golden-ratio elongation. Then ALL face circumradii are equal.
    const re = 1;
    const ha = PHI;
    const verts = [];
    verts.push([0, ha, 0]);       // 0: top apex
    verts.push([0, -ha, 0]);      // 1: bottom apex
    for (let k = 0; k < 5; k++) { // 2..6: equatorial
        const a = 2 * Math.PI * k / 5;
        verts.push([re * Math.cos(a), 0, re * Math.sin(a)]);
    }
    // Find maximum magnitude for circumscribed-sphere scaling.
    const maxMag = Math.max(...verts.map(v => Math.hypot(...v)));
    const s = R / maxMag;
    const vertices = verts.map(v => new THREE.Vector3(v[0] * s, v[1] * s, v[2] * s));

    // 10 face triplets (top apex + each pentagon edge, then bottom apex + each).
    const faceTriplets = [];
    for (let k = 0; k < 5; k++) {
        faceTriplets.push([0, 2 + k, 2 + ((k + 1) % 5)]);
        faceTriplets.push([1, 2 + ((k + 1) % 5), 2 + k]);
    }
    const faces = faceTriplets.map((tri, idx) =>
        finishFace(tri.map(i => vertices[i]), idx));

    return {
        type: 'pentagonalBipyramid',
        name: 'Pentagonal Bipyramid',
        R,
        inradius: faces[0].planeDist,
        vertsPerFace: 3,
        faces,
        threeGeometry: buildBufferGeometryFromFaces(faces),
    };
}

// Pentakis dodecahedron: take a regular dodecahedron, raise a pyramid apex
// over each pentagonal face, and emit the 60 resulting triangles. Apex
// distance is chosen so the dual relationship with the truncated icosahedron
// holds (apex height = 1/3*phi from the dodec face plane, giving all 60
// isoceles triangles congruent).
function buildPentakisDodec(R) {
    // We need the dodec face data to find pentagon edges and centers, so
    // build a unit-radius dodec first, then post-process and rescale.
    const dodec = buildPolyhedron('dodec', 1);
    const apexDistance = dodec.inradius * (1 + IP / 3); // approx, gives a nice "spiky" look

    // Vertex list: 20 dodec verts + 12 apexes (one per dodec face).
    const dodecVerts = [];
    const vKey = new Map();
    const key = v => `${v.x.toFixed(6)},${v.y.toFixed(6)},${v.z.toFixed(6)}`;
    const addV = v => {
        const k = key(v);
        if (vKey.has(k)) return vKey.get(k);
        const i = dodecVerts.length;
        vKey.set(k, i);
        dodecVerts.push(v.clone());
        return i;
    };

    const faceVerts = dodec.faces.map(f => f.vertices3D.map(addV));
    const apexes = dodec.faces.map(f =>
        f.normal.clone().multiplyScalar(apexDistance));
    const apexIdx = apexes.map(a => {
        const i = dodecVerts.length;
        dodecVerts.push(a);
        return i;
    });

    // Build 60 triangle faces.
    const faceTriplets = [];
    for (let fIdx = 0; fIdx < dodec.faces.length; fIdx++) {
        const pentVs = faceVerts[fIdx];
        const apex = apexIdx[fIdx];
        for (let i = 0; i < pentVs.length; i++) {
            const a = pentVs[i];
            const b = pentVs[(i + 1) % pentVs.length];
            faceTriplets.push([apex, a, b]);
        }
    }

    // Rescale so the OUTERMOST vertex (an apex) sits at distance R.
    const maxMag = Math.max(...dodecVerts.map(v => v.length()));
    const s = R / maxMag;
    const vertices = dodecVerts.map(v => v.clone().multiplyScalar(s));

    const faces = faceTriplets.map((tri, idx) =>
        finishFace(tri.map(i => vertices[i]), idx));

    return {
        type: 'pentakisDodec',
        name: 'Pentakis Dodecahedron',
        R,
        inradius: faces[0].planeDist,
        vertsPerFace: 3,
        faces,
        threeGeometry: buildBufferGeometryFromFaces(faces),
    };
}

// Truncated octahedron: the Archimedean solid with 24 vertices, 14 faces
// (8 regular hexagons at the octant directions + 6 squares at the axis
// directions) and 36 edges. Vertices are all distinct permutations of
// (0, +/-1, +/-2). This is the base shape for Steve Waterman's butterfly
// projection (Mode G): each octant of the celestial sphere maps onto one
// hexagonal face, and the 6 square faces sit at the +/-X/Y/Z axis points.
//
// The returned polyhedron carries an extra `hexFaces` and `sqFaces` view of
// the faces array so callers (Mode G) can address the two face classes
// separately without filtering by vertex count.
function buildTruncOcta(R) {
    const rawVerts = [];
    const seen = new Set();
    // All distinct permutations of (a, b, c) where {a, b, c} = {0, 1, 2},
    // with signs applied to non-zero coordinates only.
    const perms = [[0,1,2], [0,2,1], [1,0,2], [1,2,0], [2,0,1], [2,1,0]];
    for (const p of perms) {
        const sigOpts = (k) => p[k] === 0 ? [0] : [+1, -1];
        for (const sa of sigOpts(0)) for (const sb of sigOpts(1)) for (const sc of sigOpts(2)) {
            const v = [sa * p[0], sb * p[1], sc * p[2]];
            const key = v.join(',');
            if (!seen.has(key)) { seen.add(key); rawVerts.push(v); }
        }
    }
    // Should be 24 verts.

    // Vertices live at distance sqrt(0^2 + 1^2 + 2^2) = sqrt(5) from origin.
    // Scale so the circumscribing sphere has radius R (vertices touch the
    // celestial sphere).
    const s = R / Math.sqrt(5);
    const vertices = rawVerts.map(v =>
        new THREE.Vector3(v[0] * s, v[1] * s, v[2] * s));

    // 8 hexagonal faces, one per (sx, sy, sz) octant: vertex is included if
    // each of its coords is on the correct side (>=0 for + octants, <=0 for -).
    const hexSigns = [[+1,+1,+1], [+1,+1,-1], [+1,-1,+1], [+1,-1,-1],
                      [-1,+1,+1], [-1,+1,-1], [-1,-1,+1], [-1,-1,-1]];
    const eps = 1e-6 * R;
    const hexFaces = hexSigns.map(([sx, sy, sz], idx) => {
        const onFace = vertices.filter(v =>
            (sx > 0 ? v.x >= -eps : v.x <= eps) &&
            (sy > 0 ? v.y >= -eps : v.y <= eps) &&
            (sz > 0 ? v.z >= -eps : v.z <= eps));
        if (onFace.length !== 6) {
            throw new Error(`Truncated octahedron hex face ${idx} has ${onFace.length} verts (expected 6)`);
        }
        const face = finishFace(onFace, idx);
        face.octantSigns = [sx, sy, sz]; // tag for Mode G's wing assignment
        return face;
    });

    // 6 square faces, one per +/- axis direction.
    const axisDirs = [
        ['x', +1], ['x', -1],
        ['y', +1], ['y', -1],
        ['z', +1], ['z', -1],
    ];
    const sqFaces = axisDirs.map(([axis, sign], i) => {
        const onFace = vertices.filter(v => Math.abs(v[axis] - sign * 2 * s) < eps);
        if (onFace.length !== 4) {
            throw new Error(`Truncated octahedron square face ${axis}${sign} has ${onFace.length} verts (expected 4)`);
        }
        const face = finishFace(onFace, hexFaces.length + i);
        face.axisDir = [axis, sign];
        return face;
    });

    const allFaces = [...hexFaces, ...sqFaces];

    return {
        type: 'truncOcta',
        name: 'Truncated Octahedron',
        R,
        inradius: hexFaces[0].planeDist, // hex faces are slightly farther in than squares
        vertsPerFace: 6, // dominant; squares are 4
        faces: allFaces,
        hexFaces,
        sqFaces,
        threeGeometry: buildBufferGeometryFromFaces(allFaces),
    };
}

// =============================================================================
// Convex-hull-based builders.
//
// For polyhedra defined by a vertex set without a clean closed-form face
// list, we feed the points into THREE.ConvexHull (which returns triangulated
// faces) and merge coplanar triangles back into the actual polygon faces.
// =============================================================================

function buildConvexHullPolyhedron(rawPoints, R, name, type) {
    if (!THREE.ConvexHull) {
        throw new Error(
            'THREE.ConvexHull is not loaded — need <script src="…/math/ConvexHull.js">');
    }
    // Scale so the farthest input point sits on the circumscribed sphere of R.
    const maxMag = Math.max(...rawPoints.map(p => Math.hypot(p[0], p[1], p[2])));
    const s = R / maxMag;
    const points = rawPoints.map(p =>
        new THREE.Vector3(p[0] * s, p[1] * s, p[2] * s));

    const hull = new THREE.ConvexHull().setFromPoints(points);

    // ConvexHull stores TRIANGULAR faces. Merge coplanar triangles into the
    // polyhedron's actual polygon faces by grouping on quantized outward
    // normal. For a convex polyhedron, the union of vertices used by all
    // triangles sharing a normal IS the merged polygon's boundary (no
    // interior points, because the merged face is convex).
    const TOL = 1e-3;
    const groups = new Map();
    for (const tri of hull.faces) {
        const n = tri.normal;
        const key = `${Math.round(n.x / TOL)},${Math.round(n.y / TOL)},${Math.round(n.z / TOL)}`;
        let g = groups.get(key);
        if (!g) { g = []; groups.set(key, g); }
        g.push(tri);
    }

    const vertKey = v => `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`;
    const faces = [];
    for (const tris of groups.values()) {
        const vSet = new Map();
        for (const tri of tris) {
            let edge = tri.edge;
            do {
                const p = edge.head().point;
                vSet.set(vertKey(p), p);
                edge = edge.next;
            } while (edge !== tri.edge);
        }
        const onFace = convexFaceBoundary([...vSet.values()], tris[0].normal);
        if (onFace.length < 3) continue;
        faces.push(finishFace(onFace, faces.length));
    }

    return {
        type, name, R,
        inradius: faces[0].planeDist,
        vertsPerFace: undefined,        // varies by face
        faces,
        threeGeometry: buildBufferGeometryFromFaces(faces),
    };
}

function convexFaceBoundary(points, normal) {
    if (points.length <= 3) return points;

    let cx = 0, cy = 0, cz = 0;
    for (const p of points) { cx += p.x; cy += p.y; cz += p.z; }
    const centroid = new THREE.Vector3(cx / points.length, cy / points.length, cz / points.length);
    const n = normal.clone().normalize();
    const helper = Math.abs(n.y) < 0.95
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(1, 0, 0);
    const basisU = new THREE.Vector3().crossVectors(n, helper).normalize();
    const basisV = new THREE.Vector3().crossVectors(basisU, n).normalize();

    const pts = points.map(p => {
        const off = new THREE.Vector3().subVectors(p, centroid);
        return { p, x: off.dot(basisU), y: off.dot(basisV) };
    });
    pts.sort((a, b) => (a.x - b.x) || (a.y - b.y));

    const cross2 = (o, a, b) =>
        (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const hull = [];
    const EPS = 1e-8;
    for (const p of pts) {
        while (hull.length >= 2 && cross2(hull[hull.length - 2], hull[hull.length - 1], p) <= EPS) {
            hull.pop();
        }
        hull.push(p);
    }
    const lowerLen = hull.length;
    for (let i = pts.length - 2; i >= 0; i--) {
        const p = pts[i];
        while (hull.length > lowerLen && cross2(hull[hull.length - 2], hull[hull.length - 1], p) <= EPS) {
            hull.pop();
        }
        hull.push(p);
    }
    hull.pop();
    return hull.length >= 3 ? hull.map(h => h.p) : points;
}

// Waterman polyhedron W5: convex hull of FCC lattice points (x, y, z integer
// with x+y+z even) inside the sphere x² + y² + z² ≤ 10. Steve Waterman's
// construction. Origin is excluded since it's an interior point.
function buildWaterman5(R) {
    const points = [];
    const RMAX2 = 10;
    const MAX = 4;   // covers all FCC points with r² ≤ 10 (3² + 1² + 0² = 10)
    for (let x = -MAX; x <= MAX; x++) {
        for (let y = -MAX; y <= MAX; y++) {
            for (let z = -MAX; z <= MAX; z++) {
                if ((x + y + z) % 2 !== 0) continue;
                const r2 = x * x + y * y + z * z;
                if (r2 === 0 || r2 > RMAX2) continue;
                points.push([x, y, z]);
            }
        }
    }
    return buildConvexHullPolyhedron(points, R, 'Waterman W5', 'waterman5');
}

// Step-cut emerald gemstone. Hand-placed vertex set; convex hull derives the
// face structure. Tunable proportions match a classic emerald cut:
//   L:W ≈ 1.4, table:girdle ≈ 0.65, pavilion depth ≈ 0.43·W,
//   chamfered corners on table + girdle (8-sided cross-section).
function buildEmeraldCut(R) {
    const L  = 0.70;   // girdle half-length (long axis)
    const W  = 0.50;   // girdle half-width
    const Ht = 0.16;   // table height above girdle (crown)
    const Hk = -0.43;  // keel depth below girdle (pavilion)
    const Tt = 0.65;   // table scale (relative to girdle)
    const Cc = 0.25;   // chamfer fraction per axis (corner cut)
    const Kc = 0.35;   // keel half-length (the pavilion ridge)

    // Eight-vertex chamfered rectangle at height h. CCW from +X edge.
    function ring(hl, hw, h) {
        return [
            [ hl,            -hw * (1 - Cc), h],
            [ hl * (1 - Cc), -hw,            h],
            [-hl * (1 - Cc), -hw,            h],
            [-hl,            -hw * (1 - Cc), h],
            [-hl,             hw * (1 - Cc), h],
            [-hl * (1 - Cc),  hw,            h],
            [ hl * (1 - Cc),  hw,            h],
            [ hl,             hw * (1 - Cc), h],
        ];
    }

    const points = [
        ...ring(L * Tt, W * Tt, Ht),   // table (8 vertices at top)
        ...ring(L, W, 0),               // girdle (8 vertices at widest)
        [ Kc, 0, Hk],                   // keel +X endpoint
        [-Kc, 0, Hk],                   // keel -X endpoint
    ];
    return buildConvexHullPolyhedron(points, R, 'Emerald Cut', 'emeraldCut');
}

// Face-at-pole icosahedron: one entire face is centred on the south pole
// (Antarctica sits inside it, not split across 5 wedges) and another on
// the north pole. Vertices are placed at the golden-ratio positions and
// then rotated so a single face's centroid points to +Y. Face indices
// are assigned by BFS from the north-pole face, reserving slot 13 for
// the south-pole face — so face 0 = Arctic cap, face 13 = Antarctic cap.
// This is NOT Fuller's 1954 Dymaxion fold; see buildDymaxionIcosa below
// for the canonical AirOcean projection.
function buildFaceAtPoleIcosa(R) {
    const phi = (1 + Math.sqrt(5)) / 2;
    // Standard golden-ratio icosahedron vertex coordinates.
    const rawVerts = [
        [0,  1,  phi], [0, -1,  phi], [0,  1, -phi], [0, -1, -phi],
        [1,  phi, 0],  [-1, phi, 0],  [1, -phi, 0],  [-1, -phi, 0],
        [phi, 0,  1],  [-phi, 0,  1], [phi, 0, -1],  [-phi, 0, -1],
    ];

    // The face containing v0, v4, v8 has its centroid along (1,1,1)/√3.
    // Rotate so that direction maps to +Y — this becomes the N-pole face,
    // and its antipodal (v3, v7, v11) becomes the S-pole face.
    const faceCenter = new THREE.Vector3(
        rawVerts[0][0] + rawVerts[4][0] + rawVerts[8][0],
        rawVerts[0][1] + rawVerts[4][1] + rawVerts[8][1],
        rawVerts[0][2] + rawVerts[4][2] + rawVerts[8][2],
    ).normalize();
    const quat = new THREE.Quaternion().setFromUnitVectors(faceCenter, new THREE.Vector3(0, 1, 0));

    const rawLen = Math.hypot(rawVerts[0][0], rawVerts[0][1], rawVerts[0][2]);
    const vScale = R / rawLen;
    const vertices = rawVerts.map(v =>
        new THREE.Vector3(v[0], v[1], v[2]).applyQuaternion(quat).multiplyScalar(vScale)
    );

    // Discover the 20 triangular faces: every triple of vertices pairwise
    // separated by the icosa edge length (= 2 in the un-normalised system,
    // = 2·vScale here) forms a face. Stable and orientation-agnostic.
    const edgeLen2 = (2 * vScale) * (2 * vScale);
    const eps = edgeLen2 * 1e-3;
    const isEdge = (i, j) => {
        const dx = vertices[i].x - vertices[j].x;
        const dy = vertices[i].y - vertices[j].y;
        const dz = vertices[i].z - vertices[j].z;
        return Math.abs(dx * dx + dy * dy + dz * dz - edgeLen2) < eps;
    };
    const rawFaces = [];
    for (let i = 0; i < 12; i++) {
        for (let j = i + 1; j < 12; j++) {
            if (!isEdge(i, j)) continue;
            for (let k = j + 1; k < 12; k++) {
                if (isEdge(i, k) && isEdge(j, k)) rawFaces.push([i, j, k]);
            }
        }
    }
    if (rawFaces.length !== 20) {
        throw new Error(`Fuller icosa: expected 20 faces, got ${rawFaces.length}`);
    }

    // Locate the N-pole and S-pole faces by centroid latitude.
    const centroids = rawFaces.map(tri => {
        const c = new THREE.Vector3();
        for (const i of tri) c.add(vertices[i]);
        return c.multiplyScalar(1 / 3);
    });
    let northIdx = 0, southIdx = 0;
    let northY = -Infinity, southY = Infinity;
    for (let i = 0; i < 20; i++) {
        if (centroids[i].y > northY) { northY = centroids[i].y; northIdx = i; }
        if (centroids[i].y < southY) { southY = centroids[i].y; southIdx = i; }
    }

    // Face-to-face adjacency (faces share an edge ⇔ share 2 vertices).
    const adj = Array(20).fill(null).map(() => []);
    for (let i = 0; i < 20; i++) {
        for (let j = i + 1; j < 20; j++) {
            const a = new Set(rawFaces[i]);
            let shared = 0;
            for (const v of rawFaces[j]) if (a.has(v)) shared++;
            if (shared === 2) { adj[i].push(j); adj[j].push(i); }
        }
    }

    // BFS from the N-pole face, assigning indices 0, 1, 2, …, skipping slot
    // 13 (reserved for the S-pole face) so face 13 is always Antarctica.
    const newIdx = new Array(20).fill(-1);
    newIdx[northIdx] = 0;
    newIdx[southIdx] = 13;
    let next = 1;
    const queue = [northIdx];
    while (queue.length > 0) {
        const f = queue.shift();
        for (const n of adj[f]) {
            if (newIdx[n] !== -1) continue;
            if (next === 13) next = 14;
            newIdx[n] = next++;
            queue.push(n);
        }
    }

    const orderedFaces = new Array(20);
    for (let i = 0; i < 20; i++) orderedFaces[newIdx[i]] = rawFaces[i];

    const faces = orderedFaces.map((tri, idx) =>
        finishFace(tri.map(i => vertices[i]), idx));

    return {
        type: 'faceAtPoleIcosa',
        name: 'Face-at-Pole Icosa',
        R,
        inradius: faces[0].planeDist,
        vertsPerFace: 3,
        faces,
        threeGeometry: buildBufferGeometryFromFaces(faces),
    };
}

// Fuller's 1954 AirOcean / Dymaxion icosahedron.
//
// d3-geo-polygon's airocean projection works in two stages: vertices live
// in "projection space" at simple positions (N pole, S pole, ±arctan(0.5)
// band every 36° lon), and the projection applies the rotation
//   .rotate([-83.65929, 25.44458, -87.45184])
// to input geographic coordinates before deciding which face contains them.
//
// To reproduce the AirOcean *as a 3D polyhedron* with each vertex at its
// real geographic location, we invert that rotation and apply it to the
// simple-spec positions. After inversion, vertex 0 (originally at the N
// projection-pole) lands in the equatorial Atlantic and vertex 1 in the
// W Pacific — both well off any continent, which is the whole point of
// Fuller's orientation. The 30 icosa edges then run almost exclusively
// through ocean, so the canonical d3 face triplets + parent table can be
// re-used verbatim and the resulting unfold reproduces the iconic
// horizontal map with continents intact.
function buildDymaxionIcosa(R) {
    // Use d3-geo's rotate.invert equations exactly. The AirOcean orientation
    // is sensitive to this; treating the rotation as a plain Euler chain puts
    // the continents on the wrong facets.
    // d3's rotate convention is F = R_x(γ) · R_y(φ) · R_z(λ) applied to
    // (lon, lat) in radians, then converted to Cartesian. The inverse is
    // R_z(-λ) · R_y(-φ) · R_x(-γ). All angles below are radians.
    const deltaLambda = -83.65929 * Math.PI / 180;
    const deltaPhi    =  25.44458 * Math.PI / 180;
    const deltaGamma  = -87.45184 * Math.PI / 180;
    const cosDeltaPhi = Math.cos(deltaPhi);
    const sinDeltaPhi = Math.sin(deltaPhi);
    const cosDeltaGamma = Math.cos(deltaGamma);
    const sinDeltaGamma = Math.sin(deltaGamma);
    const tau = 2 * Math.PI;
    const wrapLon = (lambda) => {
        if (Math.abs(lambda) > Math.PI) lambda -= Math.round(lambda / tau) * tau;
        return lambda;
    };
    const invertD3Rotate = (lambda, phi) => {
        const cosPhi = Math.cos(phi);
        const x = Math.cos(lambda) * cosPhi;
        const y = Math.sin(lambda) * cosPhi;
        const z = Math.sin(phi);
        const k = z * cosDeltaGamma - y * sinDeltaGamma;
        return [
            wrapLon(Math.atan2(
                y * cosDeltaGamma + z * sinDeltaGamma,
                x * cosDeltaPhi + k * sinDeltaPhi,
            ) - deltaLambda),
            Math.asin(k * cosDeltaPhi - x * sinDeltaPhi),
        ];
    };

    // d3's airocean simple-spec vertices (projection space):
    //   v0 = N pole, v1 = S pole, v2..v11 alternate ±arctan(0.5) every 36°.
    const theta = Math.atan(0.5);
    const simpleVerts = [
        [0, Math.PI / 2],
        [0, -Math.PI / 2],
    ];
    for (let i = 0; i < 10; i++) {
        const lonDeg = ((i * 36 + 180) % 360) - 180;
        simpleVerts.push([lonDeg * Math.PI / 180, (i & 1) ? theta : -theta]);
    }

    // Apply d3's exact inverse rotation to each simple-spec vertex, then
    // convert geographic lon/lat to this app's convention:
    // +X = lon 0, +Y = north pole, -Z = lon +90E.
    const vertices = simpleVerts.map(([lon, lat]) => {
        const [geoLon, geoLat] = invertD3Rotate(lon, lat);
        const geoCosLat = Math.cos(geoLat);
        return new THREE.Vector3(
            Math.cos(geoLon) * geoCosLat * R,
            Math.sin(geoLat) * R,
            -Math.sin(geoLon) * geoCosLat * R,
        );
        // d3 Cartesian: x = cos(lon)cos(lat), y = sin(lon)cos(lat), z = sin(lat)
        // R_x(-γ): rotate (y, z) by -γ
        // R_y(-φ): rotate (z, x) by -φ → matrix form (x, z) → (x cosP + z sinP, -x sinP + z cosP)
        // R_z(-λ): rotate (x, y) by -λ
        // Convert d3 (x, y, z) → app (x, z, -y): app uses y-up + lon = atan2(-z, x).
    });

    // d3-geo-polygon's exact face triplets, in d3's index order.
    const faceTriplets = [
        // 0..4 north cap (rooted at v0):
        [0, 3, 11], [0, 5, 3], [0, 7, 5], [0, 9, 7], [0, 11, 9],
        // 5..14 equatorial belt:
        [2, 11, 3], [3, 4, 2], [4, 3, 5], [5, 6, 4], [6, 5, 7],
        [7, 8, 6], [8, 7, 9], [9, 10, 8], [10, 9, 11], [11, 2, 10],
        // 15..19 south cap (rooted at v1):
        [1, 2, 4], [1, 4, 6], [1, 6, 8], [1, 8, 10], [1, 10, 2],
    ];

    const faces = faceTriplets.map((tri, idx) => {
        const face = finishFace(tri.map(i => vertices[i]), idx);
        face.dymaxionVertexIds = tri.slice();
        return face;
    });

    return {
        type: 'dymaxionIcosa',
        name: 'Dymaxion (AirOcean)',
        R,
        inradius: faces[0].planeDist,
        vertsPerFace: 3,
        faces,
        dymaxionVertices: vertices,
        dymaxionFaceTriplets: faceTriplets.map(tri => tri.slice()),
        threeGeometry: buildBufferGeometryFromFaces(faces),
    };
}
