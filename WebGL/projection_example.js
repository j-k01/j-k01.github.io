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
scene.add(light);

const loader = new THREE.FontLoader();


const superRadius = 200;
// Add a 10 by 10 by 10 sphere at the origin
const sphereGeometry = new THREE.SphereGeometry(5, 32, 32); // Note that the first parameter 5 is the radius of the sphere, so the diameter is 10
const sphereMaterial = new THREE.MeshPhongMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 }); // Change the color to whatever you want, added transparency and opacity
const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
scene.add(sphere);

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

function mapValue(value, inputMin, inputMax, outputMin, outputMax) {
    return outputMin + (outputMax - outputMin) * ((value - inputMin) / (inputMax - inputMin));
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


function createInstancedStars2() {

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

    let instancedStars2 = new THREE.InstancedMesh(star, newMaterial, starCount);
	instancedStars2.name = 'instancedStars2';
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

        let position = new THREE.Vector3();
        position.setFromMatrixPosition(positionMatrix);

        let positionVector = new THREE.Vector3();
        positionVector.x = (superRadius + 100)*position.x/(position.y+100);
        positionVector.z = (superRadius + 100)*position.z/(position.y+100);
        positionVector.y = superRadius;

        positionMatrix.setPosition(positionVector);
        if(entry.DEC > 0){
            instancedStars2.setMatrixAt(index, positionMatrix);
        };            
                
    });
    instancedStars2.instanceMatrix.needsUpdate = true;
    scene.add(instancedStars2);
	
	
		return {
    'instancedStars': instancedStars2,
    'starMap': starMap
	};
	}

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

    function createStarLines2(){

        let spectral_lineMaterial = new THREE.LineBasicMaterial({
          color: 0x87CEEB, // a faint blue color
          linewidth: 0.5, // a thin line
          transparent: true, // allow transparency
          opacity: 0.8 // make the line slightly transparent
        });
    
        starCultureNames.STELLA.map(key => {
            for(var i = 0; i < starCulture[key].length; i++) {
            
                myMat = new THREE.Matrix4();
                instancedStars2.getMatrixAt(starMap2.get(starCulture[key][i][0]), myMat);
                let position1 = new THREE.Vector3().setFromMatrixPosition(myMat);
                instancedStars2.getMatrixAt(starMap2.get(starCulture[key][i][1]), myMat);
                let position2 = new THREE.Vector3().setFromMatrixPosition(myMat);
                
                let geometry = new THREE.BufferGeometry().setFromPoints([position1, position2]);
            
                // Create a line
                let line = new THREE.Line(geometry, spectral_lineMaterial);
                if ((position1.x == 0 && position1.y == 0 && position1.z == 0) || (position2.x == 0 && position2.y == 0 && position2.z == 0)){
                    console.log('skip')
                }
                else {
                scene.add(line);
                }
        }
        });
    }
	
async function loadSphereData() {
    let response = await fetch('starcatalogue.json');
    starData = await response.json();
    starData = starData.filter(entry => entry.MAG < 6.6);
    starCount = starData.length;
	myObj = createInstancedStars();
	myObj2 = createInstancedStars2();
	instancedStars = myObj.instancedStars;
	instancedStars2 = myObj2.instancedStars;
	starMap = myObj.starMap;
	starMap2 = myObj2.starMap;
	
	response = await fetch('starCulture.json');
    starCulture = await response.json();
	
	response = await fetch('starCultureNames.json');
    starCultureNames = await response.json();
	createStarLines();
    createStarLines2();
}


