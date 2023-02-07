// filename: main.js
// Create a scene
const scene = new THREE.Scene();

// Create a camera
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);

// Create a renderer
const renderer = new THREE.WebGLRenderer();
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// Create a sphere geometry
const sphereGeometry = new THREE.SphereGeometry(5, 32, 32);

// Create a material for the sphere
const sphereMaterial = new THREE.MeshStandardMaterial({color: 0xff0000});
sphereMaterial.transparent = true;
sphereMaterial.opacity = 0.8;

// Create a mesh with the sphere geometry and material
const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
const light = new THREE.AmbientLight(0x404040); // soft white light
scene.add(light);
// Add the sphere to the scene
scene.add(sphere);



// Create a larger sphere geometry
const largerSphereGeometry = new THREE.SphereGeometry(20, 32, 32);

// Create a material for the larger sphere
const largerSphereMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff });
largerSphereMaterial.transparent = true;
largerSphereMaterial.opacity = 0.2;
// Create a mesh for the larger sphere
const largerSphere = new THREE.Mesh(largerSphereGeometry, largerSphereMaterial);

// Add the larger sphere to the scene
scene.add(largerSphere);

// Create an array to store the dot meshes
const dotMeshes = [];

// Create a dot geometry
const dotGeometry = new THREE.SphereGeometry(0.1, 32, 32);

// Create a material for the dots
const dotMaterial = new THREE.MeshStandardMaterial({ color: 0xff0000 });

const mainSpherePos = sphere.position.clone();

// Iterate over the points on the surface of the main sphere
largerSphere.geometry.vertices.forEach((vertex) => {
    // Scale the vertex position to match the larger sphere
    /* vertex.multiplyScalar(largerSphere.geometry.parameters.radius / sphere.geometry.parameters.radius);

    // Create a mesh for the dot
    const dotMesh = new THREE.Mesh(dotGeometry, dotMaterial);

    // Position the dot mesh at the vertex position
    dotMesh.position.set(vertex.x, vertex.y, vertex.z);

    // Add the dot mesh to the scene
    largerSphere.add(dotMesh);

    // Add the dot mesh to the array
    dotMeshes.push(dotMesh); */
	vertex.add(mainSpherePos);

    // Create a mesh for the dot
    const dotMesh = new THREE.Mesh(dotGeometry, dotMaterial);

    // Position the dot mesh at the vertex position
    dotMesh.position.set(vertex.x, vertex.y, vertex.z);

    // Add the dot mesh to the scene
    scene.add(dotMesh);

    // Add the dot mesh to the array
    dotMeshes.push(dotMesh);
	
});



camera.position.z = 10;
camera.lookAt(sphere.position);


///GRID



let zoomSpeed = 0.1;

//drag movement.
let cameraIsDragging = false;
let cameraInitialPosition;
let cameraTargetPosition;

const initialCameraPosition = camera.position.clone();
const initialCameraSphereDistance = camera.position.distanceTo(sphere.position);

// Add drag functionality to the camera
let isDragging = false;
let initialMousePosition;
let targetRotation = { x: 0, y: 0 };

function onDocumentMouseDown(event) {
    event.preventDefault();
    isDragging = true;
    initialMousePosition = { x: event.clientX, y: event.clientY };
    targetRotation = { x: camera.rotation.x, y: camera.rotation.y };
	//camera.position.y = initialCameraPosition.y;
			
}

function onDocumentMouseMove(event) {
    event.preventDefault();
    if (isDragging) {
        const xDiff = event.clientX - initialMousePosition.x;
        const yDiff = event.clientY - initialMousePosition.y;
        camera.rotation.x = targetRotation.x + yDiff * 0.00;
        //camera.rotation.y = targetRotation.y + xDiff * 0.01;
        //camera.position.x = camera.position.x +  xDiff * 0.01;
        camera.position.y = camera.position.z * Math.cos(xDiff * 0.01) - camera.position.x * Math.sin(xDiff * 0.01);
        //camera.position.y = camera.position.y * Math.cos(camera.rotation.x) - camera.position.z * Math.sin(camera.rotation.x);
        camera.lookAt(sphere.position);
    }
}

