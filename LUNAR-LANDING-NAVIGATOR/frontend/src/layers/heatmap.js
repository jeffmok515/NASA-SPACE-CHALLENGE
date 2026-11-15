// Paint processed South Pole samples onto one sphere aligned to the Moon mesh.
import * as THREE from 'three';
import suitabilityMode from './suitability.js';
import sunlightMode from './sunlight.js';
import terrainMode from './terrain.js';
import solarMode from './solarEnergy.js';

const MODES = Object.fromEntries([suitabilityMode, sunlightMode, terrainMode, solarMode]
    .map(mode => [mode.key, mode]));
const MODE_COLORS = Object.fromEntries(Object.values(MODES).map(mode =>
    [mode.key, mode.stops.map(hex => new THREE.Color(hex))]));
const CANVAS_SIZE = 1024;
const OVERLAY_NAME = 'Lunar processed heatmap surface';
const SURFACE_SCALE = 1.003;
const BRUSH_RADIUS = 12;
const EDGE_FADE_START = 490;
const LUNAR_CYCLE_DAYS = 29.53;
const SLIDER_CYCLE_DAYS = 29.5;
const CYCLE_ANIMATION_MS = 60_000;
const PLAYBACK_FRAME_MS = 1000 / 12;
const SITE_PRESETS = [
    { id: 'shackleton', name: 'Shackleton Crater', lat: -90.0, lon: 0.0, color: '#ff6678' },
    { id: 'connecting-ridge', name: 'Connecting Ridge', lat: -89.4, lon: 137.4, color: '#47e6ff' },
    { id: 'malapert', name: 'Malapert Massif', lat: -86.0, lon: 0.0, color: '#ffd34f' },
];

let activeMode = document.querySelector('.control-btn.active')?.dataset.mode || 'sunlight';
let datasetsPromise;
let attachPromise;
let sceneRef;
let overlay;
let texture;
let canvasContext;
let legend;
let maxColatitudeRad;
let sunMarker;
let sitePins = [];
let selectedSite = null;
let selectedLunarDay = null;
let playbackFrame = null;
let lastPlaybackPaint = 0;

const timescalePanel = document.getElementById('solar-timescale');
const daySlider = document.getElementById('lunar-day-slider');
const dayLabel = document.getElementById('lunar-day-label');
const phaseLabel = document.getElementById('lunar-cycle-phase');
const azimuthLabel = document.getElementById('solar-azimuth-label');
const playButton = document.getElementById('lunar-cycle-play');
const cycleState = document.getElementById('solar-cycle-state');
const siteCard = document.getElementById('site-comparison-card');

async function loadDataset(mode) {
    const response = await fetch(mode.dataUrl);
    if (!response.ok) throw new Error(`${mode.key} dataset request failed (${response.status})`);
    const dataset = await response.json();
    if (!Array.isArray(dataset.locations) || dataset.locations.length === 0) {
        throw new Error(`${mode.key} dataset must contain a non-empty locations array`);
    }
    const points = dataset.locations.filter(point =>
        Number.isFinite(point.lat) && Number.isFinite(point.lon) && Number.isFinite(mode.value(point)));
    if (!points.length) throw new Error(`${mode.key} dataset has no valid map locations`);
    return points;
}

function loadDatasets() {
    if (!datasetsPromise) {
        datasetsPromise = Promise.all(Object.values(MODES).map(async mode =>
            [mode.key, await loadDataset(mode)]))
            .then(entries => {
                const datasets = Object.fromEntries(entries);
                const illuminationByCoordinate = new Map(datasets.sunlight.map(point =>
                    [`${point.lat},${point.lon}`, point.illumination_pct ?? point.value]));
                // The static solar layer remains unchanged; attach the matching
                // illumination sample for the optional Solar Energy timescale.
                datasets.solar = datasets.solar.map(point => ({
                    ...point,
                    illumination_pct: illuminationByCoordinate.get(`${point.lat},${point.lon}`) ?? 0,
                }));
                const terrainByCoordinate = new Map(datasets.terrain.map(point =>
                    [`${point.lat},${point.lon}`, point]));
                const solarByCoordinate = new Map(datasets.solar.map(point =>
                    [`${point.lat},${point.lon}`, point]));
                datasets.samplesByCoordinate = new Map(datasets.sunlight.map(point => {
                    const key = `${point.lat},${point.lon}`;
                    return [key, {
                        sunlight: point,
                        terrain: terrainByCoordinate.get(key),
                        solar: solarByCoordinate.get(key),
                    }];
                }));
                return datasets;
            });
    }
    return datasetsPromise;
}

