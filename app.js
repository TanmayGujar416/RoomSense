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
  } catch (err) {
    // Fallback matching real flat layout
    zonesData = [
      { id: "hall", label: "Hall", x: 10, y: 10, w: 130, h: 120, dotX: 30, dotY: 30, neighbors: ["outside", "router", "kitchen", "passage"] },
      { id: "router", label: "Router", x: 105, y: 60, w: 35, h: 35, dotX: 122, dotY: 77, neighbors: ["hall", "passage"] },
      { id: "outside", label: "Outside", x: 140, y: 10, w: 85, h: 45, dotX: 182, dotY: 32, neighbors: ["hall"] },
      { id: "kitchen", label: "Kitchen", x: 10, y: 130, w: 100, h: 50, dotX: 25, dotY: 155, neighbors: ["hall", "passage", "storage"] },
      { id: "passage", label: "Passage", x: 110, y: 130, w: 30, h: 90, dotX: 125, dotY: 155, neighbors: ["hall", "kitchen", "storage", "router"] },
      { id: "storage", label: "Storage", x: 10, y: 180, w: 55, h: 50, dotX: 35, dotY: 205, neighbors: ["kitchen", "passage"] }
    ];
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

    // Zone Rect
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("id", `map-rect-${z.id}`);
    rect.setAttribute("class", "zone-rect");
    rect.setAttribute("x", z.x);
    rect.setAttribute("y", z.y);
    rect.setAttribute("width", z.w);
    rect.setAttribute("height", z.h);
    rect.setAttribute("rx", "4");

    rect.addEventListener('click', () => selectZone(z.id));

    // Label
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("class", "zone-label");
    text.setAttribute("x", z.x + z.w / 2);
    text.setAttribute("y", z.y + z.h / 2 + 2);
    text.textContent = z.label;

    g.appendChild(rect);
    g.appendChild(text);

    // Survey Dot Marker (from user's floor sketch)
    if (z.dotX && z.dotY) {
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("cx", z.dotX);
      dot.setAttribute("cy", z.dotY);
      dot.setAttribute("r", "3");
      dot.setAttribute("fill", "#ef4444");
      dot.setAttribute("stroke", "#ffffff");
      dot.setAttribute("stroke-width", "0.8");
      dot.setAttribute("pointer-events", "none");
      g.appendChild(dot);
    }

    floorMap.appendChild(g);
  });
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