// Define RA (in hours) and DEC (in degrees)
//let pointsRADec = [
//    { ra: 2, dec: 10 },
//    { ra: 6, dec: 10 },
//    { ra: 6, dec: 70 },
//  ];

  let pointsRADec = [
    { ra: 2, dec: 0 },
    { ra: 4, dec: 0 },
    { ra: 6, dec: 0 },
    { ra: 8, dec: 0 },
    { ra: 10, dec: 0 },
    { ra: 12, dec: 0 },
    { ra: 14, dec: 0 },
    { ra: 16, dec: 0 },
    { ra: 18, dec: 0 },
    { ra: 20, dec: 0 },
    { ra: 22, dec: 0 },
    { ra: 24, dec: 0 },
    { ra: 2, dec: 30 },
    { ra: 4, dec: 30 },
    { ra: 6, dec: 30 },
    { ra: 8, dec: 30 },
    { ra: 10, dec: 30 },
    { ra: 12, dec: 30 },
    { ra: 14, dec: 30 },
    { ra: 16, dec: 30 },
    { ra: 18, dec: 30 },
    { ra: 20, dec: 30 },
    { ra: 22, dec: 30 },
    { ra: 24, dec: 30 },
    { ra: 2, dec: 45 },
    { ra: 4, dec: 45 },
    { ra: 6, dec: 45 },
    { ra: 8, dec: 45 },
    { ra: 10, dec: 45 },
    { ra: 12, dec: 45 },
    { ra: 14, dec: 45 },
    { ra: 16, dec: 45 },
    { ra: 18, dec: 45 },
    { ra: 20, dec: 45 },
    { ra: 22, dec: 45 },
    { ra: 24, dec: 45 },
    { ra: 2, dec: 60 },
    { ra: 4, dec: 60 },
    { ra: 6, dec: 60 },
    { ra: 8, dec: 60 },
    { ra: 10, dec: 60 },
    { ra: 12, dec: 60 },
    { ra: 14, dec: 60 },
    { ra: 16, dec: 60 },
    { ra: 18, dec: 60 },
    { ra: 20, dec: 60 },
    { ra: 22, dec: 60 },
    { ra: 24, dec: 60 },
  ];
  
  // Convert RA from hours to radians, and DEC from degrees to radians
  let points = pointsRADec.map(point => {
      let raRad = THREE.MathUtils.degToRad(point.ra * 15); // 15 degrees per hour
      let decRad = THREE.MathUtils.degToRad(point.dec);
      // Convert spherical coordinates to Cartesian coordinates
      let x = 100 * Math.cos(raRad)* Math.cos(decRad);
      let y = 100 * Math.sin(decRad);
      let z = 100 * Math.sin(raRad) * Math.cos(decRad);
      
      return new THREE.Vector3(x, y, z);
  });

// Create geometry and material for the points
let geometry = new THREE.BufferGeometry().setFromPoints(points);
let material = new THREE.PointsMaterial({color: 0xff0000, size: 2.0});

// Create point cloud and add it to the scene
let pointCloud = new THREE.Points(geometry, material);
scene.add(pointCloud);

let spectral_lineMaterial = new THREE.LineBasicMaterial({
    color: 0xff0000, // a faint blue color
    linewidth: 0.5, // a thin line
    transparent: true, // allow transparency
    opacity: 0.8 // make the line slightly transparent
  });


for(let i = 0; i < points.length; i++) {
    let geometry = new THREE.BufferGeometry().setFromPoints([points[i], points[(i + 1) % points.length]]);
    
    let line = makeArc(points[i].clone(), points[(i + 1) % points.length].clone(), 12, false);
    line.material = spectral_lineMaterial;
    scene.add(line);
}

let points2 = pointsRADec.map(point => {
    let raRad = THREE.MathUtils.degToRad(point.ra * 15); // 15 degrees per hour
    let decRad = THREE.MathUtils.degToRad(point.dec);
    // Convert spherical coordinates to Cartesian coordinates
    let x = 100 * Math.cos(decRad) * Math.cos(raRad);
    let z = 100 * Math.cos(decRad) * Math.sin(raRad);
    let y = 100 * Math.sin(decRad);



    x = (superRadius+100)*x/(y+100);
    z = (superRadius+100)*z/(y+100);


    return new THREE.Vector3(x, superRadius, z);
});

let geometry2 = new THREE.BufferGeometry().setFromPoints(points2);
let material2 = new THREE.PointsMaterial({color: 0x00ff00, size: 2.0});

// Create point cloud and add it to the scene
let pointCloud2 = new THREE.Points(geometry2, material2);
scene.add(pointCloud2);

function createLine(point1, point2, color = 0xffff00) {
    // Create a buffer geometry and set its vertices to the two points
    let geometry = new THREE.BufferGeometry().setFromPoints([point1, point2]);

    // Create a basic line material
    let material = new THREE.LineBasicMaterial({color: color});

    // Create a line
    let line = new THREE.Line(geometry, material);

    return line;
}

for(let i = 0; i < points2.length; i++) {
    let newline = createLine(points2[i], new THREE.Vector3(0, -100, 0));
    scene.add(newline);
}





function stereographicProjection(az, alt) {
    // Convert angles from degrees to radians
    console.log(az,alt);
    let azRad = THREE.MathUtils.degToRad(az);
    let altRad = THREE.MathUtils.degToRad(alt); // 90 - alt because altitude is the complement of the polar angle

    console.log(azRad,altRad);
    // Convert spherical coordinates to Cartesian coordinates
    let x = 50 * Math.cos(altRad) * Math.cos(azRad);
    let y = 50 * Math.cos(altRad) * Math.sin(azRad);
    let z = 50 * Math.sin(altRad);

    console.log(x,y,z);
    // Perform the stereographic projection
    let xProj = x / (2*50 - y);
    let zProj = z / (2*50 - y);

    return { x: xProj, y: radius, z: zProj };
}


loadSphereData();

function render() {
	requestAnimationFrame(render);	
	renderer.render(scene, camera);
}


render();
