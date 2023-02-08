// Scene, camera and renderer
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer();
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// Add orbit controls
const controls = new THREE.OrbitControls(camera, renderer.domElement);

// Set the initial position of the camera
camera.position.z = 10;

	
const light = new THREE.AmbientLight(0x404040); // soft white light
scene.add(light);

var frameDate = new Date();

function render() {
	requestAnimationFrame(render);	
	
	frameDate.setHours(frameDate.getHours()+1);
	planetMap.forEach(function(value, key) {
	let position = calcPlanetPosition(key, frameDate, orbitalDistances[key]);
	value.position.set(position.x, position.y, position.z);
	});
	
	planetPathMap.forEach(function(value, key) {
	let position = calcPlanetPosition(key, frameDate, orbitalDistances[key]);
	value.geometry.vertices.unshift(position);
	//value.geometry.vertices.pop();
	value.geometry.verticesNeedUpdate = true;
	});
	
	renderer.render(scene, camera);
}

let circleMaterial = new THREE.LineBasicMaterial({
  color: 0x336699,
  linewidth: 1,
  wireframe: true,
  opacity: 1,
  side: THREE.DoubleSide
});


let sphereGroup = new THREE.Group();

 const circleGeometry = new THREE.CircleGeometry( 1, 32, 0, 2* Math.PI);
	
for (let lat = 0; lat < 2; lat++) {
    // create a circle for each latitude and longitude segment
    const circleGeometry = new THREE.CircleGeometry( 1, 32, 0, 2* Math.PI);
    // remove center vertex
    circleGeometry.vertices.shift();
    // create a material with an earth-like appearance
    // create a line from the circle's vertices
    const circle = new THREE.LineLoop(circleGeometry, circleMaterial);
	
	circle.rotation.y = (Math.PI / 2) * lat;
    sphereGroup.add(circle);
}


//const circleGeometry = new THREE.CircleGeometry( 1, 32, 0, 2* Math.PI);
// remove center vertex
circleGeometry.vertices.shift();

const circle = new THREE.LineLoop(circleGeometry, circleMaterial);


circle.rotation.x = (Math.PI / 2) ;

	
sphereGroup.scale.set(5,5,5);
sphereGroup.add(circle);
scene.add(sphereGroup);


					
const orbitalDistances = {
'Mercury': 100,
'Venus': 100,
'Earth': 100,
'Mars': 100,
'Jupiter': 100,
'Saturn': 100,
'Uranus': 100,
'Neptune': 100,
'Sun' : 80,
'Moon' : 57.3
};

const bodyList = [
		'Sun', 'Moon', 'Mars', 'Mercury', 'Venus', 'Jupiter'
	];
	
	
const bodyMaterials = {
    'Sun': new THREE.MeshPhongMaterial({
        emissive: 0xffcc00,
		emissiveIntensity: 2,
        shininess: 100,
        specular: 0xffcc00
    }),
    'Moon': new THREE.MeshPhongMaterial({
        emissive: 0xcccccc,
		emissiveIntensity: 1,
        shininess: 10,
        specular: 0xcccccc
    }),
    'Mercury': new THREE.MeshPhongMaterial({
        emissive: 0x9b9b9b,
		emissiveIntensity: 0.5,
        shininess: 30,
        specular: 0x9b9b9b
    }),
    'Venus': new THREE.MeshPhongMaterial({
        emissive: 0xff9933,
		emissiveIntensity: 1.5,
        shininess: 80,
        specular: 0xff9933
    }),
    'Mars': new THREE.MeshPhongMaterial({
        emissive: 0xff3333,
		emissiveIntensity: 1,
        shininess: 80,
        specular: 0xff3333
    }),
    'Jupiter': new THREE.MeshPhongMaterial({
        emissive: 0xffcc99,
		emissiveIntensity: 2,
        shininess: 80,
        specular: 0xffcc99
    }),
    'Saturn': new THREE.MeshPhongMaterial({
        emissive: 0xffff66,
		emissiveIntensity: 2,
        shininess: 90,
        specular: 0xffff66
    }),
    'Uranus': new THREE.MeshPhongMaterial({
        emissive: 0x99ccff,
		emissiveIntensity: 1.5,
        shininess: 70,
        specular: 0x99ccff
    }),
    'Neptune': new THREE.MeshPhongMaterial({
        emissive: 0x3399ff,
		emissiveIntensity: 1.5,
        shininess: 60,
        specular: 0x3399ff
    }),
    'Pluto': new THREE.MeshPhongMaterial({
        emissive: 0x999999,
		emissiveIntensity: 0.5,
        shininess: 50,
        specular: 0x999999
    }),
};

		
function calcOrbitalPeriodFraction(fraction, planetName) {
    // Data for orbital periods of each planet in the solar system in days
    const orbitalPeriods = {
        "Mercury": 87.97,
        "Venus": 224.7,
        "Earth": 365.26,
        "Mars": 687,
        "Jupiter": 4333,
        "Saturn": 10760,
        "Uranus": 30600,
        "Neptune": 60225
    };
	return Math.round(orbitalPeriods[planetName] * fraction);
}

