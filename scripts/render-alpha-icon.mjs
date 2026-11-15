// Render the shipped GLB on transparency for Alpha's app and project icons.
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { launchBrowser } from '../desktop/service/test/browser.mjs';

const root = path.resolve(import.meta.dirname, '..');
const destination = path.resolve(process.argv[2] || path.join(root, '.cache/alpha-head-render.png'));
const files = new Map([
  ['/model.glb', [path.join(root, 'public/models/alpha-head/alpha-android.glb'), 'model/gltf-binary']],
  ['/color.jpg', [path.join(root, 'public/models/alpha-head/color.jpg'), 'image/jpeg']],
]);
const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;background:transparent}</style>
<script type="importmap">{"imports":{"three":"/node_modules/three/build/three.module.js"}}</script></head><body><script type="module">
import * as THREE from 'three';
import { GLTFLoader } from '/node_modules/three/examples/jsm/loaders/GLTFLoader.js';
const renderer = new THREE.WebGLRenderer({antialias:true, alpha:true, preserveDrawingBuffer:true});
renderer.setSize(1024,1024,false);
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.setClearColor(0,0);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(34,1,.1,30);
camera.position.set(0,.025,3.72);
camera.lookAt(0,0,0);
scene.add(new THREE.AmbientLight(0xa5e4ff,.96));
const key = new THREE.PointLight(0xc1f5ff,12,9); key.position.set(-2,2,3); scene.add(key);
const fill = new THREE.PointLight(0x2b87df,6,9); fill.position.set(2,-.1,2.4); scene.add(fill);
const rim = new THREE.PointLight(0x55dfff,10,9); rim.position.set(.5,.8,-1.6); scene.add(rim);
const texture = await new THREE.TextureLoader().loadAsync('/color.jpg');
texture.colorSpace = THREE.SRGBColorSpace;
texture.flipY = false;
const gltf = await new GLTFLoader().loadAsync('/model.glb');
const model = gltf.scene;
const bounds = new THREE.Box3().setFromObject(model);
const size = bounds.getSize(new THREE.Vector3());
const center = bounds.getCenter(new THREE.Vector3());
model.position.copy(center.multiplyScalar(-1));
model.traverse(object => {
  if (!(object instanceof THREE.Mesh)) return;
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  for (const material of materials) {
    if (!(material instanceof THREE.MeshStandardMaterial)) continue;
    material.map = texture;
    material.color.set(0xffffff);
    material.roughness = .62;
    material.metalness = .12;
    material.metalnessMap = null;
    material.roughnessMap = null;
    material.needsUpdate = true;
  }
});
const facing = new THREE.Group();
facing.rotation.y = -Math.PI/2;
facing.scale.setScalar(1.9 / Math.max(size.x,size.y));
facing.add(model);
scene.add(facing);
renderer.render(scene,camera);
window.alphaIconReady = true;
</script></body></html>`;

const server = http.createServer(async (request, response) => {
  try {
    if (request.url === '/') { response.writeHead(200, { 'content-type': 'text/html' }); response.end(html); return; }
    if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    let item = files.get(request.url);
    if (!item && request.url.startsWith('/node_modules/three/')) {
      const base = path.join(root, 'node_modules/three');
      const file = path.resolve(root, '.' + decodeURIComponent(request.url));
      if (file.startsWith(base + path.sep)) item = [file, 'text/javascript'];
    }
    if (!item) { response.writeHead(404); response.end(); return; }
    const [file, type] = item;
    response.writeHead(200, { 'content-type': type });
    response.end(await readFile(file));
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.alphaIconReady === true, { timeout: 30000 }).catch(error => { throw new Error(`${error.message}\n${errors.join('\n')}`); });
  if (errors.length) throw new Error(errors.join('\n'));
  const dataUrl = await page.locator('canvas').evaluate(canvas => canvas.toDataURL('image/png'));
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
  console.log(destination);
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
