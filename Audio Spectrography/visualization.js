// Three.js Audio Visualizer - A 3D audio visualization tool using Three.js and Web Audio API
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import FirebaseAudioLoader from './firebaseAudioLoader.js';

// Mobile detection function
function isMobileDevice() {
    return (
        /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
        (window.innerWidth <= 800 && window.innerHeight <= 900)
    );
}

// Set global mobile flag
const isMobile = isMobileDevice();

// Debug logging utility
const debugElement = document.getElementById('debug');
function log(message) {
    console.log(message);
    if (debugElement && !isMobile) {
        debugElement.innerHTML += `<br>${message}`;
    }
}

log('Audio Visualizer starting');
if (isMobile) {
    log('Mobile device detected - simplified UI mode');
}

// Global variables for Three.js rendering
let scene, camera, renderer, controls;
// Audio processing variables
let audioContext, audioSource, analyser, audioBuffer;
let frequencyData, timeData;
// Visualization objects
let waves = [];
let isPlaying = false;
let timeRingOffsetY = 55;  // Vertical offset for time domain ring
let startYFreq = 0;        // Starting Y position for frequency rings
let frequencies = [];      // Array of frequency values to visualize
let fftSize = 2048;        // FFT window size (powers of 2: 512-16384)
// Audio history for spiral visualization
let audioHistoryBuffer = []; // Buffer to store audio history
let lastAudioTime = 0;       // For tracking time between audio frames
// let maxHistorySize = 500000; // Maximum samples in history buffer - UNUSED
let spiralGrowthFactor = 0.1;  // Controls how much the spiral expands with audio
// let spiralDepthFactor = 0.05;  // Controls spiral z-axis displacement - UNUSED
let historyDuration = 2.5;     // How many seconds of audio history to display
let samplingFactor = 4;        // Sample reduction factor (higher = smoother but less detailed)
let pausedTime = 0;            // Timestamp when audio was paused
let startTime = 0;             // Timestamp when playback started
let spiralRevolutions = 20;    // Number of revolutions in spiral visualization

// Firebase audio loader for cloud storage integration
let firebaseAudioLoader;

// Visualization configuration parameters
const config = {
    sphereRadius: 40,
    numNotes: 12,    // Notes in chromatic scale
    numOctaves: 3,   // Number of octaves to visualize
    // waveLength: 30,  // Length of each sine wave - UNUSED
    waveAmplitude: 5,
    ringModulation: 6,  // Number of sine wave peaks around the ring
    harmonic: {
        count: 3,    // Number of harmonics per note
        spacing: 8   // Vertical spacing between harmonics
    },
    animation: {
        rotationSpeed: 0.2,
        pulseSpeed: 0.5,
        waveSpeed: 1.0
    },
    views: {
        default: {
            position: { x: 381.18, y: 178.02, z: -141.00 },
            target: { x: 4.73, y: 45.22, z: 7.54 },
            fov: 60
        },
        view2: {
            position: { x: 2.06, y: -139.60, z: -3.48 },
            target: { x: 2.06, y: 57.73, z: -3.48 },
            fov: 60
        },
        view3: {
            position: { x: -146.38, y: 250.87, z: -145.14 },
            target: { x: 5.48, y: 149.00, z: -5.38 },
            fov: 60
        }
    }
};


/******************************************************************
 *  MOBILE-AUDIO UNLOCK (runs on the first finger-tap)
 ******************************************************************/
let audioCtx;                            // forward declaration
window.addEventListener('pointerdown', async function unlock () {
    window.removeEventListener('pointerdown', unlock);

    // create context on the SAME call-stack as the gesture
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    /*  iOS plays Web-Audio on the "ringer" channel, which is muted when the
        side-switch is down.  A 1-frame silent <audio> bumps us to the
        media channel so sound is audible even in silent mode.           */
    const kick = new Audio();
    kick.src = 'data:audio/mp3;base64,//uQxAAAAAAA=';   // <-- silent MP3
    kick.play().catch(() => {});      // fire-and-forget
    await audioCtx.resume();          // Autoplay gate passed
});

/* Utility: never call .start() until the context is RUNNING. */
function safeStart (src, offset = 0) {
    if (audioCtx.state !== 'running') audioCtx.resume();
    src.start(0, offset);
}




// Initialize Three.js scene, camera, renderer and lighting
function initScene() {
    // Create scene with dark background
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    
    // Camera positioned for better view of stacked rings
    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(381.18, 178.02, -141.00);
    camera.fov = 60;
    camera.updateProjectionMatrix();
    
    // Create WebGL renderer with antialiasing
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);
    
    // Add orbit controls for interactive camera movement
    controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(4.73, 45.22, 7.54);
    camera.lookAt(controls.target);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.autoRotate = true;         // Auto-rotate for better viewing
    controls.autoRotateSpeed = 0.5;     // Slow rotation speed
    controls.update();
    
    // Create lighting for better visibility of objects
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);
    
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(0, 50, 50);
    scene.add(directionalLight);
    
    // Add colored point lights for visual interest
    const colors = [0xff0000, 0x00ff00, 0x0000ff];
    const positions = [
        [config.sphereRadius, 0, 0],
        [0, config.sphereRadius, 0],
        [0, 0, config.sphereRadius]
    ];
    
    colors.forEach((color, i) => {
        const light = new THREE.PointLight(color, 0.7);
        light.position.set(...positions[i]);
        scene.add(light);
    });
    
    log('Scene initialized');
}

// Initialize Web Audio API context and analyzers
function initAudio() {
    if (audioContext) return; // Already initialized

    lastAudioTime = 0; // Reset timing tracker
    try {
        // Create audio context using browser-compatible constructor
        audioContext = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioContext.createAnalyser();
        setFFTSize(fftSize); // Configure FFT size using dedicated function
        
        // Initialize Firebase Audio Loader for cloud audio streaming
        firebaseAudioLoader = new FirebaseAudioLoader(audioContext);
        
        // Clear Firebase cache when page is unloaded to prevent memory leaks
        window.addEventListener('unload', () => {
            if (firebaseAudioLoader) {
                firebaseAudioLoader.clearCache();
            }
        });
        
        log('Audio context and Firebase audio loader initialized');
        
        // Create default audio for testing when no audio file is loaded
        createDefaultAudio();
    } catch (error) {
        log(`Audio initialization error: ${error.message}`);
    }
}

// Configure the FFT analyzer size and update data buffers
function setFFTSize(size) {
    // FFT size must be a power of 2 between 512 and 16384
    const validSizes = [512, 1024, 2048, 4096, 8192, 16384];
    if (!validSizes.includes(size)) {
        size = 2048; // Default if invalid size provided
    }
    
    fftSize = size;
    analyser.fftSize = fftSize;
    
    // Create data arrays sized to match the analyzer's output
    frequencyData = new Uint8Array(analyser.frequencyBinCount); // frequencyBinCount = fftSize / 2
    timeData = new Uint8Array(fftSize);                        // Time domain data needs full fftSize
    
    log(`FFT size set to ${fftSize} (${analyser.frequencyBinCount} frequency bins)`);
    
    // Update UI slider if it exists
    const fftSlider = document.getElementById('fftSizeSlider');
    if (fftSlider) {
        fftSlider.value = Math.log2(fftSize);
    }
}

