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


// Define RA (in hours) and DEC (in degrees)
let pointsRADec = [
    { ra: 2, dec: 10 },
    { ra: 6, dec: 10 },
    { ra: 6, dec: 70 },
  ];
  
  // Convert RA from hours to radians, and DEC from degrees to radians
  let points = pointsRADec.map(point => {
      let raRad = THREE.MathUtils.degToRad(point.ra * 15); // 15 degrees per hour
      let decRad = THREE.MathUtils.degToRad(point.dec);
      // Convert spherical coordinates to Cartesian coordinates
      let x = 50 * Math.cos(decRad) * Math.cos(raRad);
      let y = 50 * Math.cos(decRad) * Math.sin(raRad);
      let z = 50 * Math.sin(decRad);
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





loadSphereData();

function render() {
	requestAnimationFrame(render);	
	renderer.render(scene, camera);
}


render();