function hasUvMesh(object) {
    let found = false;
    object?.traverse?.(child => {
        if (child.isMesh && child.geometry?.attributes?.uv) found = true;
    });
    return found;
}

function isMoonGroup(object) {
    return Boolean(object?.isGroup && hasUvMesh(object));
}

function findMoonRoot(pivot) {
    // main.js wraps the loaded glTF in a pivot and adds pole markers to that pivot.
    // The direct child containing the UV meshes is the actual lunar model root.
    return pivot.children.find(child => child !== pivot && child.isGroup && hasUvMesh(child)) || pivot;
}

function measureWorldSphere(moonRoot) {
    moonRoot.updateWorldMatrix(true, true);
    const bounds = new THREE.Box3().setFromObject(moonRoot);
    if (bounds.isEmpty()) throw new Error('Could not measure the loaded Moon mesh bounds');

    const sphere = new THREE.Sphere();
    bounds.getBoundingSphere(sphere);
    // Box3.getBoundingSphere returns the sphere around the AABB corners, which
    // overestimates a globe's radius. Keep its exact world center, then measure
    // the farthest actual Moon vertex from that center for the surface radius.
    let radiusSquared = 0;
    const vertex = new THREE.Vector3();
    moonRoot.traverse(mesh => {
        const positions = mesh.isMesh ? mesh.geometry?.attributes?.position : null;
        if (!positions) return;
        for (let i = 0; i < positions.count; i++) {
            vertex.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
            radiusSquared = Math.max(radiusSquared, vertex.distanceToSquared(sphere.center));
        }
    });
    sphere.radius = Math.sqrt(radiusSquared);
    if (!Number.isFinite(sphere.radius) || sphere.radius <= 0) {
        throw new Error('Could not determine the Moon mesh world radius');
    }
    return sphere;
}

function frameFromMain({ northAxis, lonA, lonB, lonSign = 1, centerLon = 0 }) {
    const center = THREE.MathUtils.degToRad(centerLon);
    const xAxis = new THREE.Vector3()
        .addScaledVector(lonA, Math.cos(center))
        .addScaledVector(lonB, -lonSign * Math.sin(center));
    const zAxis = new THREE.Vector3()
        .addScaledVector(lonA, Math.sin(center))
        .addScaledVector(lonB, lonSign * Math.cos(center));
    const southAxis = northAxis.clone().negate();
    if (new THREE.Vector3().crossVectors(xAxis, southAxis).dot(zAxis) < 0) zAxis.negate();
    return new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(xAxis, southAxis, zAxis));
}

