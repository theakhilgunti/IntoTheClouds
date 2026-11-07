import React, { useState } from 'react';
import { Activity, Compass, Flame, Footprints, Mic, MicOff, Radio, RefreshCw, ShieldAlert, Wifi } from 'lucide-react';
import { BeaconAnchor, FirefighterState, HazardPin, WifiScan } from '../types';

interface HUDProps {
  connected: boolean;
  state: FirefighterState;
  anchors: BeaconAnchor[];
  recentScans: WifiScan[];
  hazards: HazardPin[];
  onAddHazard: (hazardType: 'fire' | 'collapse' | 'victim' | 'blocked', note: string) => void;
  onReset: () => void;
}

export const IncidentCommandHUD: React.FC<HUDProps> = ({
  connected,
  state,
  anchors,
  recentScans,
  hazards,
  onAddHazard,
  onReset,
}) => {
  const [isListening, setIsListening] = useState(false);
  const [speechTranscript, setSpeechTranscript] = useState('');

  // Web Speech API for voice radio hazard pinning (PRD Requirement)
  const toggleVoiceRadio = () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('Web Speech API is not supported in this browser. You can click the manual hazard buttons below.');
      return;
    }

    if (isListening) {
      setIsListening(false);
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = 'en-US';

      recognition.onstart = () => {
        setIsListening(true);
        setSpeechTranscript('Listening for voice radio command (e.g. "Fire spotted")...');
      };

      recognition.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript.toLowerCase();
        setSpeechTranscript(`Transcribed: "${transcript}"`);

        if (transcript.includes('fire') || transcript.includes('flame')) {
          onAddHazard('fire', transcript);
        } else if (transcript.includes('collapse') || transcript.includes('wall') || transcript.includes('debris')) {
          onAddHazard('collapse', transcript);
        } else if (transcript.includes('victim') || transcript.includes('person') || transcript.includes('survivor')) {
          onAddHazard('victim', transcript);
        } else {
          onAddHazard('blocked', transcript);
        }
      };

      recognition.onerror = () => {
        setIsListening(false);
        setSpeechTranscript('Voice recognition error or ended.');
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognition.start();
    } catch (err) {
      console.error(err);
      setIsListening(false);
    }
  };

  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-6">
      {/* Top Bar Header */}
      <div className="flex items-center justify-between">
        <div className="pointer-events-auto flex items-center space-x-4 rounded-xl border border-gray-800 bg-gray-900/90 px-4 py-3 backdrop-blur-md shadow-2xl">
          <div className="flex h-3 w-3 relative">
            <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${connected ? 'bg-emerald-400' : 'bg-red-400'}`} />
            <span className={`relative inline-flex rounded-full h-3 w-3 ${connected ? 'bg-emerald-500' : 'bg-red-500'}`} />
          </div>
          <div>
            <h1 className="text-sm font-bold tracking-widest text-cyan-400 uppercase">
              INTO THE CLOUDS // TACTICAL 3D SAR
            </h1>
            <p className="text-xs text-gray-400 font-mono">
              STATUS: {connected ? 'LIVE TELEMETRY STREAM' : 'OFFLINE / RECONNECTING'}
            </p>
          </div>
        </div>

        {/* Action Controls */}
        <div className="pointer-events-auto flex items-center space-x-3">
          <button
            onClick={toggleVoiceRadio}
            className={`flex items-center space-x-2 rounded-xl border px-4 py-2.5 text-xs font-semibold uppercase tracking-wider backdrop-blur-md transition-all ${
              isListening
                ? 'border-red-500 bg-red-500/20 text-red-300 shadow-lg shadow-red-500/30 animate-pulse'
                : 'border-cyan-500/30 bg-gray-900/80 text-cyan-300 hover:border-cyan-400 hover:bg-cyan-500/10'
            }`}
          >
            {isListening ? <Mic className="h-4 w-4 animate-bounce" /> : <MicOff className="h-4 w-4" />}
            <span>{isListening ? 'Radio Active...' : 'Voice Radio Pin'}</span>
          </button>

          <button
            onClick={onReset}
            className="flex items-center space-x-2 rounded-xl border border-gray-800 bg-gray-900/80 px-4 py-2.5 text-xs font-semibold text-gray-300 hover:border-gray-700 hover:text-white backdrop-blur-md transition-all"
          >
            <RefreshCw className="h-4 w-4" />
            <span>Reset Run</span>
          </button>
        </div>
      </div>

      {/* Voice Transcript Toast if active */}
      {speechTranscript && (
        <div className="self-center pointer-events-auto rounded-lg border border-cyan-500/30 bg-gray-900/90 px-4 py-2 text-xs text-cyan-300 font-mono backdrop-blur-md shadow-xl animate-fade-in">
          {speechTranscript}
        </div>
      )}

      {/* Bottom HUD Panels */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Firefighter Rig Telemetry */}
        <div className="pointer-events-auto rounded-xl border border-gray-800 bg-gray-900/90 p-4 backdrop-blur-md shadow-xl">
          <div className="flex items-center justify-between border-b border-gray-800 pb-2 mb-3">
            <span className="flex items-center space-x-2 text-xs font-bold tracking-wider text-cyan-400 uppercase">
              <Activity className="h-4 w-4" />
              <span>Rig: {state.device_id}</span>
            </span>
            <span className="text-[10px] text-gray-400 font-mono">PDR + RSSI FUSION</span>
          </div>
          <div className="grid grid-cols-2 gap-3 text-xs font-mono">
            <div>
              <span className="text-gray-400 block text-[10px] uppercase">Position (X, Y)</span>
              <span className="text-white text-base font-bold">
                {state.x.toFixed(2)}m, {state.y.toFixed(2)}m
              </span>
            </div>
            <div>
              <span className="text-gray-400 block text-[10px] uppercase">Heading</span>
              <span className="text-white text-base font-bold flex items-center space-x-1">
                <Compass className="h-4 w-4 text-cyan-400" />
                <span>{state.heading_deg.toFixed(1)}°</span>
              </span>
            </div>
            <div>
              <span className="text-gray-400 block text-[10px] uppercase">Total Steps</span>
              <span className="text-white text-base font-bold flex items-center space-x-1">
                <Footprints className="h-4 w-4 text-emerald-400" />
                <span>{state.step_count}</span>
              </span>
            </div>
            <div>
              <span className="text-gray-400 block text-[10px] uppercase">Elevation (Z)</span>
              <span className="text-white text-base font-bold">{state.z.toFixed(2)}m</span>
            </div>
          </div>
        </div>

        {/* Wi-Fi Beacons / RSSI */}
        <div className="pointer-events-auto rounded-xl border border-gray-800 bg-gray-900/90 p-4 backdrop-blur-md shadow-xl">
          <div className="flex items-center justify-between border-b border-gray-800 pb-2 mb-3">
            <span className="flex items-center space-x-2 text-xs font-bold tracking-wider text-amber-400 uppercase">
              <Wifi className="h-4 w-4" />
              <span>Perimeter Anchors ({anchors.length})</span>
            </span>
            <span className="text-[10px] text-gray-400 font-mono">nmcli 500ms</span>
          </div>
          <div className="space-y-2">
            {anchors.map(anchor => {
              const scan = recentScans.find(s => s.bssid.toLowerCase() === anchor.bssid.toLowerCase());
              const rssi = scan ? scan.rssi_dbm : -85;
              const pct = Math.max(0, Math.min(100, (rssi + 100) * 1.5));
              return (
                <div key={anchor.id} className="text-xs font-mono">
                  <div className="flex justify-between text-[11px] mb-0.5">
                    <span className="text-gray-300 font-bold">Beacon {anchor.id} ({anchor.x}m, {anchor.y}m)</span>
                    <span className={rssi > -60 ? 'text-emerald-400 font-bold' : rssi > -75 ? 'text-amber-400' : 'text-red-400'}>
                      {rssi.toFixed(0)} dBm
                    </span>
                  </div>
                  <div className="h-1.5 w-full bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${
                        rssi > -60 ? 'bg-emerald-400' : rssi > -75 ? 'bg-amber-400' : 'bg-red-400'
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Hazard Quick Actions */}
        <div className="pointer-events-auto rounded-xl border border-gray-800 bg-gray-900/90 p-4 backdrop-blur-md shadow-xl">
          <div className="flex items-center justify-between border-b border-gray-800 pb-2 mb-3">
            <span className="flex items-center space-x-2 text-xs font-bold tracking-wider text-red-400 uppercase">
              <ShieldAlert className="h-4 w-4" />
              <span>Tactical Hazard Pinning</span>
            </span>
            <span className="text-[10px] text-gray-400 font-mono">Active: {hazards.length}</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => onAddHazard('fire', 'Flashover / Fire threat')}
              className="flex items-center justify-center space-x-1.5 rounded-lg border border-red-500/40 bg-red-950/30 p-2 text-xs font-bold text-red-400 hover:bg-red-900/50 hover:border-red-400 transition"
            >
              <Flame className="h-3.5 w-3.5" />
              <span>Fire</span>
            </button>
            <button
              onClick={() => onAddHazard('collapse', 'Structural wall collapse')}
              className="flex items-center justify-center space-x-1.5 rounded-lg border border-amber-500/40 bg-amber-950/30 p-2 text-xs font-bold text-amber-400 hover:bg-amber-900/50 hover:border-amber-400 transition"
            >
              <ShieldAlert className="h-3.5 w-3.5" />
              <span>Collapse</span>
            </button>
            <button
              onClick={() => onAddHazard('victim', 'Unconscious occupant')}
              className="flex items-center justify-center space-x-1.5 rounded-lg border border-emerald-500/40 bg-emerald-950/30 p-2 text-xs font-bold text-emerald-400 hover:bg-emerald-900/50 hover:border-emerald-400 transition"
            >
              <Radio className="h-3.5 w-3.5" />
              <span>Victim</span>
            </button>
            <button
              onClick={() => onAddHazard('blocked', 'Blocked door / debris')}
              className="flex items-center justify-center space-x-1.5 rounded-lg border border-gray-700 bg-gray-800 p-2 text-xs font-bold text-gray-300 hover:bg-gray-700 transition"
            >
              <span>Blocked</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

