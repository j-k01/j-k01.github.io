// Scene, camera and renderer
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ alpha: true });
renderer.setClearColor(0x000000, 1);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// Add orbit controls
const controls = new THREE.OrbitControls(camera, renderer.domElement);
camera.position.z = -45;
camera.position.y = 45;
camera.position.x = -45;
camera.lookAt(0,0,0);

	
const light = new THREE.AmbientLight(0x404040); // soft white light
const sunLightingLayer = new THREE.Layers();
sunLightingLayer.set(1);
const pointLight = new THREE.PointLight(0xffffff, 1);
pointLight.layers.enable(1);
pointLight.layers.disable(0);

pointLight.position.set(0, 0, 80);
scene.add(pointLight);

scene.add(light);

const loader = new THREE.FontLoader();


let myObjA = new THREE.Object3D();
myObjA.position.y = camera.position.y;
let monthGroup =  new THREE.Group();
var loadedFont;
loader.load( '/helvetiker_regular.typeface.json', function ( font ) {
					loadedFont = font;
					const color = 0xFF6699;

					const matDark = new THREE.LineBasicMaterial( {
						color: color,
						side: THREE.DoubleSide
					} );

					const matLite = new THREE.MeshBasicMaterial( {
						color: 0xffa500,
						transparent: true,
						opacity: .9,
						side: THREE.DoubleSide
					} );
					
					for (let month of months) {  
					
						const letterforms = font.generateShapes(month, 2.5);

						const textGeometry = new THREE.ShapeGeometry( letterforms );

						textGeometry.computeBoundingBox();

						const xMid = - 0.5 * ( textGeometry.boundingBox.max.x - textGeometry.boundingBox.min.x );
						const yMid = - 0.5 * ( textGeometry.boundingBox.max.y - textGeometry.boundingBox.min.y );
						const zMid = - 0.5 * ( textGeometry.boundingBox.max.z - textGeometry.boundingBox.min.z );

						textGeometry.translate( xMid, yMid, zMid );
					
						let monthText = new THREE.Mesh( textGeometry, matLite );
						let monthDate = new Date(calendarDates[month]);
						if (month != 'FEB'){
							monthDate.setDate(monthDate.getDate() + 15);
						}
						else{
							monthDate.setDate(monthDate.getDate() + 13);
						}
						let textPosition = sunPositionOnEquator(monthDate);
						monthText.position.set(textPosition.x, textPosition.y, textPosition.z);
	
						
						monthGroup.add(monthText); 
					}
					const date = new Date();
					date.setMonth(0);
					date.setDate(1);
					let yearText = generateYD(date, loadedFont);
					yearText.name = 'year';		

					monthGroup.add(yearText);
						
	
});

scene.add(monthGroup);

const months = [
		'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'
	];
		
const calendarDates = {
'JAN': 'January 1, 2023 00:00:00',
'FEB': 'Feburary 1, 2023 00:00:00',
'MAR': 'March 1, 2023 00:00:00',
'APR': 'April 1, 2023 00:00:00',
'MAY': 'May 1, 2023 00:00:00',
'JUN': 'June 1, 2023 00:00:00',
'JUL': 'July 1, 2023 00:00:00',
'AUG': 'August 1, 2023 00:00:00',
'SEP' : 'September 1, 2023 00:00:00',
'OCT' : 'October 1, 2023 00:00:00',
'NOV' : 'November 1, 2023 00:00:00',
'DEC' : 'December 1, 2023 00:00:00'
};



let sunProjectionGeometry = new THREE.Geometry();
sunProjectionGeometry.vertices.push(calcPlanetPosition('Sun', new Date(), 80));
sunProjectionGeometry.vertices.push(calcPlanetPosition('Sun', new Date(), 80));
let sunProjection = new THREE.Line(sunProjectionGeometry, new THREE.LineDashedMaterial({
	color: 0xffa500,
	linewidth: 2,
	transparent: true,
	opacity: 0.8,
	dashSize: 1,
	gapSize: 1,
	}));