function uvDirectionFrame(moonRoot, center) {
    // Prefer the axes used by the Moon's landmarks; the fallback below is for
    // standalone use without main.js and preserves the existing polar cap.
    if (window.lunarFrame) return frameFromMain(window.lunarFrame);
    moonRoot.updateWorldMatrix(true, true);
    const meshes = [];
    let minV = Infinity;
    let maxV = -Infinity;
    moonRoot.traverse(mesh => {
        if (!mesh.isMesh || !mesh.geometry?.attributes?.uv || !mesh.geometry?.attributes?.position) return;
        const uv = mesh.geometry.attributes.uv;
        meshes.push({ uv, positions: mesh.geometry.attributes.position, matrixWorld: mesh.matrixWorld.clone() });
        for (let i = 0; i < uv.count; i++) {
            minV = Math.min(minV, uv.getY(i));
            maxV = Math.max(maxV, uv.getY(i));
        }
    });
    if (!meshes.length) throw new Error('Moon model has no UV coordinates for polar alignment');

    const worldVertex = (item, index) => new THREE.Vector3()
        .fromBufferAttribute(item.positions, index).applyMatrix4(item.matrixWorld);
    function poleAt(targetV) {
        const position = new THREE.Vector3();
        let count = 0;
        for (const item of meshes) {
            for (let i = 0; i < item.uv.count; i++) {
                if (Math.abs(item.uv.getY(i) - targetV) < 0.002) {
                    position.add(worldVertex(item, i));
                    count++;
                }
            }
        }
        return count ? position.divideScalar(count) : null;
    }
    function vertexAt(targetU, targetV) {
        let nearest = Infinity;
        let result = null;
        for (const item of meshes) {
            for (let i = 0; i < item.uv.count; i++) {
                let du = Math.abs(item.uv.getX(i) - targetU);
                du = Math.min(du, 1 - du);
                const dv = item.uv.getY(i) - targetV;
                const distance = du * du + dv * dv;
                if (distance < nearest) {
                    nearest = distance;
                    result = worldVertex(item, i);
                }
            }
        }
        return result;
    }

    const north = poleAt(minV);
    const south = poleAt(maxV);
    if (!north || !south) throw new Error('Could not find the Moon mesh north/south UV poles');
    const northAxis = new THREE.Vector3().subVectors(north, south).normalize();
    const equatorV = (minV + maxV) / 2;
    const flatten = point => {
        const direction = point.sub(center);
        return direction.addScaledVector(northAxis, -direction.dot(northAxis)).normalize();
    };
    const longitudeZero = flatten(vertexAt(0.5, equatorV));
    const longitudeQuarter = flatten(vertexAt(0.75, equatorV));
    let eastAxis = new THREE.Vector3().crossVectors(northAxis, longitudeZero).normalize();
    if (eastAxis.dot(longitudeQuarter) < 0) eastAxis.negate();

    // SphereGeometry's local u=0.5 meridian points along +X, north along +Y,
    // and u=0.75 points along -Z. Rotate that UV frame onto the real Moon mesh.
    // The polar cap geometry uses local +X for longitude zero, local +Z for
    // increasing longitude, and local -Y toward the South Pole.
    const basis = new THREE.Matrix4().makeBasis(longitudeZero, northAxis.clone().negate(), eastAxis);
    return new THREE.Quaternion().setFromRotationMatrix(basis);
}

function polarCapExtent(points) {
    const maxSampleColatitude = Math.max(...points.map(point =>
        (90 - Math.abs(point.lat)) * Math.PI / 180));
    // Leave a small margin around the outermost sample so the heatmap can fade
    // cleanly before the cap edge.
    return maxSampleColatitude + Math.PI / 180;
}

function createPolarCapGeometry(radius, colatitudeRad) {
    const geometry = new THREE.SphereGeometry(
        radius,
        256,
        64,
        0,
        Math.PI * 2,
        0,
        colatitudeRad,
    );
    const positions = geometry.getAttribute('position');
    const uvs = geometry.getAttribute('uv');
    const maxHorizontalR = radius * Math.sin(colatitudeRad);
    for (let i = 0; i < positions.count; i++) {
        const x = positions.getX(i);
        const z = positions.getZ(i);
        uvs.setXY(i,
            0.5 + x / (2 * maxHorizontalR),
            0.5 + z / (2 * maxHorizontalR));
    }
    uvs.needsUpdate = true;
    return geometry;
}

function colorAt(mode, value) {
    const t = THREE.MathUtils.clamp((value - mode.min) / (mode.max - mode.min), 0, 1);
    const stops = MODE_COLORS[mode.key];
    const scaled = t * (stops.length - 1);
    const lower = Math.min(Math.floor(scaled), stops.length - 2);
    return new THREE.Color().copy(stops[lower]).lerp(stops[lower + 1], scaled - lower).getStyle();
}

function fixed(value, digits = 1) {
    return Number(value).toFixed(digits);
}

function coordinate(point) {
    return `${fixed(point.lat, 3)}°, ${fixed(point.lon, 3)}°`;
}

