/* Minimal worker to synthesize elevations: h(t) = sum_k A_k cos(omega_k t + phi_k)
   Hardened with input sanitization and debug messages. */

let numStations = 0;
let numConstituents = 0;
let amplitudes = null; // Float32Array length N*K (row-major by station)
let cosPhi = null;     // Float32Array length N*K
let sinPhi = null;     // Float32Array length N*K
let omega = null;      // Float64Array length K (rad/sec)

let selectedStation = -1;
let trackedComponentIndices = [];

self.onmessage = (ev) => {
  const { type } = ev.data || {};
  if (type === 'init') {
    const { N, K, A, Phi, Omega } = ev.data;
    numStations = N;
    numConstituents = K;
    amplitudes = new Float32Array(A);
    omega = new Float64Array(Omega);

    // Inspect phases for degree-like values and convert if needed per station/constituent
    // Heuristic: if max(|phi|) > 2*pi, treat as degrees
    let maxAbsPhi = 0;
    for (let i = 0; i < Phi.length; i++) {
      const v = Phi[i];
      if (Number.isFinite(v)) {
        const av = Math.abs(v);
        if (av > maxAbsPhi) maxAbsPhi = av;
      }
    }
    const phiIsDegrees = maxAbsPhi > (Math.PI * 2 + 1e-6);

    cosPhi = new Float32Array(N * K);
    sinPhi = new Float32Array(N * K);

    // Precompute cos/sin of phase per station/constituent (sanitize inputs)
    for (let s = 0; s < N; s++) {
      for (let k = 0; k < K; k++) {
        const idx = s * K + k;
        let Ak = amplitudes[idx];
        let ph = Phi[idx];
        if (!Number.isFinite(Ak) || Math.abs(Ak) > 100) {
          // Sanitize absurd amplitude
          amplitudes[idx] = 0;
          Ak = 0;
        }
        if (!Number.isFinite(ph)) {
          ph = 0;
        } else if (phiIsDegrees) {
          ph = ph * Math.PI / 180;
        }
        cosPhi[idx] = Math.cos(ph);
        sinPhi[idx] = Math.sin(ph);
      }
    }
    postMessage({ type: 'ready', phiIsDegrees });
    return;
  }
  if (type === 'set_selected_station') {
    selectedStation = ev.data.station;
    trackedComponentIndices = ev.data.componentIndices || [];
    return;
  }
  if (type === 'compute_historical') {
    const { station, componentIndices, startTime, endTime, timeStep } = ev.data;
    if (station < 0 || station >= numStations || !componentIndices.length) {
      postMessage({ type: 'historical_result', error: 'Invalid parameters' });
      return;
    }

    const timePoints = [];
    const componentData = [];
    
    // Initialize arrays for each component
    for (let i = 0; i < componentIndices.length; i++) {
      componentData.push([]);
    }

    // Compute data for each time point
    for (let t = startTime; t <= endTime; t += timeStep) {
      timePoints.push(t);
      
      // Compute cos/sin alpha_k(t) for this time
      const cosAlpha = new Float64Array(numConstituents);
      const sinAlpha = new Float64Array(numConstituents);
      for (let k = 0; k < numConstituents; k++) {
        const a = omega[k] * t;
        cosAlpha[k] = Math.cos(a);
        sinAlpha[k] = Math.sin(a);
      }

      // Compute each tracked component value
      const base = station * numConstituents;
      for (let i = 0; i < componentIndices.length; i++) {
        const k = componentIndices[i];
        const Ak = amplitudes[base + k];
        const term = Ak * (cosPhi[base + k] * cosAlpha[k] + sinPhi[base + k] * sinAlpha[k]);
        componentData[i].push(Number.isFinite(term) ? term : 0);
      }
    }

    postMessage({ 
      type: 'historical_result', 
      station, 
      timePoints, 
      componentData 
    }, []);
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
      const base = s * numConstituents;
      for (let k = 0; k < numConstituents; k++) {
        const Ak = amplitudes[base + k];
        if (Ak === 0) continue;
        const term = Ak * (cosPhi[base + k] * cosAlpha[k] + sinPhi[base + k] * sinAlpha[k]);
        if (!Number.isFinite(term)) {
          // Emit debug message and skip term
          postMessage({ type: 'debug', station: s, constituent: k, issue: 'non_finite_term', Ak, cosPhi: cosPhi[base+k], sinPhi: sinPhi[base+k], cosAlpha: cosAlpha[k], sinAlpha: sinAlpha[k] });
          continue;
        }
        h += term;
      }
      if (!Number.isFinite(h) || Math.abs(h) > 100) {
        // Emit debug for this station and set to NaN; main thread will handle
        postMessage({ type: 'debug', station: s, issue: 'bad_sum', h });
        out[s] = NaN;
      } else {
        out[s] = h;
      }
    }
    
    let componentValues = null;
    if (selectedStation !== -1 && trackedComponentIndices.length > 0) {
      // Always compute all components when we have a selected station
      componentValues = new Float32Array(numConstituents);
      const base = selectedStation * numConstituents;
      for (let k = 0; k < numConstituents; k++) {
        const Ak = amplitudes[base + k];
        const term = Ak * (cosPhi[base + k] * cosAlpha[k] + sinPhi[base + k] * sinAlpha[k]);
        componentValues[k] = Number.isFinite(term) ? term : 0;
      }
    }

    // Transfer buffer back
    if (componentValues) {
      postMessage({ type: 'result', elevations: out, componentValues: componentValues }, [out.buffer, componentValues.buffer]);
    } else {
      postMessage({ type: 'result', elevations: out }, [out.buffer]);
    }
    return;
  }
  if (type === 'compute_single') {
    const { station, tSeconds } = ev.data;
    const s = station;
    if (s < 0 || s >= numStations) {
      postMessage({ type: 'single_debug', station: s, error: 'out_of_range' });
      return;
    }
    const terms = new Float64Array(numConstituents);
    const base = s * numConstituents;
    for (let k = 0; k < numConstituents; k++) {
      const a = omega[k] * tSeconds;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const Ak = amplitudes[base + k];
      if (Ak === 0) { terms[k] = 0; continue; }
      const term = Ak * (cosPhi[base + k] * ca + sinPhi[base + k] * sa);
      terms[k] = Number.isFinite(term) ? term : NaN;
    }
    let sum = 0;
    for (let k = 0; k < numConstituents; k++) {
      const v = terms[k];
      if (!Number.isFinite(v)) continue;
      sum += v;
    }
    postMessage({ type: 'single_debug', station: s, terms, sum }, [terms.buffer]);
    return;
  }
};


