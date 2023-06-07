/**
 * Module that contacts the Vercel hosted "Get IP" function to get the user's IP address, city, and region. Meant to run once on page load.
 * @module location
 */

let locationInfo = {
    ip: 'Unknown',
    city: 'Unknown',
    region: 'Unknown'
  };
  
/**
 * Fetches the user's IP and location information from a third-party API. Note the Vercel function is infact a proxy API.
 * @async
 * @function
 */
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

/**
 * Loads the locationInfo object with the user's IP and location information. 
 * @async
 * @function
 */
async function initializeIP() {
  const ipInfo = await getIpLocation();
  locationInfo.ip = ipInfo.locationInfo.ip || "Unknown";
  locationInfo.city = ipInfo.locationInfo.city || "Unknown";
  locationInfo.region = ipInfo.locationInfo.region || "Unknown";
}


export { locationInfo, initializeIP};