function summaryRows(mode, points) {
    const values = points.map(point => mode.value(point));
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const peak = points[values.indexOf(maximum)];

    if (mode.key === 'suitability') {
        const optimalCount = points.filter(point => mode.value(point) >= 75 && point.risk_rating === 'Optimal').length;
        return [
            ['Optimal Zones', `${optimalCount.toLocaleString()} / ${points.length.toLocaleString()} (${fixed(optimalCount / points.length * 100)}%)`],
            ['Peak Site Score', `${fixed(maximum)} / 100 · ${coordinate(peak)}`],
        ];
    }
    if (mode.key === 'sunlight') {
        const shadowedCount = points.filter(point => mode.value(point) < 5).length;
        return [
            ['Mean Illumination', `${fixed(mean)}%`],
            ['Peak Sunlight Ridge', `${fixed(maximum)}% · ${coordinate(peak)}`],
            ['Permanently Shadowed (<5%)', `${shadowedCount.toLocaleString()} / ${points.length.toLocaleString()} (${fixed(shadowedCount / points.length * 100)}%)`],
        ];
    }
    if (mode.key === 'terrain') {
        const safeCount = points.filter(point => mode.value(point) < 15).length;
        const elevations = points.map(point => point.elevation_m).filter(Number.isFinite);
        const elevationRange = elevations.length
            ? `${fixed(Math.min(...elevations))}–${fixed(Math.max(...elevations))} m`
            : 'Elevation unavailable';
        return [
            ['Safe Flat Terrain (<15°)', `${fixed(safeCount / points.length * 100)}% of surveyed region`],
            ['Slope Range · Elevation Range', `${fixed(minimum)}–${fixed(maximum)}° · ${elevationRange}`],
        ];
    }
    return [
        ['Mean Solar Yield', `${fixed(mean, 2)} kWh/m²/day`],
        ['Peak Power Site', `${fixed(maximum, 2)} kWh/m²/day · ${coordinate(peak)}`],
    ];
}

function renderSummary(mode, points) {
    const panel = document.getElementById('mode-summary');
    if (!panel || !points.length) return;
    const rows = summaryRows(mode, points);
    panel.replaceChildren(...rows.map(([label, value]) => {
        const row = document.createElement('div');
        row.className = 'row';
        const heading = document.createElement('span');
        heading.textContent = label;
        const result = document.createElement('b');
        result.textContent = value;
        row.append(heading, result);
        return row;
    }));
}

function cssRgb(colorStyle) {
    const match = colorStyle.match(/\d+(?:\.\d+)?/g);
    return match ? match.slice(0, 3).map(value => Math.round(Number(value))).join(',') : '255,255,255';
}

function drawSpot(x, y, rgb) {
    const gradient = canvasContext.createRadialGradient(x, y, 0, x, y, BRUSH_RADIUS);
    // Keep samples translucent so the Moon's own texture stays visible under
    // overlapping values and the heatmap reads as a surface overlay.
    gradient.addColorStop(0, `rgba(${rgb},0.68)`);
    gradient.addColorStop(0.62, `rgba(${rgb},0.36)`);
    gradient.addColorStop(1, `rgba(${rgb},0)`);
    canvasContext.fillStyle = gradient;
    canvasContext.beginPath();
    canvasContext.arc(x, y, BRUSH_RADIUS, 0, Math.PI * 2);
    canvasContext.fill();
}

function paintDataset(mode, points, logPaint = true) {
    canvasContext.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    let observedMin = Infinity;
    let observedMax = -Infinity;
    const maxSinColatitude = Math.sin(maxColatitudeRad);

    for (const point of points) {
        const value = mode.value(point);
        observedMin = Math.min(observedMin, value);
        observedMax = Math.max(observedMax, value);
        const colatitudeRad = (90 - Math.abs(point.lat)) * Math.PI / 180;
        const lonRad = point.lon * Math.PI / 180;
        const px = CANVAS_SIZE / 2
            + (Math.sin(colatitudeRad) * Math.cos(lonRad) / maxSinColatitude) * (CANVAS_SIZE / 2);
        const py = CANVAS_SIZE / 2
            + (Math.sin(colatitudeRad) * Math.sin(lonRad) / maxSinColatitude) * (CANVAS_SIZE / 2);
        const rgb = cssRgb(colorAt(mode, value));
        drawSpot(px, py, rgb);
    }

    const edgeFade = canvasContext.createRadialGradient(
        CANVAS_SIZE / 2, CANVAS_SIZE / 2, 0,
        CANVAS_SIZE / 2, CANVAS_SIZE / 2, CANVAS_SIZE / 2,
    );
    edgeFade.addColorStop(EDGE_FADE_START / (CANVAS_SIZE / 2), 'rgba(0,0,0,1)');
    edgeFade.addColorStop(1, 'rgba(0,0,0,0)');
    canvasContext.globalCompositeOperation = 'destination-in';
    canvasContext.fillStyle = edgeFade;
    canvasContext.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    canvasContext.globalCompositeOperation = 'source-over';

    texture.needsUpdate = true;
    updateLegend(mode, observedMin, observedMax, points.length);
    if (logPaint) {
        console.info(`Heatmap ${mode.key}: painted ${points.length.toLocaleString()} JSON locations (${observedMin.toFixed(3)}–${observedMax.toFixed(3)} ${mode.unit}).`);
    }
}

