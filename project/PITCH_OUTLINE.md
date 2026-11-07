# 🎤 Pitch Deck & Presentation Outline

### Slide 1: The Problem (The Smoke Trap)
- In structural fires, optical and thermal cameras fail due to severe aerosol light backscatter.
- Standard GPS fails indoors.
- Firefighters enter burning buildings blind, resulting in disorientation and spatial failure.

### Slide 2: The Solution (RF + Dead Reckoning Fusion)
- Wi-Fi radio frequencies penetrate smoke and aerosol plumes without optical scattering.
- Fusing Pedestrian Dead Reckoning (PDR step vectors) with Log-Distance Path-Loss RSSI using a Particle Filter.
- Real-time 3D reconstruction without optical line-of-sight.

### Slide 3: System Architecture
- Raspberry Pi wearable rig + USB Gadget Tethering (`g_ether`).
- Zero router dependency, immune to local network congestion.
- Central FastAPI server with WebSockets streaming to Three.js dashboard.

### Slide 4: Real-time Demo
- Live blindfolded walk test.
- Hands-free Web Speech API radio hazard pinning.

### Slide 5: Future Roadmap & Impact
- Ultra-wideband (UWB) + 802.11bf Wi-Fi Sensing.
- Integration into standard SCBA (Self-Contained Breathing Apparatus) firefighter gear.