// Create a default sine sweep audio for testing
function createDefaultAudio() {
    try {
        const duration = 10;
        const sampleRate = audioContext.sampleRate;
        const numSamples = duration * sampleRate;
        const buffer = audioContext.createBuffer(1, numSamples, sampleRate);
        const channelData = buffer.getChannelData(0);
        
        // Generate a sine sweep from 20Hz to 2000Hz
        const startFreq = 20;
        const endFreq = 2000;
        const freqRange = endFreq - startFreq;
        
        for (let i = 0; i < numSamples; i++) {
            const t = i / sampleRate;
            const normalizedTime = t / duration;
            // Calculate instantaneous frequency at this point in the sweep
            const instantFreq = startFreq + (freqRange * normalizedTime);
            // Generate sine wave based on phase accumulation
            const phase = 2 * Math.PI * instantFreq * t;
            channelData[i] = 0.5 * Math.sin(phase);
        }
        
        audioBuffer = buffer;
        log('Default audio created');
    } catch (error) {
        log(`Default audio creation error: ${error.message}`);
    }
}

// Generate frequencies for notes across multiple octaves
function getNoteFrequencies() {
    // Base frequencies for notes C through B in the lowest octave
    const baseFrequencies = {
        'C': 16.35, 'C#': 17.32, 'D': 18.35, 'D#': 19.45, 'E': 20.60,
        'F': 21.83, 'F#': 23.12, 'G': 24.50, 'G#': 25.96, 'A': 27.50,
        'A#': 29.14, 'B': 30.87
    };
    
    const freqArray = [];
    const notesInfo = [];
    
    // Calculate frequencies across octaves
    // Each octave doubles the frequency of notes (e.g., A4 = 440Hz, A5 = 880Hz)
    for (let octave = 3; octave < 3 + config.numOctaves; octave++) {
        Object.entries(baseFrequencies).forEach(([note, freq]) => {
            const frequency = freq * Math.pow(2, octave);
            freqArray.push(frequency);
            notesInfo.push({
                note: `${note}${octave}`,
                frequency,
                octave
            });
        });
    }
    
    return { frequencies: freqArray, notesInfo };
}

// Create a 3D ring geometry with sine wave modulation
function createSineWaveGeometry(frequency, noteIndex) {
    const points = [];
    const numPoints = 120; // High point count for smooth rings
    // Slightly different radius per note for visual separation
    const radius = config.sphereRadius * 0.8 * (1 + noteIndex * 0.02);
    
    // Create a circular path of points with sine wave modulation
    for (let i = 0; i <= numPoints; i++) {
        // Calculate angle around the circle
        const angle = (i / numPoints) * Math.PI * 2;
        
        // Base circular coordinates in the X-Z plane
        const baseX = Math.cos(angle) * radius;
        const baseZ = Math.sin(angle) * radius;
        
        // Add sine wave modulation to the Y value (different per frequency)
        const sinePhase = angle * config.ringModulation + (noteIndex * 0.2); 
        const y = Math.sin(sinePhase) * config.waveAmplitude;
        
        points.push(new THREE.Vector3(baseX, y, baseZ));
    }
    
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    
    // Store the original positions for animation reference
    const origPositions = new Float32Array(points.length * 3);
    for (let i = 0; i < points.length; i++) {
        origPositions[i * 3] = points[i].x;
        origPositions[i * 3 + 1] = points[i].y;
        origPositions[i * 3 + 2] = points[i].z;
    }
    
    // Store metadata with the geometry for animation
    geometry.userData = { 
        origPositions,
        frequency,
        noteIndex
    };
    
    return geometry;
}

// Create all visualization elements (frequency rings and time spiral)
function createWaves() {
    // Remove any existing visualization elements
    waves.forEach(wave => scene.remove(wave));
    waves = [];
    
    // Get frequencies for musical notes in our configured range
    const { frequencies: freqArray, notesInfo } = getNoteFrequencies();
    frequencies = freqArray; // Store globally for other functions to access
    log(`Creating rings for ${frequencies.length} frequencies`);
    
    // Calculate vertical spacing for the frequency rings
    const totalHeight = frequencies.length * config.harmonic.spacing;
    startYFreq = -totalHeight / 2; // Center vertically
    
    // Create the time domain spiral visualization
    createTimeSpiral();
    
    // Create frequency rings stacked vertically
    frequencies.forEach((freq, index) => {
        const noteInfo = notesInfo[index];
        
        // Create a base sine wave ring geometry for this frequency
        const geometry = createSineWaveGeometry(freq, index);
        
        // Create the main note ring and its harmonics
        for (let h = 0; h < config.harmonic.count; h++) {
            // Create a glowing material for the ring
            const material = new THREE.LineBasicMaterial({
                color: 0xffffff,
                linewidth: 3,
                opacity: 0.9 - (h * 0.15), // Higher harmonics are more transparent
                transparent: true
            });
            
            // Create a closed loop for the ring
            const wave = new THREE.LineLoop(geometry.clone(), material);
            
            // Position vertically with equal spacing in the stack
            const ringPosition = startYFreq + (index * config.harmonic.spacing);
            wave.position.set(0, ringPosition, 0);
            
            // Scale rings based on harmonic - higher harmonics are slightly smaller
            const scale = 1.0 - (h * 0.1);
            wave.scale.set(scale, 1, scale);
            
            // Offset higher harmonics slightly upward
            if (h > 0) {
                wave.position.y += h * 3;
            }
            
            scene.add(wave);
            waves.push({
                mesh: wave,
                type: 'frequency',
                frequency: freq * (h + 1), // Fundamental or harmonic frequency
                noteInfo: noteInfo,
                harmonic: h,
                index,
                baseY: ringPosition + (h * 3) // Store base position for animation
            });
        }
    });
    
    log(`Created ${waves.length} total wave elements`);
}

// Create a spiral visualization for the time-domain audio data
function createTimeSpiral() {
    // Reset history buffer when creating a new spiral
    audioHistoryBuffer = [];

    // Create initial points for the spiral in a spherical pattern
    const points = [];
    const numRevolutions = spiralRevolutions;
    const numPointsPerRevolution = 40;
    const totalPoints = numRevolutions * numPointsPerRevolution;
    
    // Create a spiral pattern that wraps around a sphere
    for (let i = 0; i < totalPoints; i++) {
        // Calculate normalized position within the entire spiral (0 to 1)
        const t = i / totalPoints;
        
        // Calculate phi angle (longitude) - exactly numRevolutions around the sphere
        const phi = t * Math.PI * 2 * numRevolutions;
        
        // Calculate theta angle (latitude) - go from north to south pole
        const theta = t * Math.PI;
        
        // Convert to cartesian coordinates on a sphere
        const sphereRadius = config.sphereRadius;
        const x = sphereRadius * Math.sin(theta) * Math.cos(phi);
        const y = sphereRadius * Math.cos(theta);
        const z = sphereRadius * Math.sin(theta) * Math.sin(phi);
        
        points.push(new THREE.Vector3(x, y, z));
    }

    // Create geometry and glowing gold material for the spiral
    const spiralGeometry = new THREE.BufferGeometry().setFromPoints(points);
    const spiralMaterial = new THREE.LineBasicMaterial({
        color: 0xffd700,      // Gold color
        linewidth: 1,
        opacity: 0.8,
        transparent: true,
        blending: THREE.AdditiveBlending,  // Adds glow effect
    });

    const spiralMesh = new THREE.Line(spiralGeometry, spiralMaterial);
    scene.add(spiralMesh);

    // Add to waves array with configuration for future updates
    waves.push({
        mesh: spiralMesh,
        type: 'timeSpiral',
        initialRadius: config.sphereRadius,
        growthFactor: spiralGrowthFactor,
        // depthFactor: spiralDepthFactor, // UNUSED
        revolutions: spiralRevolutions,
        // turnFactor: 0.01 // UNUSED
    });

    log('Created time domain spiral with glowing gold effect');
}

