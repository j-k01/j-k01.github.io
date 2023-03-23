        
    import db from './firebaseConfig.js';
    import { collection, addDoc, getDocs } from "https://www.gstatic.com/firebasejs/9.6.9/firebase-firestore.js";


    let currentConversationID = null;
    let firstInteraction = true;
    
    
async function startNewConversation(initString) {
    const conversationRef = await addDoc(collection(db, "murphy-conversations"), {
        startTime: new Date(),
        prompt: initString,
      });
    return conversationRef.id;
  }


    // Get the DOM elements for the chat area, user input, and send button
	const chatArea = document.getElementById('chatArea');
	const userInput = document.getElementById('userInput');
	const sendBtn = document.getElementById('sendBtn');

    // Add an input event listener to enable/disable the send button when the user has not entered any text
    userInput.addEventListener('input', () => {
        sendBtn.disabled = userInput.value.trim() === '';
    });

    // Add a click event listener to the send button to handle user messages and chatbot responses
    sendBtn.addEventListener('click', async () => {
        // Get the user's message and append it to the chat area
        const message = userInput.value.trim();
        
        const prompt = `
        You are a little, playful dog named Murphy, talking to his owner, Fei, who you always address as Feinion or Mama.
        Your favorite thing in the world is playing fetch. 
        You can only respond using woofs, barks, snarls, tail wags, and other things dogs will do.
        Howevever, you then translate your expression into human language using parenthesis wrapped by tildes.
        Ex: User: Hello Murphy!/n Murphy: *barks excitedly while chasing his tail* ~(Hello, Feinion! Let's play!)~
        User: ${message}/n
        Murphy: `;

        appendMessage('user', message);
        // Clear the input field and disable the send button
        userInput.value = '';
        sendBtn.disabled = true;

        // Get the chatbot's response and append it to the chat area
        
        //Just hacking in a retry until I can fix this on the backend.
        const response = await getBotResponse(prompt);
        if (response === 'Sorry, an error occurred. Please try again later.'){
            appendMessage('bot', getBotResponse(prompt));
        } else{
        appendMessage('bot', response);
        }

        if (firstInteraction) {
          currentConversationID = await startNewConversation(prompt);
          firstInteraction = false;
        }

        const timestamp = new Date();
        const logData = {
          prompt: message,
          completion: response,
          timestamp: timestamp
        };
        addDoc(collection(db, "murphy-conversations",currentConversationID, "chathistory"), logData)
        .then((docRef) => {
        console.log("Document written with ID: ", docRef.id);
        })
        .catch((error) => {
        console.error("Error adding document: ", error);
        });

    });


    //change event listener for the translate switch
    const translateSwitch = document.getElementById("translateSwitch");
    let translationEnabled = false;

        // Event listener for the translate switch
    translateSwitch.addEventListener("change", () => {
        

        console.log("activate!");
        document.querySelectorAll(".chat-message").forEach((messageElement) => {
          console.log(messageElement);
          if (messageElement.dataset.translated) {
            const textElement = messageElement.querySelector(".message");
            console.log(textElement);
            if (translateSwitch.checked) {
              // Show the translated message
              textElement.textContent = messageElement.dataset.translated;
            } else {
              textElement.textContent = messageElement.dataset.original;
            }
          }
        });


        // Update the translation state
        translationEnabled = !translationEnabled;

        // Update the "murphy" name
        const murphyName = translationEnabled ? "Murphy: (translated)" : "Murphy:";
        document.querySelectorAll(".bot").forEach(murphyLabel => {
            murphyLabel.textContent = murphyName;
        });
    });


    // Function to append a message (from user or chatbot) to the chat area
    function appendMessage(sender, message) {
        // Create the message element and set its class
        const messageElement = document.createElement('div');
        messageElement.classList.add('chat-message');

        // Create the sender label element and set its class and text content
        const senderElement = document.createElement('span');
        senderElement.classList.add(sender === 'user' ? 'user' : 'bot');
        //senderElement.textContent = sender === 'user' ? 'You:' : 'Murphy:';
        senderElement.textContent = sender === 'user' ? 'You:' : (translationEnabled ? 'Murphy (translated):' : 'Murphy:');
        
        // Append the sender label to the message element
        messageElement.appendChild(senderElement);

        // Create the message text element and set its class and text content
        const textElement = document.createElement('span');
        textElement.classList.add('message');
        textElement.textContent = message;

        //store translated and original message in data attribute. This allows the translation to be toggled on and off.
        if (sender === 'bot') {
            console.log("adding!")
            
            messageElement.dataset.translated = message;

            const separatorIndex = message.indexOf('~');
            if (separatorIndex != -1) {
                messageElement.dataset.original = message.slice(0, separatorIndex).trim();            
                //messageElement.dataset.translated =  message.slice(0, separatorIndex).trim() + ' ' + message.slice(separatorIndex+1).trim();
            } else {                
                messageElement.dataset.original = message;
            }    
            textElement.textContent = translationEnabled ? messageElement.dataset.translated : messageElement.dataset.original;
          };

        // Append the message text to the message element
        messageElement.appendChild(textElement);

        // Append the message element to the chat area and scroll to the bottom
        chatArea.appendChild(messageElement);
        chatArea.scrollTop = chatArea.scrollHeight;
    }


		
	async function getBotResponse(message) {
	  //const endpoint = 'https://api.openai.com/v1/chat/completions';
      const endpoint = 'https://proxygpt-proj-qvxq2j0uo-j-k01.vercel.app/api/chatbot';

	  const requestOptions = {
		method: 'POST',
		headers: {
		  'Content-Type': 'application/json',
		  'Authorization': `Bearer NULL`
		},
		body: JSON.stringify({
		  model: 'gpt-3.5-turbo',
		  //prompt: `User:${message}, Chatbot:`,
		  messages: [{'role': 'user', 'content': `${message}`}]
		  //max_tokens: 50, // Limit the response length
		  //n: 1, // Number of responses generated
		  //stop: null,
		  //temperature: 0.0 // Controls the randomness of the response
		})
	  };
	  try {
		const response = await fetch(endpoint, requestOptions);
		if (!response.ok) {
		  throw new Error(`API request failed with status ${response.status}`);
		}

		const data = await response.json();
        if (data.error) {
            return `Sorry, I received this error: ${data.error.message}`;
        }
		return data.choices[0].message.content.trim();
	  } catch (error) {
		console.error('Error fetching Chatbot response:', error);
		return 'Sorry, an error occurred. Please try again later.';
	  }
	}

