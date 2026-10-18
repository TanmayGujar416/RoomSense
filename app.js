/*
 * RoomSense — Phone Survey Dashboard (Task 2)
 * Features:
 * - IndexedDB scan storage for zero data loss across page refreshes
 * - Interactive SVG floor map from zones.json
 * - Automated top-up loop on dropped/corrupt BLE packets
 * - CSV exporter for training on laptop
 */

const SERVICE_UUID      = "12345678-1234-5678-1234-56789abcdef0";
const CHAR_COMMAND_UUID = "12345678-1234-5678-1234-56789abcdef1";
const CHAR_STREAM_UUID  = "12345678-1234-5678-1234-56789abcdef2";

const DEFAULT_TARGET_SCANS = 25;

// --- State ---
let zonesData = [];
let db = null;
let bleDevice = null;
let commandChar = null;
let streamChar = null;
let rxBuffer = "";

let currentSession = "session1";
let selectedZone = "kitchen";
let targetScansPerZone = DEFAULT_TARGET_SCANS;

let isSurveying = false;
let currentBatchValid = 0;
let currentBatchTarget = 0;

// --- DOM Handles ---
const connBadge = document.getElementById('connBadge');
const flashBadge = document.getElementById('flashBadge');
const btnConnect = document.getElementById('btnConnect');
const btnDisconnect = document.getElementById('btnDisconnect');
const sessionSelect = document.getElementById('sessionSelect');
const newSessionBtn = document.getElementById('newSessionBtn');
const targetScansInput = document.getElementById('targetScansInput');
const btnStartSurvey = document.getElementById('btnStartSurvey');
const btnStopSurvey = document.getElementById('btnStopSurvey');
const btnExportCSV = document.getElementById('btnExportCSV');
const btnClearDB = document.getElementById('btnClearDB');
const progressBar = document.getElementById('progressBar');
const surveyStatusText = document.getElementById('surveyStatusText');
const zoneGrid = document.getElementById('zoneGrid');
const floorMap = document.getElementById('floorMap');
const logEl = document.getElementById('log');