function instantaneousSolarEnergy(point, day = selectedLunarDay) {
    if (day === null) return point.value;
    const p = point.illumination_pct / 100;
    if (p < 0.05) return 0;
    const sunLon = (day / LUNAR_CYCLE_DAYS) * 360 - 180;
    const alignment = Math.cos((point.lon - sunLon) * Math.PI / 180);
    // The static product is average yield (peak yield × persistence).
    // Dividing by persistence recovers the local clear-sun peak yield.
    const peakYield = point.value / p;
    if (p > 0.80) {
        // High peaks retain 75–100% even on the far side of the cycle.
        return peakYield * (0.75 + 0.25 * ((alignment + 1) / 2));
    }
    return peakYield * Math.max(0, alignment);
}

function instantaneousSolarPoints(basePoints, day) {
    return basePoints.map(point => ({ ...point, value: instantaneousSolarEnergy(point, day) }));
}

function updateSunMarker(day = selectedLunarDay) {
    if (!sunMarker) return;
    sunMarker.visible = activeMode === 'solar' && day !== null;
    if (!sunMarker.visible) return;
    const sunLon = (day / LUNAR_CYCLE_DAYS) * 360 - 180;
    const lonRad = sunLon * Math.PI / 180;
    const normal = new THREE.Vector3(
        Math.sin(maxColatitudeRad) * Math.cos(lonRad),
        Math.cos(maxColatitudeRad),
        Math.sin(maxColatitudeRad) * Math.sin(lonRad),
    );
    sunMarker.position.copy(normal.multiplyScalar(sunMarker.userData.surfaceRadius * 1.009));
}

function angularDistanceDegrees(latA, lonA, latB, lonB) {
    const a = THREE.MathUtils.degToRad(latA);
    const b = THREE.MathUtils.degToRad(latB);
    const dLon = THREE.MathUtils.degToRad(lonA - lonB);
    const cosine = Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.cos(b) * Math.cos(dLon);
    return THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(cosine, -1, 1)));
}

function directToEarthStatus(lon) {
    const absoluteLongitude = Math.abs(lon);
    if (absoluteLongitude <= 82) return 'Direct-to-Earth: Continuous Line-of-Sight';
    if (absoluteLongitude <= 98) return 'Direct-to-Earth: Intermittent (Lunar Libration Zone)';
    return 'No Direct Earth View (Lunar Relay Satellite Required)';
}

function nearestLocation(points, lat, lon) {
    let nearest = null;
    let nearestDistance = Infinity;
    for (const point of points) {
        const distance = angularDistanceDegrees(lat, lon, point.lat, point.lon);
        if (distance < nearestDistance) {
            nearest = point;
            nearestDistance = distance;
        }
    }
    return nearest;
}

function renderSelectedSite(datasets) {
    if (!selectedSite) return;
    const sampled = nearestLocation(datasets.sunlight, selectedSite.lat, selectedSite.lon);
    if (!sampled) return;
    const sampleKey = `${sampled.lat},${sampled.lon}`;
    const sample = datasets.samplesByCoordinate.get(sampleKey);
    if (!sample?.terrain || !sample?.solar) return;

    document.getElementById('site-card-title').textContent = selectedSite.name;
    document.getElementById('site-card-coordinates').textContent =
        `LAT ${selectedSite.lat.toFixed(4)}° · LON ${selectedSite.lon.toFixed(4)}°`;
    document.getElementById('site-card-slope').textContent =
        `${(sample.terrain.slope_degrees ?? sample.terrain.value).toFixed(2)}°`;
    document.getElementById('site-card-sunlight').textContent =
        `${(sample.sunlight.illumination_pct ?? sample.sunlight.value).toFixed(1)}%`;
    document.getElementById('site-card-solar').textContent =
        `${instantaneousSolarEnergy(sample.solar).toFixed(2)} kWh/m²/day`;
    document.getElementById('site-card-comms').textContent = directToEarthStatus(selectedSite.lon);
    siteCard.hidden = false;
}

