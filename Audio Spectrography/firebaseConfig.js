import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js";
import { getFirestore, collection, addDoc, getDocs, getDoc, doc, setDoc } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js";
// Import Storage functions
import { getStorage, ref, uploadBytesResumable, getDownloadURL } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-storage.js";

// Firebase configuration for your project
const firebaseConfig = {
    apiKey: "AIzaSyAr2C7iYHZNcQsLrm55w5aYcxyFbFHiB78",
    authDomain: "spectrumvisualizer-d5c3b.firebaseapp.com",
    projectId: "spectrumvisualizer-d5c3b",
    storageBucket: "spectrumvisualizer-d5c3b.firebasestorage.app",
    messagingSenderId: "644895365947",
    appId: "1:644895365947:web:518d9dfc524009f95a751e",
    measurementId: "G-6JZPPQ302L"
};

// Initialize Firebase app
console.log("Initializing Firebase app for projectId:", firebaseConfig.projectId);
let app, db, storage;
try {
    app = initializeApp(firebaseConfig);
    // Correctly initialize Firestore for the NAMED database
    db = getFirestore(app, "spectral-viz-db"); 
    // Initialize Storage
    storage = getStorage(app); 
    console.log(`Firebase initialized. Using database: spectral-viz-db and storage bucket: ${firebaseConfig.storageBucket}`);
    if (db && db._databaseId && db._databaseId.database) {
      console.log(`Firestore instance confirmed for database: ${db._databaseId.database}`);
    } else {
      console.warn(`Could not verify Firestore instance's configured database name via internal properties.`);
    }
} catch (error) {
    console.error("Error initializing Firebase:", error);
    db = null; 
    storage = null;
}

// --- Storage Upload Function --- 
// Takes the file, the firestore document ID (uniqueId), and progress callback
async function uploadAudioFile(file, uniqueId, onProgress) {
    if (!storage) throw new Error("Firebase Storage not initialized");

    // 1. Get file extension
    const originalFilename = file.name;
    const lastDotIndex = originalFilename.lastIndexOf('.');
    // Includes the dot, e.g., ".wav". Handles cases with no extension.
    const extension = (lastDotIndex > 0) ? originalFilename.substring(lastDotIndex) : ''; 

    // 2. Construct the new filename using the Firestore ID and original extension
    const newFilename = `${uniqueId}${extension}`; // e.g., hTkXuD2PzZlhrilO9Ajy.wav

    // 3. Create storage reference using the new filename directly in audio-files/
    const filePath = `audio-files/${newFilename}`;
    const storageRef = ref(storage, filePath);
    console.log(`Uploading to Storage path: ${filePath}`);

    return new Promise((resolve, reject) => {
        const uploadTask = uploadBytesResumable(storageRef, file);

        uploadTask.on('state_changed',
            (snapshot) => {
                // Progress function
                const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
                console.log('Upload is ' + progress + '% done');
                if (onProgress) {
                    onProgress(progress);
                }
            },
            (error) => {
                // Error function
                console.error("Storage upload error:", error);
                // Handle specific errors (e.g., permissions)
                switch (error.code) {
                    case 'storage/unauthorized':
                        console.error("User doesn't have permission to access the object");
                        break;
                    case 'storage/canceled':
                        console.error("User canceled the upload");
                        break;
                    case 'storage/unknown':
                        console.error("Unknown error occurred, inspect error.serverResponse");
                        break;
                }
                reject(error);
            },
            async () => {
                // Completion function
                try {
                    const downloadURL = await getDownloadURL(uploadTask.snapshot.ref);
                    console.log('File available at', downloadURL);
                    resolve(downloadURL);
                } catch (error) {
                     console.error("Error getting download URL:", error);
                     reject(error);
                }
            }
        );
    });
}

// Function to verify database connection
async function testDatabaseConnection() {
    if (!db) {
        console.error("Firestore database (db) is not initialized.");
        return { success: false, message: "Firestore DB not initialized" };
    }
    try {
        console.log(`Testing connection to database: ${db._databaseId?.database || 'spectral-viz-db (expected)'}`);
        const testDocRef = doc(db, 'test-connection', 'test-doc');
        await setDoc(testDocRef, { 
            timestamp: new Date().toISOString(), 
            test: true,
            message: "Testing connection to spectral-viz-db database" 
        });
        const testDocSnap = await getDoc(testDocRef);
        if (testDocSnap.exists()) {
            console.log("Database connection verified, test document:", testDocSnap.data());
            return {
                success: true,
                message: "Database connection successful",
                data: testDocSnap.data()
            };
        } else {
            console.error("Test document created but couldn't be read back");
            return {
                success: false,
                message: "Test document created but couldn't be read back"
            };
        }
    } catch (error) {
        console.error("Database connection test failed:", error);
        if (error.code === 'permission-denied') {
             console.error("PERMISSION DENIED: Check Firestore rules for 'test-connection' collection.");
             return { success: false, message: "Permission Denied. Check Firestore rules.", error: error };
        }
        return {
            success: false,
            message: `Connection test failed: ${error.message}`,
            error: error
        };
    }
}

// Function to add a sample to the database
async function addAudioSample(sampleData) {
    if (!db) throw new Error("Firestore DB not initialized");
    // Ensure downloadUrl is null initially or omitted
    const dataToAdd = { ...sampleData, downloadUrl: null }; 
    try {
        console.log(`Attempting to add audio sample to collection 'audio-samples'`);
        const docRef = await addDoc(collection(db, 'audio-samples'), dataToAdd);
        console.log("Document written with ID: ", docRef.id);
        return docRef.id; // Return the ID
    } catch (error) {
        console.error("Error adding document: ", error);
         if (error.code === 'permission-denied') {
             console.error("PERMISSION DENIED: Check Firestore rules for 'audio-samples' collection.");
        }
        throw error;
    }
}

// Function to update an existing sample document with the download URL
async function updateAudioSampleUrl(docId, downloadUrl) {
    if (!db) throw new Error("Firestore DB not initialized");
    try {
        console.log(`Attempting to update doc ${docId} with download URL`);
        const docRef = doc(db, 'audio-samples', docId); // Get reference to the specific doc
        // Use set with merge:true to only update the downloadUrl field
        await setDoc(docRef, { downloadUrl: downloadUrl }, { merge: true }); 
        console.log(`Document ${docId} updated successfully with download URL.`);
    } catch (error) {
        console.error(`Error updating document ${docId}:`, error);
         if (error.code === 'permission-denied') {
             console.error("PERMISSION DENIED: Check Firestore rules for 'audio-samples' collection.");
        }
        throw error;
    }
}

// Function to get all audio samples
async function getAudioSamples() {
    if (!db) throw new Error("Firestore DB not initialized");
    try {
        console.log(`Attempting to get audio samples from collection 'audio-samples' in database: ${db._databaseId?.database || 'spectral-viz-db (expected)'}`);
        const querySnapshot = await getDocs(collection(db, 'audio-samples'));
        console.log(`Retrieved ${querySnapshot.size} documents from 'audio-samples'`);
        return querySnapshot;
    } catch (error) {
        console.error("Error getting documents: ", error);
         if (error.code === 'permission-denied') {
             console.error("PERMISSION DENIED: Check Firestore rules for 'audio-samples' collection.");
        }
        throw error;
    }
}

// Export necessary functions and instances
export { 
    db, 
    storage, // Export storage if needed elsewhere, though upload fn is exported
    addAudioSample, 
    updateAudioSampleUrl, // Export the new update function
    getAudioSamples, 
    testDatabaseConnection, 
    uploadAudioFile // Export the upload function
}; 