function log(msg) {
  const time = new Date().toLocaleTimeString();
  logEl.textContent += `[${time}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

// ==========================================
// 1. IndexedDB Storage (Zero Data Loss)
// ==========================================
function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("RoomSenseDB", 1);
    request.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains("scans")) {
        const store = database.createObjectStore("scans", { keyPath: "id", autoIncrement: true });
        store.createIndex("session", "session", { unique: false });
        store.createIndex("session_zone", ["session", "zone"], { unique: false });
      }
    };
    request.onsuccess = (e) => {
      db = e.target.result;
      resolve(db);
    };
    request.onerror = (e) => reject(e.target.error);
  });
}

function saveScansToDB(records) {
  return new Promise((resolve, reject) => {
    if (!db) return resolve();
    const tx = db.transaction("scans", "readwrite");
    const store = tx.objectStore("scans");
    records.forEach(r => store.add(r));
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

function getZoneScanCounts(session) {
  return new Promise((resolve) => {
    if (!db) return resolve({});
    const tx = db.transaction("scans", "readonly");
    const store = tx.objectStore("scans");
    const index = store.index("session");
    const request = index.getAll(session);

    request.onsuccess = () => {
      const records = request.result || [];
      const counts = {};
      const seenScanIds = new Set();
      
      records.forEach(r => {
        const key = `${r.zone}-${r.scan_id}`;
        if (!seenScanIds.has(key)) {
          seenScanIds.add(key);
          counts[r.zone] = (counts[r.zone] || 0) + 1;
        }
      });
      resolve(counts);
    };
    request.onerror = () => resolve({});
  });
}

function getAllScansFromDB() {
  return new Promise((resolve) => {
    if (!db) return resolve([]);
    const tx = db.transaction("scans", "readonly");
    const store = tx.objectStore("scans");
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => resolve([]);
  });
}

function clearSessionScans(session) {
  return new Promise((resolve) => {
    if (!db) return resolve();
    const tx = db.transaction("scans", "readwrite");
    const store = tx.objectStore("scans");
    const index = store.index("session");
    const request = index.openCursor(IDBKeyRange.only(session));

    request.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      } else {
        resolve();
      }
    };
    request.onerror = () => resolve();
  });
}

// ==========================================
// 2. Zone Map & UI Rendering
// ==========================================
async function loadZones() {
  try {
    const res = await fetch("zones.json");
    const data = await res.json();
    zonesData = data.zones;
    if (data.viewBox) {
      floorMap.setAttribute("viewBox", data.viewBox);
    }
  } catch (err) {
    // Fallback if local fetch fails
    zonesData = [
      { id: "storage", label: "Storage", x: 15, y: 15, w: 70, h: 65, marker: { x: 48, y: 32 }, neighbors: ["passage"] },
      { id: "kitchen", label: "Kitchen", x: 87, y: 15, w: 60, h: 113, marker: { x: 120, y: 45 }, neighbors: ["passage"] },
      { id: "hall", label: "Hall", x: 149, y: 15, w: 196, h: 143, marker: { x: 265, y: 80 }, neighbors: ["passage", "router"] },
      { id: "passage", label: "Passage", x: 15, y: 82, w: 132, h: 76, path: "M 15 82 L 85 82 L 85 130 L 147 130 L 147 158 L 15 158 Z", marker: { x: 66, y: 115 }, neighbors: ["outside", "hall", "kitchen", "storage", "router"] },
      { id: "router", label: "Router Spot", x: 156, y: 128, w: 42, h: 28, marker: { x: 177, y: 142 }, neighbors: ["hall", "passage"] },
      { id: "outside", label: "Outside / Entrance", x: 280, y: 160, w: 65, h: 85, marker: { x: 334, y: 172 }, neighbors: ["passage"] }
    ];
    floorMap.setAttribute("viewBox", "0 0 360 255");
  }
  renderFloorMap();
  await refreshZoneUI();
}

function renderFloorMap() {
  floorMap.innerHTML = "";
  zonesData.forEach(z => {
    // SVG Group
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("id", `map-group-${z.id}`);

    // Zone shape: path (for L-corridor) or rect
    let shape;
    if (z.path) {
      shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
      shape.setAttribute("d", z.path);
    } else {
      shape = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      shape.setAttribute("x", z.x);
      shape.setAttribute("y", z.y);
      shape.setAttribute("width", z.w);
      shape.setAttribute("height", z.h);
      shape.setAttribute("rx", "5");
    }

    shape.setAttribute("id", `map-rect-${z.id}`);
    shape.setAttribute("class", "zone-rect");
    shape.addEventListener('click', () => selectZone(z.id));
    g.appendChild(shape);

    // Label coordinates
    let textX = z.marker ? z.marker.x : z.x + z.w / 2;
    let textY = z.y + z.h / 2;
    if (z.id === "storage") { textX = 50; textY = 52; }
    else if (z.id === "kitchen") { textX = 117; textY = 75; }
    else if (z.id === "hall") { textX = 247; textY = 85; }
    else if (z.id === "passage") { textX = 50; textY = 132; }
    else if (z.id === "router") { textX = 177; textY = 146; }
    else if (z.id === "outside") { textX = 312; textY = 210; }

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("class", "zone-label");
    text.setAttribute("x", textX);
    text.setAttribute("y", textY);
    text.textContent = z.label;
    g.appendChild(text);

    // Survey Point Marker Dot
    if (z.marker) {
      const marker = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      marker.setAttribute("class", "survey-marker");
      marker.setAttribute("id", `marker-${z.id}`);
      marker.setAttribute("cx", z.marker.x);
      marker.setAttribute("cy", z.marker.y);
      marker.setAttribute("r", "3.5");
      marker.setAttribute("fill", "#e11d48");
      marker.setAttribute("stroke", "#ffffff");
      marker.setAttribute("stroke-width", "1.2");
      g.appendChild(marker);
    }

    floorMap.appendChild(g);
  });

  // Animated Live Tracker Dot Group
  const trackerG = document.createElementNS("http://www.w3.org/2000/svg", "g");
  trackerG.setAttribute("id", "trackerGroup");
  trackerG.style.display = "none";
  trackerG.innerHTML = `
    <circle id="pulseRing" class="tracker-dot pulse-ring" cx="0" cy="0" r="10" fill="none" stroke="var(--primary)" stroke-width="2" />
    <circle id="trackerDot" class="tracker-dot" cx="0" cy="0" r="5.5" fill="var(--primary)" stroke="#ffffff" stroke-width="2" />
  `;
  floorMap.appendChild(trackerG);
}

function moveTrackerDot(zoneId) {
  const z = zonesData.find(item => item.id === zoneId);
  if (!z) return;
  const trackerG = document.getElementById("trackerGroup");
  const dot = document.getElementById("trackerDot");
  const ring = document.getElementById("pulseRing");
  if (!trackerG || !dot || !ring) return;

  const targetX = z.marker ? z.marker.x : (z.x + z.w / 2);
  const targetY = z.marker ? z.marker.y : (z.y + z.h / 2);

  dot.setAttribute("cx", targetX);
  dot.setAttribute("cy", targetY);
  ring.setAttribute("cx", targetX);
  ring.setAttribute("cy", targetY);
  trackerG.style.display = "block";
}

async function refreshZoneUI() {
  const counts = await getZoneScanCounts(currentSession);
  zoneGrid.innerHTML = "";

  zonesData.forEach(z => {
    const count = counts[z.id] || 0;
    const isDone = count >= targetScansPerZone;

    // Grid Button
    const btn = document.createElement('div');
    btn.className = `zone-btn ${z.id === selectedZone ? "selected" : ""} ${isDone ? "done" : ""}`;
    btn.id = `zone-btn-${z.id}`;
    btn.innerHTML = `
      <span>${z.label}</span>
      <span class="zone-count-pill">${count}/${targetScansPerZone}</span>
    `;
    btn.addEventListener('click', () => selectZone(z.id));
    zoneGrid.appendChild(btn);

    // Update Map Rect
    const mapRect = document.getElementById(`map-rect-${z.id}`);
    if (mapRect) {
      mapRect.classList.toggle("completed", isDone);
      mapRect.classList.toggle("active", z.id === selectedZone);
    }
  });

  const activeCount = counts[selectedZone] || 0;
  const pct = Math.min(100, Math.round((activeCount / targetScansPerZone) * 100));
  progressBar.style.width = `${pct}%`;
  surveyStatusText.textContent = `Zone '${selectedZone}': ${activeCount}/${targetScansPerZone} scans (${pct}%)`;
}

function selectZone(zoneId) {
  if (isSurveying) return;
  selectedZone = zoneId;
  moveTrackerDot(zoneId);
  refreshZoneUI();
}

// ==========================================
// 3. Web Bluetooth & Autonomous Top-Up
// ==========================================
function calculateXOR(str) {
  let xor = 0;
  for (let i = 0; i < str.length; i++) {
    xor ^= str.charCodeAt(i);
  }
  return xor.toString(16).padStart(2, '0');
}

async function sendBLECommand(cmd) {
  if (!commandChar) return;
  const encoder = new TextEncoder();
  try {
    log(`[BLE SEND] ${cmd}`);
    if (commandChar.writeValueWithResponse) {
      await commandChar.writeValueWithResponse(encoder.encode(cmd));
    } else {
      await commandChar.writeValue(encoder.encode(cmd));
    }
  } catch (err) {
    log(`[BLE ERR] Write failed: ${err.message}`);
  }
}

async function handleChunk(event) {
  const decoder = new TextDecoder();
  const chunk = decoder.decode(event.target.value);
  rxBuffer += chunk;

  let newlineIdx;
  while ((newlineIdx = rxBuffer.indexOf('\n')) !== -1) {
    const fullLine = rxBuffer.substring(0, newlineIdx).trim();
    rxBuffer = rxBuffer.substring(newlineIdx + 1);
    await processCompletedLine(fullLine);
  }
}

async function processCompletedLine(line) {
  if (line.startsWith("SCAN ")) {
    const starIdx = line.lastIndexOf('*');
    if (starIdx === -1) {
      log(`[ERR] Missing checksum: ${line}`);
      return;
    }

    const payload = line.substring(0, starIdx);
    const expectedChk = line.substring(starIdx + 1).toLowerCase();
    const actualChk = calculateXOR(payload).toLowerCase();

    if (expectedChk !== actualChk) {
      log(`[CORRUPT SCAN] Checksum mismatch (${actualChk} != ${expectedChk})`);
      return;
    }

    // Valid scan! Format: SCAN <zone> <scan_id> <ap_count> <bssid,rssi;...>
    const parts = payload.split(" ");
    const zone = parts[1];
    const scanId = parseInt(parts[2], 10);
    const apPairs = parts[4] ? parts[4].split(";") : [];

    const dbRecords = [];
    const timestamp = Date.now();

    apPairs.forEach(pair => {
      const [bssid, rssiStr] = pair.split(",");
      const cleanBSSID = bssid ? bssid.trim().toLowerCase() : "";
      const rssi = parseInt(rssiStr, 10);
      // Validate BSSID is 12 hex chars and valid RSSI
      if (/^[0-9a-f]{12}$/.test(cleanBSSID) && cleanBSSID !== "000000000000" && !isNaN(rssi)) {
        dbRecords.push({
          session: currentSession,
          zone: zone,
          scan_id: scanId,
          bssid: cleanBSSID,
          rssi: rssi,
          timestamp: timestamp
        });
      }
    });

    if (dbRecords.length > 0) {
      await saveScansToDB(dbRecords);
      currentBatchValid++;
      await refreshZoneUI();
      log(`[STORED] ${zone} #${scanId} (${apPairs.length} APs) in IndexedDB`);
    }

  } else if (line.startsWith("DONE ")) {
    log(`[BOARD] ${line}`);
    const parts = line.split(" ");
    const doneZone = parts[1];

    const counts = await getZoneScanCounts(currentSession);
    const validCount = counts[doneZone] || 0;

    if (validCount < targetScansPerZone) {
      const missing = targetScansPerZone - validCount;
      log(`[TOP-UP] Zone '${doneZone}' has ${validCount}/${targetScansPerZone}. Auto-requesting ${missing} scans...`);
      await sendBLECommand(`ZONE ${doneZone} ${missing}`);
    } else {
      isSurveying = false;
      btnStartSurvey.disabled = false;
      btnStopSurvey.disabled = true;
      log(`[SURVEY DONE] Zone '${doneZone}' completed target ${validCount}/${targetScansPerZone} scans! 🎉`);
      await refreshZoneUI();
      setTimeout(() => sendBLECommand("STATUS"), 200);
    }

  } else if (line.startsWith("STATUS ")) {
    const match = line.match(/flash_bytes=(\d+)/);
    if (match) {
      flashBadge.textContent = `${match[1]} B`;
    }
  }
}

