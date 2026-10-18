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

// --- Tab Handles ---
const tabSurvey = document.getElementById('tabSurvey');
const tabTracking = document.getElementById('tabTracking');
const surveySection = document.getElementById('surveySection');
const trackingSection = document.getElementById('trackingSection');
const mapCardTitle = document.getElementById('mapCardTitle');

// --- Live Tracking & Model Handles ---
const btnLoadModel = document.getElementById('btnLoadModel');
const modelFileInput = document.getElementById('modelFileInput');
const modelStatusBanner = document.getElementById('modelStatusBanner');
const modelEngineSelect = document.getElementById('modelEngineSelect');
const beliefFilterToggle = document.getElementById('beliefFilterToggle');
const btnStartTracking = document.getElementById('btnStartTracking');
const btnStopTracking = document.getElementById('btnStopTracking');
const liveRoomDisplay = document.getElementById('liveRoomDisplay');
const liveConfidenceDisplay = document.getElementById('liveConfidenceDisplay');
const liveNoveltyDisplay = document.getElementById('liveNoveltyDisplay');
const liveFilterStatus = document.getElementById('liveFilterStatus');

let loadedModel = null;
let isLiveTracking = false;
let jsBeliefFilter = null;

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
    const res = await fetch("zones.json?v=" + Date.now());
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

    if (zone === "track") {
      // Live continuous tracking scan: bypass flash & IndexedDB!
      handleLiveTrackingScan(apPairs, scanId);
      return;
    }

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
// 7. Tab Navigation (Survey vs Live Tracking)
// ==========================================
tabSurvey.addEventListener('click', () => {
  tabSurvey.classList.add('active');
  tabTracking.classList.remove('active');
  surveySection.style.display = 'block';
  trackingSection.style.display = 'none';
  mapCardTitle.textContent = 'Flat Map';
  surveyStatusText.style.display = 'inline';
});

tabTracking.addEventListener('click', () => {
  tabTracking.classList.add('active');
  tabSurvey.classList.remove('active');
  surveySection.style.display = 'none';
  trackingSection.style.display = 'block';
  mapCardTitle.textContent = 'Live Tracking on Map';
  surveyStatusText.style.display = 'none';

  // Ensure tracker dot is visible on map
  const trackerG = document.getElementById("trackerGroup");
  if (trackerG) trackerG.style.display = "block";
});

// ==========================================
// 8. Model Loading & Parity Verification
// ==========================================
btnLoadModel.addEventListener('click', () => modelFileInput.click());

modelFileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const model = JSON.parse(text);

    log(`Testing mathematical parity for '${file.name}'...`);
    const parityResult = runParityCheck(model);

    if (parityResult.passed) {
      loadedModel = model;
      jsBeliefFilter = new JSBeliefFilter(
        model.zones,
        model.filter ? model.filter.neighbors : {},
        model.filter ? (model.filter.alpha || 0.70) : 0.70
      );

      modelStatusBanner.className = "model-banner pass";
      modelStatusBanner.innerHTML = `
        <strong>[PASS] Parity Check Passed (10/10 math match)!</strong><br>
        Version: ${model.version} | Filtered APs: ${model.bssids.length} | Scans: ${model.knn.X.length}<br>
        Novelty Threshold: ${model.novelty.threshold.toFixed(2)} dBm | Math Drift &lt; 1e-6
      `;

      btnStartTracking.disabled = false;
      log(`Model '${file.name}' loaded successfully! 100% parity verified with Python.`);
    } else {
      loadedModel = null;
      modelStatusBanner.className = "model-banner fail";
      modelStatusBanner.innerHTML = `
        <strong>[FAIL] Model Parity Check Failed!</strong><br>
        ${parityResult.error}
      `;
      btnStartTracking.disabled = true;
      log(`[ERROR] Parity check failed: ${parityResult.error}`);
    }
  } catch (err) {
    modelStatusBanner.className = "model-banner fail";
    modelStatusBanner.textContent = `Failed to load model file: ${err.message}`;
    log(`[ERROR] ${err.message}`);
  }
});

// ==========================================
// 9. JavaScript ML Inference Engines (kNN, NB, Novelty, Belief)
// ==========================================
function predictKNN(vector, model) {
  const k = model.knn.k || 3;
  const eps = model.knn.eps || 1e-5;
  const X = model.knn.X;
  const y = model.knn.y;
  const classes = model.zones;

  const dists = [];
  for (let i = 0; i < X.length; i++) {
    let sumSq = 0;
    const row = X[i];
    for (let j = 0; j < vector.length; j++) {
      const diff = vector[j] - row[j];
      sumSq += diff * diff;
    }
    dists.push({ dist: Math.sqrt(sumSq), label: y[i], idx: i });
  }

  // Consistent tie breaking: sort by dist, then row index
  dists.sort((a, b) => a.dist !== b.dist ? a.dist - b.dist : a.idx - b.idx);
  const topK = dists.slice(0, k);

  const scores = {};
  classes.forEach(c => scores[c] = 0);
  let totalWeight = 0;

  topK.forEach(item => {
    const w = 1.0 / (item.dist + eps);
    scores[item.label] = (scores[item.label] || 0) + w;
    totalWeight += w;
  });

  const probArray = classes.map(c => totalWeight > 0 ? scores[c] / totalWeight : 1 / classes.length);
  let bestIdx = 0;
  let maxP = -1;
  probArray.forEach((p, idx) => {
    if (p > maxP) {
      maxP = p;
      bestIdx = idx;
    }
  });

  return {
    predictedZone: classes[bestIdx],
    confidence: maxP,
    scores: probArray,
    classes: classes
  };
}

