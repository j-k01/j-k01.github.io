import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.9/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/9.6.9/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyCFy7yDItezMrHUh90YjEwed7PSh1_BDic",
    authDomain: "brave-streamer-182808.firebaseapp.com",
    projectId: "brave-streamer-182808",
    storageBucket: "brave-streamer-182808.appspot.com",
    messagingSenderId: "285113590536",
    appId: "1:285113590536:web:252345941f6da6a7e942bd",
    measurementId: "G-YWJEKFHYWG"
  };

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

export default db;