function handleLocationSelection(location) {
    const preset = SITE_PRESETS
        .map(site => ({ site, distance: angularDistanceDegrees(location.lat, location.lon, site.lat, site.lon) }))
        .sort((a, b) => a.distance - b.distance)[0];
    const selectedPreset = SITE_PRESETS.find(site => site.id === location.presetId)
        || (preset?.distance <= 0.4 ? preset.site : null);
    selectedSite = selectedPreset
        ? { ...selectedPreset }
        : { name: 'Selected Location', lat: location.lat, lon: location.lon };

    for (const pin of sitePins) {
        const isSelected = pin.userData.site.id === selectedPreset?.id;
        pin.scale.setScalar(isSelected ? 1.55 : 1);
        for (const material of pin.userData.materials) {
            material.color.set(isSelected ? '#ffffff' : pin.userData.site.color);
        }
    }

    void loadDatasets().then(renderSelectedSite)
        .catch(error => console.error('Could not load selected lunar site values:', error));
}

function addSitePins(surfaceRadius) {
    sitePins = SITE_PRESETS.map(site => {
        const colatitude = THREE.MathUtils.degToRad(90 - Math.abs(site.lat));
        const longitude = THREE.MathUtils.degToRad(site.lon);
        const normal = new THREE.Vector3(
            Math.sin(colatitude) * Math.cos(longitude),
            Math.cos(colatitude),
            Math.sin(colatitude) * Math.sin(longitude),
        );
        const pin = new THREE.Group();
        pin.name = `Landing site pin: ${site.name}`;
        pin.position.copy(normal).multiplyScalar(surfaceRadius * 1.006);
        pin.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);

        const material = new THREE.MeshBasicMaterial({
            color: site.color,
            toneMapped: false,
            depthTest: false,
            depthWrite: false,
            side: THREE.DoubleSide,
        });
        const dot = new THREE.Mesh(
            new THREE.SphereGeometry(surfaceRadius * 0.013, 16, 12),
            material,
        );
        dot.position.z = surfaceRadius * 0.012;
        dot.renderOrder = 1002;
        const halo = new THREE.Mesh(
            new THREE.TorusGeometry(surfaceRadius * 0.026, surfaceRadius * 0.004, 8, 28),
            material.clone(),
        );
        halo.position.z = surfaceRadius * 0.009;
        halo.renderOrder = 1002;
        pin.add(dot, halo);
        pin.userData.site = site;
        pin.userData.materials = [material, halo.material];
        pin.renderOrder = 1002;
        overlay.add(pin);
        return pin;
    });
}

function displayPoints(mode, datasets) {
    if (mode.key === 'solar' && selectedLunarDay !== null) {
        return instantaneousSolarPoints(datasets.solar, selectedLunarDay);
    }
    return datasets[mode.key];
}

function updateTimescaleLabels(day) {
    if (day === null) {
        dayLabel.textContent = 'Monthly Average · static';
        phaseLabel.textContent = 'NASA MEAN';
        azimuthLabel.textContent = '—';
        cycleState.textContent = 'MONTHLY AVERAGE';
        cycleState.classList.remove('live');
        return;
    }
    const sunLon = (day / LUNAR_CYCLE_DAYS) * 360 - 180;
    const azimuth = ((sunLon + 180) % 360 + 360) % 360;
    const phases = ['NEW MOON', 'WAXING CRESCENT', 'FIRST QUARTER', 'WAXING GIBBOUS',
        'FULL MOON', 'WANING GIBBOUS', 'LAST QUARTER', 'WANING CRESCENT'];
    const phase = Math.floor((day / LUNAR_CYCLE_DAYS) * phases.length + 0.5) % phases.length;
    dayLabel.textContent = `Lunar Day ${day.toFixed(1)} / ${SLIDER_CYCLE_DAYS.toFixed(1)}`;
    phaseLabel.textContent = phases[phase];
    azimuthLabel.textContent = `${azimuth.toFixed(0)}°`;
    cycleState.textContent = 'LIVE LUNAR CYCLE';
    cycleState.classList.add('live');
}

function refreshSolarDisplay() {
    if (activeMode !== 'solar') return;
    void loadDatasets().then(datasets => {
        if (activeMode !== 'solar') return;
        const points = displayPoints(MODES.solar, datasets);
        renderSummary(MODES.solar, points);
        renderSelectedSite(datasets);
        if (overlay) paintDataset(MODES.solar, points, false);
    }).catch(error => console.error('Could not update lunar-cycle solar data:', error));
}

