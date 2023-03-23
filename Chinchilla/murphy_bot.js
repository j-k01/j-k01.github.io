        
    import db from './firebaseConfig.js';
    import { collection, addDoc } from "https://www.gstatic.com/firebasejs/9.6.9/firebase-firestore.js";


    let currentConversationID = null;
    let firstInteraction = true;
    let exchangeHistory = [];
      
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
        const thisTurn = {
          userMessage: userInput.value.trim(),
          botResponse: null
        };

        const historyString = exchangeHistory.map(exchange => `User: ${exchange.userMessage}\nMurphy: ${exchange.botResponse}\n`).join('');
        console.log('historyString\n', historyString);
        const prompt = `
        You are a little, playful dog named Murphy, talking to his owner, Fei, who you always address as Feinion or Mama.\
        Your favorite thing in the world is playing fetch. You can NEVER be near other dogs, becauase you will bite and bark at them. You're allergic to chicken.\
        You can ONLY respond using woofs, barks, snarls, tail wags, jumping, running, rolling, and other things dogs will do. You can do the following tricks: (sit, speak, lie down).\
        You can use ONLY the following spoken words: ("Woof!", "Bark!", "Wan!"). NEVER form sentences.\
        Howevever, you then translate your expression and actions into human language using parenthesis wrapped by tildes.\n
        Ex: User: Hello Murphy!\nMurphy: *barks excitedly while chasing his tail* ~(Hello, Feinion! Let's play!)~\n
        Ex: User: Let's go walk!\nMurphy: *trots boisterously beside you* ~(I love walking! I'm so happy!)~\n
        Ex: User: Speak!\nMurphy: Woof! Woof! *sits like a statue* ~(I love you, Mama! Do you have a treat?)~\n
        ${historyString}\
        User: ${thisTurn.userMessage}\nMurphy: `;
        const cleanPrompt = prompt.replace(/[\t ]+/g, ' '); //Remove extra whitespace, tabs, etc. keeping newlines that are specically included in the prompt.

        console.log('prompt', cleanPrompt);
        appendMessage('user', thisTurn.userMessage);
        // Clear the input field and disable the send button
        userInput.value = '';
        sendBtn.disabled = true;

        // Get the chatbot's response and append it to the chat area
      
        const response = await getBotResponse(cleanPrompt);
        thisTurn.botResponse = response;
        appendMessage('bot', thisTurn.botResponse);


        if (firstInteraction) {
          currentConversationID = await startNewConversation(cleanPrompt);
          firstInteraction = false;
        }

        exchangeHistory.push(thisTurn);
        if (exchangeHistory.length > 5) {
          exchangeHistory.shift();
        }

        const timestamp = new Date();
        const logData = {
          prompt: thisTurn.userMessage,
          completion: thisTurn.botResponse,
          timestamp: timestamp
        };
        addDoc(collection(db, "murphy-conversations",currentConversationID, "chathistory"), logData)
        .then((docRef) => {
        console.log("Document written with conversation ID: ", currentConversationID);
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
        document.querySelectorAll(".chat-message").forEach((messageElement) => {
          if (messageElement.dataset.translated) {
            const textElement = messageElement.querySelector(".message");
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
    return "*looks around with a tilted head and sniffs the air* ~(Hmmm, what's that smell? Oh, sorry Mama, I got distracted!)~";
		//return 'Sorry, an error occurred. Please try again later.';
	  }
	}

