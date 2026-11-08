# Raspberry Pi Setup & Wi-Fi RSSI Distance Radar Guide

This guide walks you through setting up a **Raspberry Pi (Pi Zero 2W, Pi 3, Pi 4, or Pi 5)** to capture live Wi-Fi Received Signal Strength Indicator (RSSI) measurements and calculate real-time distances for your hackathon proof-of-concept.

---

## 1. Quick Hardware Overview

* **Raspberry Pi**: Pi Zero 2W, Pi 3, Pi 4, or Pi 5 with Raspberry Pi OS (Bookworm / Bullseye 64-bit or 32-bit).
* **Connection to Laptop**: Standard USB data cable (using USB Gadget Mode `g_ether`) or connected to a local hotspot.
* **Perimeter Anchors**: 3 to 4 smartphone personal hotspots or Wi-Fi routers placed around the perimeter of the room.

---

## 2. Step-by-Step Raspberry Pi OS Setup

### Step 2.1: Flash Raspberry Pi OS
1. Download and open **Raspberry Pi Imager** on your computer.
2. Select **Raspberry Pi OS (64-bit Lite or Desktop)**.
3. In OS Customization settings:
   - Set hostname: `firefighter-pi`
   - Set username & password: `pi` / `raspberry` (or your preferred password).
   - Enable **SSH**.

---

### Step 2.2: Enable USB Gadget Mode (`g_ether`) *(From PRD)*
*Why USB Gadget Mode?*
Plugging the Raspberry Pi directly into your laptop via USB creates a high-speed virtual Ethernet link (`169.254.x.x`). This leaves the Pi's Wi-Fi card (`wlan0`) **100% dedicated to continuous sub-second scanning without dropping your network connection or SSH terminal**.

1. Insert your micro-SD card into your computer.
2. Open `config.txt` on the boot partition and add to the bottom:
   ```ini
   dtoverlay=dwc2
   ```
3. Open `cmdline.txt` (keep everything on one single line) and append after `rootwait`:
   ```text
   modules-load=dwc2,g_ether
   ```
4. Eject the SD card, put it in the Pi, and plug the Pi's **USB / Data port** directly into your laptop.
5. In PowerShell or Terminal, SSH into the Pi:
   ```powershell
   ssh pi@firefighter-pi.local
   ```

---

### Step 2.3: Disable Wi-Fi Power Saving
> [!IMPORTANT]
> Raspberry Pi Wi-Fi chips automatically go to sleep every few seconds to conserve power. For tactical sub-second scanning, you **must disable power saving**:

Run in terminal on the Pi:
```bash
sudo iw dev wlan0 set power_save off
```
*(To make it permanent across reboots, add that line before `exit 0` in `/etc/rc.local`)*.

---

## 3. Running the RSSI Distance Radar Script

Transfer [`rpi_rssi_poc.py`](rpi_rssi_poc.py) to your Raspberry Pi:
```bash
# On your laptop:
scp C:/Users/caleb/.gemini/antigravity/scratch/IntoTheClouds/pi_client/rpi_rssi_poc.py pi@firefighter-pi.local:~/
```

### Option A: Run Live Tactical Terminal HUD
SSH into your Pi and run:
```bash
python3 rpi_rssi_poc.py
```
You will see a live ASCII dashboard:
```
==============================================================================
  INTO THE CLOUDS | RASPBERRY PI TACTICAL RSSI RADAR (HACKATHON POC)
  Interface: wlan0 | Model: d = 10^((P0 - RSSI)/(10*n)) | P0: -40.0dBm | n: 2.5
==============================================================================
BEACON SSID          BSSID              RSSI (dBm)   EST DIST   SIGNAL METER
------------------------------------------------------------------------------
ANCHOR_NORTH         aa:bb:cc:11:22:33   -48.2 dBm     2.14m    [████████------] 68%
ANCHOR_EAST          aa:bb:cc:44:55:66   -56.4 dBm     4.56m    [█████---------] 45%
VICTIM_PHONE         aa:bb:cc:aa:bb:cc   -62.1 dBm     7.82m    [███-----------] 32%
------------------------------------------------------------------------------
```

### Option B: Filter for Specific Hackathon Beacons
To avoid clutter from other buildings, pass the names of your test hotspots:
```bash
python3 rpi_rssi_poc.py --ssid "ANCHOR" "HOTSPOT" "iPhone"
```

### Option C: Output Clean JSON for the Incident Command Dashboard
```bash
python3 rpi_rssi_poc.py --json
```

---

## 4. How the Distance Calculation Works

The script calculates physical distance in meters using the **Log-Distance Path Loss Model**:

$$d = 10^{\frac{P_0 - RSSI}{10 \cdot n}}$$

| Variable | Meaning | Default Value | Tuning Tip |
| :--- | :--- | :--- | :--- |
| **$RSSI$** | Measured signal strength in dBm | e.g. `-52 dBm` | Smoothed with Exponential Moving Average (EMA). |
| **$P_0$** | Reference RSSI at exactly **1.0 meter** | `-40.0 dBm` | Calibrate by holding the Pi 1m away from your beacon. |
| **$n$** | Path loss exponent | `2.5` | `2.0` in open air; `2.5 - 3.0` indoors with drywall/smoke. |

### How to Calibrate in the Hackathon Room:
1. Place your phone hotspot on a table.
2. Hold your Raspberry Pi exactly **1.0 meter** away.
3. Check the measured RSSI (e.g. if it reads `-42 dBm`).
4. Start the script with that exact calibrated value:
   ```bash
   python3 rpi_rssi_poc.py --p0 -42.0 -n 2.5
   ```

---

## 5. Live Hackathon Judging Demo Setup

1. **Beacon Setup**: Turn on Personal Hotspots on 2 or 3 smartphones named `ANCHOR_1`, `ANCHOR_2`, and `ANCHOR_3`. Place them around the room.
2. **Wearable Setup**: Hand the Raspberry Pi (connected via USB or a power bank) to a teammate.
3. **Demo Action**:
   - Have the teammate walk toward `ANCHOR_1`: Show the judges the signal bar rise to **85%+** and distance drop to **under 1 meter**.
   - Walk toward `ANCHOR_2`: Watch the radar immediately transition focus to the new closest beacon.
   - Point out that **radio signals penetrate smoke and darkness**, giving first responders visibility where cameras and GPS fail.

