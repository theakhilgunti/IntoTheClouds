import React, { useEffect, useState, useRef } from 'react';
import { ThreeCanvas } from './components/ThreeCanvas';
import { IncidentCommandHUD } from './components/IncidentCommandHUD';
import { BeaconAnchor, Breadcrumb, FirefighterState, HazardPin, WifiScan } from './types';

const WS_URL = 'ws://localhost:8000/ws/dashboard';
const API_URL = 'http://localhost:8000/api';

export const App: React.FC = () => {
  const [connected, setConnected] = useState(false);
  const [anchors, setAnchors] = useState<BeaconAnchor[]>([]);
  const [state, setState] = useState<FirefighterState>({
    device_id: 'FF_Pi_Rig_1',
    x: 0,
    y: 0,
    z: 1.0,
    heading_deg: 0,
    step_count: 0,
    last_update: Date.now(),
  });
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([]);
  const [recentScans, setRecentScans] = useState<WifiScan[]>([]);
  const [hazards, setHazards] = useState<HazardPin[]>([]);

  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let shouldReconnect = true;
    let reconnectTimeout: any = null;

    const connect = () => {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'init_state') {
            setAnchors(msg.anchors || []);
            if (msg.state) setState(msg.state);
            if (msg.breadcrumbs) setBreadcrumbs(msg.breadcrumbs);
            if (msg.hazards) setHazards(msg.hazards);
          } else if (msg.type === 'telemetry_update') {
            if (msg.state) setState(msg.state);
            if (msg.breadcrumb) {
              setBreadcrumbs((prev) => [...prev.slice(-300), msg.breadcrumb]);
            }
            if (msg.raw_scans) setRecentScans(msg.raw_scans);
          } else if (msg.type === 'hazard_pinned') {
            if (msg.hazard) {
              setHazards((prev) => [...prev, msg.hazard]);
            }
          } else if (msg.type === 'session_reset') {
            setBreadcrumbs([]);
            setHazards([]);
          }
        } catch (e) {
          console.error('Error parsing WebSocket message:', e);
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (shouldReconnect) {
          reconnectTimeout = setTimeout(connect, 2000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      shouldReconnect = false;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  const handleAddHazard = async (hazardType: 'fire' | 'collapse' | 'victim' | 'blocked', note: string) => {
    const newHazard: HazardPin = {
      id: `hazard-${Date.now()}`,
      label: hazardType.toUpperCase(),
      hazard_type: hazardType,
      x: state.x,
      y: state.y,
      z: 1.0,
      note,
      timestamp: Date.now() / 1000,
    };

    try {
      await fetch(`${API_URL}/hazards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newHazard),
      });
    } catch (e) {
      console.error('Failed to post hazard:', e);
    }
  };

  const handleReset = async () => {
    try {
      await fetch(`${API_URL}/reset`, { method: 'POST' });
    } catch (e) {
      console.error('Failed to reset session:', e);
    }
  };

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-tactical-bg select-none">
      <ThreeCanvas
        anchors={anchors}
        state={state}
        breadcrumbs={breadcrumbs}
        hazards={hazards}
      />
      <IncidentCommandHUD
        connected={connected}
        state={state}
        anchors={anchors}
        recentScans={recentScans}
        hazards={hazards}
        onAddHazard={handleAddHazard}
        onReset={handleReset}
      />
    </div>
  );
};

export default App;