function stopCycleAnimation() {
    if (playbackFrame !== null) cancelAnimationFrame(playbackFrame);
    playbackFrame = null;
    playButton.textContent = 'Play';
    playButton.setAttribute('aria-pressed', 'false');
    playButton.classList.remove('on');
}

function startCycleAnimation() {
    if (activeMode !== 'solar' || playbackFrame !== null) return;
    if (selectedLunarDay === null) selectedLunarDay = Number(daySlider.value);
    const startDay = selectedLunarDay;
    const startTime = performance.now();
    lastPlaybackPaint = 0;
    playButton.textContent = 'Pause';
    playButton.setAttribute('aria-pressed', 'true');
    playButton.classList.add('on');

    const animate = now => {
        if (activeMode !== 'solar') {
            stopCycleAnimation();
            return;
        }
        const elapsed = now - startTime;
        selectedLunarDay = (startDay + (elapsed / CYCLE_ANIMATION_MS) * SLIDER_CYCLE_DAYS) % SLIDER_CYCLE_DAYS;
        daySlider.value = selectedLunarDay.toFixed(1);
        updateTimescaleLabels(selectedLunarDay);
        updateSunMarker(selectedLunarDay);
        window.setLunarSunDay?.(selectedLunarDay);
        if (now - lastPlaybackPaint >= PLAYBACK_FRAME_MS) {
            lastPlaybackPaint = now;
            refreshSolarDisplay();
        }
        playbackFrame = requestAnimationFrame(animate);
    };
    playbackFrame = requestAnimationFrame(animate);
}

function setSolarControlsVisible(visible) {
    timescalePanel.hidden = !visible;
    if (!visible) {
        stopCycleAnimation();
        window.setLunarSunDay?.(null);
    } else if (selectedLunarDay !== null) {
        window.setLunarSunDay?.(selectedLunarDay);
    }
    updateSunMarker();
}

daySlider.addEventListener('input', () => {
    selectedLunarDay = Number(daySlider.value);
    updateTimescaleLabels(selectedLunarDay);
    updateSunMarker(selectedLunarDay);
    window.setLunarSunDay?.(selectedLunarDay);
    refreshSolarDisplay();
});

playButton.addEventListener('click', () => {
    if (playbackFrame === null) startCycleAnimation();
    else stopCycleAnimation();
});

document.getElementById('lunar-cycle-average').addEventListener('click', () => {
    stopCycleAnimation();
    selectedLunarDay = null;
    daySlider.value = '0';
    updateTimescaleLabels(null);
    updateSunMarker(null);
    window.setLunarSunDay?.(null);
    refreshSolarDisplay();
});

setSolarControlsVisible(activeMode === 'solar');
updateTimescaleLabels(null);

function createCanvasTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_SIZE;
    canvas.height = CANVAS_SIZE;
    canvasContext = canvas.getContext('2d', { alpha: true });
    if (!canvasContext) throw new Error('Could not create 2D canvas context for the lunar heatmap');
    texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    // Keep texture row zero aligned with the planar UVs written to the cap.
    texture.flipY = false;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
}

function updateLegend(mode, observedMin, observedMax, pointCount) {
    if (!legend) {
        legend = document.createElement('aside');
        legend.className = 'heatmap-legend';
        legend.setAttribute('aria-live', 'polite');
        legend.innerHTML = '<strong class="title"></strong><div class="gradient"></div><div class="labels"><span></span><span></span></div><small></small>';
        document.body.appendChild(legend);
    }
    legend.querySelector('.title').textContent = mode.title;
    legend.querySelector('.gradient').style.background = `linear-gradient(90deg, ${mode.stops.join(', ')})`;
    const labels = legend.querySelectorAll('.labels span');
    labels[0].textContent = mode.labels[0];
    labels[1].textContent = mode.labels[1];
    legend.querySelector('small').textContent = `${mode.source} · ${pointCount.toLocaleString()} locations · observed ${observedMin.toFixed(2)}–${observedMax.toFixed(2)} ${mode.unit}`;
    legend.hidden = false;
}

function removeOldOverlay(scene) {
    for (const child of [...scene.children]) {
        if (child.name === OVERLAY_NAME) scene.remove(child);
    }
}

