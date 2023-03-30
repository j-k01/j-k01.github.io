import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.9/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/9.6.9/firebase-firestore.js";
import { collection, addDoc } from "https://www.gstatic.com/firebasejs/9.6.9/firebase-firestore.js";
import { DATABASE_CONVERSATION_KEY } from "./constants.js";


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

async function startNewConversation(initString, locationInfo) {
  const conversationRef = await addDoc(collection(db, DATABASE_CONVERSATION_KEY), {
      startTime: new Date(),
      prompt: initString,
      ip: locationInfo.ip,
      location: `${locationInfo.city}, ${locationInfo.region}`
  });
  return conversationRef.id;
}

async function logChatHistory(conversationID, userMessage, botResponse) {
  const timestamp = new Date();
  const logData = {
      prompt: userMessage,
      completion: botResponse,
      timestamp: timestamp
  };
  return addDoc(collection(db, DATABASE_CONVERSATION_KEY, conversationID, "chathistory"), logData)
  .then(() => {
      console.log("Document written with conversation ID: ", conversationID);
  })
  .catch((error) => {
      console.error("Error adding document: ", error);
  });
}

export { startNewConversation, logChatHistory };