function initializePlanetPath(body){
	let days = calcOrbitalPeriodFraction(.33, 'Earth');
	let line = createLineSegment(days, body);
	line.material.color = bodyMaterials[body].emissive;
	return line;
}

function createPlanet(body, date){
	const genGeo = new THREE.SphereGeometry(.6, 32, 32);
	const sunGeo = new THREE.SphereGeometry(.35, 32, 32);
	const moonGeo = new THREE.SphereGeometry(.25, 32, 32);

	let observer = new Astronomy.Observer(0, 0, 0);
	let equ_2001 = Astronomy.Equator(body, date, observer, false, true);
	let pMT = new THREE.Matrix4();
	let rMT = new THREE.Matrix4();
	let sphere;
	let distance = 100;
	let sphereMaterial = bodyMaterials[body];
	if (body === 'Sun') {
		sphere = new THREE.Mesh(sunGeo, sphereMaterial);
		distance = 80;
		} else if (body === 'Moon') {
		sphere = new THREE.Mesh(moonGeo, sphereMaterial);
		distance = 57.3;
		} else {
		sphere = new THREE.Mesh(genGeo, sphereMaterial);
		};

				
	pMT.setPosition(distance,0,0);
	rMT.makeRotationZ(equ_2001.dec * (Math.PI / 180));
	pMT.multiplyMatrices(rMT,pMT)

	rMT.makeRotationY(equ_2001.ra * 15 * (Math.PI / 180));
	pMT.multiplyMatrices(rMT,pMT)
	myvector = new THREE.Vector3().setFromMatrixPosition(pMT)
	sphere.position.set(myvector.x, myvector.y, myvector.z);
	sphere.name = body;
	return sphere
}


const planetMap = new Map();
for (let body of bodyList) {  
	let planet = createPlanet(body, new Date())
	planetMap.set(planet.name, planet);
	scene.add(planet);
}
				
const planetPathMap = new Map();
 for (let body of bodyList){
	let planetPath = initializePlanetPath(body);
	planetPathMap.set(planetPath.name, planetPath);
	scene.add(planetPath);
}
				
function mapValue(value, inputMin, inputMax, outputMin, outputMax) {
    return outputMin + (outputMax - outputMin) * ((value - inputMin) / (inputMax - inputMin));
}

/* function surfaceLocation(diameter, DEC, RA){
	let positionMatrix = new THREE.Matrix4();
	let rotationMatrix = new THREE.Matrix4();

	positionMatrix.setPosition(diameter,0,0);
	rotationMatrix.makeRotationZ(DEC * (Math.PI / 180));
	positionMatrix.multiplyMatrices(rotationMatrix,positionMatrix)

	rotationMatrix.makeRotationY(RA * (Math.PI / 180));
	positionMatrix.multiplyMatrices(rotationMatrix,positionMatrix)
	return positionMatrix;
}
 */

