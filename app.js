import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { DISASTER_TYPES, fetchDisasters, formatEventTime } from "./data.js";

const EARTH_RADIUS = 1;
const MOON_VISUAL_DISTANCE = 4.5;
const MOON_RADIUS = 0.26;
const SUN_VISUAL_DISTANCE = 85;
const SUN_RADIUS = 0.5;
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
    float limb = pow(max(dot(normalize(vNormal), viewDir), 0.0), 0.55);
    vec3 surface = texture2D(sunMap, vUv).rgb;
    vec3 color = mix(surface * vec3(0.78, 0.44, 0.14), surface * vec3(1.32, 1.1, 0.88), limb);
    gl_FragColor = vec4(color, 1.0);
  }
`;

const PIN_ALTITUDE = 0.012;
const PIN_RADIUS = 0.0065;
const PIN_RADIUS_TSUNAMI = 0.0085;
const PIN_TSUNAMI_HALO_SCALE = 1.35;
const PIN_SEGMENTS = 16;
const PIN_TORNADO_CORE_RATIO = 0.48;
const POLE_LIMIT = THREE.MathUtils.degToRad(12);
const ZOOM_VIEW_DISTANCE = { earth: 3.2, moon: 0.85 };
const ZOOM_SURFACE_CLEARANCE = 0.2;
const ZOOM_MAX_DISTANCE = 168;
const ZOOM_LIMITS = {
  earth: { min: EARTH_RADIUS + ZOOM_SURFACE_CLEARANCE, max: ZOOM_MAX_DISTANCE },
  moon: { min: MOON_RADIUS + ZOOM_SURFACE_CLEARANCE, max: ZOOM_MAX_DISTANCE },
};
/** Wheel uses normalized deltas; pinch uses Math.pow(ratio, zoomSpeed) — needs a far lower value. */
const WHEEL_ZOOM_SPEED = 54;
const TOUCH_ZOOM_SPEED = 1.9;

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

const canvas = document.getElementById("globe-canvas");
const loadingEl = document.getElementById("loading");
const countEl = document.getElementById("event-count");
const sheetEl = document.getElementById("event-sheet");
const sheetBackdrop = document.getElementById("sheet-backdrop");
const sheetClose = document.getElementById("sheet-close");
const sheetTypeEl = document.getElementById("sheet-type");
const sheetTitleEl = document.getElementById("sheet-title");
const sheetTimeEl = document.getElementById("sheet-time");
const sheetDescEl = document.getElementById("sheet-desc");
const sheetSourceEl = document.getElementById("sheet-source");
const sheetLinkEl = document.getElementById("sheet-link");
const sheetTsunamiEl = document.getElementById("sheet-tsunami");

let subsolarObserver;
let scene, camera, renderer, controls;
let earthGroup, moonGroup, moonMesh, moonEarthshine, sunGroup, sunMesh, sunLight, fillLight, pinsGroup;
let pinGeometry, pinGeometryTsunami, pinMaterials;
let moonLodLevel = "low";
let moonHqPromise = null;
let sunLodLevel = "low";
let sunHqPromise = null;
let pinMeshes = [];
let allEvents = [];
let currentHours = 72;
let viewCenter = "earth";
let animationId = null;
let refreshTimer = null;
let eventsLoading = false;

const EVENT_REFRESH_MS = 5 * 60 * 1000;

const activeTypes = new Set(Object.keys(DISASTER_TYPES));
const EARTH_TARGET = new THREE.Vector3(0, 0, 0);
const _viewDir = new THREE.Vector3();
const _toEarth = new THREE.Vector3();
const _zAxis = new THREE.Vector3(0, 0, 1);

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

function subsolarPoint(time) {
  if (!subsolarObserver) subsolarObserver = new Astronomy.Observer(0, 0, 0);
  const eq = Astronomy.Equator(Astronomy.Body.Sun, time, subsolarObserver, true, true);
  const gst = Astronomy.SiderealTime(time);
  let lon = (eq.ra - gst) * 15;
  while (lon <= -180) lon += 360;
  while (lon > 180) lon -= 360;
  return { latitude: eq.dec, longitude: lon };
}

function geoVectorToScene(vec, distance) {
  const obs = Astronomy.VectorObserver(vec, false);
  return latLonToPosition(obs.latitude, obs.longitude, distance);
}

function updateCelestialBodies(time) {
  const subsolar = subsolarPoint(time);
  const sunDir = latLonToPosition(subsolar.latitude, subsolar.longitude, 1);
  sunGroup.position.copy(sunDir).multiplyScalar(SUN_VISUAL_DISTANCE);
  sunLight.position.copy(sunGroup.position);
  if (fillLight) fillLight.position.copy(sunGroup.position).negate();

  const moonVec = Astronomy.GeoVector(Astronomy.Body.Moon, time, false);
  moonGroup.position.copy(geoVectorToScene(moonVec, MOON_VISUAL_DISTANCE));

  _toEarth.copy(moonGroup.position).negate().normalize();
  moonGroup.quaternion.setFromUnitVectors(_zAxis, _toEarth);

  if (moonEarthshine) {
    moonEarthshine.position.copy(_toEarth).multiplyScalar(-10);
  }
}

/** Pull back far enough for the sphere to fit the narrower horizontal FOV on portrait phones. */
function earthCameraDistance() {
  if (!camera) return ZOOM_VIEW_DISTANCE.earth;

  const vFovRad = THREE.MathUtils.degToRad(camera.fov);
  const aspect = Math.max(camera.aspect || 1, 0.01);
  const hFovRad = 2 * Math.atan(Math.tan(vFovRad / 2) * aspect);
  const radius = EARTH_RADIUS * 1.02;
  const margin = 0.86;
  const distV = radius / (Math.tan(vFovRad / 2) * margin);
  const distH = radius / (Math.tan(hFovRad / 2) * margin);

  return Math.max(distV, distH, ZOOM_VIEW_DISTANCE.earth);
}

function aimCameraForEarth() {
  if (!camera) return;
  const dist = earthCameraDistance();
  _viewDir.set(0, 0.12, 1);
  _viewDir.normalize().multiplyScalar(dist);
  camera.position.copy(EARTH_TARGET).add(_viewDir);
  camera.lookAt(EARTH_TARGET);
}

function applyZoomLimits(center) {
  const limits = ZOOM_LIMITS[center] || ZOOM_LIMITS.earth;
  controls.minDistance = limits.min;
  controls.maxDistance = limits.max;
}

function isCoarsePointer() {
  return window.matchMedia("(pointer: coarse)").matches;
}

function applyZoomSpeed(pointerType) {
  if (!controls) return;
  const touchLike =
    pointerType === "touch" || (isCoarsePointer() && pointerType !== "mouse");
  controls.zoomSpeed = touchLike ? TOUCH_ZOOM_SPEED : WHEEL_ZOOM_SPEED;
}

function clampCameraDistance() {
  if (!controls || !camera) return;
  const limits = ZOOM_LIMITS[viewCenter] || ZOOM_LIMITS.earth;
  _viewDir.copy(camera.position).sub(controls.target);
  const dist = _viewDir.length();
  if (dist < limits.min || dist > limits.max) {
    _viewDir.normalize().multiplyScalar(THREE.MathUtils.clamp(dist, limits.min, limits.max));
    camera.position.copy(controls.target).add(_viewDir);
  }
}

function setViewCenter(center) {
  viewCenter = center;
  document.querySelectorAll(".center-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.center === center);
  });

  applyZoomLimits(center);

  if (center === "moon") {
    controls.target.copy(moonGroup.position);
    _viewDir.copy(camera.position).sub(controls.target);
    if (_viewDir.length() < ZOOM_LIMITS.moon.min) _viewDir.set(0.1, 0.15, 1);
    _viewDir.normalize().multiplyScalar(ZOOM_VIEW_DISTANCE.moon);
    camera.position.copy(moonGroup.position).add(_viewDir);
    upgradeMoonTextures();
  } else {
    controls.target.copy(EARTH_TARGET);
    _viewDir.copy(camera.position).sub(controls.target);
    if (_viewDir.length() < ZOOM_LIMITS.earth.min) _viewDir.set(0, 0.12, 1);
    _viewDir.normalize().multiplyScalar(earthCameraDistance());
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

function configureColorTexture(tex) {
  tex.colorSpace = THREE.SRGBColorSpace;
  if (renderer) {
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  }
}

function configureNormalTexture(tex) {
  if (renderer) {
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  }
}

function loadTexture(url) {
  return new Promise((resolve, reject) => {
    textureLoader.load(url, resolve, undefined, reject);
  });
}

function loadStarBackground() {
  textureLoader.load("stars-8k.jpg", (tex) => {
    configureSkyTexture(tex);
    scene.background = tex;
  });
}

function createEarth() {
  earthGroup = new THREE.Group();
  scene.add(earthGroup);

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

  earthGroup.add(new THREE.Mesh(new THREE.SphereGeometry(EARTH_RADIUS, 64, 64), mat));

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

  if (sunLight) {
    sunLight.target = earthGroup;
    scene.add(sunLight.target);
  }
}

function createTornadoPinTexture() {
  const size = 64;
  const el = document.createElement("canvas");
  el.width = size;
  el.height = size;
  const ctx = el.getContext("2d");
  const cx = size / 2;
  const outerR = size / 2 - 1;
  const innerR = outerR * PIN_TORNADO_CORE_RATIO;

  ctx.beginPath();
  ctx.arc(cx, cx, outerR, 0, Math.PI * 2);
  ctx.fillStyle = "#f8fafc";
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cx, innerR, 0, Math.PI * 2);
  ctx.fillStyle = "#ff2d55";
  ctx.fill();

  const tex = new THREE.CanvasTexture(el);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function initPinAssets() {
  pinGeometry = new THREE.SphereGeometry(PIN_RADIUS, PIN_SEGMENTS, PIN_SEGMENTS);
  pinGeometryTsunami = new THREE.SphereGeometry(PIN_RADIUS_TSUNAMI, PIN_SEGMENTS, PIN_SEGMENTS);
  pinMaterials = {
    _default: new THREE.MeshBasicMaterial({ color: "#ffffff" }),
    _tsunamiHalo: new THREE.MeshBasicMaterial({
      color: DISASTER_TYPES.tsunami.color,
      transparent: true,
      opacity: 0.5,
    }),
    tornado: new THREE.SpriteMaterial({
      map: createTornadoPinTexture(),
      transparent: true,
      depthTest: true,
      depthWrite: true,
    }),
  };
  for (const [type, info] of Object.entries(DISASTER_TYPES)) {
    if (type === "tornado") continue;
    pinMaterials[type] = new THREE.MeshBasicMaterial({ color: info.color });
  }
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
    moonHqPromise = Promise.all([loadTexture(cfg.map), loadTexture(cfg.normal)]);
  }
  try {
    const [map, normal] = await moonHqPromise;
    configureColorTexture(map);
    configureNormalTexture(normal);

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

function createSunMaterial(tex) {
  configureColorTexture(tex);
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
    sunHqPromise = loadTexture(SUN_LOD.high.map);
  }
  try {
    const tex = await sunHqPromise;
    configureColorTexture(tex);
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
  const tex = textureLoader.load(cfg.map, configureColorTexture);
  sunMesh = new THREE.Mesh(
    new THREE.SphereGeometry(SUN_RADIUS, cfg.segments, cfg.segments),
    createSunMaterial(tex)
  );
  sunGroup.add(sunMesh);
}

function createMoon() {
  moonGroup = new THREE.Group();
  scene.add(moonGroup);

  const cfg = MOON_LOD.low;
  const tex = textureLoader.load(cfg.map, configureColorTexture);
  const normal = textureLoader.load(cfg.normal, configureNormalTexture);

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

  moonMesh = new THREE.Mesh(
    new THREE.SphereGeometry(MOON_RADIUS, cfg.segments, cfg.segments),
    mat
  );
  moonMesh.rotation.y = Math.PI;
  moonGroup.add(moonMesh);
}

function createLights() {
  scene.add(new THREE.HemisphereLight(0xd0e0f8, 0x7a8a9e, 2.0));
  scene.add(new THREE.AmbientLight(0x99aabb, 1.0));
  sunLight = new THREE.DirectionalLight(0xfff4e8, 1.75);
  scene.add(sunLight);
  fillLight = new THREE.DirectionalLight(0x8a9ab8, 0.75);
  scene.add(fillLight);
  moonEarthshine = new THREE.DirectionalLight(0xb0c0d8, 0.75);
  scene.add(moonEarthshine);
}

function clearPins() {
  for (const pin of pinMeshes) {
    pinsGroup.remove(pin);
  }
  pinMeshes = [];
}

function createPin(event) {
  const mat = pinMaterials[event.type] || pinMaterials._default;
  const pos = latLonToPosition(event.lat, event.lon, EARTH_RADIUS + PIN_ALTITUDE);
  const root = new THREE.Group();
  root.position.copy(pos);
  root.userData.event = event;

  const tsunamiPin = event.type === "tsunami" || event.tsunami;
  const geo = tsunamiPin ? pinGeometryTsunami : pinGeometry;

  if (event.type === "tornado") {
    const sprite = new THREE.Sprite(pinMaterials.tornado);
    const pinDiameter = PIN_RADIUS * 2;
    sprite.scale.set(pinDiameter, pinDiameter, 1);
    root.add(sprite);
  } else {
    root.add(new THREE.Mesh(geo, mat));
  }

  if (tsunamiPin) {
    const halo = new THREE.Mesh(pinGeometryTsunami, pinMaterials._tsunamiHalo);
    halo.scale.setScalar(PIN_TSUNAMI_HALO_SCALE);
    root.add(halo);
  }

  pinsGroup.add(root);
  pinMeshes.push(root);
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
  sheetTypeEl.textContent = typeInfo.label;
  sheetTypeEl.style.color = typeInfo.color;
  sheetTitleEl.textContent = event.title;
  sheetTimeEl.textContent = formatEventTime(event.time);
  const showTsunamiBadge = event.type === "tsunami" || Boolean(event.tsunami);
  sheetTsunamiEl?.classList.toggle("visible", showTsunamiBadge);
  if (sheetTsunamiEl && showTsunamiBadge) {
    sheetTsunamiEl.textContent = event.alertLevel || (event.type === "tsunami" ? "Tsunami alert" : "Tsunami advisory");
  }
  sheetDescEl.textContent = event.description || "";
  if (event.tsunami && event.type === "earthquake") {
    sheetDescEl.textContent = `Tsunami advisory issued for this earthquake. ${event.description || ""}`.trim();
  }
  sheetSourceEl.textContent = event.source || "";
  if (event.url) {
    sheetLinkEl.href = event.url;
    sheetLinkEl.style.display = "";
  } else {
    sheetLinkEl.style.display = "none";
  }
  sheetEl.classList.add("open");
  sheetBackdrop.classList.add("open");
}

function hideEventSheet() {
  sheetTsunamiEl?.classList.remove("visible");
  sheetEl.classList.remove("open");
  sheetBackdrop.classList.remove("open");
}

async function loadEvents(hours, { background = false } = {}) {
  if (eventsLoading) return;
  eventsLoading = true;
  currentHours = hours;
  if (!background) loadingEl?.classList.add("visible");
  try {
    const { events, errors } = await fetchDisasters(hours);
    setPins(events);
    if (errors.length) console.warn("Partial disaster data:", errors.join(", "));
  } catch (err) {
    console.error(err);
  } finally {
    if (!background) loadingEl?.classList.remove("visible");
    eventsLoading = false;
  }
}

function startEventRefresh() {
  stopEventRefresh();
  refreshTimer = setInterval(() => {
    loadEvents(currentHours, { background: true });
  }, EVENT_REFRESH_MS);
}

function stopEventRefresh() {
  if (!refreshTimer) return;
  clearInterval(refreshTimer);
  refreshTimer = null;
}

function onPointerDown(event) {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  raycaster.params.Sprite = { threshold: PIN_RADIUS * 1.5 };
  const hits = raycaster.intersectObjects(pinMeshes, true);
  const hit = hits.find((h) => h.object.userData.event || h.object.parent?.userData.event);
  const pinEvent = hit?.object.userData.event || hit?.object.parent?.userData.event;
  if (pinEvent) {
    showEventSheet(pinEvent);
    event.preventDefault();
  }
}

function initScene() {
  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
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

  initPinAssets();
  loadStarBackground();

  createLights();
  createEarth();
  createSun();
  createMoon();

  controls = new OrbitControls(camera, canvas);
  controls.target.copy(EARTH_TARGET);
  controls.enablePan = false;
  applyZoomLimits("earth");
  controls.enableDamping = false;
  controls.rotateSpeed = 0.65;
  controls.zoomSpeed = WHEEL_ZOOM_SPEED;
  controls.enableZoom = true;
  applyZoomSpeed(isCoarsePointer() ? "touch" : "wheel");
  canvas.addEventListener("wheel", () => applyZoomSpeed("wheel"), { passive: true });
  canvas.addEventListener("pointerdown", (e) => applyZoomSpeed(e.pointerType), { capture: true });
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

  if (viewCenter === "earth" && controls) {
    const minDist = earthCameraDistance();
    _viewDir.copy(camera.position).sub(controls.target);
    if (_viewDir.length() < minDist) {
      _viewDir.normalize().multiplyScalar(minDist);
      camera.position.copy(controls.target).add(_viewDir);
      controls.update();
    }
  }
}

function animate() {
  animationId = requestAnimationFrame(animate);

  updateCelestialBodies(new Astronomy.AstroTime(new Date()));

  if (viewCenter === "moon") {
    controls.target.copy(moonGroup.position);
  }

  controls.update();
  clampCameraDistance();
  renderer.render(scene, camera);
}

export function bootGlobe() {
  try {
    initScene();
    resize();
    aimCameraForEarth();
    controls?.target.copy(EARTH_TARGET);
    controls?.update();
    animate();
  } catch (err) {
    console.error("Globe init failed:", err);
    loadingEl.classList.remove("visible");
  }
  loadEvents(currentHours);
  startEventRefresh();
  return { resize };
}

export function destroyGlobe() {
  stopEventRefresh();
  if (animationId) cancelAnimationFrame(animationId);
  animationId = null;

  canvas.removeEventListener("pointerdown", onPointerDown);
  sheetClose.removeEventListener("click", hideEventSheet);
  sheetBackdrop.removeEventListener("click", hideEventSheet);

  clearPins();
  pinGeometry?.dispose();
  pinGeometryTsunami?.dispose();
  if (pinMaterials) {
    pinMaterials.tornado?.map?.dispose();
    for (const mat of Object.values(pinMaterials)) mat.dispose();
  }

  controls?.dispose();
  renderer?.dispose();
}