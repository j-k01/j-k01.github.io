import { locationInfo, initializeIP} from './location.js';

// Scene, camera and renderer
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ alpha: true });
renderer.setClearColor(0x000000, 1);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// Add orbit controls
const controls = new THREE.OrbitControls(camera, renderer.domElement);
camera.position.z = 0;
camera.position.y = 550;
camera.position.x = 0;

//rotate the camera 90 degress counterclockwise
camera.rotateZ(Math.PI/2);
camera.lookAt(0,0,0);

const light = new THREE.AmbientLight(0x404040); // soft white light
scene.add(light);


class Star {
    constructor(id, ra, dec, xyz, az, alt, projXYZ, mag, bv) {
      this.ID = id;
      this.RA = ra; // Right Ascension
      this.DEC = dec; // Declination
      this.XYZ = xyz; // Cartesian coordinates
      this.MAG = mag; // Magnitude
      this.BV = bv; // B-V color index
      this.az = az; // Azimuth
      this.alt = alt; // Altitude
      this.projXYZ = projXYZ; 
      this.starObject = null;
      this.isVisible = true;
    }
  }

 //create a constanct dictonary of colors for eacb body, where keys are names and colors reflect apparent colors
    const bodyColors = {
        'Sun': 0xffff00,
        'Mars': 0xff0000,
        'Mercury': 0x808080,
        'Venus': 0xffffff,
        'Jupiter': 0x0000ff,
        'Saturn': 0xffff00,
        'Moon': 0x808080,
    }

    const bodySizes = {
        'Sun': 5,
        'Mercury': 2,
        'Venus': 2,
        'Mars': 2,
        'Jupiter': 2,
        'Saturn': 2,
        'Moon': 5,
    }

  class Body {
      constructor(name, ra, dec, xyz, az, alt, projXYZ) {
        this.name = name;
        this.ra = ra; // Right Ascension
        this.dec = dec; // Declination
        this.xyz = xyz; // Cartesian coordinates
        this.az = az; // Azimuth
        this.alt = alt; // Altitude
        this.projXYZ = projXYZ; 
        this.bodyObject = null;
        this.isVisible = true;
        this.size = bodySizes[name];
        this.createBodyObjFromName(name, true);
      }
      //create a function that will create a body object from a body
      createBodyObjFromName(name, useHorizon = true){
        let equ_2001 = Astronomy.Equator(name, globalDate, observer, false, false);
        this.ra = equ_2001.ra * 15;
        this.dec = equ_2001.dec;
        let geometry = new THREE.SphereGeometry(1, 32, 32);
        let material = new THREE.MeshPhongMaterial({
            color: 0xffffff,
            shininess: 100,
            specular: 0xffffff
        });
        modifyMaterialShader(material);
        material.emissive = new THREE.Color(bodyColors[name]);
        material.emissiveIntensity = 1.0;
        material.transparent = true;
        material.opacity = 1.0;
        let bodyObj = new THREE.Mesh(geometry, material);
        this.bodyObject = bodyObj;
        if (useHorizon == true) {
            let horizon = Astronomy.Horizon(globalDate, observer, this.ra/15, this.dec);
            this.az = horizon.azimuth + 90;
            this.alt = horizon.altitude;
            this.xyz = calcXYZ(this.az, this.alt);
        }
        else{
            this.xyz = calcXYZ(this.ra, this.dec);
        }
        this.bodyObject.position.set(this.xyz.x, this.xyz.y, this.xyz.z);
        this.bodyObject.scale.set(this.size, this.size, this.size);
    
        this.projXYZ = projectPoint(this.xyz, SPHERE_RADIUS);
        return this.bodyObject;
    }
      //a function that updates the az and alt of the body
        updateCoords(){   
            let equ_2001 = Astronomy.Equator(this.name, globalDate, observer, false, false);
            this.ra = equ_2001.ra * 15;
            this.dec = equ_2001.dec;
            let horizon = Astronomy.Horizon(globalDate, observer, this.ra/15, this.dec);
            this.az = horizon.azimuth + 90;
            this.alt = horizon.altitude;
        }
        updatePosition(useHorizon = true, project = true){
            this.updateCoords();
            if (useHorizon == true) {
                this.xyz = calcXYZ(this.az, this.alt);
                this.projXYZ = projectPoint(this.xyz, SPHERE_RADIUS);
            }
            else{
                this.xyz = calcXYZ(this.ra, this.dec);
                this.projXYZ = projectPoint(this.xyz, SPHERE_RADIUS);
            }
            if (project == true) {
                this.bodyObject.position.set(this.projXYZ.x, this.projXYZ.y, this.projXYZ.z);
            }
            else{
                this.bodyObject.position.set(this.xyz.x, this.xyz.y, this.xyz.z);
            }
            this.isVisible = true;
            if (this.xyz.y < 0) {
                this.isVisible = true;
            }
            if (this.isVisible == true) {
                this.bodyObject.material.opacity = 1.0;
            }
            else{
                this.bodyObject.material.opacity = 0.0;
            }
        }
    }
  
  class Constellation {
    constructor(name) {
      this.name = name;
      this.stars = []; // Will hold Star objects
      this.starIds = []; // Will hold star IDs
      this.starLines = []; // Will hold line data
      this.starLineObjs = []; // Will hold line objects
    }
  
    addStar(star) {
        this.stars.push(star);
      }

    addStarId(starId) {
        this.starIds.push(starId);
      }
  
    getStar(id) {
      return this.stars.find(star => star.id === id);
    }
  }