// Update time spiral with real-time audio data
function updateTimeSpiral() {
    const spiral = waves.find(wave => wave.type === 'timeSpiral');
    if (!spiral || !spiral.mesh) {
        // If spiral is missing, recreate it
        createTimeSpiral();
        return;
    }

    // // Pulse the center sphere based on audio amplitude if it exists
    // if (isPlaying && timeData) {
    //     const averageAmplitude = timeData.reduce((sum, val) => sum + Math.abs(val - 128), 0) / timeData.length;
    //     const normalizedAmplitude = averageAmplitude / 128;
    //     if (spiral.baseSphere) {
    //         spiral.baseSphere.material.emissiveIntensity = 0.4 + (normalizedAmplitude * 0.6);
    //         spiral.baseSphere.material.needsUpdate = true;
    //     }
    // }

    // Add new time domain data to the history buffer
    if (isPlaying && timeData) {
        // Add samples based purely on elapsed real audio time
        // This makes history length independent of the FFT size or frame rate
        const currentAudioTime = audioContext.currentTime;
        if (lastAudioTime === 0) {
            lastAudioTime = currentAudioTime;
        }
        const deltaTimeSec = currentAudioTime - lastAudioTime;
        lastAudioTime = currentAudioTime;

        // Calculate how many samples to add based on sample rate and elapsed time
        let samplesToAdd = Math.round((audioContext.sampleRate * deltaTimeSec) / samplingFactor);
        if (samplesToAdd < 1) samplesToAdd = 1; // Ensure at least one sample per frame

        // Calculate total samples needed for our desired history duration
        const targetHistorySize = Math.ceil((audioContext.sampleRate * historyDuration) / samplingFactor);
        
        // Pick evenly-spaced samples from timeData array
        const step = Math.max(1, Math.floor(timeData.length / samplesToAdd));
        let added = 0;
        for (let i = 0; i < timeData.length && added < samplesToAdd; i += step) {
            // Convert 0-255 value to normalized -1.0 to 1.0 range
            const value = ((timeData[i] / 128.0) - 1.0);
            audioHistoryBuffer.push(value);
            added++;
        }
        
        // Trim buffer to keep only the most recent samples
        if (audioHistoryBuffer.length > targetHistorySize) {
            audioHistoryBuffer = audioHistoryBuffer.slice(audioHistoryBuffer.length - targetHistorySize);
        }
    }
    
    // Create new points for the spiral based on history
    const points = [];
    
    const numRevolutions = spiral.revolutions || spiralRevolutions;
    
    // If we don't have history yet or not playing, generate a default spiral shape
    if (audioHistoryBuffer.length <= 10 || !isPlaying) {
        const numPointsPerRevolution = 40;
        const totalPoints = numRevolutions * numPointsPerRevolution;
        
        for (let i = 0; i < totalPoints; i++) {
            const t = i / totalPoints;
            const phi = t * Math.PI * 2 * numRevolutions;
            const theta = t * Math.PI;
            const x = config.sphereRadius * Math.sin(theta) * Math.cos(phi);
            const y = config.sphereRadius * Math.cos(theta);
            const z = config.sphereRadius * Math.sin(theta) * Math.sin(phi);
            points.push(new THREE.Vector3(x, y, z));
        }
        
        if (spiral.mesh.geometry) spiral.mesh.geometry.dispose();
        spiral.mesh.geometry = new THREE.BufferGeometry().setFromPoints(points);
        return;
    }
    
    // Use audio history to create the spiral shape when playing
    const historyToUse = audioHistoryBuffer.length;
    const maxVisualizationPoints = 20000;  // Cap to prevent performance issues
    const step = Math.max(1, Math.floor(historyToUse / maxVisualizationPoints));
    const baseRadius = spiral.initialRadius;
    const amplitudeScale = baseRadius * spiral.growthFactor * 5;
    
    for (let i = 0; i < historyToUse; i += step) {
        const historyIndex = audioHistoryBuffer.length - 1 - i;
        if (historyIndex < 0) continue;
        const audioValue = audioHistoryBuffer[historyIndex];
        if (isNaN(audioValue)) continue;
        
        // Calculate position on spiral based on time (i)
        const historyFraction = i / historyToUse;
        const theta = historyFraction * Math.PI;
        const phi = historyFraction * Math.PI * 2 * numRevolutions;
        
        // Normal vector on unit sphere surface (for audio displacement direction)
        const nx = Math.sin(theta) * Math.cos(phi);
        const ny = Math.cos(theta);
        const nz = Math.sin(theta) * Math.sin(phi);
        
        // Base point on sphere surface
        let sx = baseRadius * nx;
        let sy = baseRadius * ny;
        let sz = baseRadius * nz;
        
        // Displace point along normal vector based on audio amplitude
        const displacement = audioValue * amplitudeScale;
        sx += nx * displacement;
        sy += ny * displacement;
        sz += nz * displacement;
        
        points.push(new THREE.Vector3(sx, sy, sz));
    }
    
    // Make sure we have at least one valid point
    if (points.length === 0) {
        // Create default spiral points if none were generated
        const numPointsPerRevolution = 40;
        const totalPoints = numRevolutions * numPointsPerRevolution;
        
        for (let i = 0; i < totalPoints; i++) {
            const t = i / totalPoints;
            const phi = t * Math.PI * 2 * numRevolutions;
            const theta = t * Math.PI;
            const x = config.sphereRadius * Math.sin(theta) * Math.cos(phi);
            const y = config.sphereRadius * Math.cos(theta);
            const z = config.sphereRadius * Math.sin(theta) * Math.sin(phi);
            points.push(new THREE.Vector3(x, y, z));
        }
    }
    
    // Update the spiral geometry with new points
    const newGeometry = new THREE.BufferGeometry().setFromPoints(points);
    
    // Explicitly computing bounds for error handling/catching
    // try {
    //     newGeometry.computeBoundingSphere();
    // } catch (e) {
    //     console.error("Error computing bounds, using fallback geometry", e);
    //     // Create an emergency fallback if we have invalid points
    //     const fallbackPoints = [
    //         new THREE.Vector3(-1, 0, 0),
    //         new THREE.Vector3(1, 0, 0),
    //         new THREE.Vector3(0, 1, 0)
    //     ];
    //     spiral.mesh.geometry.dispose();
    //     spiral.mesh.geometry = new THREE.BufferGeometry().setFromPoints(fallbackPoints);
    //     return;
    // }
    
    // Replace the old geometry with new one
    spiral.mesh.geometry.dispose(); // Dispose old geometry to prevent memory leaks
    spiral.mesh.geometry = newGeometry;
}

