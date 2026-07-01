import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { DISASTER_TYPES, fetchDisasters, formatEventTime } from "./data.js";

const EARTH_RADIUS = 1;
const MOON_VISUAL_DISTANCE = 4.5;
const MOON_RADIUS = 0.26;
const PIN_ALTITUDE = 0.015;
const PIN_RADIUS = 0.011;
const POLE_LIMIT = THREE.MathUtils.degToRad(12);

const canvas = document.getElementById("globe-canvas");
const loadingEl = document.getElementById("loading");
const statusEl = document.getElementById("status");
const countEl = document.getElementById("event-count");
const sheetEl = document.getElementById("event-sheet");
const sheetBackdrop = document.getElementById("sheet-backdrop");
const sheetClose = document.getElementById("sheet-close");

let scene, camera, renderer, controls;
let earthGroup, earthMesh, moonGroup, moonMesh, moonEarthshine, pinsGroup;
let pinMeshes = [];
let allEvents = [];
let currentHours = 24;
let viewCenter = "earth";
let animationId = null;

const activeTypes = new Set(Object.keys(DISASTER_TYPES));
const EARTH_TARGET = new THREE.Vector3(0, 0, 0);
const _viewDir = new THREE.Vector3();
const _toEarth = new THREE.Vector3();
const _zAxis = new THREE.Vector3(0, 0, 1);
const MOON_MAP_URL = "moon-map.jpg";
const MOON_BUMP_URL = "moon-bump.jpg";

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

const textureLoader = new THREE.TextureLoader();
const STAR_MAP_URL = "stars-8k.jpg";

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
  moonGroup.position.copy(astronomyToScene(vec));

  _toEarth.copy(moonGroup.position).negate().normalize();
  moonGroup.quaternion.setFromUnitVectors(_zAxis, _toEarth);

  if (moonEarthshine) {
    moonEarthshine.position.copy(_toEarth).multiplyScalar(-10);
  }
}

/** Start with Earth and Moon both in frame — camera opposite the Moon. */
function aimCameraForMoon() {
  updateMoon();
  const moonDir = moonGroup.position.clone().normalize();
  const camDist = 3.2;
  camera.position.copy(moonDir.multiplyScalar(-camDist));
  camera.position.y += 0.35;
  camera.lookAt(EARTH_TARGET);
}

function setViewCenter(center) {
  viewCenter = center;
  document.querySelectorAll(".center-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.center === center);
  });

  if (center === "moon") {
    controls.target.copy(moonGroup.position);
    controls.minDistance = 0.4;
    controls.maxDistance = 2.2;
    _viewDir.copy(camera.position).sub(controls.target);
    if (_viewDir.length() < 0.5) _viewDir.set(0.1, 0.15, 1);
    _viewDir.normalize().multiplyScalar(0.85);
    camera.position.copy(moonGroup.position).add(_viewDir);
  } else {
    controls.target.copy(EARTH_TARGET);
    controls.minDistance = 1.5;
    controls.maxDistance = 14;
    _viewDir.copy(camera.position).sub(controls.target);
    if (_viewDir.length() < 1) _viewDir.set(0, 0.12, 1);
    _viewDir.normalize().multiplyScalar(3.2);
    camera.position.copy(EARTH_TARGET).add(_viewDir);
  }
  controls.update();
}

function configureSkyTexture(tex) {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  if (renderer) {
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  }
}

/** 8K Tycho + Milky Way equirectangular sky (CC BY 4.0 Solar System Scope). */
function loadStarBackground() {
  textureLoader.load(STAR_MAP_URL, (tex) => {
    configureSkyTexture(tex);
    scene.background = tex;
  });
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
    emissiveIntensity: 1.2,
    bumpMap: bumpTex,
    bumpScale: 0.04,
    specular: new THREE.Color(0x444444),
    shininess: 5,
  });
  mat.color.multiplyScalar(1.25);

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
  moonGroup = new THREE.Group();
  scene.add(moonGroup);

  const geo = new THREE.SphereGeometry(MOON_RADIUS, 96, 96);
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  const tex = textureLoader.load(MOON_MAP_URL);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;

  const bump = textureLoader.load(MOON_BUMP_URL);
  bump.anisotropy = maxAniso;

  const mat = new THREE.MeshStandardMaterial({
    map: tex,
    bumpMap: bump,
    bumpScale: 0.045,
    roughness: 0.82,
    metalness: 0.02,
    emissive: new THREE.Color(0x1a1a24),
    emissiveIntensity: 0.12,
  });
  mat.color.multiplyScalar(1.08);

  moonMesh = new THREE.Mesh(geo, mat);
  moonMesh.rotation.y = Math.PI;
  moonGroup.add(moonMesh);
  updateMoon();
}

function createLights() {
  scene.add(new THREE.HemisphereLight(0xd0e0f8, 0x7a8a9e, 2.2));
  scene.add(new THREE.AmbientLight(0x99aabb, 1.2));
  const sun = new THREE.DirectionalLight(0xfff8f0, 1.55);
  sun.position.set(5, 2, 3);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xbbccdd, 1.4);
  fill.position.set(-5, 1, -4);
  scene.add(fill);
  moonEarthshine = new THREE.DirectionalLight(0xb0c0d8, 0.75);
  scene.add(moonEarthshine);
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

function updateEventCount(visible, total) {
  if (visible === total) {
    countEl.textContent = `${total} event${total === 1 ? "" : "s"}`;
  } else {
    countEl.textContent = `${visible} of ${total} events`;
  }
}

function applyPinFilter() {
  clearPins();
  const visible = allEvents.filter((ev) => activeTypes.has(ev.type));
  for (const ev of visible) {
    if (Number.isFinite(ev.lat) && Number.isFinite(ev.lon)) createPin(ev);
  }
  updateEventCount(visible.length, allEvents.length);
}

function setPins(events) {
  allEvents = events;
  applyPinFilter();
}

function toggleLegendType(type) {
  if (activeTypes.has(type)) {
    activeTypes.delete(type);
  } else {
    activeTypes.add(type);
  }
  document.querySelectorAll(".legend-item").forEach((btn) => {
    const on = activeTypes.has(btn.dataset.type);
    btn.classList.toggle("active", on);
    btn.classList.toggle("off", !on);
    btn.setAttribute("aria-pressed", String(on));
  });
  applyPinFilter();
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
}

function hideEventSheet() {
  sheetEl.classList.remove("open");
  sheetBackdrop.classList.remove("open");
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
  renderer.toneMappingExposure = 1.2;

  loadStarBackground();

  createLights();
  createEarth();
  createMoon();
  aimCameraForMoon();

  controls = new OrbitControls(camera, canvas);
  controls.target.copy(EARTH_TARGET);
  controls.enablePan = false;
  controls.minDistance = 1.5;
  controls.maxDistance = 14;
  controls.enableDamping = false;
  controls.rotateSpeed = 0.65;
  controls.zoomSpeed = 6.5;
  controls.enableZoom = true;
  camera.up.set(0, 1, 0);
  controls.minPolarAngle = POLE_LIMIT;
  controls.maxPolarAngle = Math.PI - POLE_LIMIT;

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

  document.querySelectorAll(".center-btn").forEach((btn) => {
    btn.addEventListener("click", () => setViewCenter(btn.dataset.center));
  });

  document.querySelectorAll(".legend-item").forEach((btn) => {
    btn.addEventListener("click", () => toggleLegendType(btn.dataset.type));
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

  updateMoon();
  if (viewCenter === "moon") {
    controls.target.copy(moonGroup.position);
  }
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