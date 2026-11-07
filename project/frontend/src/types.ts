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