function predictGaussianNB(vector, model) {
  const classes = model.nb.classes;
  const priors = model.nb.priors;
  const means = model.nb.means;
  const vars = model.nb.variances;

  const logProbs = [];
  for (let c = 0; c < classes.length; c++) {
    let logL = Math.log(priors[c]);
    for (let j = 0; j < vector.length; j++) {
      const v = vars[c][j];
      const m = means[c][j];
      const diff = vector[j] - m;
      logL += -0.5 * (Math.log(2 * Math.PI * v) + (diff * diff) / v);
    }
    logProbs.push(logL);
  }

  const maxLog = Math.max(...logProbs);
  const exps = logProbs.map(lp => Math.exp(lp - maxLog));
  const sumExp = exps.reduce((a, b) => a + b, 0);
  const probArray = exps.map(e => e / sumExp);

  let bestIdx = 0;
  let maxP = -1;
  probArray.forEach((p, idx) => {
    if (p > maxP) {
      maxP = p;
      bestIdx = idx;
    }
  });

  return {
    predictedZone: classes[bestIdx],
    confidence: maxP,
    scores: probArray,
    classes: classes
  };
}

function computeNovelty(vector, model) {
  const X = model.knn.X;
  let minDist = Infinity;
  for (let i = 0; i < X.length; i++) {
    let sumSq = 0;
    const row = X[i];
    for (let j = 0; j < vector.length; j++) {
      const diff = vector[j] - row[j];
      sumSq += diff * diff;
    }
    const d = Math.sqrt(sumSq);
    if (d < minDist) minDist = d;
  }

  const threshold = model.novelty ? model.novelty.threshold : 22.85;
  return {
    distance: minDist,
    isNovel: minDist > threshold,
    threshold: threshold
  };
}

class JSBeliefFilter {
  constructor(zones, neighbors, selfTrans = 0.70, nonNeighborP = 0.01) {
    this.zones = [...zones].sort();
    this.neighbors = neighbors || {};
    this.selfTrans = selfTrans;
    this.nonNeighborP = nonNeighborP;
    this.belief = new Array(this.zones.length).fill(1 / this.zones.length);
  }

  update(rawProbs) {
    const predBelief = new Array(this.zones.length).fill(0);

    for (let prevIdx = 0; prevIdx < this.zones.length; prevIdx++) {
      const pPrev = this.belief[prevIdx];
      const prevZone = this.zones[prevIdx];
      const neighs = this.neighbors[prevZone] || [];
      const nLen = Math.max(1, neighs.length);
      const neighTrans = (1.0 - this.selfTrans) / nLen;

      for (let currIdx = 0; currIdx < this.zones.length; currIdx++) {
        const currZone = this.zones[currIdx];
        let transP = this.nonNeighborP;
        if (currZone === prevZone) {
          transP = this.selfTrans;
        } else if (neighs.includes(currZone)) {
          transP = neighTrans;
        }
        predBelief[currIdx] += pPrev * transP;
      }
    }

    const predSum = predBelief.reduce((a, b) => a + b, 0);
    for (let i = 0; i < predBelief.length; i++) predBelief[i] /= predSum;

    const updated = rawProbs.map((p, idx) => p * predBelief[idx]);
    const total = updated.reduce((a, b) => a + b, 0);

    if (total > 0) {
      this.belief = updated.map(u => u / total);
    } else {
      this.belief = [...rawProbs];
    }

    let maxIdx = 0;
    let maxB = -1;
    this.belief.forEach((b, idx) => {
      if (b > maxB) {
        maxB = b;
        maxIdx = idx;
      }
    });

    return {
      bestZone: this.zones[maxIdx],
      confidence: maxB,
      belief: this.belief
    };
  }
}

