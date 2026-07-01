import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { DISASTER_TYPES, fetchDisasters, formatEventTime } from "./data.js";

const EARTH_RADIUS = 1;
const MOON_VISUAL_DISTANCE = 7;
const MOON_RADIUS = 0.18;
const PIN_ALTITUDE = 0.02;
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

function createStarfield() {
  const count = 4000;
  const positions = new Float32Array(count * 3);
  const radius = 80;
  for (let i = 0; i < count; i++) {
    const u = Math.random();
    const v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const r = radius * (0.85 + Math.random() * 0.15);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 0.35,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.85,
  });
  return new THREE.Points(geo, mat);
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

  const mat = new THREE.MeshPhongMaterial({
    map: earthTex,
    bumpMap: bumpTex,
    bumpScale: 0.04,
    specular: new THREE.Color(0x222222),
    shininess: 8,
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
  const mat = new THREE.MeshPhongMaterial({ map: tex, shininess: 4 });
  moonMesh = new THREE.Mesh(geo, mat);
  scene.add(moonMesh);
  updateMoon();
}

function createLights() {
  scene.add(new THREE.AmbientLight(0x334466, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(5, 2, 3);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x4466aa, 0.3);
  fill.position.set(-4, -1, -2);
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

  const geo = new THREE.SphereGeometry(0.025, 12, 12);
  const mat = new THREE.MeshBasicMaterial({ color: typeInfo.color });
  const pin = new THREE.Mesh(geo, mat);
  pin.position.copy(pos);
  pin.userData.event = event;

  const glowGeo = new THREE.SphereGeometry(0.04, 12, 12);
  const glowMat = new THREE.MeshBasicMaterial({
    color: typeInfo.color,
    transparent: true,
    opacity: 0.35,
  });
  const glow = new THREE.Mesh(glowGeo, glowMat);
  pin.add(glow);

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

  controls = new OrbitControls(camera, canvas);
  controls.enablePan = false;
  controls.minDistance = 1.6;
  controls.maxDistance = 12;
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.rotateSpeed = 0.5;

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
  const stage = document.getElementById("fit-stage");
  const w = stage.clientWidth;
  const h = stage.clientHeight;
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