import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { DISASTER_TYPES, fetchDisasters, formatEventTime } from "./data.js";

const EARTH_RADIUS = 1;
const MOON_VISUAL_DISTANCE = 4.5;
const MOON_RADIUS = 0.26;
const SUN_VISUAL_DISTANCE = 85;
const SUN_RADIUS = 0.5;
// Sun LOD (Solar System Scope photosphere, CC BY 4.0):
//   low:  sun-2k.jpg (~800 KB) — always loaded
//   high: sun-8k.jpg (~3.5 MB) — lazy on Sun center
const SUN_LOD = {
  low: { map: "sun-2k.jpg", segments: 64 },
  high: { map: "sun-8k.jpg", segments: 96 },
};

const SUN_VERTEX_SHADER = `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  void main() {
    vUv = uv;
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    vViewPosition = -mvPos.xyz;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * mvPos;
  }
`;

const SUN_FRAGMENT_SHADER = `
  uniform sampler2D sunMap;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  void main() {
    vec3 viewDir = normalize(vViewPosition);
    float limb = pow(max(dot(normalize(vNormal), viewDir), 0.0), 0.5);
    vec3 surface = texture2D(sunMap, vUv).rgb;
    vec3 core = surface * vec3(1.4, 1.2, 0.95);
    vec3 edge = surface * vec3(0.7, 0.38, 0.1);
    vec3 color = mix(edge, core, limb);
    gl_FragColor = vec4(color, 1.0);
  }
`;
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
let earthGroup, earthMesh, moonGroup, moonMesh, moonEarthshine, sunGroup, sunMesh, sunLight, fillLight, pinsGroup;
let moonLodLevel = "low";
let moonHqPromise = null;
let sunLodLevel = "low";
let sunHqPromise = null;
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
// Moon LOD (Solar System Scope albedo, CC BY 4.0):
//   low:  moon-2k.jpg + moon-normal-2k.jpg  (~2 MB) — always loaded
//   high: moon-8k.jpg + moon-normal-4k.jpg  (~19 MB) — lazy on Moon center
const MOON_LOD = {
  low: {
    map: "moon-2k.jpg",
    normal: "moon-normal-2k.jpg",
    segments: 96,
    normalScale: 1.35,
  },
  high: {
    map: "moon-8k.jpg",
    normal: "moon-normal-4k.jpg",
    segments: 128,
    normalScale: 2.0,
  },
};

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

function astronomyDirection(vec) {
  return new THREE.Vector3(vec.x, vec.z, -vec.y).normalize();
}

function astronomyToScene(vec, distance) {
  return astronomyDirection(vec).multiplyScalar(distance);
}

function astroTime() {
  return new Astronomy.AstroTime(new Date());
}

function updateSun() {
  const vec = Astronomy.GeoVector(Astronomy.Body.Sun, astroTime(), false);
  sunGroup.position.copy(astronomyToScene(vec, SUN_VISUAL_DISTANCE));
  sunLight.position.copy(sunGroup.position);
  if (fillLight) fillLight.position.copy(sunGroup.position).negate();
}

function updateMoon() {
  const vec = Astronomy.GeoVector(Astronomy.Body.Moon, astroTime(), false);
  moonGroup.position.copy(astronomyToScene(vec, MOON_VISUAL_DISTANCE));

  _toEarth.copy(moonGroup.position).negate().normalize();
  moonGroup.quaternion.setFromUnitVectors(_zAxis, _toEarth);

  if (moonEarthshine) {
    moonEarthshine.position.copy(_toEarth).multiplyScalar(-10);
  }
}

