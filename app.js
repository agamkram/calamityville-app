import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { DISASTER_TYPES, fetchDisasters, formatEventTime } from "./data.js";

const EARTH_RADIUS = 1;
const MOON_VISUAL_DISTANCE = 4.5;
const MOON_RADIUS = 0.26;
const PIN_ALTITUDE = 0.015;
const PIN_RADIUS = 0.011;
const AUTO_ROTATE_SPEED = 0.08;

const canvas = document.getElementById("globe-canvas");
const loadingEl = document.getElementById("loading");
const statusEl = document.getElementById("status");
const countEl = document.getElementById("event-count");
const sheetEl = document.getElementById("event-sheet");
const sheetBackdrop = document.getElementById("sheet-backdrop");
const sheetClose = document.getElementById("sheet-close");

let scene, camera, renderer, controls;
let earthGroup, earthMesh, moonMesh, pinsGroup, starfield;
let pinMeshes = [];
let currentHours = 24;
let animationId = null;
let clock = new THREE.Clock();
let autoRotate = true;

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

const textureLoader = new THREE.TextureLoader();

function latLonToPosition(lat, lon, radius) {
  const phi = THREE.MathUtils.degToRad(90 - lat);
  const theta = THREE.MathUtils.degToRad(lon + 180);
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta)
  );
}

function astronomyToScene(vec) {
  const norm = new THREE.Vector3(vec.x, vec.z, -vec.y).normalize();
  return norm.multiplyScalar(MOON_VISUAL_DISTANCE);
}

function updateMoon() {
  const time = new Astronomy.AstroTime(new Date());
  const vec = Astronomy.GeoVector(Astronomy.Body.Moon, time, false);
  moonMesh.position.copy(astronomyToScene(vec));
}

/** Start with Earth and Moon both in frame — camera opposite the Moon. */
function aimCameraForMoon() {
  updateMoon();
  const moonDir = moonMesh.position.clone().normalize();
  const camDist = 3.2;
  camera.position.copy(moonDir.multiplyScalar(-camDist));
  camera.position.y += 0.35;
  camera.lookAt(0, 0, 0);
}

/** Real all-sky star map (Tycho catalog + Milky Way), CC BY 4.0 Solar System Scope. */
function createStarfield() {
  const tex = textureLoader.load("stars-milky-way.jpg");
  tex.colorSpace = THREE.SRGBColorSpace;
  const geo = new THREE.SphereGeometry(120, 64, 32);
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.renderOrder = -1;
  return sky;
}

function createEarth() {
  earthGroup = new THREE.Group();
  scene.add(earthGroup);

  const geo = new THREE.SphereGeometry(EARTH_RADIUS, 64, 64);
  const earthTex = textureLoader.load(
    "https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg"
  );
  earthTex.colorSpace = THREE.SRGBColorSpace;
  const bumpTex = textureLoader.load(
    "https://unpkg.com/three-globe/example/img/earth-topology.png"
  );
  const nightTex = textureLoader.load(
    "https://unpkg.com/three-globe/example/img/earth-night.jpg"
  );
  nightTex.colorSpace = THREE.SRGBColorSpace;

  const mat = new THREE.MeshPhongMaterial({
    map: earthTex,
    emissiveMap: nightTex,
    emissive: new THREE.Color(0xffeedd),
    emissiveIntensity: 0.55,
    bumpMap: bumpTex,
    bumpScale: 0.04,
    specular: new THREE.Color(0x333333),
    shininess: 6,
  });

  earthMesh = new THREE.Mesh(geo, mat);
  earthGroup.add(earthMesh);

  pinsGroup = new THREE.Group();
  earthGroup.add(pinsGroup);

  const atmosGeo = new THREE.SphereGeometry(EARTH_RADIUS * 1.015, 64, 64);
  const atmosMat = new THREE.MeshPhongMaterial({
    color: 0x4a9eff,
    transparent: true,
    opacity: 0.08,
    side: THREE.BackSide,
  });
  earthGroup.add(new THREE.Mesh(atmosGeo, atmosMat));
}

function createMoon() {
  const geo = new THREE.SphereGeometry(MOON_RADIUS, 32, 32);
  const tex = textureLoader.load("moon.jpg");
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshPhongMaterial({
    map: tex,
    emissive: new THREE.Color(0x888899),
    emissiveIntensity: 0.25,
    shininess: 4,
  });
  moonMesh = new THREE.Mesh(geo, mat);
  scene.add(moonMesh);
  updateMoon();
}