async function attachHeatmap(scene) {
    sceneRef = scene;
    if (overlay) return;
    if (attachPromise) return attachPromise;
    attachPromise = (async () => {
        const pivot = scene.children.find(isMoonGroup);
        if (!pivot) return;
        const moonRoot = findMoonRoot(pivot);
        const sphere = measureWorldSphere(moonRoot);
        const orientation = uvDirectionFrame(moonRoot, sphere.center);
        const datasets = await loadDatasets();

        maxColatitudeRad = polarCapExtent(datasets[activeMode]);
        createCanvasTexture();
        removeOldOverlay(scene);
        const surfaceRadius = sphere.radius * SURFACE_SCALE;
        const geometry = createPolarCapGeometry(surfaceRadius, maxColatitudeRad);
        // Draw the mapped data on a transparent shell with depth testing off.
        // This lets the South Pole remain visible through the globe as it
        // rotates onto the far hemisphere, while alphaTest preserves clear
        // canvas pixels so they do not tint the rest of the Moon.
        const material = new THREE.MeshBasicMaterial({
            map: texture,
            transparent: true,
            opacity: 1,
            alphaTest: 0.015,
            depthTest: false,
            depthWrite: false,
            side: THREE.DoubleSide,
            toneMapped: false,
        });
        overlay = new THREE.Mesh(geometry, material);
        overlay.name = OVERLAY_NAME;
        overlay.position.copy(sphere.center);
        overlay.quaternion.copy(orientation);
        overlay.visible = true;
        overlay.renderOrder = 999;
        scene.add(overlay);
        sunMarker = new THREE.Mesh(
            new THREE.SphereGeometry(surfaceRadius * 0.012, 16, 12),
            new THREE.MeshBasicMaterial({
                color: '#ffd44a',
                toneMapped: false,
                depthTest: false,
                depthWrite: false,
            }),
        );
        sunMarker.name = 'Lunar solar azimuth marker';
        sunMarker.userData.surfaceRadius = surfaceRadius;
        sunMarker.renderOrder = 1000;
        overlay.add(sunMarker);
        addSitePins(surfaceRadius);
        updateSunMarker();
        const points = displayPoints(MODES[activeMode], datasets);
        paintDataset(MODES[activeMode], points);
        renderSummary(MODES[activeMode], points);
        console.info(`Moon world sphere radius: ${sphere.radius.toFixed(6)}; heatmap cap radius: ${surfaceRadius.toFixed(6)} (${SURFACE_SCALE.toFixed(3)}×); cap colatitude: ${(maxColatitudeRad * 180 / Math.PI).toFixed(3)}°.`);
    })().finally(() => { attachPromise = null; });
    return attachPromise;
}

function scheduleAttach(scene) {
    void attachHeatmap(scene).catch(error => console.error('Moon surface heatmap could not be loaded:', error));
}

window.addEventListener('lunar-location-selected', event => {
    handleLocationSelection(event.detail);
});

document.getElementById('site-card-close').addEventListener('click', () => {
    siteCard.hidden = true;
});

const originalAdd = THREE.Object3D.prototype.add;
THREE.Object3D.prototype.add = function addWithSurfaceHeatmap(...objects) {
    const result = originalAdd.apply(this, objects);
    if (this.isScene && objects.some(isMoonGroup)) scheduleAttach(this);
    return result;
};

document.querySelectorAll('.control-btn').forEach(button => {
    button.addEventListener('click', () => {
        activeMode = button.dataset.mode;
        if (activeMode === 'solar' && selectedLunarDay === null) selectedLunarDay = 0;
        setSolarControlsVisible(activeMode === 'solar');
        updateTimescaleLabels(selectedLunarDay);
        if (!overlay) {
            if (sceneRef) scheduleAttach(sceneRef);
            loadDatasets().then(datasets => renderSummary(MODES[activeMode], displayPoints(MODES[activeMode], datasets)))
                .catch(error => console.error('Could not calculate lunar dataset summary:', error));
            return;
        }
        loadDatasets().then(datasets => {
            if (activeMode !== button.dataset.mode) return;
            const points = displayPoints(MODES[activeMode], datasets);
            paintDataset(MODES[activeMode], points);
            renderSummary(MODES[activeMode], points);
        })
            .catch(error => console.error('Could not switch lunar heatmap dataset:', error));
    });
});