// Update all frequency rings based on audio data
function updateWaves() {
    if (!analyser) return;
    
    // Get latest audio data from the analyzer
    analyser.getByteFrequencyData(frequencyData);
    analyser.getByteTimeDomainData(timeData);
    
    const time = performance.now() * 0.001; // Current time in seconds for animations
    
    // Update the time spiral first
    updateTimeSpiral();
    
    // Update each frequency ring
    waves.forEach(wave => {
        if (wave.type === 'frequency') {
            const positions = wave.mesh.geometry.attributes.position.array;
            const origPositions = wave.mesh.geometry.userData.origPositions;
            
            // Find the amplitude for this specific frequency in the frequency data
            const index = Math.min(
                Math.floor(wave.frequency / (audioContext.sampleRate / 2) * frequencyData.length),
                frequencyData.length - 1
            );
            
            // Convert to normalized amplitude (0-1)
            const amplitude = frequencyData[index] / 255.0;
            
            const harmonic = wave.harmonic;
            
            // Rotation animation - higher harmonics rotate faster
            const rotationRate = config.animation.rotationSpeed * (harmonic + 1);
            wave.mesh.rotation.y = time * rotationRate;
            
            // Vertical bouncing effect based on amplitude
            if (amplitude > 0.1) {
                const bounce = Math.sin(time * config.animation.pulseSpeed * 2) * amplitude * 5;
                wave.mesh.position.y = wave.baseY + bounce;
            }
            
            // Radial pulse animation (expand/contract)
            const pulseRate = config.animation.pulseSpeed * (1 + harmonic * 0.5);
            const pulseFactor = 1 + (amplitude * 0.3 * Math.sin(time * pulseRate));
            wave.mesh.scale.set(pulseFactor, 1, pulseFactor);
            
            // Apply wave deformation to each point in the ring
            for (let i = 0; i < positions.length / 3; i++) {
                // Get original position
                const origX = origPositions[i * 3];
                const origY = origPositions[i * 3 + 1];
                const origZ = origPositions[i * 3 + 2];
                
                // Calculate angle around the ring for wave phasing
                const angle = Math.atan2(origZ, origX);
                
                // Create a traveling wave effect around the ring
                const waveSpeed = config.animation.waveSpeed * (harmonic + 1);
                const waveFactor = Math.sin(angle * 8 + time * waveSpeed) * amplitude * 4;
                
                // Apply wave modulation to the ring shape
                const radiusMod = 1 + (amplitude * 0.3) + (waveFactor * 0.2);
                positions[i * 3] = origX * radiusMod;
                positions[i * 3 + 1] = origY * (amplitude * 4 + 1) + waveFactor; // Height modulation
                positions[i * 3 + 2] = origZ * radiusMod;
            }
            
            // Update the geometry after modifying points
            wave.mesh.geometry.attributes.position.needsUpdate = true;
            
            // Update material color based on amplitude
            if (wave.mesh.material) {
                wave.mesh.material.color.setHex(0xffffff);
            }
        }
    });
}

// Handle audio playback start/resume
function playAudio() {
    // Ensure audio context is initialized
    initAudio(); // Moved initAudio call here

    if (!audioBuffer && !(audioSource instanceof MediaStreamAudioSourceNode)) return;

    // Resume audio context if suspended (browser requirement for autoplay)
    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }
    
    // Clean up any existing audio source when starting a new one
    // BUT don't clean up if we're resuming a media stream
    if (audioSource && audioSource !== audioBuffer && !(audioSource instanceof MediaStreamAudioSourceNode)) {
        try {
            if (audioSource.stop) audioSource.stop();
            audioSource.disconnect();
        } catch(e) {
            console.warn("Error cleaning up previous audio source:", e);
        }
    }
    
    if (audioSource instanceof MediaStreamAudioSourceNode) {
        // System audio visualization handling
        log("Resuming system audio visualization...");
        
        // Check if system audio stream is still active
        if (audioSource.mediaStream) {
            const tracks = audioSource.mediaStream.getTracks();
            if (tracks.length === 0 || !tracks[0].readyState || tracks[0].readyState === 'ended') {
                log("⚠️ System audio track has ended! Recapturing system audio...");
                captureSystemAudio(); // Try to restart capture
                return; // captureSystemAudio will set isPlaying
            }
            
            log(`✓ System audio track is ${tracks[0].readyState}, resuming visualization.`);
        }
        
        // Reset connections to prevent audio feedback
        try {
            // Prevent echo by ensuring analyzer isn't connected to destination
            try { analyser.disconnect(audioContext.destination); } catch(e) {}
            
            // Reconnect source to analyzer
            audioSource.disconnect();
            audioSource.connect(analyser);
            log("✓ Reset audio connections for MediaStreamSource.");
        } catch(e) {
            console.error("Connection error:", e);
        }
        
        isPlaying = true;
    } else if (audioBuffer) {
        // For regular audio files, create a new buffer source
        try { analyser.disconnect(); } catch(e) {}
        
        audioSource = audioContext.createBufferSource();
        audioSource.buffer = audioBuffer;
        audioSource.connect(analyser);
        // For normal audio files, connect to destination so we can hear it
        analyser.connect(audioContext.destination);
        
        // Calculate the correct start time for pause/resume functionality
        const currentTime = audioContext.currentTime;
        startTime = currentTime - pausedTime; // Adjust startTime to account for previous playback
        safeStart(audioSource, pausedTime);
        
        isPlaying = true;
        log(pausedTime > 0 ? `Resuming playback from ${pausedTime.toFixed(2)}s` : 'Starting playback');
        
        // Handle end of audio playback
        audioSource.onended = () => {
            if(isPlaying) { // Only run if ended naturally (not from stop/pause)
                log('Playback finished');
                isPlaying = false;
                audioSource = null;
                pausedTime = 0; // Reset pause time when track ends
                startTime = 0;  // Reset start time as well
                if (document.getElementById('playBtn')) document.getElementById('playBtn').disabled = false;
                if (document.getElementById('pauseBtn')) document.getElementById('pauseBtn').disabled = true;
            }
        };
    }

    // Update UI buttons
    if (document.getElementById('playBtn')) document.getElementById('playBtn').disabled = true;
    if (document.getElementById('pauseBtn')) document.getElementById('pauseBtn').disabled = false;
}

// Handle audio playback pause
function pauseAudio() {
    if (!isPlaying || !audioSource) return;

    if (audioSource instanceof MediaStreamAudioSourceNode) {
        // When pausing system audio, we keep the stream active but mute visualization
        log('Pausing system audio stream (muting).');
        try { 
            // Only disconnect from the destination, maintain analyzer connection for visualization
            analyser.disconnect(audioContext.destination); 
        } catch(e){} 
        isPlaying = false;
    } else if (audioSource instanceof AudioBufferSourceNode) {
        // Calculate exact pause position for later resume
        const currentTime = audioContext.currentTime;
        pausedTime = currentTime - startTime; // Calculate elapsed time in current playback
        
        // Handle looping playback
        if (audioBuffer && pausedTime > audioBuffer.duration) {
            pausedTime = pausedTime % audioBuffer.duration;
        }
        
        audioSource.onended = null; // Prevent onended logic from firing on manual stop
        audioSource.stop();
        audioSource = null; // AudioBufferSourceNode is one-use, must be discarded
        isPlaying = false;
        log(`Playback paused at ${pausedTime.toFixed(2)}s`);
    }

    // Update UI buttons
    if (document.getElementById('playBtn')) document.getElementById('playBtn').disabled = false;
    if (document.getElementById('pauseBtn')) document.getElementById('pauseBtn').disabled = true;
}