function calcPlanetPosition(body, day, distance) {
	let positionMatrix = new THREE.Matrix4();
	let rotationMatrix = new THREE.Matrix4();
	let observer = new Astronomy.Observer(39.7, 104.9, 1609);
	let equ_2001 = Astronomy.Equator(body, day, observer, false, true);

	positionMatrix.setPosition(distance,0,0);
	rotationMatrix.makeRotationZ(equ_2001.dec * (Math.PI / 180));
	positionMatrix.multiplyMatrices(rotationMatrix,positionMatrix);				
	rotationMatrix.makeRotationY(equ_2001.ra * 15 * (Math.PI / 180)); //RA has to be muliptled by 15 because it's in 24 hr format
	positionMatrix.multiplyMatrices(rotationMatrix,positionMatrix);

	return new THREE.Vector3().setFromMatrixPosition(positionMatrix);
	}		
	
//Eliminate this, and use calcPlanetPosition
function calcSpherePosition(body, day, distance) {
	let dateQuery = new Date();
	dateQuery.setDate(dateQuery.getDate()-day);
	let positionMatrix = new THREE.Matrix4();
	let rotationMatrix = new THREE.Matrix4();
	let observer = new Astronomy.Observer(0, 0, 0);
	let equ_2001 = Astronomy.Equator(body, dateQuery, observer, false, true);

	positionMatrix.setPosition(distance,0,0);
	rotationMatrix.makeRotationZ(equ_2001.dec * (Math.PI / 180));
	positionMatrix.multiplyMatrices(rotationMatrix,positionMatrix);				
	rotationMatrix.makeRotationY(equ_2001.ra * 15 * (Math.PI / 180)); //RA has to be muliptled by 15 because it's in 24 hr format
	positionMatrix.multiplyMatrices(rotationMatrix,positionMatrix);

	return new THREE.Vector3().setFromMatrixPosition(positionMatrix);
	}		
	
	
function createLineSegment(numPoints, body) {
  let lineGeometry = new THREE.Geometry();
  let distance = 100;

	
  for (let i = 0; i < numPoints; i++) {
    let point = calcSpherePosition(body, i, orbitalDistances[body]);
    lineGeometry.vertices.push(point);
  }
  
  let lineMaterial = new THREE.LineBasicMaterial({ color: 0x0000ff });
  let line = new THREE.Line(lineGeometry, lineMaterial);
  line.name = body;
  return line;
}

function createInstancedStars() {

	const starMap = new Map();
	let originalMaterial = new THREE.MeshPhongMaterial({
		color: 0xffffff,
		shininess: 100,
		specular: 0xffffff
	});

	let newMaterial = originalMaterial.clone();
	newMaterial.emissive.setHex(0xffffff);
	newMaterial.emissiveIntensity = 2;

    let star = new THREE.SphereGeometry(.5, 5, 5);

    let instancedStars = new THREE.InstancedMesh(star, newMaterial, starCount);
	instancedStars.name = 'instancedStars';
    starData.forEach((entry, index) => {
		starMap.set(entry.ID, index);
		let positionMatrix = new THREE.Matrix4();
		let rotationMatrix = new THREE.Matrix4();
	
		positionMatrix.setPosition(100,0,0);
		rotationMatrix.makeRotationZ(entry.DEC * (Math.PI / 180));
		positionMatrix.multiplyMatrices(rotationMatrix,positionMatrix)
	
		rotationMatrix.makeRotationY(entry.RA * (Math.PI / 180));
		positionMatrix.multiplyMatrices(rotationMatrix,positionMatrix)
		
		size = mapValue(entry.MAG, -2, 6.6, 1.0,0.2);
		positionMatrix.scale(new THREE.Vector3(size, size, size));
        instancedStars.setMatrixAt(index, positionMatrix);
		
    });
    instancedStars.instanceMatrix.needsUpdate = true;
    scene.add(instancedStars);
	
	console.log(instancedStars);
	
		return {
    'instancedStars': instancedStars,
    'starMap': starMap
	};
	}
	
	
