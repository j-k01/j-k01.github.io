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
camera.position.y = 450;
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

 //create a constanct dictonary of colors for eacb body, where keys are names.
    const bodyColors = {
        'Sun': 0xffff00,
        'Mercury': 0x808080,
        'Moon': 0x808080,
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
        this.size = 5;
        this.createBodyObjFromName(name, true);
      }
      //create a function that will create a body object from a body
      createBodyObjFromName(name, useHorizon = true){
        let equ_2001 = Astronomy.Equator(name, globalDate, observer, false, false);
        this.ra = equ_2001.ra;
        this.dec = equ_2001.dec;
        let geometry = new THREE.SphereGeometry(1, 32, 32);
        let material = new THREE.MeshPhongMaterial({
            color: 0xffffff,
            shininess: 100,
            specular: 0xffffff
        });
        material.emissive = new THREE.Color(bodyColors[name]);
        material.emissiveIntensity = 1.0;
        material.transparent = true;
        material.opacity = 1.0;
        let bodyObj = new THREE.Mesh(geometry, material);
        console.log('bodyObj created', bodyObj)
        this.bodyObject = bodyObj;
        console.log('bodyObj created', this.bodyObj)
        if (useHorizon == true) {
            let horizon = Astronomy.Horizon(globalDate, observer, this.ra/15, this.dec);
            this.az = horizon.azimuth;
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
            this.ra = equ_2001.ra;
            this.dec = equ_2001.dec;
            let horizon = Astronomy.Horizon(globalDate, observer, this.ra, this.dec);
            this.az = horizon.azimuth;
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

var globalDate = new Date();
let observer = new Astronomy.Observer(39.7, -104.9, 1609); //Denver
//let observer = new Astronomy.Observer(90, 130, 0); //NP
let starMap = new Map();
let starCultureMap = new Map();
let starGroup = new THREE.Group();
//untility functions



function mapValue(value, inputMin, inputMax, outputMin, outputMax) {
    return outputMin + (outputMax - outputMin) * ((value - inputMin) / (inputMax - inputMin));
}

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
    //material.opacity = mapValue(star.MAG, -0, 6.6, 1.0, 0.2);;
    material.opacity = 0.0;
    let starObj = new THREE.Mesh(geometry, material);
    if (useHorizon == true) {
        let horizon = Astronomy.Horizon(globalDate, observer, star.RA/15, star.DEC);
        star.AZ = horizon.azimuth;
        star.ALT = horizon.altitude;
        star.XYZ = calcXYZ(star.AZ, star.ALT);
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
    starData = await response.json();
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
    starCulture = await response.json();
	
	response = await fetch('starCultureNames.json');
    starCultureNames = await response.json();

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


async function init() {
    await loadStarData();
    await loadStarCulture();
    crossStarsAndConstellations(starMap, starCultureMap);
    starCultureMap.get('Cas').stars.forEach((star, index) => {
        let starObj = createStarObj();
        let color = new THREE.Color();
        starObj.material.emissive = new THREE.Color(interpolateColor(star.BV, colorTable));
        starObj.material.color = new THREE.Color(interpolateColor(star.BV, colorTable));
        starObj.position.set(star.XYZ.x, star.XYZ.y, star.XYZ.z);
    
		size = mapValue(star.MAG, -2, 6.6, 1.0,0.2);
        starObj.scale.set(size, size, size);

       // scene.add(starObj);
    });

    //create a ring, visible from all angles, with radius 200 centered on (0,0,100)
    let ringGeometry = new THREE.TorusGeometry(200, 1, 5, 100); 
    let ringMaterial = new THREE.MeshBasicMaterial( { color: 0xb9c9ff, side: THREE.DoubleSide } );
    let ring = new THREE.Mesh( ringGeometry, ringMaterial );
    ring.position.set(0,100,0);
    ring.rotation.x = Math.PI / 2;
    scene.add( ring );
    
    scene.add(starGroup);
    for (let [key, value] of starCultureMap.entries()) {
        value.stars.forEach((star, index) => {
            let starObj2 = createStarObjFromStar(star);
            //let starObj = createStarObj();
            // let color = new THREE.Color();
            // starObj.material.emissive = new THREE.Color(interpolateColor(star.BV, colorTable));
            // starObj.material.color = new THREE.Color(interpolateColor(star.BV, colorTable));
            // starObj.position.set(star.XYZ.x, star.XYZ.y, star.XYZ.z);
            // size = mapValue(star.MAG, 0, 6.6, 0.6, 0.1);
            // starObj.scale.set(size, size, size);

            // starObj.material.transparent = true;
            // starObj.material.opacity = mapValue(star.MAG, -0, 6.6, 1.0, 0.2);;

            //star.projXYZ = projectPoint(star.XYZ, SPHERE_RADIUS);
            star.starObject = starObj2;
            //if (key == 'Cas') {
    
                starGroup.add(star.starObject);
            
                //
           
        });
        value.starLines.forEach((line, index) => {
            let lineObj = new THREE.Line(
                new THREE.BufferGeometry().setFromPoints([
                    starMap.get(line[0]).XYZ,
                    starMap.get(line[1]).XYZ
                ]),
                new THREE.LineBasicMaterial({
                    color: 0xffffff,
                    linewidth: 1,
                    transparent: true,
                    opacity: 0.5
                })
            );
            //if (key == 'Cas') {
                //scene.add(lineObj);
           // }
            //scene.add(lineObj);
        });
        value.starLines.forEach((line, index) => {
            let lineObj = new THREE.Line(
                new THREE.BufferGeometry().setFromPoints([
                    starMap.get(line[0]).XYZ,
                    starMap.get(line[1]).XYZ
                ]),
                new THREE.LineBasicMaterial({
                    color: 0xffffff,
                    linewidth: 1,
                    transparent: true,
                    opacity: 0.5
                })
            );
            //scene.add(lineObj);
        });
        value.starLines.forEach((line, index) => {
            let lineObj = new THREE.Line(
                new THREE.BufferGeometry().setFromPoints([
                    starMap.get(line[0]).projXYZ,
                    starMap.get(line[1]).projXYZ
                ]),
                new THREE.LineBasicMaterial({
                    color: 0xffffff,
                    linewidth: 1,
                    transparent: true,
                    opacity: 0.5
                })
            );
            //scene.add(lineObj);
        });
    };
};

//updates star position by calcuating new AZ and ALT, and if it's below the horizon, 
//makes the star transparent, if it is above the horizon, calucates XYZ, then projects it onto the sphere
//then updates position of star object
function updateStars() {
    for (let [key, value] of starCultureMap.entries()) {
        value.stars.forEach((star, index) => {
            let horizon = Astronomy.Horizon(globalDate, observer, star.RA/15, star.DEC, 'normal');
            star.AZ = horizon.azimuth;
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
         }
        });
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
                line.material.opacity = 0.5;
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
            else {
                line.material.opacity = 0.0;
            }

        });
    }
}