//constants
const STAR_CATALOGUE = 'starcatalogue.json';
const MAX_MAGNITUDE = 6.6;
const SPHERE_RADIUS = 100;
//globals

const loader = new THREE.FontLoader();
var loadedFont;
var autoRotate = true;
var globalDate = new Date();
let observer = new Astronomy.Observer(39.7, -104.9, 1609); //Denver
//let observer = new Astronomy.Observer(90, 130, 0); //NP
let starMap = new Map();
let starCultureMap = new Map();
let starGroup = new THREE.Group();
//untility functions

//create a flat disk that changes color with time and represents the sky background
function createSkyDisk(){
    let geometry = new THREE.CircleGeometry(SPHERE_RADIUS*2, 100);
    let material = new THREE.MeshBasicMaterial({
        color: 0x75bffe,
        side: THREE.DoubleSide
    });
    let disk = new THREE.Mesh(geometry, material);
    disk.rotation.x = Math.PI / 2;
    disk.position.set(0, 0, 0);
    return disk;
}
let skyDisk = createSkyDisk();
skyDisk.position.set(0,99,0);
scene.add(skyDisk);

function mapValue(value, inputMin, inputMax, outputMin, outputMax) {
    return outputMin + (outputMax - outputMin) * ((value - inputMin) / (inputMax - inputMin));
}

//75bffe
const tableString = `
O5(V)   155 176 255  #9bb0ff       -0.32 blue
O6(V)   162 184 255  #a2b8ff
O7(V)   157 177 255  #9db1ff
O8(V)   157 177 255  #9db1ff
O9(V)   154 178 255  #9ab2ff
O9.5(V)   164 186 255  #a4baff
B0(V)   156 178 255  #9cb2ff
B0.5(V)   167 188 255  #a7bcff
B1(V)   160 182 255  #a0b6ff
B2(V)   160 180 255  #a0b4ff
B3(V)   165 185 255  #a5b9ff
B4(V)   164 184 255  #a4b8ff
B5(V)   170 191 255  #aabfff
B6(V)   172 189 255  #acbdff
B7(V)   173 191 255  #adbfff
B8(V)   177 195 255  #b1c3ff
B9(V)   181 198 255  #b5c6ff
A0(V)   185 201 255  #b9c9ff       0.00 White
A1(V)   181 199 255  #b5c7ff
A2(V)   187 203 255  #bbcbff
A3(V)   191 207 255  #bfcfff
A5(V)   202 215 255  #cad7ff
A6(V)   199 212 255  #c7d4ff
A7(V)   200 213 255  #c8d5ff
A8(V)   213 222 255  #d5deff
A9(V)   219 224 255  #dbe0ff
F0(V)   224 229 255  #e0e5ff       0.31 yellowish
F2(V)   236 239 255  #ecefff
F4(V)   224 226 255  #e0e2ff
F5(V)   248 247 255  #f8f7ff
F6(V)   244 241 255  #f4f1ff
F7(V)   246 243 255  #f6f3ff       0.50
F8(V)   255 247 252  #fff7fc
F9(V)   255 247 252  #fff7fc
G0(V)   255 248 252  #fff8fc       0.59  Yellow
G1(V)   255 247 248  #fff7f8
G2(V)   255 245 242  #fff5f2
G4(V)   255 241 229  #fff1e5
G5(V)   255 244 234  #fff4ea
G6(V)   255 244 235  #fff4eb
G7(V)   255 244 235  #fff4eb
G8(V)   255 237 222  #ffedde
G9(V)   255 239 221  #ffefdd
K0(V)   255 238 221  #ffeedd       0.82 Orange
K1(V)   255 224 188  #ffe0bc
K2(V)   255 227 196  #ffe3c4
K3(V)   255 222 195  #ffdec3
K4(V)   255 216 181  #ffd8b5
K5(V)   255 210 161  #ffd2a1
K7(V)   255 199 142  #ffc78e
K8(V)   255 209 174  #ffd1ae
M0(V)   255 195 139  #ffc38b       1.41 red
M1(V)   255 204 142  #ffcc8e
M2(V)   255 196 131  #ffc483
M3(V)   255 206 129  #ffce81
M4(V)   255 201 127  #ffc97f
M5(V)   255 204 111  #ffcc6f
M6(V)   255 195 112  #ffc370
M8(V)   255 198 109  #ffc66d       2.00
`;



const skyTable = `
-12     #000000
-6      #4f1b74
-3       #9b6fa7
0       #ffa7a7
3      #ffbe9c 
7       #75bffe //light blue 
90      #8ae5ff //dark blue
168     #75bffe //light blue
169     #ffe769 //yellow
180     #ffa7a7 //peach
186     #9b6fa7 //purple
192     #4f1b74
198     #000000 
`;

const transparencyTable = `
-12     1.0
0       0.0
`;



//convert hex to rgp
function hexToRgb(hex) {
    const r = parseInt(hex.substring(1, 3), 16);
    const g = parseInt(hex.substring(3, 5), 16);
    const b = parseInt(hex.substring(5, 7), 16);
    return { r, g, b };
}
    
