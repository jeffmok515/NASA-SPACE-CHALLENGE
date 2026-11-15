import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ==========================================
// 1. CREATE SCENE
// ==========================================

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050510);

// ==========================================
// 2. CAMERA
// ==========================================

const camera = new THREE.PerspectiveCamera(
    45,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
);

camera.position.set(0, 0, 5);

// ==========================================
// 3. RENDERER
// ==========================================

const renderer = new THREE.WebGLRenderer({
    antialias: true
});

renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

document.body.appendChild(renderer.domElement);

// ==========================================
// 4. 360-DEGREE STARFIELD BACKGROUND
// ==========================================

const textureLoader = new THREE.TextureLoader();

textureLoader.load(
    '/assets/textures/space_panorama.jpg',

    function(texture) {

        texture.colorSpace = THREE.SRGBColorSpace;

        const skyGeometry = new THREE.SphereGeometry(
            100,
            64,
            64
        );

        const skyMaterial = new THREE.MeshBasicMaterial({
            map: texture,
            side: THREE.BackSide,
            depthWrite: false
        });

        const skybox = new THREE.Mesh(
            skyGeometry,
            skyMaterial
        );

        skybox.renderOrder = -1;
        scene.add(skybox);

        console.log('360-degree starfield loaded!');

    },

    undefined,

    function(error) {
        console.error('Skybox loading error:', error);
    }
);

// ==========================================
// 5. ADD EXTRA 3D STARS
// ==========================================

function createStarLayer(count, radius, starSize) {

    const positions = [];
    const colors = [];

    for (let i = 0; i < count; i++) {

        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);

        const x = radius * Math.sin(phi) * Math.cos(theta);
        const y = radius * Math.sin(phi) * Math.sin(theta);
        const z = radius * Math.cos(phi);

        positions.push(x, y, z);

        const color = new THREE.Color();

        if (Math.random() > 0.85) {
            color.setHSL(0.58, 0.35, 0.85);
        } else {
            color.setHSL(0.12, 0.05, 0.9 + Math.random() * 0.1);
        }

        colors.push(color.r, color.g, color.b);
    }

    const geometry = new THREE.BufferGeometry();

    geometry.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(positions, 3)
    );

    geometry.setAttribute(
        'color',
        new THREE.Float32BufferAttribute(colors, 3)
    );

    const material = new THREE.PointsMaterial({
        size: starSize,
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
        sizeAttenuation: true,
        depthWrite: false
    });

    const stars = new THREE.Points(geometry, material);

    scene.add(stars);
}

// Three layers at different distances
createStarLayer(700, 18, 0.04);
createStarLayer(450, 35, 0.06);
createStarLayer(300, 60, 0.08);

console.log('Extra 3D star layers created!');

// ==========================================
// 6. REALISTIC MOON LIGHTING
// ==========================================

const ambientLight = new THREE.AmbientLight(
    0xffffff,
    0.15
);

scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(
    0xffffff,
    2.5
);

directionalLight.position.set(5, 2, 5);
scene.add(directionalLight);

// ==========================================
// 7. CAMERA CONTROLS
// ==========================================

const controls = new OrbitControls(
    camera,
    renderer.domElement
);

controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.enableZoom = true;
controls.enablePan = false;

// ==========================================
// 8. LOAD MOON MODEL
// ==========================================

// Filled in once the moon has loaded (fades labels on the far side)
let updateLandmarks = () => {};

const loader = new GLTFLoader();