function sunAnglenOnEquator(date){
	let observer = new Astronomy.Observer(39.7, 104.9, 1609);
	let equ_2001 = Astronomy.Equator('Sun', date, observer, false, true);
	return equ_2001.ra * 15 * (Math.PI / 180);
}


function sunPositionOnEquator(date){
	
	let positionMatrix = new THREE.Matrix4();
	let rotationMatrix = new THREE.Matrix4();
	let observer = new Astronomy.Observer(39.7, 104.9, 1609);
	let equ_2001 = Astronomy.Equator('Sun', date, observer, false, true);

	positionMatrix.setPosition(77,0,0);		
	rotationMatrix.makeRotationY(equ_2001.ra * 15 * (Math.PI / 180)); //RA has to be muliptled by 15 because it's in 24 hr format
	positionMatrix.multiplyMatrices(rotationMatrix,positionMatrix);
	
	return new THREE.Vector3().setFromMatrixPosition(positionMatrix);;
}

function drawSunProjection(line, circle, date){
	//let point1 = calcPlanetPosition('Moon', date, 57.1);
	let point1 = calcPlanetPosition('Sun', date, 80)
	
		
	let positionMatrix = new THREE.Matrix4();
	let rotationMatrix = new THREE.Matrix4();
	let observer = new Astronomy.Observer(39.7, 104.9, 1609);
	let equ_2001 = Astronomy.Equator('Sun', date, observer, false, true);

	positionMatrix.setPosition(80,0,0);		
	rotationMatrix.makeRotationY(equ_2001.ra * 15 * (Math.PI / 180)); //RA has to be muliptled by 15 because it's in 24 hr format
	positionMatrix.multiplyMatrices(rotationMatrix,positionMatrix);
	
	let positionVector = new THREE.Vector3().setFromMatrixPosition(positionMatrix);
	circle.position.set(positionVector.x, positionVector.y, positionVector.z);
	line.geometry.vertices[0] = point1;
	line.geometry.vertices[1] = positionVector;
	line.computeLineDistances();
	line.geometry.verticesNeedUpdate = true;
}

let calendarGroup = new THREE.Group();

let calendarYearGroup = new THREE.Group();
scene.add(calendarYearGroup);
let innerCricleGeometry = new THREE.Geometry();
let outerCricleGeometry = new THREE.Geometry();


circleReferenceLineGroup = new THREE.Group();
circleReferenceSphereGroup = new THREE.Group();
for (let month of months) {  
	let myDate = new Date(calendarDates[month]);
	let referencePosition = calcPlanetPosition('Sun', new Date(calendarDates[month]), 80);
	const referenceSphereGeo = new THREE.SphereGeometry(3, 4, 2);
	let referenceSphere = new THREE.Mesh(referenceSphereGeo, new THREE.MeshPhongMaterial({
		color: 0xffffff,
		transparent: true,
		opacity: 0.0
	}));
	referenceSphere.position.set(referencePosition.x, referencePosition.y, referencePosition.z);
	circleReferenceSphereGroup.add(referenceSphere);
	
	let monthLineGeometry = new THREE.Geometry();
	let start = new THREE.Vector3(referenceSphere.geometry.vertices[0].x, referenceSphere.geometry.vertices[0].y, referenceSphere.geometry.vertices[0].z);
		start.applyMatrix4(referenceSphere.matrixWorld);
		monthLineGeometry.vertices.push(start);
	let stop = new THREE.Vector3(referenceSphere.geometry.vertices[5].x, referenceSphere.geometry.vertices[5].y, referenceSphere.geometry.vertices[5].z);
		stop.applyMatrix4(referenceSphere.matrixWorld);
	monthLineGeometry.vertices.push(start);
	monthLineGeometry.vertices.push(stop);
	let monthLine = new THREE.Line(monthLineGeometry, new THREE.LineBasicMaterial({
		color: 0xffa500,
		transparent: false,
		opacity: 0.8
	}));
	innerCricleGeometry.vertices.push(start.clone());
	outerCricleGeometry.vertices.push(stop.clone());
	referenceSphere.matrixWorldNeedsUpdate = true;
	referenceSphere.add(monthLine);
}

