import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { BeaconAnchor, Breadcrumb, FirefighterState, HazardPin } from '../types';

interface ThreeCanvasProps {
  anchors: BeaconAnchor[];
  state: FirefighterState;
  breadcrumbs: Breadcrumb[];
  hazards: HazardPin[];
}

export const ThreeCanvas: React.FC<ThreeCanvasProps> = ({
  anchors,
  state,
  breadcrumbs,
  hazards,
}) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const ffMeshRef = useRef<THREE.Group | null>(null);
  const trajectoryLineRef = useRef<THREE.Line | null>(null);
  const anchorsGroupRef = useRef<THREE.Group | null>(null);
  const hazardsGroupRef = useRef<THREE.Group | null>(null);

  useEffect(() => {
    if (!mountRef.current) return;
    const container = mountRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;

    // Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0f19);
    scene.fog = new THREE.FogExp2(0x0b0f19, 0.03);
    sceneRef.current = scene;

    // Camera
    const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 100);
    camera.position.set(5, 16, 16);
    camera.lookAt(5, 0, 5);

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0x06b6d4, 1.2);
    dirLight.position.set(10, 20, 10);
    scene.add(dirLight);

    // Grid Floor
    const grid = new THREE.GridHelper(30, 30, 0x06b6d4, 0x1f2937);
    grid.position.set(5, 0, 5);
    scene.add(grid);

    // Firefighter Avatar Group
    const ffGroup = new THREE.Group();
    // Base ring
    const ringGeo = new THREE.RingGeometry(0.3, 0.5, 32);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x06b6d4, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ffGroup.add(ring);

    // Center beacon sphere
    const sphereGeo = new THREE.SphereGeometry(0.25, 16, 16);
    const sphereMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8, emissive: 0x0284c7 });
    const sphere = new THREE.Mesh(sphereGeo, sphereMat);
    sphere.position.y = 0.25;
    ffGroup.add(sphere);

    // Heading arrow
    const coneGeo = new THREE.ConeGeometry(0.18, 0.6, 16);
    const coneMat = new THREE.MeshStandardMaterial({ color: 0xef4444 });
    const cone = new THREE.Mesh(coneGeo, coneMat);
    cone.position.set(0, 0.25, -0.6);
    cone.rotation.x = -Math.PI / 2;
    ffGroup.add(cone);

    scene.add(ffGroup);
    ffMeshRef.current = ffGroup;

    // Groups for anchors and hazards
    const anchorsGroup = new THREE.Group();
    scene.add(anchorsGroup);
    anchorsGroupRef.current = anchorsGroup;

    const hazardsGroup = new THREE.Group();
    scene.add(hazardsGroup);
    hazardsGroupRef.current = hazardsGroup;

    // Trajectory Line
    const lineMat = new THREE.LineBasicMaterial({ color: 0x06b6d4, linewidth: 2 });
    const lineGeo = new THREE.BufferGeometry();
    const trajectoryLine = new THREE.Line(lineGeo, lineMat);
    scene.add(trajectoryLine);
    trajectoryLineRef.current = trajectoryLine;

    // Orbit Controls via mouse drag
    let isDragging = false;
    let prevMouseX = 0;
    let prevMouseY = 0;
    let cameraAngle = 0.785;
    let cameraDistance = 20;

    const onMouseDown = (e: MouseEvent) => {
      isDragging = true;
      prevMouseX = e.clientX;
      prevMouseY = e.clientY;
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const deltaX = e.clientX - prevMouseX;
      prevMouseX = e.clientX;
      cameraAngle -= deltaX * 0.005;
      camera.position.x = 5 + Math.sin(cameraAngle) * cameraDistance;
      camera.position.z = 5 + Math.cos(cameraAngle) * cameraDistance;
      camera.lookAt(5, 0, 5);
    };

    const onMouseUp = () => { isDragging = false; };
    const onWheel = (e: WheelEvent) => {
      cameraDistance = Math.max(5, Math.min(40, cameraDistance + e.deltaY * 0.02));
      camera.position.x = 5 + Math.sin(cameraAngle) * cameraDistance;
      camera.position.z = 5 + Math.cos(cameraAngle) * cameraDistance;
      camera.lookAt(5, 0, 5);
    };

    container.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    container.addEventListener('wheel', onWheel);

    // Animation Loop
    let animationFrameId: number;
    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);
      renderer.render(scene, camera);
    };
    animate();

    const handleResize = () => {
      if (!container) return;
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', handleResize);
      container.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      container.removeEventListener('wheel', onWheel);
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
      renderer.dispose();
    };
  }, []);

  // Update Firefighter avatar position and rotation
  useEffect(() => {
    if (ffMeshRef.current) {
      ffMeshRef.current.position.set(state.x, 0.1, state.y);
      // Three.js rotation in Y plane for heading
      const rad = THREE.MathUtils.degToRad(-state.heading_deg);
      ffMeshRef.current.rotation.y = rad;
    }
  }, [state]);

  // Update Trajectory Breadcrumbs
  useEffect(() => {
    if (trajectoryLineRef.current && breadcrumbs.length > 1) {
      const points = breadcrumbs.map(b => new THREE.Vector3(b.x, 0.05, b.y));
      trajectoryLineRef.current.geometry.setFromPoints(points);
    }
  }, [breadcrumbs]);

  // Update Anchors
  useEffect(() => {
    if (!anchorsGroupRef.current) return;
    const group = anchorsGroupRef.current;
    while (group.children.length > 0) {
      group.remove(group.children[0]);
    }

    anchors.forEach(anchor => {
      const anchorMesh = new THREE.Group();
      anchorMesh.position.set(anchor.x, 0, anchor.y);

      // Tower cylinder
      const cylGeo = new THREE.CylinderGeometry(0.1, 0.15, anchor.z, 16);
      const cylMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, metalness: 0.8 });
      const cyl = new THREE.Mesh(cylGeo, cylMat);
      cyl.position.y = anchor.z / 2;
      anchorMesh.add(cyl);

      // Beacon tip sphere
      const beaconGeo = new THREE.SphereGeometry(0.3, 16, 16);
      const beaconMat = new THREE.MeshBasicMaterial({ color: 0xfbbf24 });
      const beaconSphere = new THREE.Mesh(beaconGeo, beaconMat);
      beaconSphere.position.y = anchor.z;
      anchorMesh.add(beaconSphere);

      group.add(anchorMesh);
    });
  }, [anchors]);

  // Update Hazards
  useEffect(() => {
    if (!hazardsGroupRef.current) return;
    const group = hazardsGroupRef.current;
    while (group.children.length > 0) {
      group.remove(group.children[0]);
    }

    hazards.forEach(hazard => {
      const hazardGeo = new THREE.OctahedronGeometry(0.4);
      const color = hazard.hazard_type === 'fire' ? 0xef4444 : 0xf97316;
      const hazardMat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.6 });
      const hazardMesh = new THREE.Mesh(hazardGeo, hazardMat);
      hazardMesh.position.set(hazard.x, hazard.z, hazard.y);
      group.add(hazardMesh);
    });
  }, [hazards]);

  return <div ref={mountRef} className="w-full h-full cursor-grab active:cursor-grabbing" />;
};