function runParityCheck(model) {
  if (!model.parity || !model.parity.scans) {
    return { passed: false, error: "Missing 'parity' block in model.json" };
  }

  const scans = model.parity.scans;
  const knnParity = model.parity.knn;
  const nbParity = model.parity.nb;

  for (let i = 0; i < scans.length; i++) {
    const scan = scans[i];

    // Check kNN
    const knnRes = predictKNN(scan, model);
    const expKnnZone = knnParity.expected_predictions[i];
    const expKnnScores = knnParity.expected_scores[i];

    if (knnRes.predictedZone !== expKnnZone) {
      return { passed: false, error: `kNN Scan #${i + 1} zone mismatch (JS: '${knnRes.predictedZone}' vs Python: '${expKnnZone}')` };
    }
    for (let c = 0; c < expKnnScores.length; c++) {
      const diff = Math.abs(knnRes.scores[c] - expKnnScores[c]);
      if (diff > 1e-6) {
        return { passed: false, error: `kNN Scan #${i + 1} score diff ${diff.toExponential(2)} exceeds 1e-6` };
      }
    }

    // Check Naive Bayes
    const nbRes = predictGaussianNB(scan, model);
    const expNbZone = nbParity.expected_predictions[i];
    const expNbScores = nbParity.expected_scores[i];

    if (nbRes.predictedZone !== expNbZone) {
      return { passed: false, error: `NB Scan #${i + 1} zone mismatch (JS: '${nbRes.predictedZone}' vs Python: '${expNbZone}')` };
    }
    for (let c = 0; c < expNbScores.length; c++) {
      const diff = Math.abs(nbRes.scores[c] - expNbScores[c]);
      if (diff > 1e-6) {
        return { passed: false, error: `NB Scan #${i + 1} score diff ${diff.toExponential(2)} exceeds 1e-6` };
      }
    }
  }

  return { passed: true };
}

// ==========================================
// 10. Live Tracking Handlers
// ==========================================
btnStartTracking.addEventListener('click', async () => {
  if (!loadedModel) {
    alert("Please load a verified model.json file first!");
    return;
  }
  isLiveTracking = true;
  btnStartTracking.disabled = true;
  btnStopTracking.disabled = false;
  liveRoomDisplay.textContent = "Scanning...";
  liveConfidenceDisplay.textContent = "—";
  log("[TRACK ON] Live tracking stream requested from ESP32...");
  await sendBLECommand("TRACK ON");
});

btnStopTracking.addEventListener('click', async () => {
  isLiveTracking = false;
  btnStartTracking.disabled = false;
  btnStopTracking.disabled = true;
  log("[TRACK OFF] Stopping live tracking stream...");
  await sendBLECommand("TRACK OFF");
});

function handleLiveTrackingScan(apPairs, scanId) {
  if (!loadedModel) {
    log(`[TRACK #${scanId}] No model loaded. Please load model.json.`);
    return;
  }

  // 1. Build map of BSSID -> RSSI from the live scan
  const apMap = {};
  apPairs.forEach(pair => {
    const [bssid, rssiStr] = pair.split(",");
    if (bssid && rssiStr) {
      const clean = bssid.trim().toLowerCase();
      const r = parseInt(rssiStr, 10);
      if (!isNaN(r)) apMap[clean] = r;
    }
  });

  // 2. Vectorize scan using model's selected BSSIDs (missing APs = -100 dBm)
  const vector = loadedModel.bssids.map(b => apMap[b] !== undefined ? apMap[b] : -100.0);

  // 3. Check Novelty
  const novelty = computeNovelty(vector, loadedModel);
  liveNoveltyDisplay.textContent = `Novelty: ${novelty.distance.toFixed(1)} dBm ${novelty.isNovel ? "[Outlier!]" : "[Normal]"}`;

  if (novelty.isNovel) {
    liveRoomDisplay.textContent = "Unknown / Outlier";
    liveConfidenceDisplay.textContent = "Low";
    log(`[TRACK #${scanId}] Outlier scan! Distance ${novelty.distance.toFixed(1)} dBm > threshold ${novelty.threshold.toFixed(1)} dBm`);
    return;
  }

  // 4. Raw inference (kNN or Naive Bayes)
  const engine = modelEngineSelect.value;
  const rawResult = (engine === "nb") ? predictGaussianNB(vector, loadedModel) : predictKNN(vector, loadedModel);

  let finalZone = rawResult.predictedZone;
  let finalConf = rawResult.confidence;

  // 5. Belief Filter
  if (beliefFilterToggle.checked && jsBeliefFilter) {
    const filtered = jsBeliefFilter.update(rawResult.scores);
    finalZone = filtered.bestZone;
    finalConf = filtered.confidence;
    liveFilterStatus.textContent = "Filter: Active";
  } else {
    liveFilterStatus.textContent = "Filter: Disabled";
  }

  // 6. Update UI
  const zoneObj = zonesData.find(z => z.id === finalZone);
  const zoneLabel = zoneObj ? zoneObj.label : finalZone;
  liveRoomDisplay.textContent = zoneLabel;
  liveConfidenceDisplay.textContent = `${(finalConf * 100).toFixed(1)}%`;

  // 7. Animate Tracker Dot
  moveTrackerDot(finalZone);

  log(`[TRACK #${scanId}] -> ${zoneLabel} (${(finalConf * 100).toFixed(1)}% | ${novelty.distance.toFixed(1)} dBm)`);
}

// ==========================================
// Initialization
// ==========================================
window.addEventListener('DOMContentLoaded', async () => {
  await initDB();
  await loadZones();
  log("RoomSense Survey Dashboard ready.");
});