// Load and prepare audio from Firebase Storage
async function loadAndPlayFirebaseAudio(url, trackName = 'Firebase Track') {
    // Ensure audio context is initialized
    initAudio(); // Moved initAudio call here

    if (!audioContext) {
        log('AudioContext not initialized!');
        return;
    }
    
    // Resume audio context if it's suspended
    if (audioContext.state === 'suspended') {
        await audioContext.resume();
    }
    
    log(`Loading Firebase audio: ${trackName}`);
    
    // Update UI to show loading state
    const playBtn = document.getElementById('playBtn');
    if (playBtn) {
        playBtn.disabled = true;
        playBtn.textContent = '...';
    }
    if (document.getElementById('pauseBtn')) {
        document.getElementById('pauseBtn').disabled = true;
    }
    
    // Reset playback state and clean up existing audio
    pausedTime = 0;
    startTime = 0;
    if (audioSource) {
        if (audioSource.stop) {
            try {
                audioSource.stop();
            } catch (e) {
                log(`Warning when stopping audio: ${e.message}`);
            }
        }
        if (audioSource.disconnect) {
            try {
                audioSource.disconnect();
            } catch (e) {
                log(`Warning when disconnecting audio: ${e.message}`);
            }
        }
        audioSource = null;
        isPlaying = false;
    }
    
    let loadPromise;
    try {
        // Create Firebase loader if needed
        if (!firebaseAudioLoader) {
            log('Creating Firebase Audio Loader...');
            firebaseAudioLoader = new FirebaseAudioLoader(audioContext);
        }
        
        // Handle cancellation of previous load requests
        if (window.pendingFirebaseLoadPromise) {
            window.pendingFirebaseLoadPromise.cancelled = true;
        }
        
        // Start loading with FirebaseAudioLoader (handles caching, etc.)
        loadPromise = firebaseAudioLoader.loadAudio(url, trackName);
        window.pendingFirebaseLoadPromise = loadPromise;
        
        // Wait for audio to load
        audioBuffer = await loadPromise;
        
        // Check if this load operation was cancelled by a newer request
        if (loadPromise.cancelled) {
            log('Firebase audio loading was cancelled by a newer request');
            return;
        }
        
        startTime = audioContext.currentTime; // For future pause/resume
        
        log('Firebase audio loaded successfully!');
        
        // Update UI
        if (playBtn) {
            playBtn.disabled = false;
            playBtn.textContent = '▶';
        }
        
    } catch (error) {
        const errorMsg = `Error loading Firebase audio: ${error.message}`;
        log(errorMsg);
        console.error(errorMsg, error);
        
        // Reset UI state
        if (playBtn) {
            playBtn.disabled = false;
            playBtn.textContent = '▶';
        }
        if (document.getElementById('pauseBtn')) {
            document.getElementById('pauseBtn').disabled = true;
        }
        
    } finally {
        // Clean up reference to pending promise
        if (window.pendingFirebaseLoadPromise === loadPromise) {
            window.pendingFirebaseLoadPromise = null;
        }
    }
}

// Handle sample selection from dropdown menu
async function handleSampleSelect(event) {
    // Ensure audio context is initialized
    initAudio(); // Moved initAudio call here

    const filePath = event.target.value;
    if (!filePath) {
        log('Invalid selection');
        return;
    }
    
    // Special handling for system audio capture option
    if (filePath === "capture_system_audio") {
        log('System audio capture selected');
        captureSystemAudio();
        return;
    }
    
    // Special handling for Firebase URLs
    if (filePath.startsWith('https://firebasestorage.googleapis.com')) {
        log(`Firebase URL selected`);
        return; 
    }

    // For local audio files, proceed with fetch and decoding
    const playBtn = document.getElementById('playBtn');
    if (playBtn) {
        playBtn.disabled = true;
        playBtn.textContent = '...';
    }
    if (document.getElementById('pauseBtn')) document.getElementById('pauseBtn').disabled = true;

    // Reset playback state
    pausedTime = 0;
    startTime = 0;
    
    // Clean up any existing audio source. 
    if (audioSource) {
         if (audioSource instanceof AudioBufferSourceNode) {
             audioSource.onended = null; // Prevent onended callback
            try { audioSource.stop(); } catch(e) {}
            try { audioSource.disconnect(); } catch(e) {}
         } else if (audioSource instanceof MediaStreamAudioSourceNode) {
            // For system audio capture, stop all tracks
            try {
                if (audioSource.mediaStream) {
                    const tracks = audioSource.mediaStream.getTracks();
                    tracks.forEach(track => track.stop());
                }
                audioSource.disconnect();
            } catch(e) {
                console.error("Error stopping media stream:", e);
            }
        }
        
        audioSource = null;
    }
    
    // Prevent feedback/echo by disconnecting analyzer from destination
    try { analyser.disconnect(audioContext.destination); } catch(e) {}
    
    isPlaying = false;

    // Get display name for logging
    const selectedOption = event.target.selectedOptions[0];
    const displayName = selectedOption ? selectedOption.textContent : 'unknown';
    
    log(`Loading local sample: ${displayName}`);
    try {
        // Fetch the audio file
        const response = await fetch(filePath);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        
        try {
            // Use a timeout to handle rapid file changes and prevent race conditions
            if (window.pendingAudioDecodeTimeout) {
                clearTimeout(window.pendingAudioDecodeTimeout);
            }
            
            window.pendingAudioDecodeTimeout = setTimeout(async () => {
                try {
                    // Decode the audio data
                    const buffer = await audioContext.decodeAudioData(arrayBuffer);
                    
                    audioBuffer = buffer;
                    log(`Sample loaded successfully: ${displayName}`);
                    
                    // Update UI - re-enable play button
                    if (playBtn) {
                        playBtn.disabled = false;
                        playBtn.textContent = '▶';
                    }
                } catch (decodeError) {
                    throw new Error(`Failed to decode audio data: ${decodeError.message}`);
                } finally {
                    window.pendingAudioDecodeTimeout = null;
                }
            }, 50); // Short delay to handle rapid changes
        } catch (decodeError) {
            throw new Error(`Failed to decode audio data: ${decodeError.message}`);
        }
    } catch (error) {
        log(`Error loading sample: ${error.message}`);
        if (playBtn) {
            playBtn.disabled = false;
            playBtn.textContent = '▶';
        }
        if (document.getElementById('pauseBtn')) document.getElementById('pauseBtn').disabled = true; 
    }
}

// Main animation loop - called every frame
function animate() {
    requestAnimationFrame(animate);
    
    // Update audio visualization if playing
    if (isPlaying) {
        updateWaves();
    }
    
    // Update UI and camera positioning
    updateTimeRingPosition();
    controls.update();
    
    // Render the scene
    renderer.render(scene, camera);
}

// Update position of time spiral based on slider
function updateTimeRingPosition() {
    const timeRingSlider = document.getElementById('timeRingSlider');
    if (!timeRingSlider) return;
    
    // Find the time spiral object
    const timeSpiral = waves.find(wave => wave.type === 'timeSpiral');
    if (timeSpiral && timeSpiral.mesh && frequencies.length > 0) {
        // Calculate position relative to the highest frequency ring
        const highestRingY = startYFreq + ((frequencies.length - 1) * config.harmonic.spacing) + 
                          ((config.harmonic.count - 1) * 3);
        
        // Set position based on slider value
        timeSpiral.mesh.position.y = highestRingY + parseFloat(timeRingSlider.value);
    }
}

