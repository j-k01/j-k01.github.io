import { storage } from './firebaseConfig.js';
import { ref, getDownloadURL } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-storage.js";

/**
 * FirebaseAudioLoader - Loads audio files from Firebase Storage using the SDK
 */
class FirebaseAudioLoader {
    constructor(audioContext) {
        if (!audioContext) {
            throw new Error("AudioContext is required for FirebaseAudioLoader");
        }
        this.audioContext = audioContext;
        // Add cache for audio buffers
        this.audioBufferCache = new Map();
        console.log('FirebaseAudioLoader initialized with caching');
    }

    /**
     * Extract file path from Firebase Storage URL
     * @param {string} urlString - Firebase Storage URL string
     * @returns {string|null} The file path portion of the URL or null on error
     */
    extractPathFromUrl(urlString) {
        try {
            const url = new URL(urlString);
            // Expected pathname format: /v0/b/<bucket-name>/o/<encoded-path>
            const pathPrefix = `/v0/b/${storage.app.options.storageBucket}/o/`;
            
            if (!url.pathname.startsWith(pathPrefix)) {
                console.error(`URL pathname "${url.pathname}" does not start with expected prefix "${pathPrefix}"`);
                return null;
            }
            
            // Extract the part after the prefix
            const encodedPath = url.pathname.substring(pathPrefix.length);
            
            // Decode the path
            const decodedPath = decodeURIComponent(encodedPath);
            console.log(`Extracted path from URL: "${decodedPath}"`);
            return decodedPath;
        } catch (error) {
            console.error(`Error extracting path from URL "${urlString}":`, error);
            return null;
        }
    }

    /**
     * Load audio from Firebase Storage using the SDK to get a URL, then fetch
     * @param {string} storageUrl - The original Firebase Storage URL from Firestore
     * @returns {Promise<AudioBuffer>} - The decoded audio buffer
     */
    async loadAudio(storageUrl, trackName = 'Firebase Track') {
        // Check cache first
        if (this.audioBufferCache.has(storageUrl)) {
            console.log(`[Cache Hit] Loading ${trackName} from cache`);
            return this.audioBufferCache.get(storageUrl);
        }

        console.log(`[Download] Loading audio: ${trackName}`);
        let fileRef;
        
        try {
            // 1. Extract the file path
            console.log(`[Download] Extracting path from URL`);
            const path = this.extractPathFromUrl(storageUrl);
            if (!path) {
                throw new Error('Could not extract a valid file path from the provided URL');
            }
            
            // 2. Create Storage Reference
            console.log(`[Download] Creating storage reference`);
            if (!storage) {
                 throw new Error('Firebase Storage instance is not available. Check firebaseConfig.js');
            }
            fileRef = ref(storage, path);
            console.log(`[Download] Storage reference created successfully`);
            
            // 3. Get Download URL using SDK
            console.log(`[Download] Fetching secure download URL...`);
            const downloadUrl = await getDownloadURL(fileRef);
            console.log(`[Download] Got secure URL`);

            // 4. Fetch the data using the obtained Download URL
            console.log(`[Download] Downloading audio data...`);
            const response = await fetch(downloadUrl);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status} (${response.statusText})`);
            }
            console.log(`[Download] Received response`);
            const arrayBuffer = await response.arrayBuffer();
            if (arrayBuffer.byteLength === 0) {
                throw new Error('Received empty audio data (0 bytes).');
            }
            console.log(`[Download] Received ${(arrayBuffer.byteLength / 1024 / 1024).toFixed(2)}MB of audio data`);

            // 5. Decode Audio Data
            console.log('[Download] Decoding audio data...');
            return new Promise((resolve, reject) => {
                this.audioContext.decodeAudioData(
                    arrayBuffer,
                    (buffer) => {
                        const stats = {
                            duration: buffer.duration.toFixed(2) + 's',
                            channels: buffer.numberOfChannels,
                            sampleRate: buffer.sampleRate + 'Hz'
                        };
                        console.log('[Download] Audio decoded successfully:', stats);
                        // Store in cache before resolving
                        this.audioBufferCache.set(storageUrl, buffer);
                        console.log('[Cache] Track cached for future use');
                        resolve(buffer);
                    },
                    (decodeError) => {
                        console.error('[Download] Error during audio decoding:', decodeError);
                        reject(new Error(`Failed to decode audio: ${decodeError.message}`));
                    }
                );
            });
        } catch (error) {
            console.error(`[Download] Error loading audio for path "${fileRef ? fileRef.fullPath : 'unknown'}":`, error);
            if (error.code) {
                console.error(`[Download] Firebase error code: ${error.code}`);
                if (error.code === 'storage/object-not-found') {
                    throw new Error(`File not found in Firebase Storage. Please verify the file exists.`);
                } else if (error.code === 'storage/unauthorized') {
                    throw new Error(`Permission denied. Check Firebase Storage security rules.`);
                } else {
                    throw new Error(`Firebase Storage error (${error.code}): ${error.message}`);
                }
            } else {
                 throw error;
            }
        }
    }

    /**
     * Clear the audio buffer cache
     */
    clearCache() {
        this.audioBufferCache.clear();
        console.log('[Firebase SDK->Fetch] Audio buffer cache cleared');
    }
}

export default FirebaseAudioLoader; 