async function loadSphereData() {
    let response = await fetch('starcatalogue.json');
    starData = await response.json();
    starData = starData.filter(entry => entry.MAG < 6.6);
    starCount = starData.length;
	myObj = createInstancedStars();
	instancedStars = myObj.instancedStars;
	starMap = myObj.starMap;
	
	response = await fetch('starCulture.json');
    starCulture = await response.json();
	
	response = await fetch('starCultureNames.json');
    starCultureNames = await response.json();
	createStarLines();
}

//TODO: paramaterize this
function createStarLines(){

	let spectral_lineMaterial = new THREE.LineBasicMaterial({
	  color: 0x87CEEB, // a faint blue color
	  linewidth: 0.5, // a thin line
	  transparent: true, // allow transparency
	  opacity: 0.8 // make the line slightly transparent
	});

	starCultureNames.STELLA.map(key => {
		for(var i = 0; i < starCulture[key].length; i++) {
		
			myMat = new THREE.Matrix4();
			instancedStars.getMatrixAt(starMap.get(starCulture[key][i][0]), myMat);
			let position1 = new THREE.Vector3().setFromMatrixPosition(myMat);
			instancedStars.getMatrixAt(starMap.get(starCulture[key][i][1]), myMat);
			let position2 = new THREE.Vector3().setFromMatrixPosition(myMat);
					
			let line = makeArc(position1.clone(), position2.clone(), 12, false);
			line.material = spectral_lineMaterial;
			scene.add(line)
			
	}
	});
}

//from stackoverflow
function makeArc(pointStart, pointEnd, smoothness, clockWise) {
  // calculate a normal ( taken from Geometry().computeFaceNormals() )
  let cb = new THREE.Vector3(), ab = new THREE.Vector3(), normal = new THREE.Vector3();
  cb.subVectors(new THREE.Vector3(), pointEnd);
  ab.subVectors(pointStart, pointEnd);
  cb.cross(ab);
  normal.copy(cb).normalize();


  let angle = pointStart.angleTo(pointEnd); // get the angle between vectors
  if (clockWise) angle = angle - Math.PI * 2;  // if clockWise is true, then we'll go the longest path
  let angleDelta = angle / (smoothness - 1); // increment


  let geometry = new THREE.Geometry();
  for (let i = 0; i < smoothness; i++) {
    geometry.vertices.push(pointStart.clone().applyAxisAngle(normal, angleDelta * i))  // this is the key operation
  }

  let arc = new THREE.Line(geometry, new THREE.LineBasicMaterial({
    color: 0xffffff,
	transparent: false,
    opacity: 1.0
  }));
  return arc;
}

function zodiacBelt(smoothness){
	
	const points = [];
	let angle_step = (16/ smoothness);
	for (let i = 0; i <= smoothness; i ++ ) {
		let angle = (-8 + i * angle_step) * (Math.PI/180);
		console.log(angle);
		let x = 100.1* Math.cos(angle);
		let y = 100.1* Math.sin(angle);
		points.push( new THREE.Vector2(x, y));
		}


	const geometry = new THREE.LatheGeometry( points, 100 );
	const materiala = new THREE.MeshBasicMaterial( { color: 0x0000ff, side: THREE.BackSide, transparent: true, // set to true for transparency
		opacity: 0.10} );
	const lathe = new THREE.Mesh( geometry, materiala );
	lathe.rotation.x = 23.43 * (Math.PI/180);
	return lathe;

}

loadSphereData();
let zodiac = zodiacBelt(12);
scene.add(zodiac);

console.log('MOON');
let AstroVec = Astronomy.GeoVector('Moon', new Date(), false);
let myTest = new THREE.Vector3(AstroVec.x, AstroVec.y, AstroVec.z);
console.log(calcPlanetPosition('Moon', new Date(), orbitalDistances['Moon']));
console.log(myTest);
myTest.normalize();
myTest.setLength(orbitalDistances['Moon']);
console.log(myTest);


let earthGeometry = new THREE.SphereGeometry(1, 32, 32);
let earthMaterial = new THREE.MeshPhongMaterial({color: 0x0000ff});
let earthSphere = new THREE.Mesh(earthGeometry, earthMaterial);
scene.add(earthSphere);


render();
