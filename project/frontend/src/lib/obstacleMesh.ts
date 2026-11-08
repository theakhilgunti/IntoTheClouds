import * as THREE from 'three';

/** GET /api/mesh: RF obstacle hints (a rough hint, NOT a floor plan). Vertices are [x, y, z] metres, z up. */
export interface ObstacleMeshResponse {
  vertices: number[][];
  faces: number[][];
  voxel_count: number;
  voxel_m: number;
  seen_voxels: number;
  occupied_voxels: number;
}

/**
 * Build a Three.js geometry from the backend mesh. The backend uses z-up; the scene uses
 * y-up with backend y on the scene z axis (same as the RF map cells), so swap y and z.
 * Returns null when there is nothing to draw.
 */
export function buildObstacleGeometry(mesh: ObstacleMeshResponse | null): THREE.BufferGeometry | null {
  if (!mesh || mesh.faces.length === 0 || mesh.vertices.length === 0) return null;
  const pos = new Float32Array(mesh.vertices.length * 3);
  mesh.vertices.forEach(([x, y, z], i) => {
    pos[i * 3] = x;
    pos[i * 3 + 1] = z;
    pos[i * 3 + 2] = y;
  });
  const index: number[] = [];
  for (const f of mesh.faces) index.push(f[0], f[1], f[2]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}