function parseSkyTable(tableString) {
    const lines = tableString.trim().split('\n');
    const colorTable = lines.map(line => {
        const parts = line.trim().split(/\s+/);
        return {
            alt: parseFloat(parts[0]),
            color: hexToRgb(parts[1])
        };
    });
    return colorTable;
}

function interpolateSkyColor(alt, colorTable) {
    colorTable.sort((a, b) => a.alt - b.alt);
    if(alt < colorTable[0].alt){
        alt = colorTable[0].alt;}
    else if(alt > colorTable[colorTable.length-1].alt){
        alt = colorTable[colorTable.length-1].alt;
    }
    // Find the two closest B-V values
    let low = colorTable[0], high = colorTable[1];
    for (let i = 1; i < colorTable.length - 1; i++) {
        if (colorTable[i].alt <= alt && colorTable[i + 1].alt >= alt) {
            low = colorTable[i];
            high = colorTable[i + 1];
            break;
        }
    }

    const interpolate = (lowColor, highColor) => {
        return Math.round(lowColor + (alt - low.alt) * ((highColor - lowColor) / (high.alt - low.alt)));
    }
    const r = interpolate(low.color.r, high.color.r);
    const g = interpolate(low.color.g, high.color.g);
    const b = interpolate(low.color.b, high.color.b);

    // Convert r, g, b to hex and return
    const toHex = (c) => {
        const hex = c.toString(16);
        return hex.length == 1 ? "0" + hex : hex;
    }
    return "#" + toHex(r) + toHex(g) + toHex(b);
}

//for transparency

  
function parseTransTable(tableString) {
    const lines = tableString.trim().split('\n');
    const table = lines.map(line => {
        const parts = line.trim().split(/\s+/);
        return {
            alt: parseFloat(parts[0]),
            value: parseFloat(parts[1])
        };
    });
    return table;
} 

function interpolateTransTable(alt, table) {
    table.sort((a, b) => a.alt - b.alt);
    if(alt < table[0].alt){
        alt = table[0].alt;}
    else if(alt > table[table.length-1].alt){
        alt = table[table.length-1].alt;
    }
    // Find the two closest B-V values
    let low = table[0], high = table[1];
    for (let i = 1; i < table.length - 1; i++) {
        if (table[i].alt <= alt && table[i + 1].alt >= alt) {
            low = table[i];
            high = table[i + 1];
            break;
        }
    }

    //console.log(low, high);
    const interpolate = (tableLow, tableHigh) => {
        return tableLow + (alt - low.alt) * ((tableHigh - tableLow) / (high.alt - low.alt));
    }
    const t = interpolate(low.value, high.value);
    return t;
}