let projSunShadow;
function misc(){    
    //create a buffer geometry using line loop and is positioned on an imagainry sphere at 23 degrees declination.
    const sunShadowMaterial = new THREE.LineDashedMaterial({ color: 0xffa500, dashSize: 1 });
    // Create a geometry for the circle
    const sunShadowGeometry = new THREE.CircleGeometry(100, 100);
    sunShadowGeometry.vertices.shift();

    //const sunShadowBufferGeometry = new THREE.BufferGeometry().fromGeometry(sunShadowGeometry);

    // Create a mesh for the circle
    const sunShadow = new THREE.LineLoop(sunShadowGeometry, sunShadowMaterial);
    // sunShadow.computeLineDistances();
    sunShadow.rotation.x = 90 * (Math.PI/180)
    //sunShadow.rotation.x += 23.26 * (Math.PI/180)
    // // Add the circle to the scene
    // //iterate through the verticies of sunshadow, projecting each one onto the plane   
    sunShadow.updateMatrix();  // updates the matrix of the object
    sunShadow.geometry.applyMatrix4(sunShadow.matrix);  // applies the matrix to the vertices

    // // Reset the transformation of the mesh
    sunShadow.position.set(0, 0, 0);
    sunShadow.rotation.set(0, 0, 0);
    sunShadow.scale.set(1, 1, 1);
    sunShadow.updateMatrix();

    // sunShadow.geometry.vertices.forEach((vertex, index) => {
      
    //     let projXYZ = projectPoint(vertex, SPHERE_RADIUS);
    //     //console.log(projXYZ);
    //     sunShadow.geometry.vertices[index].set(projXYZ.x, projXYZ.y, projXYZ.z);
    // });
    //scene.add(sunShadow);
    projSunShadow = new ProjectedObject(sunShadow);
    console.log(projSunShadow);
    console.log(sunShadow);
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
        console.log('points', points);
        this.projObject = new THREE.LineLoop(
            //create the gemoetry from the original object by iterating through the verticies and projecting them
            //check if vertex is nan or infity  and if so, set it to 0
            new THREE.BufferGeometry().setFromPoints(points),
            this.object.material
        );  
        console.log('geo', this.projObject.geometry);
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
        //console.log(this.projObject.geometry.attributes.position);
    }
}

        

let projShadow;

lineGroup = new THREE.Group();
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

console.log(Astronomy.Horizon(globalDate, observer, 0, 0, 'normal'));
console.log(Astronomy.Horizon(globalDate, observer, 0, 90, 'normal'));

let sun = new Body('Sun');
scene.add(sun.bodyObject);
let moon = new Body('Moon');
scene.add(moon.bodyObject);
console.log('sun', sun.bodyObject);
init().then(() => {
    //init();
    misc();
    createConstellationLines();
    render();
});

let counter = 0;

function render() {

        updateStars();
        updateConstellations();
        //useHorizon = true, project = true
        sun.updatePosition(true, true);
        moon.updatePosition(true, true);
        //projSunShadow.object.rotation.x += 0.01;
        projSunShadow.updateProjObject();
        
        let sunHorizon = Astronomy.Horizon(globalDate, observer,  90/15, 90, 'normal');
        //console.log('az/alt', sunHorizon);


        //projSunShadow.object.rotation.y = (sunHorizon.azimuth) * (Math.PI / 180);
        //projSunShadow.object.rotation.x = (23.27+sunHorizon.altitude) *  (Math.PI / 180);
        // for (let [key, value] of starMap.entries()) {
        //     let horizon = Astronomy.Horizon(globalDate, observer, value.RA, value.DEC, 'normal');
        //     value.AZ = horizon.azimuth;
        //     value.ALT = horizon.altitude;
        //     starGroup.add(createStarObjFromStar(value));
        // }
        // add 1 hour to the global date
        globalDate.setMinutes(globalDate.getMinutes() + 1)
        //globalDate.setDate(globalDate.getDate() + 1)
        //globalDate.setHours(globalDate.getHours() + 1)
        requestAnimationFrame(render);	
        renderer.render(scene, camera);
        }