// Initialize and start capturing system audio for visualization
async function captureSystemAudio() {
    // Ensure audio context is initialized
    initAudio(); // Moved initAudio call here

    log("Attempting to capture system audio...");
    
    try {
        // Resume audio context if suspended
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }
        
        log('Attempting to capture system audio...');
        
        // Disable buttons during setup
        if (document.getElementById('playBtn')) document.getElementById('playBtn').disabled = true;
        if (document.getElementById('pauseBtn')) document.getElementById('pauseBtn').disabled = true;
        
        // Request system audio capture via screen sharing
        // NOTE: Requires Chrome with getDisplayMedia support and user to select "Share system audio"
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: true,  // Video must be requested to access system audio option
            audio: true
        });
        
        // Verify we got audio tracks in the stream
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length === 0) {
            throw new Error('No audio track available. Make sure to select "Share system audio" when prompted.');
        }
        
        log(`Got ${audioTracks.length} audio tracks`);
        
        // Stop any existing audio playback
        if (isPlaying) {
            pauseAudio();
        }
        
        // IMPORTANT: Disconnect analyzer from destination to prevent audio feedback loop
        try { analyser.disconnect(audioContext.destination); } catch(e){}
        
        // Connect the media stream to our audio analyzer
        audioSource = audioContext.createMediaStreamSource(stream);
        audioSource.connect(analyser);
        // Do NOT connect analyzer to destination for system audio - prevents echo
        
        isPlaying = true;
        log('System audio capture started');
        
        // Update UI
        if (document.getElementById('pauseBtn')) {
            document.getElementById('pauseBtn').disabled = false;
        }
        
        // Add track end handler when user stops sharing
        audioTracks[0].onended = () => {
            log('Audio capture ended');
            isPlaying = false;
            
            // Reset UI
            if (document.getElementById('playBtn')) document.getElementById('playBtn').disabled = false;
            if (document.getElementById('pauseBtn')) document.getElementById('pauseBtn').disabled = true;
            
            // Reset dropdown selection
            if (sampleSelect && sampleSelect.options.length > 1) {
                sampleSelect.selectedIndex = 1;
            }
        };
        
    } catch (error) {
        log(`Error capturing system audio: ${error.message}`);
        log('Note: System audio capture requires Chrome and "Share system audio" option.');
        
        // Re-enable UI
        if (document.getElementById('playBtn')) document.getElementById('playBtn').disabled = false;
        
        // Reset dropdown selection
        if (sampleSelect && sampleSelect.options.length > 1) {
            sampleSelect.selectedIndex = 1;
        }
    }
}

// // Toggle system audio capture on/off
// function toggleCapture() {
//     const captureButton = document.getElementById('captureButton');
//     const isCapturing = captureButton && captureButton.dataset.capturing === 'true';
    
//     if (isCapturing) {
//         // Stop capturing by stopping all tracks in the media stream
//         if (audioSource && audioSource.mediaStream) {
//             const tracks = audioSource.mediaStream.getTracks();
//             tracks.forEach(track => track.stop());
//         }
        
//         isPlaying = false;
        
//         // Update button state
//         if (captureButton) {
//             captureButton.textContent = 'Capture System Audio';
//             captureButton.dataset.capturing = 'false';
//         }
        
//         log('Audio capture stopped');
//     } else {
//         // Start new capture
//         captureSystemAudio();
//     }
// }

// Display current camera and controls information for debugging/saving views
function displayCameraInfo() {
    if (!camera || !controls) return;
    
    // Get current camera position and target information
    const pos = camera.position;
    const rot = camera.rotation;
    const target = controls.target; 
    
    // Format the data for display
    const info = {
        position: { 
            x: pos.x.toFixed(2), 
            y: pos.y.toFixed(2), 
            z: pos.z.toFixed(2) 
        },
        rotation: { // Keeping rotation for reference
            x: rot.x.toFixed(4), 
            y: rot.y.toFixed(4), 
            z: rot.z.toFixed(4) 
        },
        target: {
            x: target.x.toFixed(2), 
            y: target.y.toFixed(2), 
            z: target.z.toFixed(2) 
        },
        fov: camera.fov,
        aspect: camera.aspect.toFixed(2)
    };
    
    // Output formatted code that can be used to reproduce this camera state
    log('<span style="color: cyan;">[CAMERA]</span> Current camera state:');
    log(`<pre style="color: cyan; margin: 0 0 0 10px; font-size: 0.9em;">camera.position.set(${info.position.x}, ${info.position.y}, ${info.position.z});\n// camera.rotation.set(${info.rotation.x}, ${info.rotation.y}, ${info.rotation.z}); // Might replace with lookAt\ncontrols.target.set(${info.target.x}, ${info.target.y}, ${info.target.z}); // Set the target\ncamera.lookAt(controls.target); // Look at the target\ncamera.fov = ${info.fov};\ncamera.updateProjectionMatrix(); // Update projection matrix after fov change\ncontrols.update(); // Ensure controls know about the changes</pre>`);
    
    console.log('Camera info:', info); // Also log to console for copy-paste
}

// Smoothly transition the camera to a preset view
function switchCameraView(viewName) {
    const view = config.views[viewName];
    if (!view) return;

    // Create a smooth animation to the new view
    const duration = 1000; // 1 second transition
    const startPos = camera.position.clone();
    const startTarget = controls.target.clone();
    const startTime = performance.now();

    // Animation function that interpolates between current and target views
    function updateCamera(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        
        // Smooth easing function for natural motion
        const easing = progress < 0.5 
            ? 2 * progress * progress // Ease in - quadratic
            : 1 - Math.pow(-2 * progress + 2, 2) / 2; // Ease out - quadratic

        // Interpolate position
        camera.position.x = startPos.x + (view.position.x - startPos.x) * easing;
        camera.position.y = startPos.y + (view.position.y - startPos.y) * easing;
        camera.position.z = startPos.z + (view.position.z - startPos.z) * easing;

        // Interpolate target
        controls.target.x = startTarget.x + (view.target.x - startTarget.x) * easing;
        controls.target.y = startTarget.y + (view.target.y - startTarget.y) * easing;
        controls.target.z = startTarget.z + (view.target.z - startTarget.z) * easing;

        // Update camera and controls
        camera.lookAt(controls.target);
        camera.fov = view.fov;
        camera.updateProjectionMatrix();
        controls.update();

        // Continue animation if not complete
        if (progress < 1) {
            requestAnimationFrame(updateCamera);
        }
    }

    requestAnimationFrame(updateCamera);
    log(`Switched to ${viewName}`);
}