loader.load(
    '/assets/models/moon.glb',

    function(gltf) {

        const moon = gltf.scene;

        const box = new THREE.Box3().setFromObject(moon);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());

        // Centre the model's geometry on the origin of a pivot group.
        // (Scaling the moon directly while also offsetting its position
        // pushes it off-centre, so the pivot does the scaling instead.)
        moon.position.sub(center);

        const pivot = new THREE.Group();
        pivot.add(moon);

        const maxDimension = Math.max(size.x, size.y, size.z);
        pivot.scale.setScalar(2.5 / maxDimension);

        // ==========================================
        // FIND THE REAL POLES FROM THE MODEL'S UV MAP
        // ==========================================
        // On a UV-mapped sphere the texture pinches to a single point at
        // each pole (v = min and v = max). Finding those vertices gives the
        // model's true axis, however the GLB happens to be rotated.

        const SHOW_DEBUG_AXES = false;   // true = also show X/Y/Z axes

        // --- Calibration knobs (only touch if landmarks look wrong) ---
        const FLIP_NORTH_SOUTH = true;   // calibrated against the Moon texture and South Pole landmarks
        const MAP_CENTER_LON   = 0;      // longitude at the centre of the texture
        const LONGITUDE_SIGN   = 1;      // -1 = east/west appear swapped

        pivot.updateMatrixWorld(true);
        const pivotInverse = new THREE.Matrix4().copy(pivot.matrixWorld).invert();

        let vMin = Infinity, vMax = -Infinity;
        const meshes = [];

        moon.traverse(obj => {
            if (obj.isMesh && obj.geometry.attributes.uv) {
                meshes.push(obj);
                const uv = obj.geometry.attributes.uv;
                for (let i = 0; i < uv.count; i++) {
                    const v = uv.getY(i);
                    if (v < vMin) vMin = v;
                    if (v > vMax) vMax = v;
                }
            }
        });

        function poleAt(targetV) {
            const sum = new THREE.Vector3();
            const p = new THREE.Vector3();
            let n = 0;
            const tolerance = 0.002;

            meshes.forEach(mesh => {
                const uv = mesh.geometry.attributes.uv;
                const pos = mesh.geometry.attributes.position;
                const toPivot = new THREE.Matrix4()
                    .copy(pivotInverse)
                    .multiply(mesh.matrixWorld);

                for (let i = 0; i < uv.count; i++) {
                    if (Math.abs(uv.getY(i) - targetV) < tolerance) {
                        p.fromBufferAttribute(pos, i).applyMatrix4(toPivot);
                        sum.add(p);
                        n++;
                    }
                }
            });

            return n ? sum.divideScalar(n) : null;
        }

        // glTF UV origin is the image's top-left, so v = min is the image top.
        // Standard moon textures have north at the top, so: min v = north.
        let northPos = poleAt(vMin);
        let southPos = poleAt(vMax);

        if (!northPos || !southPos) {
            console.warn('No UV poles found - falling back to the Y axis');
            northPos = new THREE.Vector3(0,  size.y / 2, 0);
            southPos = new THREE.Vector3(0, -size.y / 2, 0);
        }

        if (FLIP_NORTH_SOUTH) [northPos, southPos] = [southPos, northPos];

        // ==========================================
        // LONGITUDE REFERENCE FROM THE UV MAP
        // ==========================================
        // Take the surface points at the centre of the texture (lon 0) and a
        // quarter of the way across (lon +90), so east/west come from the
        // model itself and nothing depends on how it was exported.

        const vMid = (vMin + vMax) / 2;

        function vertexAtUV(targetU, targetV) {
            let best = Infinity;
            const bestPos = new THREE.Vector3();
            meshes.forEach(mesh => {
                const uv = mesh.geometry.attributes.uv;
                let bestI = -1, bestD = Infinity;
                for (let i = 0; i < uv.count; i++) {
                    let du = Math.abs(uv.getX(i) - targetU);
                    du = Math.min(du, 1 - du);          // u wraps around
                    const dv = uv.getY(i) - targetV;
                    const d = du * du + dv * dv;
                    if (d < bestD) { bestD = d; bestI = i; }
                }
                if (bestD < best) {
                    best = bestD;
                    bestPos.fromBufferAttribute(mesh.geometry.attributes.position, bestI)
                        .applyMatrix4(new THREE.Matrix4()
                            .copy(pivotInverse).multiply(mesh.matrixWorld));
                }
            });
            return bestPos;
        }

        const northAxis = new THREE.Vector3().subVectors(northPos, southPos).normalize();

        function flatten(v) {   // remove the north component, keep it on the equator
            return v.clone().addScaledVector(northAxis, -v.dot(northAxis)).normalize();
        }

        const lonA = flatten(vertexAtUV(0.5,  vMid));   // map centre
        const lonB = flatten(vertexAtUV(0.75, vMid));   // a quarter turn further

        // Share the same calibrated axes with the heatmap so it follows this
        // model's true South Pole and longitude convention exactly.
        window.lunarFrame = {
            northAxis: northAxis.clone(),
            lonA: lonA.clone(),
            lonB: lonB.clone(),
            lonSign: LONGITUDE_SIGN,
            centerLon: MAP_CENTER_LON,
        };
        const defaultSunPosition = directionalLight.position.clone();
        window.setLunarSunDay = day => {
            if (!Number.isFinite(day)) {
                directionalLight.position.copy(defaultSunPosition);
                return;
            }
            const sunLon = (day / 29.53) * 360 - 180;
            const sunLat = THREE.MathUtils.degToRad(-1.0);
            const sunLonRad = THREE.MathUtils.degToRad((sunLon - MAP_CENTER_LON) * LONGITUDE_SIGN);
            const direction = new THREE.Vector3()
                .addScaledVector(lonA, Math.cos(sunLat) * Math.cos(sunLonRad))
                .addScaledVector(lonB, Math.cos(sunLat) * Math.sin(sunLonRad))
                .addScaledVector(northAxis, Math.sin(sunLat))
                .transformDirection(pivot.matrixWorld);
            directionalLight.position.copy(direction.multiplyScalar(20));
        };

        // On a correct moon: north x lon0 = east. Negative means the map or
        // the poles are mirrored; flip FLIP_NORTH_SOUTH or LONGITUDE_SIGN.
        const handedness = new THREE.Vector3().crossVectors(northAxis, lonA).dot(lonB);
        console.log('Texture handedness (positive is normal):', handedness.toFixed(3));

        // Raycast from outside toward the centre to find the real surface
        const raycaster = new THREE.Raycaster();
        const worldCentre = pivot.localToWorld(new THREE.Vector3(0, 0, 0));

        function surfacePoint(dir) {
            const origin = pivot.localToWorld(dir.clone().multiplyScalar(maxDimension * 2));
            raycaster.set(origin, worldCentre.clone().sub(origin).normalize());
            const hit = raycaster.intersectObject(moon, true)[0];
            return hit ? pivot.worldToLocal(hit.point.clone()) : null;
        }

        console.log('North pole (model space):', northPos.toArray());
        console.log('South pole (model space):', southPos.toArray());

        // A group whose local +Y runs from the south pole to the north pole
        const poleFrame = new THREE.Group();
        const axisDir = new THREE.Vector3().subVectors(northPos, southPos).normalize();
        poleFrame.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axisDir);
        pivot.add(poleFrame);

        const poleRadius = (surfacePoint(southPos.clone().normalize()) || southPos).length();

        // ==========================================
        // POLE STYLING
        // ==========================================

        const NORTH_COLOR = 0x1aa9c9;   // deep teal
        const SOUTH_COLOR = 0xc8203f;   // deep crimson

        const axisHalfLength = poleRadius * 1.55;   // how far the axis pokes out
        const axisThickness  = maxDimension * 0.0028;

        // Dashed line made of small cylinders (one draw call per line)
        function dashedLine(color, yStart, yEnd, opacity, seeThrough) {
            const dash = maxDimension * 0.05;
            const gap  = maxDimension * 0.035;
            const step = dash + gap;
            const count = Math.floor(Math.abs(yEnd - yStart) / step);
            const dir = Math.sign(yEnd - yStart);

            const geo = new THREE.CylinderGeometry(axisThickness, axisThickness, dash, 6);
            const mat = new THREE.MeshBasicMaterial({
                color,
                transparent: true,
                opacity,
                depthTest: !seeThrough,
                depthWrite: false,
                blending: THREE.AdditiveBlending
            });

            const mesh = new THREE.InstancedMesh(geo, mat, count);
            const m = new THREE.Matrix4();
            for (let i = 0; i < count; i++) {
                m.makeTranslation(0, yStart + dir * (i * step + dash / 2), 0);
                mesh.setMatrixAt(i, m);
            }
            mesh.renderOrder = seeThrough ? 998 : 999;
            return mesh;
        }

        // Each half drawn twice:
        //   1) solid-ish, hidden behind the moon  -> the parts sticking out
        //   2) very faint, always on top          -> the ghost through the moon
        [[NORTH_COLOR, 1], [SOUTH_COLOR, -1]].forEach(([color, dir]) => {
            poleFrame.add(dashedLine(color, 0, dir * axisHalfLength, 0.95, false));
            poleFrame.add(dashedLine(color, 0, dir * axisHalfLength, 0.16, true));
        });

        // Pole rings: thin double ring lying flat on the surface
        function poleRing(color, dir) {
            const g = new THREE.Group();
            g.position.set(0, dir * poleRadius * 1.01, 0);
            // Torus faces +Z by default, so turn it to face outward along dir*Y
            g.quaternion.setFromUnitVectors(
                new THREE.Vector3(0, 0, 1),
                new THREE.Vector3(0, dir, 0)
            );

            const mat = (o) => new THREE.MeshBasicMaterial({
                color, transparent: true, opacity: o,
                depthWrite: false, blending: THREE.AdditiveBlending
            });

            g.add(new THREE.Mesh(
                new THREE.TorusGeometry(maxDimension * 0.035, maxDimension * 0.0025, 8, 64),
                mat(0.95)));
            g.add(new THREE.Mesh(
                new THREE.TorusGeometry(maxDimension * 0.06, maxDimension * 0.0015, 8, 64),
                mat(0.45)));
            g.add(new THREE.Mesh(
                new THREE.CircleGeometry(maxDimension * 0.012, 24),
                mat(0.9)));
            return g;
        }

        poleFrame.add(poleRing(NORTH_COLOR, 1));
        poleFrame.add(poleRing(SOUTH_COLOR, -1));

        // Small diamond at the tip of each axis
        [[NORTH_COLOR, 1], [SOUTH_COLOR, -1]].forEach(([color, dir]) => {
            const tip = new THREE.Mesh(
                new THREE.OctahedronGeometry(maxDimension * 0.022),
                new THREE.MeshBasicMaterial({
                    color, wireframe: true, transparent: true, opacity: 0.95,
                    blending: THREE.AdditiveBlending, depthWrite: false
                })
            );
            tip.position.y = dir * axisHalfLength;
            tip.renderOrder = 999;
            poleFrame.add(tip);
        });

        // Text labels (canvas sprites, always face the camera)
        function labelSprite(text, color) {
            const canvas = document.createElement('canvas');
            canvas.width = 512;
            canvas.height = 128;
            const ctx = canvas.getContext('2d');
            ctx.font = "600 52px Orbitron, 'Share Tech Mono', monospace";
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = '#' + new THREE.Color(color).getHexString();
            ctx.shadowColor = ctx.fillStyle;
            ctx.shadowBlur = 14;
            ctx.fillText(text, 256, 64);

            const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
                map: new THREE.CanvasTexture(canvas),
                transparent: true,
                depthTest: false
            }));
            sprite.scale.set(maxDimension * 0.42, maxDimension * 0.105, 1);
            sprite.renderOrder = 1000;
            return sprite;
        }

        const northLabel = labelSprite('N-POLE', NORTH_COLOR);
        northLabel.position.set(0, axisHalfLength + maxDimension * 0.09, 0);
        poleFrame.add(northLabel);

        const southLabel = labelSprite('S-POLE', SOUTH_COLOR);
        southLabel.position.set(0, -axisHalfLength - maxDimension * 0.09, 0);
        poleFrame.add(southLabel);

        // ==========================================
        // LANDMARKS  (name, latitude, longitude)
        // ==========================================

        const LANDMARKS = [
            { name: 'TRANQUILITY BASE', sub: 'APOLLO 11',  lat:   0.674, lon:   23.473 },
            { name: 'APOLLO 12',        sub: 'OCEAN OF STORMS', lat: -3.012, lon: -23.422 },
            { name: 'APOLLO 14',        sub: 'FRA MAURO',  lat:  -3.646, lon:  -17.471 },
            { name: 'APOLLO 15',        sub: 'HADLEY RILLE', lat: 26.132, lon:   3.634 },
            { name: 'APOLLO 16',        sub: 'DESCARTES',  lat:  -8.973, lon:   15.500 },
            { name: 'APOLLO 17',        sub: 'TAURUS-LITTROW', lat: 20.191, lon: 30.772 },
            { name: 'TYCHO',            sub: 'CRATER',     lat: -43.310, lon:  -11.360 },
            { name: 'COPERNICUS',       sub: 'CRATER',     lat:   9.620, lon:  -20.080 },
            { name: 'ARISTARCHUS',      sub: 'CRATER',     lat:  23.730, lon:  -47.490 },
            { name: "CHANG'E 4",        sub: 'FAR SIDE',   lat: -45.445, lon:  177.599 }
        ];

        // --- Landmark look (sizes are in SCREEN pixels, not 3D units) ---
        const LABEL_WIDTH_PX  = 140;   // label width on screen
        const RING_RADIUS_PX  = 5;     // marker ring radius
        const STEM_LENGTH_PX  = 38;    // height of the line
        const LABEL_FULL_DIST = 4.3;   // camera farther than this = full size
        const LABEL_HIDE_DIST = 0.5;   // camera closer than this = only the dot is left

        const LABEL_RATIO = 128 / 512; // label canvas height / width

        function landmarkLabel(item) {
            const canvas = document.createElement('canvas');
            canvas.width = 512;
            canvas.height = 128;
            const ctx = canvas.getContext('2d');
            const texture = new THREE.CanvasTexture(canvas);

            function draw() {
                ctx.clearRect(0, 0, 512, 128);

                // dark glass plate so the white text reads on any terrain
                ctx.fillStyle = 'rgba(3, 12, 30, 0.75)';
                ctx.fillRect(4, 8, 504, 112);
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
                ctx.lineWidth = 3;
                ctx.strokeRect(4, 8, 504, 112);
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(4, 8, 8, 112);                  // white edge accent

                // name, shrunk to fit if it is long
                let size = 46;
                ctx.font = `600 ${size}px Orbitron, 'Share Tech Mono', monospace`;
                const w = ctx.measureText(item.name).width;
                if (w > 450) {
                    size *= 450 / w;
                    ctx.font = `600 ${size}px Orbitron, 'Share Tech Mono', monospace`;
                }
                ctx.textAlign = 'left';
                ctx.textBaseline = 'alphabetic';
                ctx.fillStyle = '#ffffff';
                ctx.fillText(item.name, 28, 64);

                ctx.fillStyle = 'rgba(180, 215, 235, 0.9)';
                ctx.font = "28px 'Share Tech Mono', monospace";
                ctx.fillText(item.sub, 28, 102);

                texture.needsUpdate = true;
            }

            draw();
            if (document.fonts && document.fonts.ready) document.fonts.ready.then(draw);

            const material = new THREE.SpriteMaterial({
                map: texture, transparent: true, depthTest: false, opacity: 0
            });
            const sprite = new THREE.Sprite(material);
            sprite.renderOrder = 1001;
            return { sprite, material };
        }

        const landmarkGroup = new THREE.Group();
        const landmarkEntries = [];

        // Unit-sized geometry, scaled every frame so it keeps a fixed pixel size
        const ringGeo = new THREE.TorusGeometry(1, 0.14, 8, 40);
        const dotGeo  = new THREE.CircleGeometry(0.28, 20);
        const stemGeo = new THREE.CylinderGeometry(1, 1, 1, 6);
        stemGeo.translate(0, 0.5, 0);                    // grows upward from y = 0
        const capGeo  = new THREE.SphereGeometry(1, 12, 12);

        LANDMARKS.forEach(item => {
            const lat = THREE.MathUtils.degToRad(item.lat);
            const lon = THREE.MathUtils.degToRad(
                (item.lon - MAP_CENTER_LON) * LONGITUDE_SIGN
            );

            // direction from the moon's centre toward this place
            const dir = new THREE.Vector3()
                .addScaledVector(lonA, Math.cos(lat) * Math.cos(lon))
                .addScaledVector(lonB, Math.cos(lat) * Math.sin(lon))
                .addScaledVector(northAxis, Math.sin(lat))
                .normalize();

            const surface = surfacePoint(dir) || dir.clone().multiplyScalar(poleRadius);

            const root = new THREE.Group();
            root.position.copy(surface);
            root.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);

            const markerMats = [];
            const whiteMat = (o) => {
                const m = new THREE.MeshBasicMaterial({
                    color: 0xffffff, transparent: true, opacity: o, depthWrite: false
                });
                markerMats.push({ material: m, base: o });
                return m;
            };

            const stem = new THREE.Mesh(stemGeo, whiteMat(0.9));
            root.add(stem);

            const ring = new THREE.Group();
            ring.rotation.x = Math.PI / 2;               // lie flat on the surface
            ring.add(new THREE.Mesh(ringGeo, whiteMat(0.95)));
            ring.add(new THREE.Mesh(dotGeo, whiteMat(0.95)));
            root.add(ring);

            const cap = new THREE.Mesh(capGeo, whiteMat(1));
            root.add(cap);

            const label = landmarkLabel(item);
            root.add(label.sprite);

            landmarkGroup.add(root);
            landmarkEntries.push({
                root, dir, stem, ring, cap, label, markerMats,
                labelAlpha: 0, dist: 0, fade: 0, t: 0, wantLabel: false,
                widthPx: 0
            });
        });

        pivot.add(landmarkGroup);

        // Every frame: keep sizes constant on screen, shrink + hide when zoomed
        // in, hide the far side, and drop labels that would overlap a closer one.
        const _worldPos = new THREE.Vector3();
        const _normal = new THREE.Vector3();
        const _view = new THREE.Vector3();
        const _ndc = new THREE.Vector3();

        updateLandmarks = () => {
            const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
            const pivotScale = pivot.scale.x;
            const H = window.innerHeight;
            const W = window.innerWidth;
            const px2local = (px, dist) => px / H * 2 * tanHalf * dist / pivotScale;

            landmarkEntries.forEach(e => {
                e.root.getWorldPosition(_worldPos);
                e.dist = camera.position.distanceTo(_worldPos);

                // far-side fade
                _normal.copy(e.dir).transformDirection(pivot.matrixWorld);
                _view.subVectors(camera.position, _worldPos).normalize();
                e.fade = THREE.MathUtils.clamp((_normal.dot(_view) - 0.05) / 0.3, 0, 1);
                e.root.visible = e.fade > 0;
                if (!e.root.visible) { e.labelAlpha = 0; return; }

                // 0 = zoomed right in, 1 = far enough for full detail
                const x = THREE.MathUtils.clamp(
                    (e.dist - LABEL_HIDE_DIST) / (LABEL_FULL_DIST - LABEL_HIDE_DIST), 0, 1);
                e.t = x * x * (3 - 2 * x);

                // marker: constant pixel size, line retracts as you zoom in
                const stemLen = px2local(STEM_LENGTH_PX, e.dist) * e.t;
                const stemW = px2local(0.8, e.dist);
                e.stem.scale.set(stemW, Math.max(stemLen, 1e-5), stemW);
                e.stem.visible = e.t > 0.02;

                e.cap.position.y = stemLen;
                e.cap.scale.setScalar(px2local(2.2, e.dist));
                e.cap.visible = e.t > 0.02;

                e.ring.scale.setScalar(px2local(RING_RADIUS_PX, e.dist));

                e.markerMats.forEach(m => { m.material.opacity = m.base * e.fade; });

                // label: shrinks a little as you zoom in, then fades out
                e.widthPx = LABEL_WIDTH_PX * (0.55 + 0.45 * e.t);
                const wLocal = px2local(e.widthPx, e.dist);
                const hLocal = wLocal * LABEL_RATIO;
                e.label.sprite.scale.set(wLocal, hLocal, 1);
                e.label.sprite.position.y = stemLen + hLocal * 0.62 + px2local(4, e.dist);
                e.root.updateMatrixWorld(true);

                e.wantLabel = e.fade > 0.3 && e.t > 0.08;
            });

            // Closest first: a label is only shown if it does not cover an
            // already-shown one, so clusters stay readable.
            const placed = [];
            [...landmarkEntries]
                .sort((a, b) => a.dist - b.dist)
                .forEach(e => {
                    let target = 0;

                    if (e.root.visible && e.wantLabel) {
                        e.label.sprite.getWorldPosition(_ndc).project(camera);
                        const cx = (_ndc.x * 0.5 + 0.5) * W;
                        const cy = (-_ndc.y * 0.5 + 0.5) * H;
                        const hw = e.widthPx / 2 + 4;
                        const hh = e.widthPx * LABEL_RATIO / 2 + 4;

                        const clash = placed.some(r =>
                            Math.abs(cx - r.cx) < hw + r.hw &&
                            Math.abs(cy - r.cy) < hh + r.hh);

                        if (!clash) {
                            placed.push({ cx, cy, hw, hh });
                            target = 1;
                        }
                    }

                    e.labelAlpha += (target - e.labelAlpha) * 0.2;   // smooth fade
                    e.label.material.opacity =
                        e.labelAlpha * e.fade * Math.min(1, e.t * 2.5);
                    e.label.sprite.visible = e.label.material.opacity > 0.01;
                });
        };

        console.log(`${LANDMARKS.length} landmarks plotted`);

        if (SHOW_DEBUG_AXES) {
            pivot.add(new THREE.AxesHelper(maxDimension * 0.8));
        }

        scene.add(pivot);

        let surfacePointerStart = null;
        renderer.domElement.addEventListener('pointerdown', event => {
            surfacePointerStart = { id: event.pointerId, x: event.clientX, y: event.clientY };
        });
        window.addEventListener('pointerup', event => {
            const start = surfacePointerStart;
            surfacePointerStart = null;
            if (!start || start.id !== event.pointerId
                || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;

            const rect = renderer.domElement.getBoundingClientRect();
            const pointer = new THREE.Vector2(
                ((event.clientX - rect.left) / rect.width) * 2 - 1,
                -((event.clientY - rect.top) / rect.height) * 2 + 1,
            );
            raycaster.setFromCamera(pointer, camera);
            const heatmap = scene.children.find(child => child.name === 'Lunar processed heatmap surface');
            const pinMeshes = [];
            heatmap?.traverse(child => {
                if (child.isMesh && child.parent?.name.startsWith('Landing site pin:')) pinMeshes.push(child);
            });
            const pinHit = pinMeshes.length ? raycaster.intersectObjects(pinMeshes, false)[0] : null;
            if (pinHit) {
                const site = pinHit.object.parent.userData.site;
                window.dispatchEvent(new CustomEvent('lunar-location-selected', {
                    detail: { lat: site.lat, lon: site.lon, presetId: site.id },
                }));
                return;
            }
            const hit = raycaster.intersectObject(moon, true)[0];
            if (!hit) return;

            const direction = pivot.worldToLocal(hit.point.clone()).normalize();
            const latitude = THREE.MathUtils.radToDeg(Math.asin(
                THREE.MathUtils.clamp(direction.dot(northAxis), -1, 1),
            ));
            if (latitude > -80) return;
            let longitude = MAP_CENTER_LON + THREE.MathUtils.radToDeg(
                Math.atan2(direction.dot(lonB), direction.dot(lonA)) / LONGITUDE_SIGN,
            );
            longitude = ((longitude + 180) % 360 + 360) % 360 - 180;
            window.dispatchEvent(new CustomEvent('lunar-location-selected', {
                detail: { lat: latitude, lon: longitude },
            }));
        });

        console.log('Moon loaded successfully!');
        console.log('South pole marker added!');

    },

    function(progress) {

        if (progress.total > 0) {

            const percentage = Math.round(
                (progress.loaded / progress.total) * 100
            );

            console.log(`Loading Moon: ${percentage}%`);
        }
    },

    function(error) {
        console.error('Moon loading error:', error);
    }
);

