import * as THREE from 'three';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.156.1/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'https://cdn.jsdelivr.net/npm/three@0.156.1/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'https://cdn.jsdelivr.net/npm/three@0.156.1/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'https://cdn.jsdelivr.net/npm/three@0.156.1/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'https://cdn.jsdelivr.net/npm/three@0.156.1/examples/jsm/postprocessing/ShaderPass.js';

async function main() {
  // Load real harmonics exported from GOT5.5/5.6
  async function loadHarm(){
    const url = 'harmonics_demo.json';
    try {
      const r = await fetch(url, { cache: 'no-cache' });
      if (r.ok) {
        console.log('Loaded harmonics from', url);
        return await r.json();
      } else {
        console.warn('Failed to load', url, r.status, r.statusText);
      }
    } catch (e) {
      console.warn('Error fetching', url, e);
    }
    return null;
  }
  const harm = await loadHarm();
  if (!harm) {
    const msg = 'Failed to load harmonics data';
    console.error(msg);
    const div = document.createElement('div');
    div.textContent = msg;
    div.style.position = 'fixed';
    div.style.top = '50%';
    div.style.left = '50%';
    div.style.transform = 'translate(-50%, -50%)';
    div.style.background = 'rgba(0,0,0,0.7)';
    div.style.padding = '12px 16px';
    div.style.borderRadius = '6px';
    document.body.appendChild(div);
    return; // Stop execution if no data
  }

  const lats = harm.latitudes;
  const lons = harm.longitudes;
  const N = lats.length;
  const names = harm.meta.constituents;
  const K = names.length;
  const land = harm.land_mask || new Array(N).fill(false);

  // Convert to typed arrays and compute angular speeds from periods (use simplified Doodson where known or fallback approx).
  // For now, accept a static mapping for common constituents; others default to zero (static phase contribution).
  const periodHours = {
    'M2': 12.4206012,
    'S2': 12.0000000,
    'N2': 12.6583475,
    'K2': 11.9672361,
    'K1': 23.9344721,
    'O1': 25.8193387,
    'P1': 24.065889,
    'Q1': 26.868356,
    'M4': 6.2103006,
    'MS4': 6.0,
    'S1': 24.0,
    'OO1': 22.30608,
    'SIG1': 22.3972,
    '2N2': 12.905374,
    'J1': 23.0985,
    'M3': 8.2804008,
    // Additional
    'MU2': 12.871754,
    'L2': 12.191620,
    'M1': 24.841200
  };
  const Omega = new Float64Array(K);
  for (let k=0;k<K;k++) {
    let name = names[k].toUpperCase();
    // Normalize common variants: strip primes, fix O01->OO1
    name = name.replace(/[\'`′]/g, '');
    if (name === 'O01') name = 'OO1';
    const ph = periodHours[name];
    Omega[k] = ph ? (2*Math.PI/(ph*3600)) : 0.0;
  }
  // Debug: list any zero-frequency constituents (won't oscillate)
  const zeroFreq = [];
  for (let k=0;k<K;k++) if (Omega[k] === 0) zeroFreq.push(names[k]);
  if (zeroFreq.length) console.warn('Zero-frequency constituents (no oscillation):', zeroFreq);
  // Flatten amplitudes/phases into typed arrays (amplitudes: meters; phases: radians)
  const A = new Float32Array(N*K);
  const Phi = new Float32Array(N*K);
  for (let k=0;k<K;k++) {
    const ak = harm.amplitudes[k];
    const pk = harm.phases[k];
    for (let s=0;s<N;s++) {
      const idx = s*K + k;
      A[idx] = ak[s] || 0;
      Phi[idx] = pk[s] || 0;
    }
  }

  let simTime = 0; // seconds since epoch (UTC) — declared early so worker can reference
  // Worker
  const worker = new Worker('harmonic_worker.js', { type: 'module' });
  let ready = false;
  worker.postMessage({ type:'init', N, K, A, Phi, Omega });
  const tlabel = document.getElementById('tlabel');
  
  const requestedComponents = ['M2', 'S2', 'K1', 'O1', 'P1'];
  const trackedPairs = requestedComponents.map(name => {
    const upper = name.toUpperCase();
    const idx = names.findIndex(n => n.toUpperCase().replace(/[\'`′]/g, '') === upper);
    return idx !== -1 ? { name, index: idx } : null;
  }).filter(Boolean);
  const trackedComponentIndices = trackedPairs.map(p => p.index);
  const trackedComponentNames = trackedPairs.map(p => p.name);
  console.log('Tracking components:', trackedPairs);

  const componentDescriptions = {
    'M2': 'Principal Lunar Semidiurnal',
    'S2': 'Principal Solar Semidiurnal',
    'N2': 'Larger Lunar Elliptic Semidiurnal',
    'K2': 'Lunisolar Semidiurnal',
    'K1': 'Lunisolar Diurnal',
    'O1': 'Principal Lunar Diurnal',
    'P1': 'Principal Solar Diurnal',
    'Q1': 'Larger Lunar Elliptic Diurnal'
  };

  function latLonFromVec(x,y,z){
    const r = Math.hypot(x,y,z) || 1;
    const lat = Math.asin(y/r) * 180/Math.PI;
    const lon = -Math.atan2(z, x) * 180/Math.PI; // invert to match render
    return { lat, lon };
  }
  function nearestStationIndex(ray){
    // project ray to sphere and find nearest point by angle (fast scan; N is small)
    let best = -1, bestDot = -2;
    for (let i=0;i<N;i++){
      const b = i*3;
      const vx = basePos[b], vy = basePos[b+1], vz = basePos[b+2];
      const mag = Math.hypot(vx,vy,vz) || 1;
      const nx = vx/mag, ny = vy/mag, nz = vz/mag;
      const dot = ray.x*nx + ray.y*ny + ray.z*nz;
      if (dot > bestDot){ bestDot = dot; best = i; }
    }
    return best;
  }
  
  let phiIsDegreesFlag = null;
  worker.onmessage = (ev) => {
    const { type } = ev.data || {};
    if (type === 'ready') { 
      ready = true; 
      if (ev.data && typeof ev.data.phiIsDegrees === 'boolean') {
        phiIsDegreesFlag = ev.data.phiIsDegrees;
        console.warn('Worker phases treated as', ev.data.phiIsDegrees ? 'degrees (auto-converted to radians)' : 'radians');
      }
      // Trigger initial compute to show points with proper colors
      worker.postMessage({ type:'compute', tSeconds: simTime });
    }
    if (type === 'debug') {
      const s = ev.data.station;
      const lat = lats[s];
      const lon = lons[s];
      console.warn('Worker debug:', { ...ev.data, lat, lon });
    }
    if (type === 'single_debug') {
      const s = ev.data.station;
      if (ev.data.error) { console.warn('single_debug error', ev.data); return; }
      const terms = new Float64Array(ev.data.terms);
      const sum = ev.data.sum;
      const detail = [];
      for (let k=0;k<names.length;k++){
        const Ak = harm.amplitudes[k][s];
        const ph = harm.phases[k][s];
        detail.push({ k, name: names[k], Ak, ph, term: terms[k] });
      }
      detail.sort((a,b)=>Math.abs(b.term)-Math.abs(a.term));
      console.table(detail.slice(0,12));
      console.log('[single_debug] station', s, 'lat/lon', lats[s], lons[s], 'sum=', sum, 'top terms above');
    }
    if (type === 'result') { 
      if (ev.data.componentValues) {
        updateGraph(simTime, new Float32Array(ev.data.componentValues));
      }
      applyElevations(ev.data.elevations);
      // Update highlight tile with current elevation
      if (selectedStation !== -1) {
        updateHighlightTile(selectedStation, ev.data.elevations[selectedStation]);
      }
    }
    if (type === 'historical_result') {
      if (ev.data.error) {
        console.warn('Historical computation error:', ev.data.error);
        return;
      }
      populateHistoricalData(ev.data.timePoints, ev.data.componentData);
    }
  };

  // Three.js scene
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, innerWidth/innerHeight, 0.1, 1000);
  const renderer = new THREE.WebGLRenderer({ antialias:true });
  renderer.setSize(innerWidth, innerHeight);
  document.body.appendChild(renderer.domElement);

  const renderPass = new RenderPass( scene, camera );
  const bloomPass = new UnrealBloomPass( new THREE.Vector2( window.innerWidth, window.innerHeight ), 1.5, 0.4, 0.85 );
  bloomPass.threshold = 0;
  bloomPass.strength = 1.0;
  bloomPass.radius = 0.4;

  const bloomComposer = new EffectComposer( renderer );
  bloomComposer.renderToScreen = false;
  bloomComposer.addPass( renderPass );
  bloomComposer.addPass( bloomPass );
  
  const finalPass = new ShaderPass(
    new THREE.ShaderMaterial( {
      uniforms: {
        baseTexture: { value: null },
        bloomTexture: { value: bloomComposer.renderTarget2.texture }
      },
      vertexShader: document.getElementById( 'vertexshader' ).textContent,
      fragmentShader: document.getElementById( 'fragmentshader' ).textContent,
      defines: {}
    } ), 'baseTexture'
  );
  finalPass.needsSwap = true;

  const finalComposer = new EffectComposer( renderer );
  finalComposer.addPass( renderPass );
  finalComposer.addPass( finalPass );


  const controls = new OrbitControls(camera, renderer.domElement);
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.2;

  const stopAutoRotate = () => {
    if (controls.autoRotate) {
      controls.autoRotate = false;
      renderer.domElement.removeEventListener('pointerdown', stopAutoRotate);
      renderer.domElement.removeEventListener('wheel', stopZooming);
    }
  };

  const stopZooming = () => {
      // This function does nothing but is used to remove the wheel listener
  };

  renderer.domElement.addEventListener('pointerdown', stopAutoRotate, { once: true });
  renderer.domElement.addEventListener('wheel', stopZooming, { once: true });


  let distance = 14;
  const angle = 20 * Math.PI / 180; // 20 degrees in radians

  // Adjust for mobile devices
  if (window.innerWidth < 768) {
    distance = 14 * 1.5; // 50% more zoomed out
    // Panning the camera up (moving the globe down) is done by raising the camera's target
    controls.target.set(0, 3, 0); 
  }

  camera.position.set(0, distance * Math.sin(angle), distance * Math.cos(angle));
  controls.update();

  // Add lighting for better shading
  const ambientLight = new THREE.AmbientLight(0x404040, 0.6); // soft ambient
  scene.add(ambientLight);
  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
  directionalLight.position.set(1, 1, 1).normalize();
  scene.add(directionalLight);

  const cameraInverseMatrix = camera.matrixWorld.clone().invert();
  const lightOffsetDirection = directionalLight.position.clone().transformDirection(cameraInverseMatrix);

  const earthR = 6.37;
  // Invisible sphere for raycasting
  const earthSphere = new THREE.Mesh(
    new THREE.SphereGeometry(earthR, 64, 32),
    new THREE.MeshBasicMaterial({ color: 0xff0000, wireframe: true, visible: false })
  );
  scene.add(earthSphere);

  const ptsGeom = new THREE.BufferGeometry();
  const vertices = [];
  for (let i=0;i<N;i++) {
    const lat = lats[i]*Math.PI/180;
    const lon = -lons[i]*Math.PI/180; // flip for view
    const x = earthR*Math.cos(lat)*Math.cos(lon);
    const y = earthR*Math.sin(lat);
    const z = earthR*Math.cos(lat)*Math.sin(lon);
    vertices.push(x,y,z);
  }
  ptsGeom.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  const colors = new Float32Array(N*3);
  // Initialize all points to white so they're visible immediately
  for (let i=0; i<N*3; i+=3) {
    colors[i] = 1.0; colors[i+1] = 1.0; colors[i+2] = 1.0;
  }
  ptsGeom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const points = new THREE.Points(ptsGeom, new THREE.PointsMaterial({
    vertexColors:true,
    size:0.08,
    depthTest: true
  }));
  points.renderOrder = 5; // Render after tiles but still depth-tested by occluder
  scene.add(points);
  console.log(`Created ${N} points on sphere`);

  // Occluder disc to hide back half of the globe
  const occluderGeometry = new THREE.CircleGeometry(earthR + 0.1, 64);
  const occluderMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide });
  const occluder = new THREE.Mesh(occluderGeometry, occluderMaterial);
  occluder.renderOrder = 0;
  scene.add(occluder);

  const metersToUnits = earthR / 6371000;
  const pointOffsetUnits = 0.02 * metersToUnits; // 2 cm outward so points stay visible over tiles
  const basePos = ptsGeom.attributes.position.array.slice();
  let isPlaying = true;
  let fps = 20;
  let exag = 250000;
  let range = 0.4;
  const playBtn = document.getElementById('play');
  const pauseBtn = document.getElementById('pause');
  const dtInput = document.getElementById('datetime');
  const jumpBtn = document.getElementById('jump');
  const fpsSlider = document.getElementById('fps');
  const exagSlider = document.getElementById('exag');
  const rangeSlider = document.getElementById('range');
  const goldSlider = document.getElementById('gold');
  const oceanGlowSlider = document.getElementById('ocean-glow');
  const lockLightBtn = document.getElementById('lock-light-btn');
  const invertBtn = document.getElementById('invert-btn');
  
  let isLightLocked = false;
  lockLightBtn.textContent = isLightLocked ? '☀️ Follow Camera' : 'Lock ☀️';
  let oceanGlow = 0.0;
  let isLandShown = false;
  let currentTween = null;
  let currentTimeTween = null;
  let selectedStation = -1;
  const graphContainer = document.getElementById('graph-container');
  const graphInfo = document.getElementById('graph-info');
  const closeGraphBtn = document.getElementById('close-graph-btn');
  const graphCanvas = document.getElementById('tidal-graph');
  const graphCtx = graphCanvas.getContext('2d');

  const twoDaysInSeconds = 2 * 24 * 3600;
  const graphData = trackedComponentNames.map(() => []); // Array of arrays for each component's data points [time, value]
  const componentColors = ['#ff6384', '#36a2eb', '#ffce56', '#4bc0c0', '#9966ff'];

  function initGraph() {
    const dpr = window.devicePixelRatio || 1;
    const rect = graphCanvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    graphCanvas.width = w * dpr;
    graphCanvas.height = h * dpr;
    graphCtx.setTransform(1, 0, 0, 1, 0, 0);
    graphCtx.scale(dpr, dpr);
  }
  initGraph();

  window.addEventListener('resize', () => {
    if (graphContainer.classList.contains('visible')) {
      initGraph();
      drawGraph();
    }
  });

  function clearGraph() {
    graphData.forEach(arr => arr.length = 0);
  }

  function drawGraph() {
    const rect = graphCanvas.getBoundingClientRect();
    const width = Math.floor(rect.width);
    const height = Math.floor(rect.height);
    if (width <= 0 || height <= 0) return;
    graphCtx.clearRect(0, 0, width, height);
    
    // Some visual settings
    const padding = { top: 60, right: 15, bottom: 20, left: 140 }; // extra top space for header
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const maxAmplitude = 1.0; // Fixed y-axis range [-1m, 1m] shared across all subplots
    if (plotWidth <= 0 || plotHeight <= 0) return;

    // Background
    graphCtx.fillStyle = 'rgba(0, 0, 0, 0.15)';
    graphCtx.fillRect(0, 0, width, height);

    // Determine global time window from latest available data across all components
    let latestTime = -Infinity;
    for (let i = 0; i < graphData.length; i++) {
      const arr = graphData[i];
      if (arr.length > 0) latestTime = Math.max(latestTime, arr[arr.length - 1][0]);
    }
    const hasData = Number.isFinite(latestTime);
    const startTime = hasData ? latestTime - twoDaysInSeconds : (simTime - twoDaysInSeconds);

    // Subplot layout (two columns: left=component, right=accumulator)
    const num = Math.max(1, trackedComponentNames.length);
    const subH = Math.max(80, Math.floor(plotHeight / num));
    const colGap = 10;
    const colWidth = (plotWidth - colGap) / 2;

    // Draw each subplot
    for (let i = 0; i < num; i++) {
      const subTop = padding.top + i * subH;
      const subBottom = subTop + subH;

      // Axes: left axis and zero line
      graphCtx.strokeStyle = '#00aaff';
      graphCtx.lineWidth = 1;
      graphCtx.beginPath();
      // component column axes
      graphCtx.moveTo(padding.left, subTop);
      graphCtx.lineTo(padding.left, subBottom);
      const yZero = subTop + subH / 2;
      graphCtx.moveTo(padding.left, yZero);
      graphCtx.lineTo(padding.left + colWidth, yZero);
      // accumulator column axes
      const rightColLeft = padding.left + colWidth + colGap;
      graphCtx.moveTo(rightColLeft, subTop);
      graphCtx.lineTo(rightColLeft, subBottom);
      graphCtx.moveTo(rightColLeft, yZero);
      graphCtx.lineTo(rightColLeft + colWidth, yZero);
      graphCtx.stroke();

      // Right column title once at the top row
      if (i === 0) {
        graphCtx.fillStyle = '#ffaa00';
        graphCtx.font = 'bold 10px Courier New';
        graphCtx.textAlign = 'left';
        graphCtx.textBaseline = 'bottom';
        graphCtx.fillText('Accumulators', rightColLeft + 4, padding.top - 4);
        // also label left column once
        graphCtx.fillStyle = '#00aaff';
        graphCtx.fillText('Components', padding.left + 4, padding.top - 4);
      }

      // Dotted daily time markers (00:00 UTC) across both columns
      graphCtx.save();
      graphCtx.strokeStyle = 'rgba(255,255,255,0.45)';
      graphCtx.lineWidth = 1.1;
      graphCtx.setLineDash([3, 5]);
      const day = 24 * 3600;
      const firstMidnight = Math.ceil(startTime / day) * day;
      for (let t = firstMidnight; t <= startTime + twoDaysInSeconds + 1; t += day) {
        const rel = (t - startTime) / twoDaysInSeconds;
        const xComp = padding.left + rel * colWidth;
        const xAcc = rightColLeft + rel * colWidth;
        graphCtx.beginPath();
        graphCtx.moveTo(xComp, subTop);
        graphCtx.lineTo(xComp, subBottom);
        graphCtx.stroke();
        graphCtx.beginPath();
        graphCtx.moveTo(xAcc, subTop);
        graphCtx.lineTo(xAcc, subBottom);
        graphCtx.stroke();
      }
      graphCtx.restore();

      // Left gutter info per component
      const labelName = trackedComponentNames[i] || '';
      const kIdx = trackedPairs[i] ? trackedPairs[i].index : -1;
      let periodH = null;
      if (kIdx !== -1) {
        const key = labelName.toUpperCase();
        periodH = periodHours[key] || (Omega[kIdx] ? (2*Math.PI / Omega[kIdx] / 3600) : null);
      }
      let ampStr = '-';
      let phiStr = '-';
      if (selectedStation !== -1 && kIdx !== -1) {
        const amp = harm.amplitudes[kIdx] && Number.isFinite(harm.amplitudes[kIdx][selectedStation]) ? harm.amplitudes[kIdx][selectedStation] : NaN;
        let phiVal = harm.phases[kIdx] && Number.isFinite(harm.phases[kIdx][selectedStation]) ? harm.phases[kIdx][selectedStation] : NaN;
        // Convert phase to degrees if needed
        if (Number.isFinite(phiVal)) {
          const isDeg = (phiIsDegreesFlag === null) ? true : phiIsDegreesFlag; // default assume degrees
          phiVal = isDeg ? phiVal : (phiVal * 180/Math.PI);
          // normalize to [-180, 180]
          phiVal = ((phiVal + 180) % 360 + 360) % 360 - 180;
        }
        if (Number.isFinite(amp)) ampStr = amp.toFixed(2) + ' m';
        if (Number.isFinite(phiVal)) phiStr = phiVal.toFixed(1) + '°';
      }

      graphCtx.font = '10px Courier New';
      graphCtx.textAlign = 'left';
      graphCtx.textBaseline = 'top';
      const gutterX = 8;
      const line1Y = subTop + 2;
      const desc = componentDescriptions[labelName.toUpperCase()] || '';
      function wrapText(str, maxChars) {
        const words = str.split(' ');
        const lines = [];
        let current = '';
        for (const w of words) {
          const tryLine = current ? current + ' ' + w : w;
          if (tryLine.length <= maxChars) current = tryLine;
          else { if (current) lines.push(current); current = w; }
        }
        if (current) lines.push(current);
        return lines;
      }
      const descLines = wrapText(desc, 18).slice(0, 2);
      graphCtx.fillStyle = componentColors[i % componentColors.length];
      graphCtx.fillText(`${labelName}`, gutterX, line1Y);
      graphCtx.fillStyle = '#cccccc';
      for (let li = 0; li < descLines.length; li++) {
        graphCtx.fillText(descLines[li], gutterX, line1Y + 12 + li*12);
      }
      graphCtx.fillStyle = '#ffffff';
      const periodText = (periodH && Number.isFinite(periodH)) ? `T=${periodH.toFixed(2)} h` : 'T=—';
      const infoStartY = line1Y + 12 * (1 + descLines.length);
      graphCtx.fillText(periodText, gutterX, infoStartY);
      graphCtx.fillText(`A=${ampStr}`, gutterX, infoStartY + 12);
      graphCtx.fillText(`φ=${phiStr}`, gutterX, infoStartY + 24);

      // Y tick labels at left of axis
      graphCtx.fillStyle = '#ffffff';
      graphCtx.textAlign = 'right';
      graphCtx.textBaseline = 'middle';
      graphCtx.fillText('+1m', padding.left - 4, subTop);
      graphCtx.fillText('0', padding.left - 4, yZero);
      graphCtx.fillText('-1m', padding.left - 4, subBottom);

      // Plot data line for this component (left column)
      const history = graphData[i];
      if (!history || history.length < 1 || !hasData) continue;

      graphCtx.strokeStyle = componentColors[i % componentColors.length];
      graphCtx.lineWidth = 1;
      graphCtx.beginPath();

      let moved = false;
      for (let j = 0; j < history.length; j++) {
        const time = history[j][0];
        const value = history[j][1];
        if (time < startTime) continue;

        const x = padding.left + ((time - startTime) / twoDaysInSeconds) * colWidth;
        const y = yZero - (value / maxAmplitude) * (subH / 2);

        if (!moved) { graphCtx.moveTo(x, y); moved = true; }
        else { graphCtx.lineTo(x, y); }
      }
      graphCtx.stroke();

      // Plot accumulator line (right column)
      graphCtx.strokeStyle = '#ffaa00';
      graphCtx.lineWidth = 1;
      graphCtx.beginPath();
      moved = false;
      for (let j = 0; j < history.length; j++) {
        const time = history[j][0];
        if (time < startTime) continue;
        let sumVal = 0;
        for (let c = 0; c <= i; c++) {
          const h = graphData[c];
          if (!h || h.length === 0) continue;
          let idx = h.length - 1;
          while (idx > 0 && h[idx][0] > time) idx--;
          sumVal += h[idx][1];
        }
        const x = rightColLeft + ((time - startTime) / twoDaysInSeconds) * colWidth;
        const y = yZero - (sumVal / maxAmplitude) * (subH / 2);
        if (!moved) { graphCtx.moveTo(x, y); moved = true; }
        else { graphCtx.lineTo(x, y); }
      }
      graphCtx.stroke();
    }
  }

  function populateHistoricalData(timePoints, componentData) {
    clearGraph();
    for (let i = 0; i < trackedComponentNames.length && i < componentData.length; i++) {
      for (let j = 0; j < timePoints.length; j++) {
        graphData[i].push([timePoints[j], componentData[i][j]]);
      }
    }
    drawGraph();
    console.log(`Populated ${timePoints.length} historical data points`);
  }

  function updateGraph(time, values) {
    if (selectedStation === -1) return;
    for (let i = 0; i < trackedComponentNames.length && i < values.length; i++) {
      graphData[i].push([time, values[i]]);
      const cutoffTime = time - twoDaysInSeconds;
      while(graphData[i].length > 0 && graphData[i][0][0] < cutoffTime) {
        graphData[i].shift();
      }
    }
    drawGraph();
  }

  function tweenValues(targets, duration) {
    if (currentTween) cancelAnimationFrame(currentTween);
  
    const startValues = {};
    const endValues = {};
    for (const key in targets) {
      startValues[key] = parseFloat(targets[key].slider.value);
      endValues[key] = targets[key].endValue;
    }
  
    const startTime = performance.now();
  
    function animateTween() {
      const elapsedTime = performance.now() - startTime;
      let progress = elapsedTime / duration;
      if (progress > 1) progress = 1;
  
      for (const key in targets) {
        const slider = targets[key].slider;
        const start = startValues[key];
        const end = endValues[key];
        const newValue = start + (end - start) * progress;
        slider.value = newValue;
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      }
  
      if (progress < 1) {
        currentTween = requestAnimationFrame(animateTween);
      } else {
        currentTween = null;
      }
    }
    currentTween = requestAnimationFrame(animateTween);
  }

  closeGraphBtn.onclick = () => {
    setSelectedStation(-1);
  };

  function setSelectedStation(index) {
    if (index === selectedStation) return;

    selectedStation = index;

    if (selectedStation !== -1) {
      graphContainer.classList.add('visible');
      if (window.innerWidth <= 768) {
        document.body.classList.add('graph-open');
      }
      graphInfo.innerHTML = `Tidal Components<br><span style="opacity:0.9">Lat: ${lats[selectedStation].toFixed(2)}, Lon: ${lons[selectedStation].toFixed(2)}</span><br>`;
      clearGraph();
      initGraph();
      drawGraph();
      worker.postMessage({ type: 'set_selected_station', station: selectedStation, componentIndices: trackedComponentIndices });
      const endTime = simTime;
      const startTime = endTime - twoDaysInSeconds;
      const timeStep = 300;
      worker.postMessage({ 
        type: 'compute_historical', 
        station: selectedStation, 
        componentIndices: trackedComponentIndices,
        startTime: startTime,
        endTime: endTime,
        timeStep: timeStep
      });
      console.log("Selected station:", selectedStation, `Lat: ${lats[selectedStation]}, Lon: ${lons[selectedStation]}`);
    } else {
      graphContainer.classList.remove('visible');
      document.body.classList.remove('graph-open');
      worker.postMessage({ type: 'set_selected_station', station: -1 });
      updateHighlightTile(-1);
      console.log("Deselected station.");
    }
  }

  function selectTileFromPointer(clientX, clientY) {
    const mouse = new THREE.Vector2();
    mouse.x = (clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(clientY / window.innerHeight) * 2 + 1;
  
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);
  
    const intersects = raycaster.intersectObject(earthSphere);
  
    if (intersects.length > 0) {
      const intersectionPoint = intersects[0].point;
      let best = -1, bestDistSq = Infinity;
      const p = new THREE.Vector3();
      for (let i=0; i<N; i++){
        const b = i*3;
        p.set(basePos[b], basePos[b+1], basePos[b+2]);
        const distSq = p.distanceToSquared(intersectionPoint);
        if (distSq < bestDistSq){
          bestDistSq = distSq;
          best = i;
        }
      }
      if (best !== -1) {
        setSelectedStation(best);
      }
    }
  }

  renderer.domElement.addEventListener('dblclick', (event) => {
    selectTileFromPointer(event.clientX, event.clientY);
  });

  let tapStartTime = 0;
  let tapStartPos = { x: 0, y: 0 };
  const tapThreshold = 300; // ms
  const tapDistanceThreshold = 10; // pixels

  renderer.domElement.addEventListener('touchstart', (event) => {
    if (event.touches.length === 1) {
      tapStartTime = performance.now();
      tapStartPos.x = event.touches[0].clientX;
      tapStartPos.y = event.touches[0].clientY;
    }
  });

  renderer.domElement.addEventListener('touchend', (event) => {
    if (event.changedTouches.length === 1) {
      const tapEndTime = performance.now();
      const tapDuration = tapEndTime - tapStartTime;
      const tapEndPos = {
        x: event.changedTouches[0].clientX,
        y: event.changedTouches[0].clientY
      };
      const tapDistance = Math.hypot(
        tapEndPos.x - tapStartPos.x,
        tapEndPos.y - tapStartPos.y
      );

      if (tapDuration < tapThreshold && tapDistance < tapDistanceThreshold) {
        event.preventDefault();
        selectTileFromPointer(tapEndPos.x, tapEndPos.y);
      }
    }
  });

  let mouseStartPos = { x: 0, y: 0 };
  let mouseStartTime = 0;
  let isDragging = false;
  const clickDistanceThreshold = 5; // pixels

  renderer.domElement.addEventListener('mousedown', (event) => {
    mouseStartPos.x = event.clientX;
    mouseStartPos.y = event.clientY;
    mouseStartTime = performance.now();
    isDragging = false;
  });

  renderer.domElement.addEventListener('mousemove', (event) => {
    if (mouseStartTime > 0) {
      const distance = Math.hypot(
        event.clientX - mouseStartPos.x,
        event.clientY - mouseStartPos.y
      );
      if (distance > clickDistanceThreshold) {
        isDragging = true;
      }
    }
  });

  renderer.domElement.addEventListener('mouseup', (event) => {
    mouseStartTime = 0;
  });

  renderer.domElement.addEventListener('click', (event) => {
    if (performance.now() - tapStartTime > tapThreshold && !isDragging) {
      selectTileFromPointer(event.clientX, event.clientY);
    }
    isDragging = false;
  });

  function tweenSimTime(targetSimTime, duration) {
    if (currentTimeTween) cancelAnimationFrame(currentTimeTween);
    const wasPlaying = isPlaying;
    isPlaying = false;

    const startSimTime = simTime;
    const startTime = performance.now();

    function animateTimeTween() {
        const elapsedTime = performance.now() - startTime;
        let progress = elapsedTime / duration;
        if (progress > 1) progress = 1;

        simTime = startSimTime + (targetSimTime - startSimTime) * progress;
        
        worker.postMessage({ type:'compute', tSeconds: simTime });
        
        if (progress < 1) {
            currentTimeTween = requestAnimationFrame(animateTimeTween);
        } else {
            currentTimeTween = null;
            isPlaying = wasPlaying;
        }
    }
    currentTimeTween = requestAnimationFrame(animateTimeTween);
  }

  invertBtn.onclick = () => {
    isLandShown = !isLandShown;
    invertBtn.classList.toggle('inverted', isLandShown);
    updateLandColorVisibility();

    const targets = {
        gold: { slider: goldSlider, endValue: isLandShown ? 0.33 : 0 },
        ocean: { slider: oceanGlowSlider, endValue: isLandShown ? 0 : 0.15 }
    };

    tweenValues(targets, 1000);
  };

  lockLightBtn.onclick = (e) => {
    isLightLocked = !isLightLocked;
    lockLightBtn.textContent = isLightLocked ? '☀️ Follow Camera' : 'Lock ☀️';
  };
  // Instanced tile extrusion (per-vertex thin boxes on the sphere)
  const toRad = Math.PI/180;
  const tileFill = 0.95; // fraction of cell coverage in lat/lon
  const baseThicknessMeters = 0.25; // keep a thin visible base
  const baseThicknessUnits = baseThicknessMeters * metersToUnits;
  const surfaceOffsetUnits = 0.01 * metersToUnits; // ~1cm so points are just on top of tiles
  const landWallMeters = 5000000; // land tiles extrude inward as a wall (make very tall to see)
  const landWallUnits = landWallMeters * metersToUnits;
  const minTileHeightMeters = 0.01; // avoid zero-height degeneracy
  const minTileHeightUnits = minTileHeightMeters * metersToUnits;
  let instancedTiles = null;
  let highlightTile = null;
  const tileAxisX = new Float32Array(N*3); // lon tangent per instance
  const tileAxisY = new Float32Array(N*3); // normal per instance
  const tileAxisZ = new Float32Array(N*3); // lat tangent per instance
  const tileSizeX = new Float32Array(N);   // along lon
  const tileSizeZ = new Float32Array(N);   // along lat
  // Reusable temp objects
  const tmpMat = new THREE.Matrix4();
  const tmpQuat = new THREE.Quaternion();
  const tmpScale = new THREE.Vector3();
  const tmpPosV = new THREE.Vector3();
  const axisX = new THREE.Vector3();
  const axisY = new THREE.Vector3();
  const axisZ = new THREE.Vector3();
  
  function uniqSorted(values){
    // Round to 1e-6 to fold floating noise, then sort
    return Array.from(new Set(values.map(v => +v.toFixed(6)))).sort((a,b)=>a-b);
  }
  function medianStep(sortedVals){
    const diffs = [];
    for (let i=1;i<sortedVals.length;i++) diffs.push(sortedVals[i]-sortedVals[i-1]);
    if (!diffs.length) return 5; // deg fallback
    diffs.sort((a,b)=>a-b);
    return diffs[(diffs.length/2)|0];
  }
  function buildInstancedTiles(){
    const uniqLats = uniqSorted(lats);
    const uniqLons = uniqSorted(lons);
    const dLat = medianStep(uniqLats);
    const dLon = medianStep(uniqLons);
    const minDim = 0.003; // scene units; clamps near poles
    const boxGeom = new THREE.BoxGeometry(1,1,1);
    // Add a white vertex color attribute to the base geometry.
    // This prevents the instance color from being multiplied by a default black.
    const n_verts = boxGeom.attributes.position.count;
    const white = new Float32Array(n_verts * 3);
    white.fill(1.0);
    boxGeom.setAttribute('color', new THREE.BufferAttribute(white, 3));
    const tileMat = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: false,
      opacity: 1.0,
      side: THREE.FrontSide,
      wireframe: false
    });
    instancedTiles = new THREE.InstancedMesh(boxGeom, tileMat, N);
    instancedTiles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  instancedTiles.renderOrder = 1; // Render after occluder but before points
    // Create instance color attribute manually
    const instanceColors = new Float32Array(N * 3);
    for (let i = 0; i < N * 3; i += 3) {
      instanceColors[i] = 1.0; instanceColors[i+1] = 1.0; instanceColors[i+2] = 1.0; // white default
    }
    instancedTiles.instanceColor = new THREE.InstancedBufferAttribute(instanceColors, 3);
    instancedTiles.instanceColor.setUsage(THREE.DynamicDrawUsage);
    scene.add(instancedTiles);

    // Precompute axes and base sizes
    const dLatRad = dLat * toRad;
    const dLonRad = dLon * toRad;
    for (let i=0;i<N;i++){
      const latDeg = lats[i];
      const lonDeg = lons[i];
      const lat = latDeg * toRad;
      const lon = -lonDeg * toRad; // match view flip

      const cosLat = Math.cos(lat);
      const sinLat = Math.sin(lat);
      const cosLon = Math.cos(lon);
      const sinLon = Math.sin(lon);

      // Normal on sphere
      const nx = cosLat*cosLon;
      const ny = sinLat;
      const nz = cosLat*sinLon;
      // Tangents from spherical partial derivatives
      const tx_lon_x = -cosLat*sinLon;
      const tx_lon_y = 0;
      const tx_lon_z =  cosLat*cosLon;
      const tz_lat_x = -sinLat*cosLon;
      const tz_lat_y =  cosLat;
      const tz_lat_z = -sinLat*sinLon;

      const base = i*3;
      // Store normalized axes
      let len;
      // x axis (lon tangent)
      len = Math.hypot(tx_lon_x, tx_lon_y, tx_lon_z) || 1;
      tileAxisX[base] = tx_lon_x/len; tileAxisX[base+1] = tx_lon_y/len; tileAxisX[base+2] = tx_lon_z/len;
      // y axis (normal)
      len = Math.hypot(nx, ny, nz) || 1;
      tileAxisY[base] = nx/len; tileAxisY[base+1] = ny/len; tileAxisY[base+2] = nz/len;
      // z axis (lat tangent)
      len = Math.hypot(tz_lat_x, tz_lat_y, tz_lat_z) || 1;
      tileAxisZ[base] = tz_lat_x/len; tileAxisZ[base+1] = tz_lat_y/len; tileAxisZ[base+2] = tz_lat_z/len;

      // Base footprint size in scene units (arc length)
      const sizeX = Math.max(minDim, earthR * dLonRad * Math.max(0.0, cosLat) * tileFill);
      const sizeZ = Math.max(minDim, earthR * dLatRad * tileFill);
      tileSizeX[i] = sizeX;
      tileSizeZ[i] = sizeZ;

      // Initialize instance with thin base (height updated in applyElevations)
      axisX.set(tileAxisX[base], tileAxisX[base+1], tileAxisX[base+2]);
      axisY.set(tileAxisY[base], tileAxisY[base+1], tileAxisY[base+2]);
      axisZ.set(tileAxisZ[base], tileAxisZ[base+1], tileAxisZ[base+2]);
      tmpMat.makeBasis(axisX, axisY, axisZ);
      tmpQuat.setFromRotationMatrix(tmpMat);
      const b = base;
      tmpPosV.set(basePos[b], basePos[b+1], basePos[b+2]);
      tmpPosV.addScaledVector(axisY, baseThicknessUnits/2 - surfaceOffsetUnits);
      tmpScale.set(sizeX, baseThicknessUnits, sizeZ);
      tmpMat.compose(tmpPosV, tmpQuat, tmpScale);
      instancedTiles.setMatrixAt(i, tmpMat);
    }
    instancedTiles.instanceMatrix.needsUpdate = true;
  }
  buildInstancedTiles();

  function createHighlightTile() {
    const boxGeom = new THREE.BoxGeometry(1,1,1);
    const highlightMat = new THREE.ShaderMaterial({
      uniforms: {
        color: { value: new THREE.Color(0xffffff) },
        opacity: { value: 0.10 },
        tileHeight: { value: 1.0 }
      },
      vertexShader: `
        varying vec3 vPosition;
        void main() {
          vPosition = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 color;
        uniform float opacity;
        uniform float tileHeight;
        varying vec3 vPosition;
        void main() {
          float normalizedY = vPosition.y + 0.5;
          float fadeAmount = 1.0 - smoothstep(0.0, 1.0, normalizedY);
          gl_FragColor = vec4(color, opacity * fadeAmount);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    
    highlightTile = new THREE.Mesh(boxGeom, highlightMat);
    highlightTile.visible = false;
    highlightTile.renderOrder = 10; // Render after everything else
    scene.add(highlightTile);
  }
  createHighlightTile();

  function updateHighlightTile(stationIndex, elevation) {
    if (stationIndex === -1) {
      highlightTile.visible = false;
      return;
    }

    if (land[stationIndex]) {
      highlightTile.visible = false;
      return;
    }

    const i = stationIndex;
    const b = i * 3;
    const e = elevation || 0;

    const dispUnits = e * metersToUnits * exag; 
    
    axisX.set(tileAxisX[b], tileAxisX[b+1], tileAxisX[b+2]);
    axisY.set(tileAxisY[b], tileAxisY[b+1], tileAxisY[b+2]);
    axisZ.set(tileAxisZ[b], tileAxisZ[b+1], tileAxisZ[b+2]);
    tmpMat.makeBasis(axisX, axisY, axisZ);
    const quat = new THREE.Quaternion().setFromRotationMatrix(tmpMat);
    
    const baseVisibleHeight = 1.8;
    const scaledComponent = 1.0 * metersToUnits * exag;
    const highlightHeight = baseVisibleHeight + Math.max(0, scaledComponent);
    
    const minElevUnits = -5.6 * metersToUnits * exag;
    const regularTileHeight = Math.max(minTileHeightUnits, dispUnits - minElevUnits);
    const regularTileBase = minElevUnits;
    
    const totalHighlightHeight = regularTileHeight + highlightHeight;
    
    const highlightCenter = regularTileBase + totalHighlightHeight/2;
    
    const surfacePos = new THREE.Vector3(basePos[b], basePos[b+1], basePos[b+2]);
    const tilePos = surfacePos.clone().addScaledVector(axisY, highlightCenter);
    
    highlightTile.position.copy(tilePos);
    highlightTile.quaternion.copy(quat);
    highlightTile.scale.set(tileSizeX[i] * 1.15, totalHighlightHeight, tileSizeZ[i] * 1.15);
    highlightTile.material.uniforms.tileHeight.value = totalHighlightHeight;
    highlightTile.visible = true;
  }
  
  range = parseFloat(rangeSlider.value);
  playBtn.onclick = ()=>{isPlaying=true;};
  pauseBtn.onclick = ()=>{isPlaying=false;};
  fpsSlider.oninput = (e)=>{ 
    fps = parseInt(e.target.value,10); 
  };
  exagSlider.oninput = (e)=>{
    exag = parseInt(e.target.value,10);
  };
  rangeSlider.oninput = (e)=>{ 
    range = parseFloat(e.target.value); 
  };

  function updateSliderFill(slider) {
    const min = slider.min || 0;
    const max = slider.max || 100;
    const value = slider.value;
    const percent = ((value - min) / (max - min)) * 100;
    slider.style.setProperty('--value-percent', `${percent}%`);
  }

  document.querySelectorAll('input[type=range]').forEach(slider => {
    updateSliderFill(slider);
    slider.addEventListener('input', () => updateSliderFill(slider));
  });

  const tmp = new THREE.Color();
  let last = 0;
  const startISO = new Date('2025-09-01T00:00:00Z');
  const oneSecond = 1000;

  function setSimTimeFromDate(dateObj){
    simTime = (dateObj.getTime() - new Date('1970-01-01T00:00:00Z').getTime())/1000;
  }
  setSimTimeFromDate(startISO);
  function toLocalDateTimeInputValue(d){
    const pad = (n)=>String(n).padStart(2,'0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  dtInput.value = toLocalDateTimeInputValue(startISO);
  jumpBtn.onclick = ()=>{
    const val = dtInput.value; // yyyy-mm-ddThh:mm:ss
    if (!val) return;
    const local = new Date(val.replace('T',' ') + ' UTC');
    if (isNaN(local.getTime())) return;
    const targetSimTime = (local.getTime() - new Date('1970-01-01T00:00:00Z').getTime())/1000;
    tweenSimTime(targetSimTime, 2000); // Tween over 2 seconds
  };

  const waterColorCache = {
      points: null,
      tiles: null,
  };

  function prepareForBloom() {
    if (!ptsGeom || !instancedTiles || !land) return;
  
    const pColors = ptsGeom.attributes.color.array;
    const tColors = instancedTiles.instanceColor.array;
  
    if (!waterColorCache.points) waterColorCache.points = new Float32Array(pColors.length);
    if (!waterColorCache.tiles) waterColorCache.tiles = new Float32Array(tColors.length);
  
    for (let i = 0; i < N; i++) {
      if (!land[i]) {
        const b = i * 3;
        waterColorCache.points[b] = pColors[b];
        waterColorCache.points[b + 1] = pColors[b + 1];
        waterColorCache.points[b + 2] = pColors[b + 2];
        pColors[b] *= oceanGlow;
        pColors[b + 1] *= oceanGlow;
        pColors[b + 2] *= oceanGlow;
  
        waterColorCache.tiles[b] = tColors[b];
        waterColorCache.tiles[b + 1] = tColors[b + 1];
        waterColorCache.tiles[b + 2] = tColors[b + 2];
        tColors[b] *= oceanGlow;
        tColors[b + 1] *= oceanGlow;
        tColors[b + 2] *= oceanGlow;
      }
    }
    ptsGeom.attributes.color.needsUpdate = true;
    instancedTiles.instanceColor.needsUpdate = true;
  }

  function cleanupAfterBloom() {
    if (!ptsGeom || !instancedTiles || !land) return;
  
    const pColors = ptsGeom.attributes.color.array;
    const tColors = instancedTiles.instanceColor.array;
  
    for (let i = 0; i < N; i++) {
      if (!land[i]) {
        const b = i * 3;
        pColors[b] = waterColorCache.points[b];
        pColors[b + 1] = waterColorCache.points[b + 1];
        pColors[b + 2] = waterColorCache.points[b + 2];
  
        tColors[b] = waterColorCache.tiles[b];
        tColors[b + 1] = waterColorCache.tiles[b + 1];
        tColors[b + 2] = waterColorCache.tiles[b + 2];
      }
    }
    ptsGeom.attributes.color.needsUpdate = true;
    instancedTiles.instanceColor.needsUpdate = true;
  }

  const darkMaterial = new THREE.MeshBasicMaterial({ color: 'black' });
  const materials = {};

  function darkenNonBloomed(obj) {
    if (obj.isMesh && bloomLayer.test(obj.layers) === false) {
      materials[obj.uuid] = obj.material;
      obj.material = darkMaterial;
    }
  }
  function restoreMaterials(obj) {
    if (materials[obj.uuid]) {
      obj.material = materials[obj.uuid];
      delete materials[obj.uuid];
    }
  }

  function animate(ts){
    requestAnimationFrame(animate);
    if (!ready) { renderer.render(scene,camera); return; }
    const dt = (ts - last) / 1000;
    last = ts;
    if (isPlaying) {
      simTime += (3600 * (fps/12)) * dt; // advance ~fps hours per real second
      worker.postMessage({ type:'compute', tSeconds: simTime });
    }
    
    controls.update();
    if (!isLightLocked) {
      directionalLight.position.copy(lightOffsetDirection.clone().transformDirection(camera.matrixWorld));
    }
    occluder.lookAt(camera.position);
    
    if (highlightTile && highlightTile.visible) {
      const minOpacity = 0.12;
      const maxOpacity = 0.45;
      const minExag = 10; // slider min
      const maxExag = 1000000; // slider max
      const exagFactor = Math.min(1.0, Math.max(0.0, (exag - minExag) / (maxExag - minExag)));
      const baseOpacity = minOpacity + (maxOpacity - minOpacity) * exagFactor;
      const opacity = baseOpacity + 0.02 * Math.sin(ts * 0.002);
      highlightTile.material.uniforms.opacity.value = opacity;
    }
    
    prepareForBloom();
    bloomComposer.render();
    cleanupAfterBloom();

    finalComposer.render();
  }

  let scaleLogged = false;
  let lastElevations = null;
  function applyElevations(elev){
    lastElevations = elev;
    const colors = ptsGeom.attributes.color.array;
    const pos = ptsGeom.attributes.position.array;
    let rawMin = Infinity, rawMax = -Infinity;
    let clampLow = 0, clampHigh = 0, finiteCount = 0;
    for (let i=0;i<N;i++){
      const e = elev[i];
      if (Number.isFinite(e) && Math.abs(e) < 100) {
        finiteCount++;
        if (e < rawMin) rawMin = e;
        if (e > rawMax) rawMax = e;
        if (e <= -range) clampLow++;
        if (e >=  range) clampHigh++;
      } else {
        elev[i] = NaN;
      }
    }

    const minElevUnits = -5.6 * metersToUnits * exag;

    for (let i=0;i<N;i++){
      const b = i*3;
      if (land[i]) {
        colors[b]=colorLand.r; colors[b+1]=colorLand.g; colors[b+2]=colorLand.b;
        const vx = basePos[b], vy = basePos[b+1], vz = basePos[b+2];
        const mag0 = Math.hypot(vx,vy,vz) || 1;
        const nx0 = vx/mag0, ny0 = vy/mag0, nz0 = vz/mag0;
        pos[b] = vx + nx0*pointOffsetUnits; pos[b+1] = vy + ny0*pointOffsetUnits; pos[b+2] = vz + nz0*pointOffsetUnits;

        if (instancedTiles) {
          const baseIdx = b;
          axisX.set(tileAxisX[baseIdx], tileAxisX[baseIdx+1], tileAxisX[baseIdx+2]);
          axisY.set(tileAxisY[baseIdx], tileAxisY[baseIdx+1], tileAxisY[baseIdx+2]);
          axisZ.set(tileAxisZ[baseIdx], tileAxisZ[baseIdx+1], tileAxisZ[baseIdx+2]);
          tmpMat.makeBasis(axisX, axisY, axisZ);
          tmpQuat.setFromRotationMatrix(tmpMat);
          const height = Math.max(baseThicknessUnits, -minElevUnits);
          const centerOffset = minElevUnits / 2;
          tmpPosV.set(basePos[b], basePos[b+1], basePos[b+2]);
          tmpPosV.addScaledVector(axisY, centerOffset);
          tmpScale.set(tileSizeX[i], height, tileSizeZ[i]);
          tmpMat.compose(tmpPosV, tmpQuat, tmpScale);
          instancedTiles.setMatrixAt(i, tmpMat);
          const colorIdx = i * 3;
          instancedTiles.instanceColor.array[colorIdx] = colorLand.r;
          instancedTiles.instanceColor.array[colorIdx+1] = colorLand.g;
          instancedTiles.instanceColor.array[colorIdx+2] = colorLand.b;
        }
        continue;
      }

      const e = elev[i];
      if (!Number.isFinite(e)) {
        const vx = basePos[b], vy = basePos[b+1], vz = basePos[b+2];
        const mag0 = Math.hypot(vx,vy,vz) || 1;
        const nx0 = vx/mag0, ny0 = vy/mag0, nz0 = vz/mag0;
        pos[b] = vx + nx0*pointOffsetUnits; pos[b+1] = vy + ny0*pointOffsetUnits; pos[b+2] = vz + nz0*pointOffsetUnits;
        colors[b] = 1; colors[b+1] = 0; colors[b+2] = 1;
        if (instancedTiles) {
          tmpScale.set(0,0,0);
          instancedTiles.getMatrixAt(i, tmpMat);
          tmpMat.decompose(tmpPosV, tmpQuat, new THREE.Vector3());
          tmpMat.compose(tmpPosV, tmpQuat, tmpScale);
          instancedTiles.setMatrixAt(i, tmpMat);
        }
        continue;
      }

      const disp = e * metersToUnits * exag;
      const vx = basePos[b], vy = basePos[b+1], vz = basePos[b+2];
      const mag = Math.hypot(vx,vy,vz);
      const nx = vx/mag, ny = vy/mag, nz = vz/mag;
      pos[b] = vx + nx*(disp + pointOffsetUnits);
      pos[b+1] = vy + ny*(disp + pointOffsetUnits);
      pos[b+2] = vz + nz*(disp + pointOffsetUnits);

      const v = Math.max(-range, Math.min(range, e));
      if (v <= 0) {
        let u = (v + range) / range; // -range..0 => 0..1
        u = Math.sqrt(Math.max(0, Math.min(1, u)));
        tmp.lerpColors(colorWhite, colorBlue, u);
      } else {
        let u = v / range; // 0..range => 0..1
        u = Math.sqrt(Math.max(0, Math.min(1, u)));
        tmp.lerpColors(colorBlue, colorDeep, u);
      }
      colors[b]=tmp.r; colors[b+1]=tmp.g; colors[b+2]=tmp.b;

      if (instancedTiles) {
        const baseIdx = b;
        axisX.set(tileAxisX[baseIdx], tileAxisX[baseIdx+1], tileAxisX[baseIdx+2]);
        axisY.set(tileAxisY[baseIdx], tileAxisY[baseIdx+1], tileAxisY[baseIdx+2]);
        axisZ.set(tileAxisZ[baseIdx], tileAxisZ[baseIdx+1], tileAxisZ[baseIdx+2]);
        tmpMat.makeBasis(axisX, axisY, axisZ);
        tmpQuat.setFromRotationMatrix(tmpMat);
        const dispUnits = e * metersToUnits * exag;
        const height = dispUnits - minElevUnits;
        
        if (height <= 0) {
          tmpScale.set(0,0,0);
          instancedTiles.getMatrixAt(i, tmpMat);
          tmpMat.decompose(tmpPosV, tmpQuat, new THREE.Vector3());
          tmpMat.compose(tmpPosV, tmpQuat, tmpScale);
          instancedTiles.setMatrixAt(i, tmpMat);
        } else {
          const bottomOffset = minElevUnits;
          const centerOffset = bottomOffset + height/2;
          tmpPosV.set(basePos[b], basePos[b+1], basePos[b+2]);
          tmpPosV.addScaledVector(axisY, centerOffset);
          tmpScale.set(tileSizeX[i], height, tileSizeZ[i]);
          tmpMat.compose(tmpPosV, tmpQuat, tmpScale);
          instancedTiles.setMatrixAt(i, tmpMat);
        }

        const colorIdx = i * 3;
        instancedTiles.instanceColor.array[colorIdx] = colorBlue.r;
        instancedTiles.instanceColor.array[colorIdx+1] = colorBlue.g;
        instancedTiles.instanceColor.array[colorIdx+2] = colorBlue.b;
      }
    }
    ptsGeom.attributes.position.needsUpdate = true;
    ptsGeom.attributes.color.needsUpdate = true;
    if (instancedTiles) {
      instancedTiles.instanceMatrix.needsUpdate = true;
      instancedTiles.instanceColor.needsUpdate = true;
    }
    const maxExtrusion = metersToUnits * range * exag;
    const occlDesired = earthR + maxExtrusion + 0.1;
    const occlScale = occlDesired / (earthR + 0.1);
    occluder.scale.set(occlScale, occlScale, 1);
    const d = new Date(simTime*1000);
    const lowPct = finiteCount ? Math.round((clampLow/finiteCount)*100) : 0;
    const highPct = finiteCount ? Math.round((clampHigh/finiteCount)*100) : 0;
    tlabel.textContent = `${d.toISOString().replace('T',' ').replace('Z','Z')}`;
  }

  function updateLandColors() {
    if (!ptsGeom || !instancedTiles) return;
    const colors = ptsGeom.attributes.color.array;
    const instanceColors = instancedTiles.instanceColor.array;
    for (let i = 0; i < N; i++) {
      if (land[i]) {
        const b = i * 3;
        colors[b] = colorLand.r;
        colors[b+1] = colorLand.g;
        colors[b+2] = colorLand.b;
        if (instancedTiles.instanceColor) {
          instanceColors[b] = colorLand.r;
          instanceColors[b+1] = colorLand.g;
          instanceColors[b+2] = colorLand.b;
        }
      }
    }
    if (ptsGeom.attributes.color) ptsGeom.attributes.color.needsUpdate = true;
    if (instancedTiles.instanceColor) instancedTiles.instanceColor.needsUpdate = true;
  }

  goldSlider.oninput = (e) => {
    const goldness = parseFloat(e.target.value);
    colorLand.lerpColors(landColorBase, colorGold, goldness);
    updateLandColors();
  };

  oceanGlowSlider.oninput = (e) => {
    oceanGlow = parseFloat(e.target.value);
  };

  const colorways = {
    original: {
      white: 0xffffff,
      blue: 0x0077ff,
      deep: 0x483D8B,
      landBase: 0x000066,
      gold: 0xffd700,
    },
    oceanic: {
      white: 0xffffff,
      blue: 0x0077ff,
      deep: 0x001b3a,
      landBase: 0x000066,
      gold: 0xffd700,
    },
    digital: {
      white: 0xE0FFFF,
      blue: 0x40E0D0,
      deep: 0x008080,
      landBase: 0x2F4F4F,
      gold: 0x39FF14,
    },
    oceanic3: {
      white: 0xADD8E6,
      blue: 0x4169E1,
      deep: 0x00008B,
      landBase: 0x191970,
      gold: 0xFFEC8B,
    },
    'ember-zoa': {
      white: 0xFFFF00,
      blue: 0xFF4500,
      deep: 0x8B0000,
      landBase: 0x4B0082,
      gold: 0xEE82EE,
    },
    'deep-land': {
      white: 0xffffff,
      blue: 0x0077ff,
      deep: 0x483D8B,
      landBase: 0x000044,
      gold: 0xffd700,
    },
    magma: {
      white: 0xFFFF00,
      blue: 0xFF4500,
      deep: 0x8B0000,
      landBase: 0x1a1a1a,
      gold: 0xFFD700,
    },
    grayscale: {
      white: 0xFFFFFF,
      blue: 0x808080,
      deep: 0x202020,
      landBase: 0x404040,
      gold: 0xFFFFFF,
    }
  };

  let colorGold = new THREE.Color();
  let colorWhite = new THREE.Color();
  let colorBlue = new THREE.Color();
  let colorDeep = new THREE.Color();
  let landColorBase = new THREE.Color();
  let colorLand = new THREE.Color();
  let currentThemeName = '';

  function updateLandColorVisibility() {
    const oceanicOptions = document.getElementById('oceanic-land-options');
    const digitalOptions = document.getElementById('digital-land-options');
    
    oceanicOptions.style.display = (currentThemeName === 'oceanic' && isLandShown) ? 'flex' : 'none';
    digitalOptions.style.display = (currentThemeName === 'digital' && isLandShown) ? 'flex' : 'none';
  }

  function setColorway(name) {
    const scheme = colorways[name];
    if (!scheme) return;
    currentThemeName = name;

    if (name === 'digital') {
      setDigitalLandColor('white', 0xFFFFFF);
    } else if (name === 'oceanic') {
      setOceanicLandColor('gold', 0xffd700);
    }

    updateLandColorVisibility();

    document.querySelectorAll('#main-colorway-buttons button').forEach(btn => {
      btn.classList.remove('active-colorway');
    });
    const activeBtn = document.getElementById(`colorway-${name}`);
    if (activeBtn) activeBtn.classList.add('active-colorway');

    colorWhite.setHex(scheme.white);
    colorBlue.setHex(scheme.blue);
    colorDeep.setHex(scheme.deep);
    landColorBase.setHex(scheme.landBase);
    colorGold.setHex(scheme.gold);
    
    const goldness = parseFloat(goldSlider.value);
    colorLand.lerpColors(landColorBase, colorGold, goldness);
    
    updateLandColors();
    if (ready) {
      worker.postMessage({ type: 'compute', tSeconds: simTime });
    }
  }

  document.getElementById('colorway-oceanic').onclick = () => setColorway('oceanic');
  document.getElementById('colorway-digital').onclick = () => setColorway('digital');
  document.getElementById('colorway-ember-zoa').onclick = () => setColorway('ember-zoa');

  function setOceanicLandColor(colorName, hexValue) {
    if (currentThemeName !== 'oceanic') return;

    document.querySelectorAll('#oceanic-land-options button').forEach(btn => {
      btn.classList.remove('active-colorway');
    });
    document.getElementById(`land-color-${colorName}-oceanic`).classList.add('active-colorway');

    colorways.oceanic.gold = hexValue;
    colorGold.setHex(hexValue);
    const goldness = parseFloat(goldSlider.value);
    colorLand.lerpColors(landColorBase, colorGold, goldness);
    updateLandColors();
  }

  function setDigitalLandColor(colorName, hexValue) {
    if (currentThemeName !== 'digital') return;
    
    document.querySelectorAll('#digital-land-options button').forEach(btn => {
      btn.classList.remove('active-colorway');
    });
    document.getElementById(`land-color-${colorName}`).classList.add('active-colorway');
    
    colorways.digital.gold = hexValue;
    colorGold.setHex(hexValue);
    const goldness = parseFloat(goldSlider.value);
    colorLand.lerpColors(landColorBase, colorGold, goldness);
    updateLandColors();
  }

  document.getElementById('land-color-gold-oceanic').onclick = () => setOceanicLandColor('gold', 0xffd700);
  document.getElementById('land-color-green-oceanic').onclick = () => setOceanicLandColor('green', 0x39FF14);
  document.getElementById('land-color-gold').onclick = () => setDigitalLandColor('gold', 0xffd700);
  document.getElementById('land-color-cyan').onclick = () => setDigitalLandColor('cyan', 0x00FFFF);
  document.getElementById('land-color-white').onclick = () => setDigitalLandColor('white', 0xFFFFFF);
  document.getElementById('land-color-green').onclick = () => setDigitalLandColor('green', 0x39FF14);

  setColorway('oceanic');

  document.getElementById('time-box').onclick = () => {
    document.getElementById('datetime').showPicker();
  };

  function animateStart(){
    animate(0);
  }
  animateStart();
}

main().catch(err => console.error("App failed to start:", err));


