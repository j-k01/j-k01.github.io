        
    import db from './firebaseConfig.js';
    import { collection, addDoc } from "https://www.gstatic.com/firebasejs/9.6.9/firebase-firestore.js";


    let currentConversationID = null;
    let firstInteraction = true;
    let exchangeHistory = [];
    const databaseConversationKey = "murphy_chat_conversations"
    let locationInfo = {
      ip: 'Unknown',
      city: 'Unknown',
      region: 'Unknown'
    };

    initalizeIp(locationInfo);

    const systemPrompt = `Act like you are a little, playful dog named Murphy, talking to his owner, Fei. Always address Fei as Feinion or Mama. Fei adopted you.\
    You can ONLY respond using woofs, barks, snarls, tail wags, jumping, running, rolling, and other things dogs will do. You can do the following tricks: (sit, speak, lie down).\
    You can use ONLY the following spoken words: ("Woof!", "Bark!", "Wan!"). NEVER speak English. Actions are wrapped in *asterisks*.\
    However, you then translate your expression and actions into human language. Translations are wrapped by these characters: ~( )~\
    Make sure translations are the appropriate length and roughly match the length of the untranslated phrase or implied action.\
    When translated to English, your vocabulary is that of a clever, young child. You are cute, precocious, energetic and funny, in a word: a goofball.\
    Your favorite thing in the world is playing fetch. You can NEVER be near other dogs because you will bite and bark at them. Chicken gives you painful stomach aches.`.replace(/[\t ]+/g, ' '); //Remove extra whitespace, tabs, etc. keeping newlines that are specically included in the prompt.
    //const systemPrompt = `You are a little, playful dog named Murphy, talking to his owner, Fei, always addressed as Feinion or Mama. You can ONLY respond using woofs, barks, snarls, tail wags, jumping, running, rolling, and other things dogs will do. You can do the following tricks: (sit, speak, lie down). You can use ONLY the following spoken words: ("Woof!", "Bark!", "Wan!"). NEVER form sentences. NEVER speak English. Actions are wrapped in *asterisks*. However, you then translate your expression and actions into human language using parenthesis wrapped by tildes.`;  
    
    const sampleExchanges = [
      {
        userMessage: `Hello Murphy! Remember, you're a dog and NEVER SPEAK ENGLISH!`,
        botResponse: `*barks excitedly while chasing his tail* ~(Hello, Feinion! Let's play!)~`
      },
      {
        userMessage: `Let's go walk!`,
        botResponse: `Wan! *trots boisterously beside you* ~(I love walking! I'm so happy!)~`
      },
      {
        userMessage: `Speak!`,
        botResponse: `Woof! Woof! ~(I love you, Mama! Do you have a treat?)~`
      }
    ];
    exchangeHistory = sampleExchanges;

async function startNewConversation(initString) {
    const conversationRef = await addDoc(collection(db, databaseConversationKey), {
        startTime: new Date(),
        prompt: initString,
        ip: locationInfo.ip,
        location: `${locationInfo.city}, ${locationInfo.region}`
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

        let inputArray = exchangeHistory.map(exchange =>
          [{'role': 'user', 'content': exchange.userMessage},
           {'role': 'assistant', 'content': exchange.botResponse}]
        ).flat();
        
        inputArray.unshift({'role' : 'system', 'content' : `${systemPrompt}`});
        inputArray.push({'role' : 'user', 'content' : thisTurn.userMessage});


        appendMessage('user', thisTurn.userMessage);
        // Clear the input field and disable the send button
        userInput.value = '';
        sendBtn.disabled = true;

        // Get the chatbot's response and append it to the chat area
        const response = await getBotResponse(inputArray);
        thisTurn.botResponse = response;
        appendMessage('bot', thisTurn.botResponse);


        if (firstInteraction) {
          currentConversationID = await startNewConversation(inputArray);
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
        addDoc(collection(db, databaseConversationKey,currentConversationID, "chathistory"), logData)
        .then(() => {
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
      const endpoint = 'https://proxygpt-proj-57gxh9j3g-j-k01.vercel.app/api/chatbot';
   
	  const requestOptions = {
		method: 'POST',
		headers: {
		  'Content-Type': 'application/json',
		  'Authorization': `Bearer NULL`
		},
		body: JSON.stringify({
		  model: 'gpt-4',
		  //prompt: `User:${message}, Chatbot:`,
		  messages: message
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

  		
	async function getIpLocation() {
    const endpoint = 'https://proxygpt-proj-57gxh9j3g-j-k01.vercel.app/api/get-ip';
  
    const requestOptions = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer NULL`
    }
    };
    try {
    const response = await fetch(endpoint, requestOptions);
    if (!response.ok) {
      throw new Error(`Get IP API request failed with status ${response.status}`);
    }

    const data = await response.json();
        if (data.error) {
            return `GetIP ecncountered this errrorr: ${data.error.message}`;
        }
    return data
    } catch (error) {
    console.error('Error fetching Get IP response:', error);
    return {ip: "Unknown", city: "Unknown", region: "Unknown"};
    }
}

async function initalizeIp(info) {
  const ipInfo = await getIpLocation();
  info.ip = ipInfo.locationInfo.ip || "Unknown";
  info.city = ipInfo.locationInfo.city || "Unknown";
  info.region = ipInfo.locationInfo.region || "Unknown";
}


  		
async function getNames() {
  const endpoint = 'https://proxygpt-proj-57gxh9j3g-j-k01.vercel.app/api/get-names';

  const requestOptions = {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer NULL`
  }
  };
  try {
  const response = await fetch(endpoint, requestOptions);
  if (!response.ok) {
    throw new Error(`Get Names API request failed with status ${response.status}`);
  }

  const data = await response.json();
      if (data.error) {
          return `Get names ecncountered this errrorr: ${data.error.message}`;
      }
  return data
  } catch (error) {
  console.error('Error fetching Get IP response:', error);
  return "Fei";
  }
}


