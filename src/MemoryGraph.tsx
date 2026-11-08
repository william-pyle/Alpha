import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { RecordItem, Theme } from "./types";

function hash(text: string) {
  let n = 0;
  for (const c of text) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return n;
}
export default function MemoryGraph({
  records,
  theme,
  onSelect,
  highlight = [],
}: {
  records: RecordItem[];
  theme: Theme;
  onSelect: (record: RecordItem) => void;
  highlight?: string[];
}) {
  const host = useRef<HTMLDivElement>(null),
    callback = useRef(onSelect);
  callback.current = onSelect;
  const [failure, setFailure] = useState(""),
    [hover, setHover] = useState(""),
    [moving, setMoving] = useState(false);
  const cameraPosition = useRef<[number, number, number]>([0, 6, 23]),
    cameraTarget = useRef<[number, number, number]>([0, 0, 0]);
  useEffect(() => {
    const container = host.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setFailure(
        "3D acceleration is unavailable. Your knowledge is still accessible in the list below.",
      );
      return;
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    container.appendChild(renderer.domElement);
    const scene = new THREE.Scene(),
      camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
    camera.position.set(...cameraPosition.current);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(...cameraTarget.current);
    controls.enableDamping = true;
    controls.minDistance = 6;
    controls.maxDistance = 60;
    controls.autoRotate =
      moving && !matchMedia("(prefers-reduced-motion: reduce)").matches;
    controls.autoRotateSpeed = 0.35;
    const objects: THREE.Mesh[] = [],
      positions = new Map<string, THREE.Vector3>(),
      resources: (THREE.BufferGeometry | THREE.Material)[] = [];
    const material = (color: string, opacity = 1) => {
      const m = new THREE.MeshBasicMaterial({
        color,
        transparent: opacity < 1,
        opacity,
      });
      resources.push(m);
      return m;
    };
    const sphere = new THREE.SphereGeometry(1, 16, 12);
    resources.push(sphere);
    const core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.1, 1),
      new THREE.MeshBasicMaterial({
        color: theme.accent,
        wireframe: true,
        transparent: true,
        opacity: 0.5,
      }),
    );
    resources.push(core.geometry, core.material);
    scene.add(core);
    for (let i = 0; i < 3; i++) {
      const g = new THREE.TorusGeometry(1.75 + i * 0.48, 0.013, 8, 100);
      resources.push(g);
      const ring = new THREE.Mesh(g, material(theme.accent, 0.32 - i * 0.06));
      ring.rotation.set(i * 0.6, Math.PI / 3 + i * 0.3, i * 0.2);
      scene.add(ring);
    }
    const groups = [
      ...new Set(
        records.map(
          (r) =>
            (r.scope === "alpha" ? "Shared" : "Project") +
            " / " +
            (r.tags[0] || r.kind),
        ),
      ),
    ];
    const groupIndices = new Map<string, number>();
    for (const record of records) {
      const key =
          (record.scope === "alpha" ? "Shared" : "Project") +
          " / " +
          (record.tags[0] || record.kind),
        gi = groups.indexOf(key),
        index = groupIndices.get(key) || 0;
      groupIndices.set(key, index + 1);
      const angle = (gi * Math.PI * 2) / Math.max(groups.length, 1),
        seed = hash(record.id),
        phi = index * 2.399963,
        rad = 1.5 + Math.sqrt(index) * 0.5;
      const point = new THREE.Vector3(
        Math.cos(angle) * 6 + Math.cos(phi) * rad,
        ((seed % 100) / 100 - 0.5) * 5,
        Math.sin(angle) * 5 + Math.sin(phi) * rad,
      );
      positions.set(record.id, point);
      const selected = highlight.includes(record.id),
        color = selected
          ? "#ffffff"
          : record.scope === "alpha"
            ? theme.accent
            : theme.secondary;
      const node = new THREE.Mesh(sphere, material(color));
      node.scale.setScalar(
        0.13 + record.importance * 0.035 + (selected ? 0.07 : 0),
      );
      node.position.copy(point);
      node.userData.record = record;
      objects.push(node);
      scene.add(node);
      const geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(),
        point,
      ]);
      resources.push(geometry);
      const lineMat = new THREE.LineDashedMaterial({
        color,
        transparent: true,
        opacity: 0.12,
        dashSize: 0.16,
        gapSize: 0.12,
      });
      resources.push(lineMat);
      const line = new THREE.Line(geometry, lineMat);
      line.computeLineDistances();
      scene.add(line);
    }
    for (const record of records)
      for (const targetId of record.links) {
        const a = positions.get(record.id),
          b = positions.get(targetId);
        if (!a || !b) continue;
        const midpoint = a.clone().add(b).multiplyScalar(0.5);
        midpoint.y += 1;
        const curve = new THREE.QuadraticBezierCurve3(a, midpoint, b);
        const geometry = new THREE.BufferGeometry().setFromPoints(
          curve.getPoints(30),
        );
        const mat = new THREE.LineBasicMaterial({
          color: theme.secondary,
          opacity: 0.6,
          transparent: true,
        });
        resources.push(geometry, mat);
        scene.add(new THREE.Line(geometry, mat));
      }
    const raycaster = new THREE.Raycaster(),
      pointer = new THREE.Vector2();
    let press = { x: 0, y: 0 };
    const hit = (event: PointerEvent) => {
      const box = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((event.clientX - box.left) / box.width) * 2 - 1,
        (-(event.clientY - box.top) / box.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      return raycaster.intersectObjects(objects)[0]?.object.userData.record as
        RecordItem | undefined;
    };
    const move = (event: PointerEvent) => {
      const record = hit(event);
      setHover(record?.title || "");
      renderer.domElement.style.cursor = record ? "pointer" : "grab";
    };
    const down = (event: PointerEvent) => {
      press = { x: event.clientX, y: event.clientY };
    };
    const up = (event: PointerEvent) => {
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5)
        return;
      const record = hit(event);
      if (record) callback.current(record);
    };
    renderer.domElement.addEventListener("pointermove", move);
    renderer.domElement.addEventListener("pointerdown", down);
    renderer.domElement.addEventListener("pointerup", up);
    const resize = () => {
      const width = container.clientWidth,
        height = container.clientHeight;
      if (width && height) {
        renderer.setSize(width, height);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      controls.update();
      renderer.render(scene, camera);
    };
    draw();
    return () => {
      cameraPosition.current = camera.position.toArray();
      cameraTarget.current = controls.target.toArray();
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      resources.forEach((r) => r.dispose());
      renderer.dispose();
      container.replaceChildren();
    };
  }, [
    JSON.stringify(records),
    JSON.stringify(theme),
    highlight.join(","),
    moving,
  ]);
  return (
    <div className="graph-wrap">
      <div
        ref={host}
        className="graph-canvas"
        aria-label="Interactive 3D knowledge graph"
      />
      <div className="graph-top">
        <span className="eyebrow">MEMORY NETWORK</span>
        <span className="live-dot">LIVE</span>
      </div>
      <div className="graph-core-label">
        <strong>{theme.controller}</strong>
        <span>{records.length} knowledge nodes</span>
      </div>
      {failure && <div className="graph-error">{failure}</div>}
      <div className="graph-bottom">
        <span>{hover || "Drag to orbit · Scroll to zoom · Click a node"}</span>
        <button className="quiet" onClick={() => setMoving(!moving)}>
          {moving ? "Pause orbit" : "Auto orbit"}
        </button>
      </div>
      <div className="graph-legend">
        <span>
          <i style={{ background: theme.accent }} />
          Shared
        </span>
        <span>
          <i style={{ background: theme.secondary }} />
          Project
        </span>
        <span>Solid: saved relationship</span>
        <span>Dotted: membership</span>
      </div>
    </div>
  );
}
