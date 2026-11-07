# 📋 Multi-Agent & Team Progress Board

> **Project**: IntoTheClouds (Tactical 3D SAR Mapping)  
> **Rule for AI Agents**: Read this file before modifying code. Never modify files claimed by another agent or team member.

---

## 🔒 Active File & Task Locks (Claims)

| Task ID | Claimed Files / Directories | Owner / Agent | Branch | Status | Timestamp (UTC) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| *None* | *(No active locks — all modules available)* | — | — | ⚪ Open | — |

---

## 🧭 Domain Ownership Boundaries

To avoid collision, each member and agent has a defined territory based on the hackathon PRD:

| Role / Member | Primary Scope | Permitted File Boundaries | Prohibited (Unless Coordinated) |
| :--- | :--- | :--- | :--- |
| **Member A (Backend)** | FastAPI, Math, Fusion | `project/backend/app/**`, `project/backend/tests/**` | `project/frontend/**`, `project/pi_client/**` |
| **Member B (Hardware/Pi)** | nmcli Scanner, Pi Setup | `project/pi_client/**`, `project/PRD.md` | `project/frontend/**`, `project/backend/app/fusion/**` |
| **Member C (Frontend)** | Three.js, React, UI HUD | `project/frontend/src/**`, `project/frontend/public/**` | `project/backend/**`, `project/pi_client/**` |
| **Member D (Voice & Demo)**| Voice Radio, Pitch, Docs | `project/frontend/src/components/IncidentCommandHUD.tsx`, `project/DEMO_GUIDE.md` | Core Math & Backend endpoints |

---

## 🚦 Task Backlog & Execution Pipeline

### 1. 🟡 In Progress (Claimed)
*(None currently claimed. Ready to pick up next tasks!)*

---

### 2. ⚪ Ready to Claim (Backlog)

#### 🔹 Backend & Fusion Math (`Member A / Backend Agent`)
- [ ] **`BE-01` RF Attenuation Tomography**: Ray tracing path attenuation between anchors and firefighter to identify dense walls ($RSSI_{\text{measured}} \ll RSSI_{\text{expected}}$).
- [ ] **`BE-02` 3D Voxel Density Grid**: Maintain a $0.25\text{m}^3$ voxel space representing occupied obstacles vs. cleared space.
- [ ] **`BE-03` Marching Cubes API**: Generate structural wall wireframe mesh payload for Three.js.

#### 🔹 Frontend & 3D Visualization (`Member C / Frontend Agent`)
- [ ] **`FE-01` Marching Cubes Mesh Renderer**: Render 3D wireframe walls in Three.js from the backend voxel payload.
- [ ] **`FE-02` Tactical Room Bounds & Floorplan**: Add customizable room dimensions and wall outlines to the 3D canvas.
- [ ] **`FE-03` Particle Cloud Visualization**: Render the real-time cloud of 600 particles showing localization confidence spread.

#### 🔹 Hardware & Pi Client (`Member B / Pi Agent`)
- [ ] **`HW-01` USB Gadget Mode (`g_ether`) Config Script**: Script to set up Raspberry Pi Zero/4 as a USB ethernet gadget (`169.254.x.x`).
- [ ] **`HW-02` Hardware IMU Integration**: Hook up real MPU-6050 / BNO055 I2C accelerometer/gyro step detection to `pi_scanner.py`.

#### 🔹 Voice & Integration (`Member D / Voice & Pitch Agent`)
- [ ] **`VO-01` Radio Sound Effects**: Add tactical radio beep and sound feedback on voice commands.
- [ ] **`VO-02` Hazard Export**: Export pinned hazard markers with timestamps to JSON / PDF report for incident debrief.

---

## 📜 Activity & Completion Log

| Time | Agent / Member | Action / Commit | Summary |
| :--- | :--- | :--- | :--- |
| 17:50 | Antigravity | Scaffolding | Initialized FastAPI backend, React+Three.js frontend, mock simulator, and test suite. |
| 17:52 | Backend-Agent | BE-01 | Tested claim CLI |
| 18:12 | Claude Code | DOC-01 | Removed broken duplicate project/scripts/agent_claim.py; fixed AGENTS.md claim example path to project/backend/... |
| 18:14 | Claude Code | DOC-02 | Added project/WORK_ORDERS.md: Pi-focused work orders with risks, phases and acceptance criteria |
| 18:22 | Claude Code | DOC-03 | Updated WORK_ORDERS.md for Pi 4, no IMU, laptop anchors: added HW-02a, Ethernet-first link, revised R3-R5 and HW-05 |
| 18:24 | Claude Code | HW-03 | Added pi_client/scan_benchmark.py (nmcli vs iw scan rate/noise/freshness) and pi_client/README.md; parsers tested on sample data, not yet run on a Pi |
| 18:34 | Claude Code | DOC-04 | Rewrote WORK_ORDERS.md: usage steps, priority boards, uniform task cards |
