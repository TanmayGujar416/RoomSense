 """RoomSense collector: labels the board's scan stream and appends it to scans.csv.

Example:
  python collect.py --port COM5 --zones bedroom hall kitchen balcony passage router --round 1
"""
import argparse
import csv
import os
import sys
import time

import serial

ap = argparse.ArgumentParser()
ap.add_argument("--port", required=True, help="COM5, /dev/ttyUSB0, /dev/cu.usbserial-xxxx ...")
ap.add_argument("--zones", nargs="+", required=True, help="single-word zone names, in the order you will visit them")
ap.add_argument("--round", type=int, required=True, help="1 for the first pass, 2 for the second pass")
ap.add_argument("--scans", type=int, default=25, help="scans to record per zone")
ap.add_argument("--out", default="scans.csv")
args = ap.parse_args()

ser = serial.Serial(args.port, 115200, timeout=1)
time.sleep(2.5)  # opening the port resets the board; give it time to boot

is_new = not os.path.exists(args.out)
f = open(args.out, "a", newline="")
w = csv.writer(f)
if is_new:
    w.writerow(["round", "zone", "scan_id", "bssid", "rssi"])


def read_scan(timeout_s=20):
    """Return one scan as a list of (bssid, rssi) pairs."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        line = ser.readline().decode(errors="ignore").strip()
        if line.startswith("SCAN"):
            pairs = []
            for part in line.split("|")[1:]:
                bits = part.split(",")
                if len(bits) == 2:
                    try:
                        pairs.append((bits[0], int(bits[1])))
                    except ValueError:
                        pass
            return pairs
    print("No scan received for 20 s. Press the EN (reset) button on the board and retry.")
    sys.exit(1)


for zone in args.zones:
    input(f"\n[round {args.round}] Put the board on the marked spot for '{zone}', step back to your usual spot, press Enter...")
    ser.reset_input_buffer()
    read_scan()  # throw away the first scan (may be stale)
    for i in range(args.scans):
        pairs = read_scan()
        for bssid, rssi in pairs:
            w.writerow([args.round, zone, i, bssid, rssi])
        f.flush()
        print(f"  {zone}: {i + 1}/{args.scans}  ({len(pairs)} APs heard)", end="\r")
    print(f"  {zone}: done                                  ")

f.close()
print(f"\nSaved to {args.out}. Back it up before you do anything else.")