// ==========================================
// 4. Bluetooth Connection Setup
// ==========================================
btnConnect.addEventListener('click', async () => {
  try {
    log("Scanning for RoomSense...");
    bleDevice = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [SERVICE_UUID]
    });

    connBadge.textContent = "Connecting...";
    bleDevice.addEventListener('gattserverdisconnected', onDisconnected);

    const server = await bleDevice.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);

    commandChar = await service.getCharacteristic(CHAR_COMMAND_UUID);
    streamChar = await service.getCharacteristic(CHAR_STREAM_UUID);

    await streamChar.startNotifications();
    streamChar.addEventListener('characteristicvaluechanged', handleChunk);

    connBadge.textContent = "Connected";
    connBadge.className = "badge badge-connected";
    btnConnect.disabled = true;
    btnDisconnect.disabled = false;
    btnStartSurvey.disabled = false;

    // Send session name to ESP32
    setTimeout(async () => {
      await sendBLECommand(`SESSION ${currentSession}`);
      await sendBLECommand("STATUS");
    }, 350);

    log("Connected to ESP32 over BLE.");
  } catch (err) {
    log(`Connection failed: ${err.message}`);
    onDisconnected();
  }
});

function onDisconnected() {
  connBadge.textContent = "Disconnected";
  connBadge.className = "badge badge-disconnected";
  btnConnect.disabled = false;
  btnDisconnect.disabled = true;
  btnStartSurvey.disabled = true;
  btnStopSurvey.disabled = true;
  isSurveying = false;
  log("Disconnected from ESP32.");
}