// Setup all UI elements and event listeners
function setupEventListeners() {
    // Handle window resize by updating camera and renderer
    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });
    
    // Setup audio sample selection dropdown
    const sampleSelect = document.getElementById('sampleSelect');
    if (sampleSelect) {
        log('Loading available samples...');
        
        // Clear any existing options
        while (sampleSelect.firstChild) {
            sampleSelect.removeChild(sampleSelect.firstChild);
        }

        // Fallback list of audio files if we can't load a manifest
        const hardcodedAudioFiles = [
            "OMNI  SCALE (Demo, No Talking).mp3"
        ];
        
        // Try to load sample manifest from file
        async function loadSamplesManifest() {
            try {
                const manifestResponse = await fetch('./samples/manifest.json');
                
                if (manifestResponse.ok) {
                    const manifest = await manifestResponse.json();
                    log('Loaded samples manifest successfully');
                    
                    // Extract file list from manifest in correct format
                    if (Array.isArray(manifest.files)) {
                        return manifest.files;
                    } else if (manifest.files && typeof manifest.files === 'object') {
                        return Object.values(manifest.files);
                    } else {
                        log('Invalid manifest format: files property is not an array or object');
                        return hardcodedAudioFiles;
                    }
                } else {
                    log('Manifest file not found, using hardcoded list');
                    return hardcodedAudioFiles;
                }
            } catch (error) {
                log(`Error loading manifest: ${error.message}, using hardcoded list`);
                return hardcodedAudioFiles;
            }
        }
        
        // Verify file existence and add to dropdown
        async function verifyAndAddFiles() {
            const audioFiles = await loadSamplesManifest();
            
            // Check each file in the list
            for (const filename of audioFiles) {
                const encodedFilename = encodeURIComponent(filename);
                const filePath = `./samples/${encodedFilename}`;
                
                try {
                    // Use HEAD request to check if file exists without downloading it
                    const response = await fetch(filePath, { method: 'HEAD' });
                    
                    if (response.ok) {
                        // Add to dropdown if file exists
                        const option = document.createElement('option');
                        option.value = filePath;
                        option.textContent = filename.replace(/\.(mp3|wav|ogg|flac)$/i, '');
                        sampleSelect.appendChild(option);
                        log(`Found and added: ${filename}`);
                    } else {
                        log(`File not available: ${filename} (${response.status})`);
                    }
                } catch (error) {
                    log(`Error checking file ${filename}: ${error.message}`);
                }
            }
            
            // Add system audio capture option
            const captureOption = document.createElement('option');
            captureOption.value = "capture_system_audio";
            captureOption.textContent = "[CAPTURE SYSTEM AUDIO]";
            captureOption.style.color = "gold";
            captureOption.style.fontWeight = "bold";
            sampleSelect.appendChild(captureOption);
            log("Added system audio capture option");
            
            // Check if we found any audio files
            if (sampleSelect.options.length <= 1) {
                log('Warning: No audio samples were found');
                return false;
            }
            
            log(`Successfully added ${sampleSelect.options.length - 1} audio samples plus system capture option`);
            return true;
        }
        
        // Load files and select first one by default
        verifyAndAddFiles().then(success => {
            if (success && sampleSelect.options.length > 0) {
                sampleSelect.selectedIndex = 0;
                sampleSelect.dispatchEvent(new Event('change'));
            }
        });

        // Add change handler
        sampleSelect.addEventListener('change', handleSampleSelect);
    }
    
    // Listen for Firebase track selection events
    const sampleSelectElement = document.getElementById('sampleSelect');
    if (sampleSelectElement) {
        sampleSelectElement.addEventListener('firebaseTrackSelected', (event) => {
            log('Received firebaseTrackSelected event');
            if (event.detail && event.detail.url) {
                loadAndPlayFirebaseAudio(event.detail.url, event.detail.name);
            } else {
                log('firebaseTrackSelected event missing URL in detail');
            }
        });
    }
    
    // Setup playback control buttons
    const playBtn = document.getElementById('playBtn');
    if (playBtn) {
        playBtn.addEventListener('click', playAudio);
    }

    const pauseBtn = document.getElementById('pauseBtn');
    if (pauseBtn) {
        pauseBtn.addEventListener('click', pauseAudio);
        pauseBtn.disabled = true;  // Initially disabled until audio is loaded
    }
    
    // Setup camera info button
    const cameraInfoBtn = document.getElementById('cameraInfoBtn');
    if (cameraInfoBtn) {
        cameraInfoBtn.addEventListener('click', displayCameraInfo);
    }
    
    // Create UI controls container if needed
    let controlsContainer = document.getElementById('visualizerControls');
    if (!controlsContainer) {
        controlsContainer = document.createElement('div');
        controlsContainer.id = 'visualizerControls';
        controlsContainer.style.position = 'absolute';
        controlsContainer.style.bottom = '20px';
        controlsContainer.style.left = '20px';
        controlsContainer.style.background = 'rgba(0,0,0,0.7)';
        controlsContainer.style.padding = '10px';
        controlsContainer.style.borderRadius = '0';
        controlsContainer.style.color = 'white';
        document.body.appendChild(controlsContainer);
    }

    // On mobile, only show view buttons, not configuration controls
    if (!isMobile) {
        // Create slider for time ring position adjustment
        const timeRingSliderContainer = document.createElement('div');
        timeRingSliderContainer.innerHTML = `
            <label for="timeRingSlider">Time Ring Position: </label>
            <input type="range" id="timeRingSlider" min="-50" max="100" value="${timeRingOffsetY}" step="1">
            <span id="timeRingValue">${timeRingOffsetY}</span>
        `;
        controlsContainer.appendChild(timeRingSliderContainer);

        // Create slider for FFT size adjustment
        const fftSliderContainer = document.createElement('div');
        fftSliderContainer.style.marginTop = '10px';
        
        // Use logarithmic scale for FFT size (2^9 to 2^14)
        const fftLogSize = Math.log2(fftSize);
        fftSliderContainer.innerHTML = `
            <label for="fftSizeSlider">FFT Window Size: </label>
            <input type="range" id="fftSizeSlider" min="9" max="14" value="${fftLogSize}" step="1">
            <span id="fftSizeValue">${fftSize}</span>
        `;
        controlsContainer.appendChild(fftSliderContainer);

        // Create slider for spiral growth factor
        const spiralGrowthSliderContainer = document.createElement('div');
        spiralGrowthSliderContainer.style.marginTop = '10px';
        spiralGrowthSliderContainer.innerHTML = `
            <label for="spiralGrowthSlider">Spiral Growth: </label>
            <input type="range" id="spiralGrowthSlider" min="0.0001" max="1.0" value="${spiralGrowthFactor}" step="0.0001">
            <span id="spiralGrowthValue">${spiralGrowthFactor.toFixed(5)}</span>
        `;
        controlsContainer.appendChild(spiralGrowthSliderContainer);

        // Create slider for spiral revolutions
        const spiralRevolutionsSliderContainer = document.createElement('div');
        spiralRevolutionsSliderContainer.style.marginTop = '10px';
        spiralRevolutionsSliderContainer.innerHTML = `
            <label for="spiralRevolutionsSlider">Spiral Revolutions: </label>
            <input type="range" id="spiralRevolutionsSlider" min="1" max="40" value="${spiralRevolutions}" step="1">
            <span id="spiralRevolutionsValue">${spiralRevolutions}</span>
        `;
        controlsContainer.appendChild(spiralRevolutionsSliderContainer);

        // Create slider for audio history duration
        const historyDurationSliderContainer = document.createElement('div');
        historyDurationSliderContainer.style.marginTop = '10px';
        historyDurationSliderContainer.innerHTML = `
            <label for="historyDurationSlider">History Length (sec): </label>
            <input type="range" id="historyDurationSlider" min="1" max="10" value="${historyDuration}" step="0.5">
            <span id="historyDurationValue">${historyDuration.toFixed(1)}</span>
        `;
        controlsContainer.appendChild(historyDurationSliderContainer);

        // Create slider for sampling rate adjustment
        const samplingSliderContainer = document.createElement('div');
        samplingSliderContainer.style.marginTop = '10px';
        samplingSliderContainer.innerHTML = `
            <label for="samplingSlider">Sampling Rate (higher = smoother): </label>
            <input type="range" id="samplingSlider" min="1" max="8" value="${samplingFactor}" step="1">
            <span id="samplingValue">${samplingFactor}</span>
        `;
        controlsContainer.appendChild(samplingSliderContainer);

        // Add event listeners for all UI controls
        
        // Time ring position slider
        const timeRingSlider = document.getElementById('timeRingSlider');
        const timeRingValue = document.getElementById('timeRingValue');
        if (timeRingSlider && timeRingValue) {
            timeRingSlider.addEventListener('input', (e) => {
                const value = e.target.value;
                timeRingValue.textContent = value;
                timeRingOffsetY = parseFloat(value);
            });
        }

        // FFT size slider (logarithmic)
        const fftSlider = document.getElementById('fftSizeSlider');
        const fftValue = document.getElementById('fftSizeValue');
        if (fftSlider && fftValue) {
            fftSlider.addEventListener('input', (e) => {
                const logValue = parseInt(e.target.value);
                const newSize = Math.pow(2, logValue);
                fftValue.textContent = newSize;
                
                // Only update if changed to avoid unnecessary recalculations
                if (fftSize !== newSize) {
                    setFFTSize(newSize);
                    
                    // Restart playback with new FFT size if currently playing
                    if (isPlaying && audioSource) {
                        pauseAudio();
                        playAudio();
                    }
                }
            });
        }

        // Spiral growth factor slider
        const spiralGrowthSlider = document.getElementById('spiralGrowthSlider');
        const spiralGrowthValue = document.getElementById('spiralGrowthValue');
        if (spiralGrowthSlider && spiralGrowthValue) {
            spiralGrowthSlider.addEventListener('input', (e) => {
                const value = parseFloat(e.target.value);
                spiralGrowthValue.textContent = value.toFixed(5);
                spiralGrowthFactor = value;
                
                // Update the spiral parameter
                const spiral = waves.find(wave => wave.type === 'timeSpiral');
                if (spiral) {
                    spiral.growthFactor = value;
                }
            });
        }

        // Spiral revolutions slider
        const spiralRevolutionsSlider = document.getElementById('spiralRevolutionsSlider');
        const spiralRevolutionsValue = document.getElementById('spiralRevolutionsValue');
        if (spiralRevolutionsSlider && spiralRevolutionsValue) {
            spiralRevolutionsSlider.addEventListener('input', (e) => {
                const value = parseInt(e.target.value, 10);
                spiralRevolutionsValue.textContent = value;
                spiralRevolutions = value;
                // Update the spiral if it exists
                const spiral = waves.find(wave => wave.type === 'timeSpiral');
                if (spiral) {
                    spiral.revolutions = value;
                    // Force regeneration of spiral
                    audioHistoryBuffer = [];
                    updateTimeSpiral();
                }
            });
        }

        // History duration slider
        const historyDurationSlider = document.getElementById('historyDurationSlider');
        const historyDurationValue = document.getElementById('historyDurationValue');
        if (historyDurationSlider && historyDurationValue) {
            historyDurationSlider.addEventListener('input', (e) => {
                const value = parseFloat(e.target.value);
                historyDurationValue.textContent = value.toFixed(1);
                historyDuration = value;
                
                // Clear history buffer for clean restart with new duration
                audioHistoryBuffer = [];
            });
        }

        // Sampling factor slider
        const samplingSlider = document.getElementById('samplingSlider');
        const samplingValue = document.getElementById('samplingValue');
        if (samplingSlider && samplingValue) {
            samplingSlider.addEventListener('input', (e) => {
                const value = parseInt(e.target.value);
                samplingValue.textContent = value;
                samplingFactor = value;
                
                // Clear history buffer for clean restart with new sampling
                audioHistoryBuffer = [];
            });
        }
    }

    // Add separator before view buttons
    const separator = document.createElement('div');
    separator.style.height = '1px';
    separator.style.background = 'rgba(255, 255, 255, 0.2)';
    separator.style.margin = '10px 0';
    controlsContainer.appendChild(separator);

    // Create container for camera view buttons
    const viewButtonsContainer = document.createElement('div');
    viewButtonsContainer.style.display = 'flex';
    viewButtonsContainer.style.gap = '10px';
    viewButtonsContainer.style.marginTop = '10px';
    controlsContainer.appendChild(viewButtonsContainer);

    // Create buttons for each preset camera view
    ['default', 'view2', 'view3'].forEach((viewName, index) => {
        const button = document.createElement('button');
        button.textContent = `View ${index + 1}`;
        button.style.backgroundColor = 'transparent';
        button.style.border = '1px solid white';
        button.style.color = 'white';
        button.style.padding = '5px 16px';
        button.style.cursor = 'pointer';
        button.style.fontFamily = 'monospace';
        button.style.fontSize = '14px';
        button.style.transition = 'background-color 0.3s';
        button.style.borderRadius = '0';
        button.style.outline = 'none';
        button.style.margin = '0';
        button.style.height = '32px';
        button.style.flex = '1';

        // Add hover effects
        button.addEventListener('mouseover', () => {
            button.style.backgroundColor = 'rgba(255, 255, 255, 0.2)';
        });
        button.addEventListener('mouseout', () => {
            button.style.backgroundColor = 'transparent';
        });

        // Add click handler to switch camera view
        button.addEventListener('click', () => switchCameraView(viewName));

        viewButtonsContainer.appendChild(button);
    });
}