function onDocumentMouseUp(event) {
    event.preventDefault();
    isDragging = false;
}
//end drfag

function onMouseWheel(event) {
    event.preventDefault();
    camera.position.z -= event.deltaY * zoomSpeed;
    camera.lookAt(sphere.position);
}
document.addEventListener("mousewheel", onMouseWheel, false);
// Listen for mouse wheel events
document.addEventListener("mousedown", onDocumentMouseDown, false);
document.addEventListener("mousemove", onDocumentMouseMove, false);
document.addEventListener("mouseup", onDocumentMouseUp, false);

/* // Create a material for the front half of the smaller sphere
const frontMaterial = new THREE.MeshStandardMaterial({ color: 0xff0000 });

// Create a material for the back half of the smaller sphere
const backMaterial = new THREE.MeshStandardMaterial({ color: 0x00ff00 });

// Create a new smaller sphere geometry with a new index buffer
const smallerSphereGeometry = new THREE.SphereGeometry(5, 32, 32, 0, Math.PI * 2, 0, Math.PI);

// Create a mesh for the smaller sphere
const smallerSphere = new THREE.Mesh(smallerSphereGeometry, frontMaterial);

// Add the smaller sphere to the scene
scene.add(smallerSphere);

// Create a new mesh for the back half of the smaller sphere
const backHalf = new THREE.Mesh(smallerSphereGeometry, backMaterial);

// Flip the normals of the back half
backHalf.geometry.computeFlippedNormals();

// Position the back half of the smaller sphere behind the front half
backHalf.position.z = -5;

// Add the back half of the smaller sphere to the scene
//scene.add(backHalf); */



const smallerSphereGeometry = new THREE.SphereGeometry(2, 32, 32);
const smallerSphereMaterial = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
const smallerSphere = new THREE.Mesh(smallerSphereGeometry, smallerSphereMaterial);

// Position the smaller sphere at a distance from the main sphere
smallerSphere.position.x = 8;

// Add the smaller sphere to the scene
scene.add(smallerSphere);



// Create a grid helper
const size = 10;
const divisions = 10;
const gridHelper = new THREE.GridHelper(size, divisions);
gridHelper.position.set(sphere.position.x, sphere.position.y, sphere.position.z);
gridHelper.rotation.x = Math.PI / 2;

// Create a axis helper
const axisHelper = new THREE.AxesHelper(size);
axisHelper.position.set(sphere.position.x, sphere.position.y, sphere.position.z);



// Create text labels for the axis
const xTextGeometry = new THREE.TextGeometry('X', {
  size: 0.5,
  height: 0.2
});
const xTextMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });
const xText = new THREE.Mesh(xTextGeometry, xTextMaterial);
xText.position.set(size + 0.5, 0, 0);

const yTextGeometry = new THREE.TextGeometry('Y', {
  //font: new THREE.Font(fontJSON),
  size: 0.5,
  height: 0.2
});
const yTextMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
const yText = new THREE.Mesh(yTextGeometry, yTextMaterial);
yText.position.set(0, size + 0.5, 0);

const zTextGeometry = new THREE.TextGeometry('Z', {
  //font: new THREE.Font(fontJSON),
  size: 0.5,
  height: 0.2
});
const zTextMaterial = new THREE.MeshBasicMaterial({ color: 0x0000ff });
const zText = new THREE.Mesh(zTextGeometry, zTextMaterial);
zText.position.set(0, 0, size + 0.5);


// Add the grid and axis helpers to the scene
scene.add(gridHelper);
scene.add(axisHelper);
scene.add(xText);
//scene.add(yText);
//scene.add(zText);
///


// render the scene
function render() {
    requestAnimationFrame(render);
    smallerSphere.rotation.y += 0.01;
    smallerSphere.position.x = 8 * Math.cos(smallerSphere.rotation.y);
    smallerSphere.position.z = 8 * Math.sin(smallerSphere.rotation.y);
    sphere.rotation.x += 0.01;
    sphere.rotation.y += 0.01;
    renderer.render(scene, camera);
}
render();