btnDisconnect.addEventListener('click', () => {
  if (bleDevice && bleDevice.gatt.connected) {
    bleDevice.gatt.disconnect();
  }
});

// ==========================================
// 5. Survey Controls
// ==========================================
btnStartSurvey.addEventListener('click', async () => {
  targetScansPerZone = parseInt(targetScansInput.value, 10) || DEFAULT_TARGET_SCANS;
  const counts = await getZoneScanCounts(currentSession);
  const currentCount = counts[selectedZone] || 0;
  const needed = Math.max(0, targetScansPerZone - currentCount);

  if (needed === 0) {
    if (!confirm(`Zone '${selectedZone}' already has ${currentCount} scans. Collect more?`)) {
      return;
    }
  }

  const scansToRequest = needed > 0 ? needed : targetScansPerZone;
  isSurveying = true;
  btnStartSurvey.disabled = true;
  btnStopSurvey.disabled = false;

  log(`[START] Requesting ${scansToRequest} scans for '${selectedZone}' (session: ${currentSession})...`);
  await sendBLECommand(`ZONE ${selectedZone} ${scansToRequest}`);
});

btnStopSurvey.addEventListener('click', async () => {
  isSurveying = false;
  btnStartSurvey.disabled = false;
  btnStopSurvey.disabled = true;
  await sendBLECommand("STOP");
  log("Survey stopped by user.");
});