// Create help notification for system audio capture
function createSystemAudioNote() {
    // Skip on mobile devices
    if (isMobile) {
        return;
    }
    
    // Adjust position of controls if needed
    const controlsDiv = document.getElementById('controls');
    if (controlsDiv) {
        controlsDiv.style.top = '35px'; // Make room for the note
    }
    
    // Create floating notification element
    const noteElement = document.createElement('div');
    noteElement.style.position = 'fixed';
    noteElement.style.top = '20px';
    noteElement.style.left = '20px';
    noteElement.style.background = 'rgba(0,0,0,0.7)';
    noteElement.style.color = 'white';
    noteElement.style.padding = '5px 10px';
    noteElement.style.borderRadius = '5px';
    noteElement.style.zIndex = '999';
    noteElement.style.fontSize = '0.8em';
    noteElement.style.fontFamily = 'monospace';
    noteElement.style.whiteSpace = 'nowrap';
    noteElement.innerHTML = `To pass audio from another tab: Select <span style="color: gold; font-weight: bold;">[CAPTURE SYSTEM AUDIO]</span> from dropdown, enable "Share system audio"`;
    document.body.appendChild(noteElement);
}

// Main application initialization
try {
    // Initialize core components
    initScene();
    // initAudio(); // Removed direct call from here
    createWaves();
    setupEventListeners();
    createSystemAudioNote();
    
    // Start the animation loop
    animate();
    
    log('<span style="color: gold;">[READY]</span> All circuits are go.');
    log('<span style="color: gold;">Send music through this channel...</span>');
} catch (error) {
    log(`Initialization error: ${error.message}`);
}