function parseTable(tableString) {
    const lines = tableString.trim().split('\n');
    const colorTable = lines.map(line => {
        const matches = line.match(/(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(#\w+)(\s+(-?[\d\.]+))?/);
        return {
            type: matches[1],
            r: parseInt(matches[2]),
            g: parseInt(matches[3]),
            b: parseInt(matches[4]),
            rrggbb: matches[5],
            BV: matches[6] ? parseFloat(matches[7]) : null
        };
    });
    return colorTable;
}

const colorTable = parseTable(tableString);
const skyColorTable = parseSkyTable(skyTable);
console.log(interpolateSkyColor(-10, skyColorTable));


const transTable = parseTransTable(transparencyTable);
console.log('transparency', interpolateTransTable(-10, transTable));



function interpolateColor(BV, colorTable) {
    // Filter out rows without a B-V value
    const filteredTable = colorTable.filter(row => row.BV !== null);
    // Sort the table by B-V value
    filteredTable.sort((a, b) => a.BV - b.BV);
    if(BV < filteredTable[0].BV){
        BV = filteredTable[0].BV;}
    else if(BV > filteredTable[filteredTable.length-1].BV){
        BV = filteredTable[filteredTable.length-1].BV;
    }


    // Find the two closest B-V values
    let low = filteredTable[0], high = filteredTable[1];
    for (let i = 1; i < filteredTable.length - 1; i++) {
        if (filteredTable[i].BV <= BV && filteredTable[i + 1].BV >= BV) {
            low = filteredTable[i];
            high = filteredTable[i + 1];
            break;
        }
    }

    // Interpolate r, g, b values
    const interpolate = (lowColor, highColor) => {
        return Math.round(lowColor + (BV - low.BV) * ((highColor - lowColor) / (high.BV - low.BV)));
    }
    const r = interpolate(low.r, high.r);
    const g = interpolate(low.g, high.g);
    const b = interpolate(low.b, high.b);

    // Convert r, g, b to hex and return
    const toHex = (c) => {
        const hex = c.toString(16);
        return hex.length == 1 ? "0" + hex : hex;
    }
    return "#" + toHex(r) + toHex(g) + toHex(b);
}


function projectPoint(point, sphereRadius, planeY = 100){
    let projPoint = new THREE.Vector3();
    projPoint.x = (planeY + sphereRadius)*(point.x/(point.y+sphereRadius));
    projPoint.z = (planeY + sphereRadius)*(point.z/(point.y+sphereRadius));
    projPoint.y = planeY;
    return projPoint
}

function calcXYZ(RA, DEC) {
    let positionMatrix = new THREE.Matrix4();
    let rotationMatrix = new THREE.Matrix4();
    positionMatrix.setPosition(SPHERE_RADIUS,0,0);
    
    rotationMatrix.makeRotationZ(DEC * (Math.PI / 180));
    positionMatrix.multiplyMatrices(rotationMatrix,positionMatrix);
    rotationMatrix.makeRotationY(RA * (Math.PI / 180));
    positionMatrix.multiplyMatrices(rotationMatrix,positionMatrix)

    return new THREE.Vector3().setFromMatrixPosition(positionMatrix);
}

function createStarObj(){
    let geometry = new THREE.SphereGeometry(1, 5, 5);
    let material = new THREE.MeshPhongMaterial({
		color: 0x000000,
		shininess: 100,
		specular: 0xffffff
	});
    material.emissive.setHex(0xffffff);
	material.emissiveIntensity = 1.0;
    let star = new THREE.Mesh(geometry, material);
    return star;
}

function createStarObjFromStar(star, useHorizon = true){
    let geometry = new THREE.SphereGeometry(1, 5, 5);
    let material = new THREE.MeshPhongMaterial({
        color: 0x000000,
        shininess: 100,
        specular: 0xffffff
    });
    material.emissive = new THREE.Color(interpolateColor(star.BV, colorTable));
    material.emissiveIntensity = 1.0;
    material.transparent = true;
    material.opacity = 0.0;
    let starObj = new THREE.Mesh(geometry, material);
    star.starObject = starObj;
    if (useHorizon == true) {
        let horizon = Astronomy.Horizon(globalDate, observer, star.RA/15, star.DEC);
        star.AZ = horizon.azimuth + 90;
        star.ALT = horizon.altitude;
        star.XYZ = calcXYZ(star.AZ, star.ALT);
    }
    else{
        star.XYZ = calcXYZ(star.RA, star.DEC);
    }
    starObj.position.set(star.XYZ.x, star.XYZ.y, star.XYZ.z);
    let size = mapValue(star.MAG, -0, 6.6, 1.0, 0.2);
    starObj.scale.set(size, size, size);

    star.projXYZ = projectPoint(star.XYZ, SPHERE_RADIUS);
    return starObj;
}

//main functions
async function loadStarData() {
    let response = await fetch(STAR_CATALOGUE);
    let starData = await response.json();
    starData = starData.filter(entry => entry.MAG < MAX_MAGNITUDE);
    starData.forEach((entry, index) => {
        let thisStar = new Star();
        thisStar.ID = entry.ID;
        thisStar.RA = entry.RA;
        thisStar.DEC = entry.DEC;
        thisStar.MAG = entry.MAG;
        thisStar.BV = entry.BV;
        thisStar.XYZ = calcXYZ(entry.RA, entry.DEC);
        starMap.set(entry.ID, thisStar);
    });
}

async function loadStarCulture() {    
	let response = await fetch('starCulture.json');
    let starCulture = await response.json();
	
	response = await fetch('starCultureNames.json');
    let starCultureNames = await response.json();

    starCultureNames.STELLA.map(key => {
        let constellation = new Constellation(key);
        let starArray = [...new Set(starCulture[key].flat())];
        for(var i = 0; i < starArray.length; i++) {
            constellation.addStarId(starArray[i]);
        }
        constellation.starLines = starCulture[key];
        starCultureMap.set(key, constellation);
    });
}

function crossStarsAndConstellations(starMap, starCultureMap) {
    starCultureMap.forEach((constellation, key) => {
        constellation.starIds.forEach((starId, index) => {
            constellation.addStar(starMap.get(starId));
        });
    });
}

function generateTime(date, font){
	
	const color = 0xFF6699;

	const matDark = new THREE.LineBasicMaterial( {
	color: color,
	side: THREE.DoubleSide
	} );

	const matLite = new THREE.MeshBasicMaterial( {
	color: 0xffa500,
	transparent: true,
	opacity: 1.0,
	side: THREE.DoubleSide
	} );

    //get the time in 24 hour fromat from date object
    //check if type is not a string
    let letterforms;
    if (typeof date !== 'string') {
        const time = date.toLocaleTimeString('en-US', { hour12: false, hour: 'numeric', minute: 'numeric' });
    	letterforms = font.generateShapes(time.toString(), 24);
    }
    else{
    	letterforms = font.generateShapes(date, 24);    
    }
	const textGeometry = new THREE.ShapeGeometry( letterforms );

	textGeometry.computeBoundingBox();

	const xMid = - 0.5 * ( textGeometry.boundingBox.max.x - textGeometry.boundingBox.min.x );
	const yMid = - 0.5 * ( textGeometry.boundingBox.max.y - textGeometry.boundingBox.min.y );
	const zMid = - 0.5 * ( textGeometry.boundingBox.max.z - textGeometry.boundingBox.min.z );

	textGeometry.translate( xMid, yMid, zMid );
    textGeometry.rotateX(3* (Math.PI/2));

	let yearText = new THREE.Mesh( textGeometry, matLite );
	
	let textPosition = new THREE.Vector3(0, 100, 230);
	yearText.position.set(textPosition.x, textPosition.y, textPosition.z);

	return yearText;
}

//mkae this function return a promise
async function loadFont(){
    return new Promise((resolve, reject) => {
        loader.load('./azimuthal_projection_files/helvetiker_regular.typeface.json', function ( font ) {
            loadedFont = font;
            resolve(font);
        });
    });
}

let locationText;
async function init() {
    await loadStarData();
    await loadStarCulture();
    await loadFont();    
    await initializeIP();
    crossStarsAndConstellations(starMap, starCultureMap);

    locationText = generateTime(locationInfo.city, loadedFont);
    locationText.position.set(0, 100, -230);
    scene.add(locationText);
    //create a ring, visible from all angles, with radius 200 centered on (0,0,100)
    let ringGeometry = new THREE.TorusGeometry(200, 1, 5, 100); 
    let ringMaterial = new THREE.MeshBasicMaterial( { color: 0xb9c9ff, side: THREE.DoubleSide } );
    // /ffc66d
    //0xb9c9ff
    let ring = new THREE.Mesh( ringGeometry, ringMaterial );
    ring.position.set(0,100,0);
    ring.rotation.x = Math.PI / 2;
    scene.add( ring );
    
    scene.add(starGroup);

    //create a set or list of all starIds in starCultureMap, then only add stars with those ids to the scece, or stars with magnitude less than 4.0
    let starCultureIds = new Set();
    for (let [key, value] of starCultureMap.entries()) {
        value.starIds.forEach((starId, index) => {
            starCultureIds.add(starId);
        });
    };



    //for all stars in starMap, if the star is magnitude less than 4.0 OR is in the starCultureMap, add it to the scene
    for (let [key, value] of starMap.entries()) {
        if(value.MAG < 5.5 || starCultureIds.has(value.ID)){
            value.starObject = createStarObjFromStar(value);
            starGroup.add(value.starObject);           
        }
    }

    // for (let [key, value] of starCultureMap.entries()) {
    //     value.stars.forEach((star, index) => {
    //         star.starObject = createStarObjFromStar(star);
    //         starGroup.add(star.starObject);           
    //     });
    // };
};

//updates star position by calcuating new AZ and ALT, and if it's below the horizon, 
//makes the star transparent, if it is above the horizon, calucates XYZ, then projects it onto the sphere
//then updates position of star object
function updateStars() {
    for (let [key, value] of starMap.entries()) {
        if (value.starObject != null) {
                let star = value;
                let horizon = Astronomy.Horizon(globalDate, observer, star.RA/15, star.DEC, 'normal');
                star.AZ = horizon.azimuth + 90;
                star.ALT = horizon.altitude;
                star.XYZ = calcXYZ(star.AZ, star.ALT);
                star.projXYZ = projectPoint(star.XYZ, SPHERE_RADIUS);
                star.starObject.position.set(star.projXYZ.x, star.projXYZ.y, star.projXYZ.z);
                
            if (star.ALT < 0) {
                    star.starObject.material.opacity = 0.0;
                    star.isVisible = false;
            } else {
                
    //                star.starObject.position.set(star.projXYZ.x, star.XYZ.y, star.projXYZ.z); This is cool
                    star.isVisible = true;
                    star.starObject.material.opacity = mapValue(star.MAG, -0, 6.6, 1.0, 0.2);
                    //console.log(interpolateTransTable(sun.alt, transTable));
                    star.starObject.material.opacity = star.starObject.material.opacity * interpolateTransTable(sun.alt, transTable);
            }
        }
    }
}

function findIntersection(x1, y1, x2, y2, h, k, r) {
    let dx = x2 - x1;
    let dy = y2 - y1;

    let a = dx*dx + dy*dy;
    let b = 2*(dx*(x1 - h) + dy*(y1 - k));
    let c = h*h + k*k + x1*x1 + y1*y1 - 2*(h*x1 + k*y1) - r*r;

    // solve for t using the quadratic formula: (-b ± sqrt(b^2 - 4ac)) / 2a
    let t1 = (-b + Math.sqrt(b*b - 4*a*c)) / (2*a);
    let t2 = (-b - Math.sqrt(b*b - 4*a*c)) / (2*a);

    // find the valid t (0 <= t <= 1)
    let t = (0 <= t1 && t1 <= 1) ? t1 : t2;

    // find the intersection point using P(t)
    let x = x1 + t*dx;
    let y = y1 + t*dy;

    return {x: x, y: y};
}


//updates constellations by modifying the verticies of each line object to match the projected XYZ of the stars
//stars are stored in userdata of each line object
function updateConstellations() {
    for (let [key, value] of starCultureMap.entries()) {
        value.starLineObjs.forEach((line, index) => {           
            const star1 = starMap.get(line.userData[0]);
            const star2 = starMap.get(line.userData[1]);
            if (star1.isVisible && star2.isVisible) {
                line.material.opacity = 1.0 * (1.0 - interpolateTransTable(sun.alt, transTable));
                line.material.color = new THREE.Color(0xffffff);
                if (line.material.opacity < 0.5){
                    line.material.opacity = 0.5;
                    line.material.color = new THREE.Color(0x9bb0ff);
                }
                //9bb0ff
                //use direct buffer manipulation of the buffergeometry to update the line
                //creating new geometry and diposing of the old one is inefficient
                //and failing to dispose of the old one causes signficant memory leaks.
                let positions = line.geometry.attributes.position.array;
                positions[0] = star1.projXYZ.x;
                positions[1] = star1.projXYZ.y;
                positions[2] = star1.projXYZ.z;
                positions[3] = star2.projXYZ.x;
                positions[4] = star2.projXYZ.y;
                positions[5] = star2.projXYZ.z;
                line.geometry.attributes.position.needsUpdate = true;
            }
            else if (star1.isVisible && !star2.isVisible) {
                line.material.opacity = 0.5;
                let tempPoint =calcCircleIntersection3d(star2.projXYZ, star1.projXYZ, SPHERE_RADIUS);
                let positions = line.geometry.attributes.position.array;
                positions[0] = star1.projXYZ.x;
                positions[1] = star1.projXYZ.y;
                positions[2] = star1.projXYZ.z;
                positions[3] = tempPoint.x;
                positions[4] = tempPoint.y;
                positions[5] = tempPoint.z;
                line.geometry.attributes.position.needsUpdate = true;
            }
            else if (!star1.isVisible && star2.isVisible) {
                line.material.opacity = 0.5;
                let tempPoint =calcCircleIntersection3d(star1.projXYZ, star2.projXYZ, SPHERE_RADIUS);
                let positions = line.geometry.attributes.position.array;
                positions[0] = tempPoint.x;
                positions[1] = tempPoint.y;
                positions[2] = tempPoint.z;
                positions[3] = star2.projXYZ.x;
                positions[4] = star2.projXYZ.y;
                positions[5] = star2.projXYZ.z;
                line.geometry.attributes.position.needsUpdate = true;
            }
            else {

                line.material.opacity = 0.0;
            }

        });
    }
}

// let shaderMaterial = new THREE.ShaderMaterial({
//     vertexShader: `
//     varying vec4 vWorldPosition;
//     varying vec4 vWorldCameraPosition;

//         void main() {
//             vWorldPosition = modelMatrix * vec4(position, 1.0);
//             vWorldCameraPosition = modelViewMatrix * vec4(position, 1.0);
//             gl_Position = projectionMatrix * vWorldCameraPosition ;
//         }
//     `,
//     fragmentShader: `
//     varying vec4 vWorldPosition;

//     void main() {
//         if (sqrt(vWorldPosition.x * vWorldPosition.x + vWorldPosition.z * vWorldPosition.z) > 200.0) discard;
//         gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0); // Sets color to white. Change this to your liking.
//     }
//     `
// });
 
//I really just want to discard the pixel if its out of bounds without changing anything else about the material.
//We take the custom shader material above and hack it into the existing material. 

function modifyMaterialShader(material) {
    material.onBeforeCompile = function (shader) {
        shader.vertexShader = 'varying vec4 vWorldPosition;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace(
            'void main() {',
            [
                'void main() {',
                'vWorldPosition = modelMatrix * vec4(position, 1.0);'
            ].join('\n')
        );

        shader.fragmentShader = 'varying vec4 vWorldPosition;\n' + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace(
            'void main() {',
            [
                'void main() {',
                'if (sqrt(vWorldPosition.x * vWorldPosition.x + vWorldPosition.z * vWorldPosition.z) > 199.0) discard;'
            ].join('\n')
        );
    };
}


let projSunShadow;
function misc(){    
    //create a buffer geometry using line loop and is positioned on an imagainry sphere at 23 degrees declination.
    const sunShadowMaterial = new THREE.LineDashedMaterial({ color: 0xffa500, dashSize: 1 });
    modifyMaterialShader(sunShadowMaterial);

    // Create a geometry for the circle
    const sunShadowGeometry = new THREE.CircleGeometry(100, 100);
    sunShadowGeometry.vertices.shift();

    //const sunShadowBufferGeometry = new THREE.BufferGeometry().fromGeometry(sunShadowGeometry);

    // Create a mesh for the circle
    const sunShadow = new THREE.LineLoop(sunShadowGeometry, sunShadowMaterial);
    // sunShadow.computeLineDistances();
    
    sunShadow.rotation.x = 90 * (Math.PI/180)    // sunShadow.updateMatrix();  // updates the matrix of the object
    
    
    sunShadow.updateMatrix();  // updates the matrix of the object
    sunShadow.geometry.applyMatrix4(sunShadow.matrix);  // applies the matrix to the vertices

    // // // Reset the transformation of the mesh
    sunShadow.position.set(0, 0, 0);
    sunShadow.rotation.set(0, 0, 0);
    sunShadow.scale.set(1, 1, 1);
    sunShadow.updateMatrix();

    // debugging star
    // let specialStar = new Star(101010, 0, 0);
    // specialStar.MAG = -2.0;
    // createStarObjFromStar(specialStar, false);
    // scene.add(specialStar.starObject);
   
    //scene.add(sunShadow);
    projSunShadow = new ProjectedObject(sunShadow);
}

//create a class that can hold miscellanious information about an object
//the class holds the original object, and the projected object
//the projected object is updated when the original object is updated
class ProjectedObject {
    constructor(object) {
        this.object = object;
        this.projObject = null;
        this.initProjObject();
        scene.add(this.projObject);
    }
    initProjObject() {
        //create a new object that converts the gemetry of the origina
        
        this.object.updateMatrix();  // updates the matrix of the object
        //this.object.geometry.applyMatrix4(this.object.matrix); 
        let points = this.object.geometry.vertices.map((vertex) => {
            let projXYZ = projectPoint(vertex.clone().applyMatrix4(this.object.matrix), SPHERE_RADIUS);

            if (isNaN(projXYZ.x) || isNaN(projXYZ.y) || isNaN(projXYZ.z)) {
                projXYZ.x = 0;
                projXYZ.y = 0;
                projXYZ.z = 0;
            }
            return new THREE.Vector3(projXYZ.x, projXYZ.y, projXYZ.z);
        });
        this.projObject = new THREE.LineLoop(
            //create the gemoetry from the original object by iterating through the verticies and projecting them
            //check if vertex is nan or infity  and if so, set it to 0
            new THREE.BufferGeometry().setFromPoints(points),
            this.object.material
        );  
    }
    //update all the verticies of the projected object
    updateProjObject() {
        //this.object.geometry.applyMatrix4(this.object.matrix); 
        this.object.updateMatrix();  // updates the matrix of the object
        //this.object.geometry.applyMatrix4(this.object.matrix); 
        
        let rotationMatrix = Astronomy.Rotation_EQJ_HOR(globalDate, observer);
        let matrix4 = new THREE.Matrix4();
        let matrixArray = 
    [
        rotationMatrix.rot[0][0], rotationMatrix.rot[0][1], rotationMatrix.rot[0][2], 0,
        rotationMatrix.rot[1][0], rotationMatrix.rot[1][1], rotationMatrix.rot[1][2], 0,
        rotationMatrix.rot[2][0], rotationMatrix.rot[2][1], rotationMatrix.rot[2][2], 0,
        0, 0, 0, 1
    ];
    matrix4.fromArray(matrixArray);

        let points = this.object.geometry.vertices.map((vertex) => {
            let realVert = vertex.clone().applyMatrix4(this.object.matrix);
            let projXYZ = projectPoint(realVert, SPHERE_RADIUS);
            if (isNaN(projXYZ.x) || isNaN(projXYZ.y) || isNaN(projXYZ.z)) {
                projXYZ.x = 0;
                projXYZ.y = 0;
                projXYZ.z = 0;
            }
            return new THREE.Vector3(projXYZ.x, projXYZ.y, projXYZ.z);
        });

        this.object.geometry.vertices.forEach((vertex, index) => {
            let realVert = vertex.clone().applyMatrix4(this.object.matrix).applyMatrix4(matrix4);
            if (realVert.y > 0) {
                let projXYZ = projectPoint(realVert, SPHERE_RADIUS);
                let positionAttribute = this.projObject.geometry.attributes.position;
                positionAttribute.setXYZ(index, projXYZ.x, projXYZ.y, projXYZ.z);
        
                this.projObject.geometry.attributes.position[index] = projXYZ.x;
                this.projObject.geometry.attributes.position[index+1] = projXYZ.y;
                this.projObject.geometry.attributes.position[index+2] = projXYZ.z;
            }
        }
        );
        this.projObject.geometry.dispose();
        this.projObject.geometry.setFromPoints(points);
        this.projObject.geometry.attributes.position.needsUpdate = true;
    }
}

        

let projShadow;

let lineGroup = new THREE.Group();
scene.add(lineGroup);
/* iterates thorough line segments of a constellation and creates a line object for each one, 
then pairs it with the original line information so that the verticies can be updated later */
function createConstellationLines() {
    for (let [key, value] of starCultureMap.entries()) {
        value.starLines.forEach((line, index) => {
            let lineObj = new THREE.Line(
                new THREE.BufferGeometry().setFromPoints([
                    starMap.get(line[0]).XYZ,
                    starMap.get(line[1]).XYZ
                ]),
                new THREE.LineBasicMaterial({
                    color: 0xffffff,
                    linewidth: 1.0,
                    transparent: true,
                    opacity: 1.0
                })
            );
        //pair the line object with the original line information
        lineObj.userData = line;
        value.starLineObjs.push(lineObj);
        lineGroup.add(lineObj);
        });
    };

}
let shaderMaterial = new THREE.ShaderMaterial({
    vertexShader: `
    varying vec4 vWorldPosition;
    varying vec4 vWorldCameraPosition;

        void main() {
            vWorldPosition = modelMatrix * vec4(position, 1.0);
            vWorldCameraPosition = modelViewMatrix * vec4(position, 1.0);
            gl_Position = projectionMatrix * vWorldCameraPosition ;
        }
    `,
    fragmentShader: `
    varying vec4 vWorldPosition;

    void main() {
        if (sqrt(vWorldPosition.x * vWorldPosition.x + vWorldPosition.z * vWorldPosition.z) > 200.0) discard;
        gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0); // Sets color to white. Change this to your liking.
    }
    `
});

//planets. Group these into one creation function
let sun = new Body('Sun');
scene.add(sun.bodyObject);
let moon = new Body('Moon');
scene.add(moon.bodyObject);
let venus = new Body('Venus');
venus.bodyObject.material = shaderMaterial;
scene.add(venus.bodyObject);
let mars = new Body('Mars');
scene.add(mars.bodyObject);
let mercury = new Body('Mercury');
scene.add(mercury.bodyObject);
let jupiter = new Body('Jupiter');
scene.add(jupiter.bodyObject);


let textObject;
init().then(() => {
    //init();
    
    misc();
    createConstellationLines();
    console.log(loadedFont);
    textObject = generateTime(globalDate, loadedFont);
    scene.add(textObject);
    console.log(textObject);
    console.log(locationInfo);
    render();
});


// debug hack
// //drawCoords. Draws a red line from (0,0,0) to (100,0,0). a blue line from (0,0,0) to (0,100,0), and a green line from (0,0,0) to (0,0,100)
// function drawCoords() {
//     let xCoord = new THREE.Geometry();
//     xCoord.vertices.push(
//         new THREE.Vector3(0, 0, 0),
//         new THREE.Vector3(100, 0, 0)
//     );        
//     let xCoordLine = new THREE.Line(
//         xCoord,
//         new THREE.LineBasicMaterial({
//             color: 0xff0000,
//             linewidth: 1.0,
//             transparent: true,
//             opacity: 1.0
//         })
//     );
//     scene.add(xCoordLine);

//     let yCoord = new THREE.Geometry();
//     yCoord.vertices.push(
//         new THREE.Vector3(0, 0, 0),
//         new THREE.Vector3(0, 100, 0)
//     );        
//     let yCoordLine = new THREE.Line(
//         yCoord,
//         new THREE.LineBasicMaterial({
//             color: 0x00ff00,
//             linewidth: 1.0,
//             transparent: true,
//             opacity: 1.0
//         })
//     );
//     scene.add(yCoordLine);

//     let zCoord = new THREE.Geometry();
//     zCoord.vertices.push(
//         new THREE.Vector3(0, 0, 0),
//         new THREE.Vector3(0, 0, 100)
//     );        
//     let zCoordLine = new THREE.Line(
//         zCoord,
//         new THREE.LineBasicMaterial({
//             color: 0x0000ff,
//             linewidth: 1.0,
//             transparent: true,
//             opacity: 1.0
//         })
//     );
//     scene.add(zCoordLine);
// }


//calculate the intersection of a line and a circle
function calcCircleIntersection(m, b, r){
    //x^2 + y^2 = r^2
    //y = mx + b
    //x^2 + (mx + b)^2 = r^2
    //x^2 + m^2x^2 + 2mbx + b^2 = r^2
    //(1 + m^2)x^2 + 2mbx + b^2 - r^2 = 0
    //quadratic formula
    //-b +- sqrt(b^2 - 4ac) / 2a
    let a = 1 + m*m;
    let b2 = 2*m*b;
    let c = b*b - r*r;
    let x1 = (-b2 + Math.sqrt(b2*b2 - 4*a*c)) / (2*a);
    let x2 = (-b2 - Math.sqrt(b2*b2 - 4*a*c)) / (2*a);
    let y1 = m*x1 + b;
    let y2 = m*x2 + b;
    return [{x: x1, y: y1}, {x: x2, y: y2}];
}

//take two vectors and a point and return the vector with the smallest distance
function closestVector(v1, v2, p){
    let d1 = Math.sqrt(Math.pow(v1.x - p.x, 2) + Math.pow(v1.y - p.y, 2));
    let d2 = Math.sqrt(Math.pow(v2.x - p.x, 2) + Math.pow(v2.y - p.y, 2));
    if(d1 < d2){
        return v1;
    }
    else{
        return v2;
    }
}

//combine the three functions above, take two 3d vectors but use the x and z values as x and y values, retrun a vector3
function calcCircleIntersection3d(v1, v2, r){
    let m = (v2.z - v1.z) / (v2.x - v1.x);
    let b = v1.z - (m * v1.x);
    let intersections = calcCircleIntersection(m, b, 2*r);
    let closest = closestVector(intersections[0], intersections[1], {x: v1.x, y: v1.z});
    return new THREE.Vector3(closest.x, 100, closest.y);
}

        

let counter = 0;
window.addEventListener('keydown', function(event) {
    // check if the key pressed was the 'd' key
    if (event.key === 'd') {
        // add one day to the date
        //globalDate.setDate(globalDate.getDate() + 1);
        globalDate.setMinutes(globalDate.getMinutes() + 1);
    }
    else if (event.key === 'a') {
        //globalDate.setDate(globalDate.getDate() - 1);
        globalDate.setMinutes(globalDate.getMinutes() - 1);
    }
    else if (event.key === ' ') {
        autoRotate = !autoRotate;
    }
    else if (event.key === 'r') {
        globalDate = new Date();   
    }
});


function render() {

        updateStars();
        updateConstellations();
        //useHorizon = true, project = true
        sun.updatePosition(true, true);
        moon.updatePosition(true, true);
        venus.updatePosition(true, true);
        mercury.updatePosition(true, true);
        mars.updatePosition(true, true);
        jupiter.updatePosition(true, true);
        projSunShadow.updateProjObject();
        //reload the textObject and update all necessary properties
        scene.remove(textObject);
        textObject.geometry.dispose();
        textObject.material.dispose(); 
        textObject = generateTime(globalDate, loadedFont); 
        //replace the textObject in the scene witha  new one

        scene.add(textObject);

        skyDisk.material.color = new THREE.Color(interpolateSkyColor(sun.alt, skyColorTable));
        
        let horizonSun = Astronomy.Horizon(globalDate, observer, 270/15, (90-23.4), 'normal');  
        //Dunno why the 90s are here. Maybe because the ecliptic line   is rotated 90 degrees in the x axis
        projSunShadow.object.rotation.z = (90 - horizonSun.altitude) * (Math.PI/180)    
        projSunShadow.object.rotation.y = (horizonSun.azimuth-90) * (Math.PI/180)
    
        if (autoRotate) {
            globalDate.setMinutes(globalDate.getMinutes() + 1)
        }
        requestAnimationFrame(render);	
        renderer.render(scene, camera);
        }