// Session switcher
sessionSelect.addEventListener('change', async (e) => {
  currentSession = e.target.value;
  await sendBLECommand(`SESSION ${currentSession}`);
  await refreshZoneUI();
  log(`Switched to active session: '${currentSession}'`);
});

newSessionBtn.addEventListener('click', async () => {
  const name = prompt("Enter new session name (e.g. round2, oct18_evening):");
  if (!name) return;
  const cleanName = name.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (!cleanName) return;

  const opt = document.createElement('option');
  opt.value = cleanName;
  opt.textContent = cleanName;
  sessionSelect.appendChild(opt);
  sessionSelect.value = cleanName;
  currentSession = cleanName;

  await sendBLECommand(`SESSION ${currentSession}`);
  await refreshZoneUI();
  log(`Created and selected new session: '${currentSession}'`);
});

// ==========================================
// 6. CSV Exporter (survey.csv)
// ==========================================
btnExportCSV.addEventListener('click', async () => {
  const allScans = await getAllScansFromDB();
  if (allScans.length === 0) {
    alert("No survey scans collected yet! Run a survey first.");
    return;
  }

  // Header matching PROJECT_NOTES.md
  let csvContent = "session,zone,scan_id,bssid,rssi\n";
  allScans.forEach(row => {
    csvContent += `${row.session},${row.zone},${row.scan_id},${row.bssid},${row.rssi}\n`;
  });

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `survey.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  log(`Exported survey.csv with ${allScans.length} AP records!`);
});

btnClearDB.addEventListener('click', async () => {
  if (confirm(`Wipe all browser survey data for '${currentSession}'?`)) {
    await clearSessionScans(currentSession);
    await refreshZoneUI();
    log(`Browser data for '${currentSession}' cleared.`);
  }
});

// ==========================================
// Initialization
// ==========================================
window.addEventListener('DOMContentLoaded', async () => {
  await initDB();
  await loadZones();
  log("RoomSense Survey Dashboard ready.");
});
