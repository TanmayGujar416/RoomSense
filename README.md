# RoomSense

Indoor room-level positioning using 2.4 GHz Wi-Fi RSSI fingerprinting on an ESP32.

GPS doesn't work indoors, and ultra-wideband (UWB) or dedicated beacon setups get expensive quickly. RoomSense checks whether ambient Wi-Fi signal strength from existing access points is consistent enough to reliably tell which room an ESP32 board is in.

## How it works

1. **Scan:** An ESP32 scans nearby 2.4 GHz Wi-Fi beacons (`BSSID` and `RSSI`).
2. **Collect:** Scans are labelled with room zones (`hall`, `kitchen`, `passage`, etc.) and saved to a dataset.
3. **Classify:** A lightweight classifier (Weighted kNN / Gaussian Naive Bayes) predicts the current zone from live signal fingerprints.
4. **Track:** The predicted zone is shown live on a floor map.

## Hardware

- **MCU:** DOIT ESP32 DEVKIT V1
- **Peripherals:** 1x LED (`GPIO27`), 1x active buzzer (`GPIO15`)
- **Power:** USB power bank for walk tests
- **Client:** Android phone running Chrome (for Web Bluetooth streaming)

## Repository Layout

- `collect.py` — serial data collector used during initial testing to record labelled scans.
- `analyze.py` — baseline model evaluator; tests kNN, Naive Bayes, and Decision Tree on held-out scan rounds and outputs a confusion matrix.

## Quick Start (Pilot Data)

Set up a virtual environment and install dependencies:

```bash
python -m venv venv
# On Windows:
venv\Scripts\activate
# On Linux/macOS:
# source venv/bin/activate

pip install -r requirements.txt  # numpy, pandas, scikit-learn, matplotlib, pyserial
```

Evaluate the baseline models on recorded rounds:

```bash
python analyze.py --train 1 --test 2
```

## Current Status

- Initial serial data collection pipeline verified on pilot scans.
- Web Bluetooth (BLE) live streaming firmware and phone dashboard in progress.