/** Start with Earth and Moon both in frame — camera opposite the Moon. */
function aimCameraForMoon() {
  updateSun();
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
    upgradeMoonTextures();
  } else if (center === "sun") {
    controls.target.copy(sunGroup.position);
    controls.minDistance = 0.35;
    controls.maxDistance = 5;
    _viewDir.copy(EARTH_TARGET).sub(sunGroup.position).normalize();
    camera.position.copy(sunGroup.position).add(_viewDir.multiplyScalar(2.5));
    upgradeSunTextures();
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

function configureMoonColorTexture(tex) {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
}

function configureMoonNormalTexture(tex) {
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
}

function loadMoonTexture(url) {
  return new Promise((resolve, reject) => {
    textureLoader.load(url, resolve, undefined, reject);
  });
}

function applyMoonLod(lod) {
  const cfg = MOON_LOD[lod];
  const mat = moonMesh.material;
  mat.normalScale.set(cfg.normalScale, cfg.normalScale);

  if (moonMesh.geometry.parameters.widthSegments < cfg.segments) {
    moonMesh.geometry.dispose();
    moonMesh.geometry = new THREE.SphereGeometry(MOON_RADIUS, cfg.segments, cfg.segments);
  }
  moonLodLevel = lod;
}

async function upgradeMoonTextures() {
  if (moonLodLevel === "high") return;
  if (!moonHqPromise) {
    const cfg = MOON_LOD.high;
    moonHqPromise = Promise.all([
      loadMoonTexture(cfg.map),
      loadMoonTexture(cfg.normal),
    ]);
  }
  try {
    const [map, normal] = await moonHqPromise;
    configureMoonColorTexture(map);
    configureMoonNormalTexture(normal);

    const mat = moonMesh.material;
    mat.map?.dispose();
    mat.normalMap?.dispose();
    mat.map = map;
    mat.normalMap = normal;
    mat.needsUpdate = true;
    applyMoonLod("high");
  } catch (err) {
    console.error("Moon HQ textures failed:", err);
    moonHqPromise = null;
  }
}

function configureSunTexture(tex) {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
}

function createSunMaterial(tex) {
  configureSunTexture(tex);
  return new THREE.ShaderMaterial({
    uniforms: { sunMap: { value: tex } },
    vertexShader: SUN_VERTEX_SHADER,
    fragmentShader: SUN_FRAGMENT_SHADER,
    toneMapped: false,
  });
}

function applySunLod(lod) {
  const cfg = SUN_LOD[lod];
  if (sunMesh.geometry.parameters.widthSegments < cfg.segments) {
    sunMesh.geometry.dispose();
    sunMesh.geometry = new THREE.SphereGeometry(SUN_RADIUS, cfg.segments, cfg.segments);
  }
  sunLodLevel = lod;
}

async function upgradeSunTextures() {
  if (sunLodLevel === "high") return;
  if (!sunHqPromise) {
    sunHqPromise = loadMoonTexture(SUN_LOD.high.map);
  }
  try {
    const tex = await sunHqPromise;
    configureSunTexture(tex);
    sunMesh.material.uniforms.sunMap.value = tex;
    applySunLod("high");
  } catch (err) {
    console.error("Sun HQ texture failed:", err);
    sunHqPromise = null;
  }
}

function createSun() {
  sunGroup = new THREE.Group();
  scene.add(sunGroup);

  const cfg = SUN_LOD.low;
  const tex = textureLoader.load(cfg.map, configureSunTexture);
  configureSunTexture(tex);

  sunMesh = new THREE.Mesh(
    new THREE.SphereGeometry(SUN_RADIUS, cfg.segments, cfg.segments),
    createSunMaterial(tex)
  );
  sunGroup.add(sunMesh);
  updateSun();
}

function createMoon() {
  moonGroup = new THREE.Group();
  scene.add(moonGroup);

  const cfg = MOON_LOD.low;
  const geo = new THREE.SphereGeometry(MOON_RADIUS, cfg.segments, cfg.segments);

  const tex = textureLoader.load(cfg.map, configureMoonColorTexture);
  configureMoonColorTexture(tex);

  const normal = textureLoader.load(cfg.normal, configureMoonNormalTexture);
  configureMoonNormalTexture(normal);

  const mat = new THREE.MeshStandardMaterial({
    map: tex,
    normalMap: normal,
    normalScale: new THREE.Vector2(cfg.normalScale, cfg.normalScale),
    roughness: 0.72,
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
  sunLight = new THREE.DirectionalLight(0xfff8f0, 1.55);
  scene.add(sunLight);
  fillLight = new THREE.DirectionalLight(0xbbccdd, 1.4);
  scene.add(fillLight);
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
  createSun();
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

  updateSun();
  updateMoon();
  if (viewCenter === "moon") {
    controls.target.copy(moonGroup.position);
  } else if (viewCenter === "sun") {
    controls.target.copy(sunGroup.position);
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