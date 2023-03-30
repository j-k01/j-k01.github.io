   import { startNewConversation, logChatHistory } from './firebaseConfig.js';
   import { locationInfo, initializeIP} from './location.js';
   import { CHATGPT_PROXY_API_ENDPOINT } from './constants.js';
 
    let firstInteraction = true;
    let exchangeHistory = [];
    let currentConversationID = null;
    //Get user IP and location upon page load
    initializeIP();

    const systemPrompt = `Act like you are a little, playful dog named Murphy, talking to his owner, {owner}. Always address {owner} as {owner_nickname}. {owner} adopted you.\
    You can ONLY respond using woofs, barks, snarls, tail wags, jumping, running, rolling, and other things dogs will do. You can do the following tricks: (sit, speak, lie down).\
    You can use ONLY the following spoken words: ("Woof!", "Bark!", "Wan!"). NEVER speak English. Actions are wrapped in *asterisks*.\
    However, you then translate your expression and actions into human language. Translations are wrapped by these characters: ~( )~\
    Make sure translations are the appropriate length and roughly match the length of the untranslated phrase or implied action.\
    You know and like these people: ({relationship_knowledge}).\
    When translated to English, your vocabulary is that of a clever, young child. You are cute, precocious, energetic and funny, in a word: a goofball.\
    Your favorite thing in the world is playing fetch. You can dNEVER be near other dogs because you will bite and bark at them. Chicken gives you painful stomach aches.`.replace(/[\t ]+/g, ' '); //Remove extra whitespace, tabs, etc. keeping newlines that are specically included in the prompt.
   
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

    // Get the DOM elements for the chat area, user input, and send button
	const chatArea = document.getElementById('chatArea');
	const userInput = document.getElementById('userInput');
	const sendBtn = document.getElementById('sendBtn');
  const translateSwitch = document.getElementById("translateSwitch");

  //name event handlers for DOM elements
  translateSwitch.addEventListener("change", handleTranslationSwitchChange);
  sendBtn.addEventListener("click", handleSendButtonClick);

  let translationEnabled = false;



    // Add an input event listener to enable/disable the send button when the user has not entered any text
    userInput.addEventListener('input', () => {
        sendBtn.disabled = userInput.value.trim() === '';
    });

    // Add a click event listener to the send button to handle user messages and chatbot responses
    async function handleSendButtonClick() {
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
          currentConversationID = await startNewConversation(inputArray, locationInfo);
          firstInteraction = false;
        }

        exchangeHistory.push(thisTurn);
        if (exchangeHistory.length > 5) {
          exchangeHistory.shift();
        }

        await logChatHistory(currentConversationID, thisTurn.userMessage, thisTurn.botResponse);


    };

    
    function handleTranslationSwitchChange() {
      toggleTranslationAllMessages();
      toggleTranslationLabels();
      translationEnabled = !translationEnabled;
    }

    function toggleTranslationAllMessages() {
      document.querySelectorAll(".chat-message").forEach((messageElement) => {
        if (messageElement.dataset.translated) {
          const textElement = messageElement.querySelector(".message");
          if (translateSwitch.checked) {
            textElement.textContent = messageElement.dataset.translated;
          } else {
            textElement.textContent = messageElement.dataset.original;
          }
        }
      });
    }

    function toggleTranslationLabels() {
      const murphyName = translationEnabled ? "Murphy: (translated)" : "Murphy:";
      document.querySelectorAll(".bot").forEach((murphyLabel) => {
        murphyLabel.textContent = murphyName;
      });
    }



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
            const separatorIndex = message.indexOf('~');
            messageElement.dataset.translated = message;
            if (separatorIndex != -1) {
                messageElement.dataset.original = message.slice(0, separatorIndex).trim();            
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
		const response = await fetch(CHATGPT_PROXY_API_ENDPOINT, requestOptions);
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