function createLights() {
  scene.add(new THREE.HemisphereLight(0x8899bb, 0x223344, 0.85));
  scene.add(new THREE.AmbientLight(0x445566, 0.45));
  const sun = new THREE.DirectionalLight(0xfff8f0, 1.5);
  sun.position.set(5, 2, 3);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x6688cc, 0.65);
  fill.position.set(-3, 0.5, -4);
  scene.add(fill);
}

function clearPins() {
  for (const pin of pinMeshes) {
    pinsGroup.remove(pin);
    pin.geometry?.dispose();
    pin.material?.dispose();
  }
  pinMeshes = [];
}

function createPin(event) {
  const typeInfo = DISASTER_TYPES[event.type] || { color: "#ffffff" };
  const pos = latLonToPosition(event.lat, event.lon, EARTH_RADIUS + PIN_ALTITUDE);

  const geo = new THREE.SphereGeometry(PIN_RADIUS, 10, 10);
  const mat = new THREE.MeshBasicMaterial({ color: typeInfo.color });
  const pin = new THREE.Mesh(geo, mat);
  pin.position.copy(pos);
  pin.userData.event = event;

  pinsGroup.add(pin);
  pinMeshes.push(pin);
}

function setPins(events) {
  clearPins();
  for (const ev of events) {
    if (Number.isFinite(ev.lat) && Number.isFinite(ev.lon)) createPin(ev);
  }
  countEl.textContent = `${events.length} event${events.length === 1 ? "" : "s"}`;
}

function showEventSheet(event) {
  const typeInfo = DISASTER_TYPES[event.type] || { label: "Event", color: "#fff" };
  document.getElementById("sheet-type").textContent = typeInfo.label;
  document.getElementById("sheet-type").style.color = typeInfo.color;
  document.getElementById("sheet-title").textContent = event.title;
  document.getElementById("sheet-time").textContent = formatEventTime(event.time);
  document.getElementById("sheet-desc").textContent = event.description || "";
  document.getElementById("sheet-source").textContent = event.source || "";
  const link = document.getElementById("sheet-link");
  if (event.url) {
    link.href = event.url;
    link.style.display = "";
  } else {
    link.style.display = "none";
  }
  sheetEl.classList.add("open");
  sheetBackdrop.classList.add("open");
  autoRotate = false;
}

function hideEventSheet() {
  sheetEl.classList.remove("open");
  sheetBackdrop.classList.remove("open");
  autoRotate = true;
}

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", isError);
}

async function loadEvents(hours) {
  currentHours = hours;
  loadingEl.classList.add("visible");
  setStatus("Loading events…");
  try {
    const { events, errors } = await fetchDisasters(hours);
    setPins(events);
    if (errors.length) {
      setStatus(`Loaded with partial data (${errors.join(", ")} unavailable)`);
    } else {
      setStatus(`Past ${hours} hours`);
    }
  } catch (err) {
    setStatus("Failed to load events", true);
    console.error(err);
  } finally {
    loadingEl.classList.remove("visible");
  }
}

function onPointerDown(event) {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(pinMeshes, false);
  if (hits.length > 0 && hits[0].object.userData.event) {
    showEventSheet(hits[0].object.userData.event);
    event.preventDefault();
  }
}

function initScene() {
  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
  camera.position.set(0, 0.4, 3.2);

  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x020308);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  starfield = createStarfield();
  scene.add(starfield);

  createLights();
  createEarth();
  createMoon();
  aimCameraForMoon();

  controls = new OrbitControls(camera, canvas);
  controls.enablePan = false;
  controls.minDistance = 1.5;
  controls.maxDistance = 14;
  controls.enableDamping = false;
  controls.rotateSpeed = 0.65;
  controls.zoomSpeed = 6.5;
  controls.enableZoom = true;

  canvas.addEventListener("pointerdown", onPointerDown);
  sheetClose.addEventListener("click", hideEventSheet);
  sheetBackdrop.addEventListener("click", hideEventSheet);

  document.querySelectorAll(".time-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".time-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      loadEvents(Number(btn.dataset.hours));
    });
  });
}

function resize() {
  const app = document.getElementById("app");
  const w = app?.clientWidth || document.getElementById("fit-stage")?.clientWidth;
  const h = app?.clientHeight || document.getElementById("fit-stage")?.clientHeight;
  if (!w || !h) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}

function animate() {
  animationId = requestAnimationFrame(animate);
  const delta = clock.getDelta();

  if (autoRotate) {
    earthGroup.rotation.y += AUTO_ROTATE_SPEED * delta;
  }

  updateMoon();
  controls.update();
  renderer.render(scene, camera);
}

export function bootGlobe() {
  initScene();
  resize();
  animate();
  loadEvents(currentHours);
  return { resize };
}

export function destroyGlobe() {
  if (animationId) cancelAnimationFrame(animationId);
  controls?.dispose();
  renderer?.dispose();
}