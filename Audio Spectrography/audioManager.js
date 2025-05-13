import { getAudioSamples } from './firebaseConfig.js';

class AudioManager {
    constructor() {
        this.dropdownElement = document.getElementById('sampleSelect');
        if (!this.dropdownElement) {
            console.error("Dropdown element '#sampleSelect' not found!");
            return;
        }
        this.audioSamples = [];
        this.initialized = false;
        this.initializeDropdown();
    }

    async initializeDropdown() {
        try {
            // Clear existing options but don't add the "Select a track..." option
            this.dropdownElement.innerHTML = '';
            
            // Get audio samples from Firebase
            const querySnapshot = await getAudioSamples();
            this.audioSamples = [];
            
            querySnapshot.forEach(doc => {
                const data = doc.data();
                this.audioSamples.push({
                    id: doc.id,
                    ...data
                });
                
                // Only add tracks that have a download URL
                if (data.downloadUrl) {
                    // Create option element with reversed order
                    const option = document.createElement('option');
                    option.value = data.downloadUrl;
                    option.textContent = `${data.trackName || data.name || 'Untitled'} - ${data.artistName || 'Unknown'}`;
                    this.dropdownElement.appendChild(option);
                } else {
                    console.warn(`Track ${doc.id} (${data.name || 'Untitled'}) has no download URL`);
                }
            });

            // Add change event listener to handle selection
            this.dropdownElement.addEventListener('change', this.handleTrackSelection.bind(this));
            
            console.log('Dropdown initialized with', this.audioSamples.length, 'tracks');
            this.initialized = true;
        } catch (error) {
            console.error('Error initializing dropdown:', error);
            // Add error option to dropdown
            const errorOption = document.createElement('option');
            errorOption.textContent = 'Error loading tracks';
            errorOption.disabled = true;
            this.dropdownElement.appendChild(errorOption);
            this.initialized = true; // Still mark as initialized even with error
        }
    }

    // Method to check if initialization is complete
    isInitialized() {
        return this.initialized;
    }

    handleTrackSelection(event) {
        const selectedUrl = event.target.value;
        const selectedOption = event.target.selectedOptions[0];
        const trackName = selectedOption ? selectedOption.textContent : 'Selected Track';

        // Only process if it looks like a valid HTTP/S URL (i.e., a Firebase URL)
        if (selectedUrl && (selectedUrl.startsWith('http://') || selectedUrl.startsWith('https://'))) {
            try {
                console.log(`Selected track: ${trackName} with URL: ${selectedUrl}`);
                
                // Ensure the URL is properly formatted for CORS
                const url = new URL(selectedUrl); // This should be safe now
                
                // Dispatch an event with the URL for visualization.js to handle
                const trackSelectedEvent = new CustomEvent('firebaseTrackSelected', {
                    detail: { 
                        url: url.toString(), 
                        name: trackName
                    },
                    bubbles: true
                });
                
                this.dropdownElement.dispatchEvent(trackSelectedEvent);
                console.log(`Dispatched firebaseTrackSelected event for: ${trackName}`);
            } catch (error) {
                // Log error but maybe don't alert unless necessary
                console.error(`Error processing Firebase track URL: ${error.message}`);
                // alert(`Error with track URL: ${error.message}`); // Alert might be too intrusive
            }
        } else {
            // Log that this selection is being ignored by audioManager (handled by visualization.js)
            // console.log(`Ignoring non-URL selection in audioManager: ${selectedUrl}`);
        }
    }
}

// Export a singleton instance
const audioManager = new AudioManager();
export { audioManager }; 