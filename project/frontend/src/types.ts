export interface BeaconAnchor {
  id: string;
  bssid: string;
  x: number;
  y: number;
  z: number;
  p0: number;
}

export interface FirefighterState {
  device_id: string;
  x: number;
  y: number;
  z: number;
  heading_deg: number;
  step_count: number;
  last_update: number;
}

export interface HazardPin {
  id: string;
  label: string;
  hazard_type: 'fire' | 'collapse' | 'victim' | 'blocked';
  x: number;
  y: number;
  z: number;
  note?: string;
  timestamp: number;
}

export interface Breadcrumb {
  x: number;
  y: number;
  z: number;
}

export interface WifiScan {
  bssid: string;
  rssi_dbm: number;
}


export interface RFMapBounds {
  min_x: number;
  min_y: number;
  max_x: number;
  max_y: number;
}

/** GET /api/map. cells[anchorId][row=y][col=x] is mean dBm or null. */
export interface RFMapResponse {
  cell_m: number;
  bounds: RFMapBounds;
  width: number;
  height: number;
  cells: Record<string, (number | null)[][]>;
}
