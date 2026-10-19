// Interactive 3D preview of the planned mosaic: every stud is rendered as a
// 1×1 plate with a stud on top, sitting on a baseplate. Drag to orbit,
// scroll or pinch to zoom, right-drag (or two fingers) to pan.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// Proportions in stud units (1 stud = 8 mm).
const PLATE_H = 0.4;     // 3.2 mm plate
const STUD_R = 0.3;      // 4.8 mm stud diameter
const STUD_H = 0.21;     // 1.7 mm stud height
const GAP = 0.04;        // seam between neighbouring bricks
const BASE_H = 0.3;

let renderer, scene, camera, controls, container;
let mosaic = null;       // { group, width, height }
let highlight = null;
let active = false;
let frame = 0;
let callbacks = {};
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const pickPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(PLATE_H + STUD_H));
const hit = new THREE.Vector3();

function mount(el, cbs = {}) {
  container = el;
  callbacks = cbs;

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.domElement.className = 'viewer3d-canvas';
  container.prepend(renderer.domElement);

  scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  scene.add(sun, sun.target);
  scene.userData.sun = sun;

  camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.screenSpacePanning = true;

  new ResizeObserver(resize).observe(container);
  resize();
  bindPointer();
}

function resize() {
  if (!renderer) return;
  const w = container.clientWidth || 1;
  const h = container.clientHeight || 1;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function disposeMosaic() {
  if (!mosaic) return;
  scene.remove(mosaic.group);
  mosaic.group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
  mosaic = null;
  highlight = null;
}

function setMosaic(result) {
  disposeMosaic();
  const { width, height, grid } = result;
  const group = new THREE.Group();
  const count = width * height;

  const brickGeo = new THREE.BoxGeometry(1 - GAP, PLATE_H, 1 - GAP);
  brickGeo.translate(0, PLATE_H / 2, 0);
  const studGeo = new THREE.CylinderGeometry(STUD_R, STUD_R, STUD_H, 20);
  studGeo.translate(0, PLATE_H + STUD_H / 2, 0);

  const plastic = () => new THREE.MeshStandardMaterial({ roughness: 0.32, metalness: 0, envMapIntensity: 0.6 });
  const bricks = new THREE.InstancedMesh(brickGeo, plastic(), count);
  const studs = new THREE.InstancedMesh(studGeo, plastic(), count);
  for (const mesh of [bricks, studs]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  }

  const m = new THREE.Matrix4();
  const color = new THREE.Color();
  const colorCache = {};
  let i = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const name = grid[y][x];
      if (!colorCache[name]) {
        const [r, g, b] = result.palette[name];
        colorCache[name] = new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
      }
      color.copy(colorCache[name]);
      m.makeTranslation(x - width / 2 + 0.5, 0, y - height / 2 + 0.5);
      bricks.setMatrixAt(i, m);
      studs.setMatrixAt(i, m);
      bricks.setColorAt(i, color);
      studs.setColorAt(i, color);
      i += 1;
    }
  }
  group.add(bricks, studs);

  const base = new THREE.Mesh(
    new THREE.BoxGeometry(width + 1, BASE_H, height + 1),
    new THREE.MeshStandardMaterial({ color: 0x8a8d91, roughness: 0.5 }),
  );
  base.position.y = -BASE_H / 2;
  base.receiveShadow = true;
  group.add(base);

  // Current build-guide row: a translucent band with a bright outline.
  const bandGeo = new THREE.BoxGeometry(width + 0.2, PLATE_H + STUD_H + 0.12, 1.08);
  highlight = new THREE.Group();
  highlight.add(new THREE.Mesh(bandGeo, new THREE.MeshBasicMaterial({
    color: 0xf5c518, transparent: true, opacity: 0.22, depthWrite: false,
  })));
  highlight.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(bandGeo),
    new THREE.LineBasicMaterial({ color: 0xf5c518 }),
  ));
  highlight.position.y = (PLATE_H + STUD_H) / 2;
  group.add(highlight);

  scene.add(group);
  mosaic = { group, width, height };

  // Fit the shadow camera to the mosaic.
  const sun = scene.userData.sun;
  const span = Math.max(width, height);
  sun.position.set(-span * 0.6, span * 1.2, span * 0.8);
  Object.assign(sun.shadow.camera, {
    left: -span, right: span, top: span, bottom: -span, near: 0.1, far: span * 4,
  });
  sun.shadow.camera.updateProjectionMatrix();

  controls.minDistance = 2;
  controls.maxDistance = span * 4;
  resetView();
}

function resetView() {
  if (!mosaic) return;
  const fit = Math.max(mosaic.width / camera.aspect, mosaic.height);
  const dist = (fit / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)))) * 1.2 + 2;
  // Look down at roughly 55° so the studs read as 3D straight away.
  camera.position.set(0, dist * 0.82, dist * 0.57);
  controls.target.set(0, 0, 0);
  controls.update();
}

function setRow(y) {
  if (!mosaic || !highlight) return;
  highlight.visible = y != null;
  if (y != null) highlight.position.z = y - mosaic.height / 2 + 0.5;
}

function setActive(on) {
  active = on;
  cancelAnimationFrame(frame);
  if (on) {
    resize();
    loop();
  }
}

function loop() {
  if (!active) return;
  frame = requestAnimationFrame(loop);
  controls.update();
  renderer.render(scene, camera);
}

// Pointer → stud under the cursor, by intersecting the ray with the plane
// at stud-top height (cheaper than raycasting tens of thousands of instances).
function cellFromEvent(e) {
  if (!mosaic) return null;
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  if (!raycaster.ray.intersectPlane(pickPlane, hit)) return null;
  const x = Math.floor(hit.x + mosaic.width / 2);
  const y = Math.floor(hit.z + mosaic.height / 2);
  if (x < 0 || y < 0 || x >= mosaic.width || y >= mosaic.height) return null;
  return { x, y, left: e.clientX - rect.left, top: e.clientY - rect.top };
}

function bindPointer() {
  const canvas = renderer.domElement;
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointerup', (e) => {
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) {
      const cell = cellFromEvent(e);
      if (cell) callbacks.onPick?.(cell);
    }
    down = null;
  });
  canvas.addEventListener('pointermove', (e) => {
    callbacks.onHover?.(e.buttons ? null : cellFromEvent(e));
  });
  canvas.addEventListener('pointerleave', () => callbacks.onHover?.(null));
}

window.Mosaic3D = { mount, setMosaic, setRow, setActive, resetView };
window.dispatchEvent(new Event('mosaic3d-ready'));