circleReferenceSphereGroup.rotation.x = -23.47 * (Math.PI/180);




let innerCircle = new THREE.LineLoop(innerCricleGeometry, new THREE.LineBasicMaterial({
	color: 0xffa500,
	transparent: true,
	opacity: 0.8
}));
//circleReferenceSphereGroup.add(innerCircle);
scene.add(innerCircle);	
	
let outerCircle = new THREE.LineLoop(outerCricleGeometry, new THREE.LineBasicMaterial({
	color: 0xffa500,
	transparent: true,
	opacity: 0.8
}));

scene.add(circleReferenceSphereGroup);
scene.add(outerCircle);

	
 
var eclipseGroup = new THREE.Group();
scene.add(eclipseGroup);

var frameDate = new Date();
var next_eclipse = Astronomy.NextLunarEclipse(new Date());
var next_solar_eclipse = Astronomy.NextGlobalSolarEclipse(new Date());
var increment = true;
var keepLastEclipse = true;
var eclipseThreshold = new Date();
var yearThreshold = new Date(frameDate.getFullYear()+1, 0, 1, 0, 0, 0);
function render() {
	requestAnimationFrame(render);	
	if (increment){
		//frameDate.setDate(frameDate.getDate()+1);
		frameDate.setHours(frameDate.getHours()+1);
	};
	
	planetMap.forEach(function(value, key) {
		let postion;
		if (key != 'geoMoon'){
			position = calcPlanetPosition(key, frameDate, orbitalDistances[key]);
		}
		else {
			position = calcMoonGeoPosition(frameDate);
		}
	value.position.set(position.x, position.y, position.z);
	});
	
	planetPathMap.forEach(function(value, key) {
		let postion;
		if (key != 'geoMoon'){
			position = calcPlanetPosition(key, frameDate, orbitalDistances[key]);

		}
		else {
			position = calcMoonGeoPosition(frameDate);			
		}
		
		value.geometry.vertices.unshift(position);
		value.geometry.vertices.pop();
		value.geometry.verticesNeedUpdate = true;

	});
	
	let sunPosition = calcPlanetPosition('Sun', frameDate, orbitalDistances['Sun'])
	pointLight.position.set(sunPosition.x, sunPosition.y, sunPosition.z);

	drawSunProjection(sunProjection, sunShadow, frameDate);

	if (loadedFont){
		if (yearThreshold < frameDate){
			for (let i = 0; i < monthGroup.children.length; i++) {
				let object = monthGroup.children[i];
				if (object.name == 'year'){
					let newYear = generateYD(frameDate, loadedFont);
					newYear.name = 'year';
					monthGroup.remove(object);
					monthGroup.add(newYear);
					object.geometry.dispose();
					object.material.dispose();
					//try and dispose of this object
				}
			}
			yearThreshold.setFullYear(yearThreshold.getFullYear() + 1);
		}
	}

	var polarAngle;
	myObjA.position.y = camera.position.y;
	sunShadow.lookAt(myObjA.position);
	let thisyearPosition = new THREE.Vector3();
	//innerCricleGeometry.vertices.push(referenceSphere.localToWorld(monthLineGeometry.vertices[0].clone()));
	for (let i = 0; i < circleReferenceSphereGroup.children.length; i++) {
		let object = circleReferenceSphereGroup.children[i];
		//let lineObject = circleReferenceLineGroup.children[i];
		object.lookAt(myObjA.position);
		
		const thisThing = object.localToWorld(object.geometry.vertices[0].clone());
		innerCircle.geometry.vertices[i].set(thisThing.x, thisThing.y, thisThing.z);
		const thisThing2 = object.localToWorld(object.geometry.vertices[5].clone());
		outerCircle.geometry.vertices[i].set(thisThing2.x, thisThing2.y, thisThing2.z);
		innerCircle.geometry.verticesNeedUpdate = true;
		outerCircle.geometry.verticesNeedUpdate = true;
		
		if (i == 0){
			thisyearPosition.subVectors(thisThing, thisThing2);
			thisyearPosition.setLength(2.2);
			thisyearPosition.addVectors(thisThing, thisyearPosition);
		}
	}
	
	
	for (let i = 0; i < monthGroup.children.length; i++) {
		let object = monthGroup.children[i];
		object.lookAt(myObjA.position);
		if (object.name == 'year'){
			object.position.set(thisyearPosition.x, thisyearPosition.y, thisyearPosition.z);
		}
	}

	if (next_eclipse.peak.date < frameDate || next_solar_eclipse.peak.date < frameDate){
		if (frameDate > eclipseThreshold){			
			eclipseThreshold.setTime(frameDate.getTime());
			eclipseThreshold.setMonth(eclipseThreshold.getMonth()+4);
			
			while (eclipseGroup.children.length > 0) {
				const child = eclipseGroup.children[0];
				eclipseGroup.remove(child);

				// optionally dispose of the child's resources
				if (child.geometry) child.geometry.dispose();
				if (child.material) child.material.dispose();
			}
		}
	}
	if (next_eclipse.peak.date < frameDate){
		FreezeEclipse(next_eclipse, eclipseGroup);
	}
	if (next_solar_eclipse.peak.date < frameDate){
		FreezeSolarEclipse(next_solar_eclipse, eclipseGroup);
	
	}

	

	renderer.render(scene, camera);

}

