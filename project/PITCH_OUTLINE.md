# 🎤 Pitch Deck & Presentation Outline

### Slide 1: The Problem (The Smoke Trap)
- In structural fires, optical and thermal cameras fail due to severe aerosol light backscatter.
- Standard GPS fails indoors.
- Firefighters enter burning buildings blind, resulting in disorientation and spatial failure.

### Slide 2: The Solution (RF Signal Mapping)
- Wi-Fi and Bluetooth radio signals pass through smoke and aerosol plumes without optical scattering.
- A particle filter turns signal strength (RSSI, log-distance path loss) from 3 beacons into an **approximate position** (meter-level at best).
- From the same signals we build an **RF obstacle hints coverage map**, in stages: 2D signal heatmap, then obstacle hints, then rough 2.5D blocks.
- Honest limit: not a precise floor plan. RSSI cannot give that, and true Wi-Fi sensing needs CSI, which phones and laptops do not expose. (We borrow one idea from Wi-Fi sensing research: compare against a baseline scan of the empty scene instead of trusting a path-loss model.)

### Slide 3: System Architecture
- 3 stationary laptops as beacons (Windows Mobile Hotspot named `ITC-A1`..`A3`).
- One Windows laptop carried by the walker runs the scanner, the FastAPI backend and the Three.js dashboard on localhost.
- No router, no internet; nothing leaves the walker laptop and iPhone.
- Fallback if the phone link fails: a random-walk motion model keeps the filter stable. An iPhone carried with the walker streams compass/gyro heading and steps to improve the track.

### Slide 4: Real-time Demo
- Live blindfolded walk test with the laptop (approximate position).
- RF signal coverage map growing on the 3D floor.
- Hands-free Web Speech API radio hazard pinning.

### Slide 5: Future Roadmap & Impact
- Ultra-wideband (UWB) and 802.11bf Wi-Fi Sensing (CSI) for real precision and true sensing.
- Foot-mounted motion sensors for better dead reckoning.
- Integration into standard SCBA (Self-Contained Breathing Apparatus) firefighter gear. Real fireground use needs testing in smoke and heat; we do not claim field readiness.