// ==========================================
// 9. WINDOW RESIZE
// ==========================================

window.addEventListener('resize', () => {

    camera.aspect = window.innerWidth / window.innerHeight;

    camera.updateProjectionMatrix();

    renderer.setSize(
        window.innerWidth,
        window.innerHeight
    );
});

// ==========================================
// 9.5 MISSION CONTROL BUTTONS
// ==========================================

const moduleDescriptions = {

    sunlight: {
        title: 'SUNLIGHT',
        description: 'Monitoring lunar illumination conditions.'
    },

    terrain: {
        title: 'TERRAIN',
        description: 'Inspecting lunar elevation and surface slopes.'
    },

    solar: {
        title: 'SOLAR ENERGY',
        description: 'Analysing potential solar energy generation.'
    },

    suitability: {
        title: 'SUITABILITY',
        description: 'Evaluating potential lunar landing locations.'
    }

};

const controlButtons = document.querySelectorAll('.control-btn');

controlButtons.forEach(button => {

    button.addEventListener('click', () => {

        // Remove active state from all buttons
        controlButtons.forEach(btn => {
            btn.classList.remove('active');
        });

        // Activate selected button
        button.classList.add('active');

        // Get selected module
        const mode = button.dataset.mode;
        const selectedModule = moduleDescriptions[mode];

        // Update information panel
        document.getElementById('active-module').textContent =
            selectedModule.title;

        document.getElementById('module-description').textContent =
            selectedModule.description;

        console.log('Active module:', selectedModule.title);

    });

});

// ==========================================
// 10. ANIMATION LOOP
// ==========================================

function animate() {

    requestAnimationFrame(animate);

    controls.update();
    updateLandmarks();

    renderer.render(scene, camera);
}

animate();