let circleMaterial = new THREE.LineBasicMaterial({
  color: 0xFFFFFF,
  //color: 0x87CEEB,
  linewidth: 1,
  wireframe: true,
  opacity: 1,
  side: THREE.DoubleSide
});

//SunShadow

const sunShadowMaterial = new THREE.LineDashedMaterial({ color: 0xffa500, dashSize: 1 });


// Create a geometry for the circle
const sunShadowGeometry = new THREE.CircleGeometry(1, 32);
sunShadowGeometry.vertices.shift();

// Create a mesh for the circle
const sunShadow = new THREE.Line(sunShadowGeometry, sunShadowMaterial);
sunShadow.computeLineDistances();

// Add the circle to the scene
scene.add(sunShadow);


let sphereGroup = new THREE.Group();

 const circleGeometry = new THREE.CircleGeometry( 1, 32, 0, 2* Math.PI);
	
for (let lat = 0; lat < 1; lat++) {
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
'Moon' : 60,
'geoMoon' : 57.3 
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
        emissive: 0xFF6699,
		emissiveIntensity: 1,
        shininess: 10,
        specular: 0xFF6699
    }),	
	'Earth': new THREE.MeshPhongMaterial({
        emissive: 0x0033ff,
		emissiveIntensity: 0.5,
        shininess: 10,
        specular: 0xffffff
    }),	
    'ghostMoon': new THREE.MeshPhongMaterial({
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
        'Mercury': 87.97,
        'Venus': 224.7,
        'Earth': 365.26,
        'Mars': 687,
        'Jupiter': 4333,
        'Saturn': 10760,
        'Uranus': 30600,
        'Neptune': 60225
    };
	return Math.round(orbitalPeriods[planetName] * fraction);
}

function initializePlanetPath(body){
	let days = calcOrbitalPeriodFraction(.33, 'Earth');
	let maxLineLength = 3000;
	if (body == 'Moon'){
		maxLineLength = 100;
	}
	let line = createLineSegment(maxLineLength, body);
	line.material.color = bodyMaterials[body].emissive;
	return line;
}


