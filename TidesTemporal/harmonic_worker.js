/* Minimal worker to synthesize elevations: h(t) = sum_k A_k cos(omega_k t + phi_k) */

let numStations = 0;
let numConstituents = 0;
let amplitudes = null; // Float32Array length N*K (row-major by station)
let cosPhi = null;     // Float32Array length N*K
let sinPhi = null;     // Float32Array length N*K
let omega = null;      // Float64Array length K (rad/sec)

self.onmessage = (ev) => {
  const { type } = ev.data || {};
  if (type === 'init') {
    const { N, K, A, Phi, Omega } = ev.data;
    numStations = N;
    numConstituents = K;
    amplitudes = new Float32Array(A);
    omega = new Float64Array(Omega);
    cosPhi = new Float32Array(N * K);
    sinPhi = new Float32Array(N * K);
    // Precompute cos/sin of phase per station/constituent
    for (let s = 0; s < N; s++) {
      for (let k = 0; k < K; k++) {
        const idx = s * K + k;
        const ph = Phi[idx];
        cosPhi[idx] = Math.cos(ph);
        sinPhi[idx] = Math.sin(ph);
      }
    }
    postMessage({ type: 'ready' });
    return;
  }
  if (type === 'compute') {
    const { tSeconds } = ev.data;
    const out = new Float32Array(numStations);
    // Compute cos/sin alpha_k(t) once per constituent
    const cosAlpha = new Float64Array(numConstituents);
    const sinAlpha = new Float64Array(numConstituents);
    for (let k = 0; k < numConstituents; k++) {
      const a = omega[k] * tSeconds;
      cosAlpha[k] = Math.cos(a);
      sinAlpha[k] = Math.sin(a);
    }
    // Sum per station
    for (let s = 0; s < numStations; s++) {
      let h = 0.0;
      let base = s * numConstituents;
      for (let k = 0; k < numConstituents; k++) {
        const Ak = amplitudes[base + k];
        if (Ak === 0) continue;
        // cos(alpha - phi) = cosAlpha*cosPhi + sinAlpha*sinPhi
        h += Ak * (cosPhi[base + k] * cosAlpha[k] + sinPhi[base + k] * sinAlpha[k]);
      }
      out[s] = h;
    }
    // Transfer buffer back
    postMessage({ type: 'result', elevations: out }, [out.buffer]);
    return;
  }
};