function createPlanet(body, date){
	const genGeo = new THREE.SphereGeometry(.6, 32, 32);
	const sunGeo = new THREE.SphereGeometry(.35, 32, 32);
	const moonGeo = new THREE.SphereGeometry(.25, 32, 32);
	let observer = new Astronomy.Observer(0, 0, 0);
	let	equ_2001 = Astronomy.GeoVector('Moon',date, false);
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

let geoMoon = createGeoMoon(new Date())
	planetMap.set(geoMoon.name, geoMoon);
	scene.add(geoMoon);
				
				
const planetPathMap = new Map();
 for (let body of bodyList){
	let planetPath = initializePlanetPath(body);
	planetPathMap.set(planetPath.name, planetPath);
	scene.add(planetPath);
}

let geoMoonLine = createGeoMoonLineSegment(3000)
	planetPathMap.set(geoMoonLine.name, geoMoonLine);
	scene.add(geoMoonLine);
	
				
function mapValue(value, inputMin, inputMax, outputMin, outputMax) {
    return outputMin + (outputMax - outputMin) * ((value - inputMin) / (inputMax - inputMin));
}

function generateYD(date, font){
	
	const color = 0xFF6699;

	const matDark = new THREE.LineBasicMaterial( {
	color: color,
	side: THREE.DoubleSide
	} );

	const matLite = new THREE.MeshBasicMaterial( {
	color: 0xffa500,
	transparent: true,
	opacity: .9,
	side: THREE.DoubleSide
	} );

	const letterforms = font.generateShapes(date.getFullYear().toString(), 2.5);

	const textGeometry = new THREE.ShapeGeometry( letterforms );

	textGeometry.computeBoundingBox();

	const xMid = - 0.5 * ( textGeometry.boundingBox.max.x - textGeometry.boundingBox.min.x );
	const yMid = - 0.5 * ( textGeometry.boundingBox.max.y - textGeometry.boundingBox.min.y );
	const zMid = - 0.5 * ( textGeometry.boundingBox.max.z - textGeometry.boundingBox.min.z );

	textGeometry.translate( xMid, yMid, zMid );

	let yearText = new THREE.Mesh( textGeometry, matLite );
	
	let textPosition = calcYDPosition(date, 77);
	yearText.position.set(textPosition.x, textPosition.y, textPosition.z);

	return yearText;
}

function calcYDPosition(day, distance) {
	let positionMatrix = new THREE.Matrix4();
	let rotationMatrix = new THREE.Matrix4();
	let observer = new Astronomy.Observer(39.7, 104.9, 1609);	
	let equ_2001 = Astronomy.Equator('Sun', day, observer, false, true);

	positionMatrix.setPosition(distance,0,0);
	rotationMatrix.makeRotationZ((-4) * (Math.PI / 180));
	positionMatrix.multiplyMatrices(rotationMatrix,positionMatrix);				
	rotationMatrix.makeRotationY(equ_2001.ra * 15 * (Math.PI / 180)); //RA has to be muliptled by 15 because it's in 24 hr format
	positionMatrix.multiplyMatrices(rotationMatrix,positionMatrix);

	return new THREE.Vector3().setFromMatrixPosition(positionMatrix);
	}		

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
function calcSpherePosition(body, date, distance) {
	
	let positionMatrix = new THREE.Matrix4();
	let rotationMatrix = new THREE.Matrix4();
	let observer = new Astronomy.Observer(39.7, 104.9, 1609);	
	let equ_2001 = Astronomy.Equator(body, date, observer, false, true);
	
	positionMatrix.setPosition(distance,0,0);
	rotationMatrix.makeRotationZ(equ_2001.dec * (Math.PI / 180));
	positionMatrix.multiplyMatrices(rotationMatrix,positionMatrix);				
	rotationMatrix.makeRotationY(equ_2001.ra * 15 * (Math.PI / 180)); //RA has to be muliptled by 15 because it's in 24 hr format
	positionMatrix.multiplyMatrices(rotationMatrix,positionMatrix);

	return new THREE.Vector3().setFromMatrixPosition(positionMatrix);
	}		
	
	
function createLineSegment(maxPoints, body) {
	let lineGeometry = new THREE.Geometry();
	let dateQuery = new Date();
	
	let totalLength = 0;
	let prevPoint;
	let i = 0;

	while (totalLength < (100*Math.PI*2)) {
		dateQuery.setHours(dateQuery.getHours()-1);
		let point = calcSpherePosition(body, dateQuery, orbitalDistances[body]);
		lineGeometry.vertices.push(point);
		if (prevPoint) {
			totalLength += prevPoint.distanceTo(point)
		}
		prevPoint = point;

		i++;

		if (i> maxPoints){
			break;
		}
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

function createGeoMoonLineSegment(maxPoints) {
	let lineGeometry = new THREE.Geometry();
	let dateQuery = new Date();
	
	let totalLength = 0;
	let prevPoint;
	let i = 0;

	while (totalLength < (100*Math.PI*2)) {
		dateQuery.setHours(dateQuery.getHours()-1);
		let point = calcMoonGeoPosition(dateQuery);
		lineGeometry.vertices.push(point);
		if (prevPoint) {
			totalLength += prevPoint.distanceTo(point)
		}
		prevPoint = point;

		i++;

		if (i> maxPoints){
			break;
		}
	}

	let lineMaterial = new THREE.LineBasicMaterial({ color: bodyMaterials['ghostMoon'].emissive });
	let line = new THREE.Line(lineGeometry, lineMaterial);
	line.name = 'geoMoon';
	return line;
}



function createGeoMoon(date){
	const moonGeo = new THREE.SphereGeometry(.25, 32, 32);
	let sphereMaterial = bodyMaterials['ghostMoon'];
	let sphere = new THREE.Mesh(moonGeo, sphereMaterial);
	let spherePos = calcMoonGeoPosition(date);
	sphere.position.set(spherePos.x, spherePos.y, spherePos.z);
	sphere.name = 'geoMoon';
	return sphere;	
}

function calcMoonGeoPosition(date){
	let astroVec = Astronomy.GeoVector('Moon', date, false);
	let moonVec = new THREE.Vector3(astroVec.x, astroVec.y, astroVec.z);
	moonVec.normalize();
	moonVec.setLength(orbitalDistances['geoMoon']);
	let quaternion = new THREE.Quaternion();
	quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI/2);

	// Apply the rotation to the vector
	moonVec.applyQuaternion(quaternion);
//	moonVec.rotation.x -= Math.PI/2;
	return moonVec;
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

function makeLine(position1, position2){
	
	let geometry = new THREE.Geometry();
	geometry.vertices.push(position1);
	geometry.vertices.push(position2);
	let line = new THREE.Line(geometry, new THREE.LineBasicMaterial({
	color: 0xffffff,
	transparent: false,
	opacity: 1.0
	}));
	return line;
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



function FreezeEclipse(eclipse_obj, eclipseGroup){
	let thisGroup = new THREE.Group();
	let moonVec = calcPlanetPosition('Moon', eclipse_obj.peak.date, orbitalDistances['Moon']);
	let geoMoonVec = calcMoonGeoPosition(eclipse_obj.peak.date);
	let sunVec = calcPlanetPosition('Sun', eclipse_obj.peak.date, orbitalDistances['Sun']);
	

	let sunGhostGeometry = new THREE.SphereGeometry(.35, 32, 32);
	let moonGhostGeometry = new THREE.SphereGeometry(.25, 32, 32);
	let ghostMaterial = new THREE.MeshPhongMaterial({color: 0xFF6699});

    let moonGhost = new THREE.Mesh(moonGhostGeometry, bodyMaterials['Moon']);
    let sunGhost = new THREE.Mesh(sunGhostGeometry, bodyMaterials['Moon']);
    let moonEcl = new THREE.Mesh(moonGhostGeometry,  bodyMaterials['ghostMoon']);
	moonGhost.position.set(moonVec.x, moonVec.y, moonVec.z);
	sunGhost.position.set(sunVec.x, sunVec.y, sunVec.z);
	moonEcl.position.set(geoMoonVec.x, geoMoonVec.y, geoMoonVec.z);
	
	let eclipseTraceGeometry = new THREE.Geometry();
	eclipseTraceGeometry.vertices.push(moonVec);
	eclipseTraceGeometry.vertices.push(sunVec);

	let eclipseTrace = new THREE.Line(eclipseTraceGeometry, new THREE.LineBasicMaterial({
	color: 0xFF6699,
	transparent: true,
	opacity: 1.0
	}));
	
	Object.assign(eclipse_obj, Astronomy.NextLunarEclipse(eclipse_obj.peak.date));

	thisGroup.add(moonGhost);
	thisGroup.add(sunGhost);
	thisGroup.add(moonEcl);
	thisGroup.add(eclipseTrace);
	eclipseGroup.add(thisGroup);
}

function FreezeSolarEclipse(eclipse_obj, eclipseGroup){
	let thisGroup = new THREE.Group();
	let moonVec = calcPlanetPosition('Moon', eclipse_obj.peak.date, orbitalDistances['Moon']);
	let geoMoonVec = calcMoonGeoPosition(eclipse_obj.peak.date);
	let sunVec = calcPlanetPosition('Sun', eclipse_obj.peak.date, orbitalDistances['Sun']);

	let sunGhostGeometry = new THREE.SphereGeometry(.35, 32, 32);
	let moonGhostGeometry = new THREE.SphereGeometry(.25, 32, 32);
	let ghostMaterial = new THREE.MeshPhongMaterial({color: 0xFF6699});

    let moonGhost = new THREE.Mesh(moonGhostGeometry, bodyMaterials['Moon']);
    let sunGhost = new THREE.Mesh(sunGhostGeometry, bodyMaterials['Moon']);
    let moonEcl = new THREE.Mesh(moonGhostGeometry,  bodyMaterials['ghostMoon']);
	moonGhost.position.set(moonVec.x, moonVec.y, moonVec.z);
	sunGhost.position.set(sunVec.x, sunVec.y, sunVec.z);
	moonEcl.position.set(geoMoonVec.x, geoMoonVec.y, geoMoonVec.z);
	
	let eclipseTraceGeometry = new THREE.Geometry();
	eclipseTraceGeometry.vertices.push(new THREE.Vector3(0,0,0));
	eclipseTraceGeometry.vertices.push(sunVec);

	let eclipseTrace = new THREE.Line(eclipseTraceGeometry, new THREE.LineBasicMaterial({
	color: 0xffffcc,
	transparent: true,
	opacity: 1.0
	}));
	
	
	Object.assign(eclipse_obj, Astronomy.NextGlobalSolarEclipse(eclipse_obj.peak.date));
	
	thisGroup.add(moonEcl);
	thisGroup.add(moonGhost);
	thisGroup.add(sunGhost);
	thisGroup.add(eclipseTrace);
	eclipseGroup.add(thisGroup);
}





loadSphereData();
let zodiac = zodiacBelt(12);
scene.add(zodiac);
scene.add(sunProjection);


let earthGeometry = new THREE.SphereGeometry(1, 32, 32);
let earthMaterial = new THREE.MeshPhongMaterial({color: 0x0033ff});
let earthSphere = new THREE.Mesh(earthGeometry, bodyMaterials['Earth']);
earthSphere.layers.enable(1);
scene.add(earthSphere);


render();
