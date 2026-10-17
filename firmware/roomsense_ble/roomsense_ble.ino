/*
 * RoomSense ESP32 Firmware (v1 - Flat Edition)
 * Hardware: EDU_ROBO IoT Trainer Kit (ESP32-WROOM-32 DevKit V1)
 * Pins: LED1 = GPIO27, BUZZER = GPIO15
 *
 * Requirements:
 * - Library: "NimBLE-Arduino" by h2zero (Install via Library Manager)
 */

#include <WiFi.h>
#include <NimBLEDevice.h>

// --- Hardware Pin Definitions ---
const int PIN_LED = 27;     // LED1 on EDU_ROBO board
const int PIN_BUZZER = 15;  // Buzzer on EDU_ROBO board

// --- BLE UUIDs ---
#define SERVICE_UUID        "12345678-1234-5678-1234-56789abcdef0"
#define CHAR_COMMAND_UUID   "12345678-1234-5678-1234-56789abcdef1"
#define CHAR_STREAM_UUID    "12345678-1234-5678-1234-56789abcdef2"

// --- Global State ---
NimBLEServer* pServer = nullptr;
NimBLECharacteristic* pStreamChar = nullptr;
bool deviceConnected = false;

// Job request flags set by BLE onWrite callback
volatile bool jobPending = false;
volatile bool trackMode = false;
char currentZone[32] = "unknown";
int targetScans = 0;
int currentScanIndex = 0;

// --- Helper: Buzzer Beep ---
void beep(int frequency, int durationMs) {
  // Simple square-wave tone on GPIO15
  ledcAttach(PIN_BUZZER, frequency, 8);
  ledcWrite(PIN_BUZZER, 128);
  delay(durationMs);
  ledcWrite(PIN_BUZZER, 0);
  ledcDetach(PIN_BUZZER);
}

// --- Helper: Format BSSID to lowercase 12 hex chars (no colons) ---
String formatBSSID(uint8_t* bssid) {
  char buf[13];
  snprintf(buf, sizeof(buf), "%02x%02x%02x%02x%02x%02x",
           bssid[0], bssid[1], bssid[2], bssid[3], bssid[4], bssid[5]);
  return String(buf);
}

// --- Helper: Calculate XOR Checksum (2-char hex string) ---
String calculateXORChecksum(const String& payload) {
  uint8_t xorVal = 0;
  for (size_t i = 0; i < payload.length(); i++) {
    xorVal ^= (uint8_t)payload[i];
  }
  char hexBuf[3];
  snprintf(hexBuf, sizeof(hexBuf), "%02x", xorVal);
  return String(hexBuf);
}

// Helper: Check if client is actually connected
bool isClientConnected() {
  if (pServer != nullptr && pServer->getConnectedCount() > 0) return true;
  return deviceConnected;
}

// --- Helper: Send String in <= 20 Byte Chunks Over BLE Notify ---
void sendBLEChunked(const String& line) {
  if (pStreamChar == nullptr || !isClientConnected()) return;

  const size_t CHUNK_SIZE = 20;
  size_t len = line.length();
  size_t sent = 0;

  while (sent < len) {
    size_t chunkLen = min(CHUNK_SIZE, len - sent);
    String chunk = line.substring(sent, sent + chunkLen);
    pStreamChar->setValue((uint8_t*)chunk.c_str(), chunkLen);
    pStreamChar->notify();
    sent += chunkLen;
    delay(15); // Pace notifications to avoid buffer congestion
  }
}

// --- BLE Callbacks ---
class ServerCallbacks : public NimBLEServerCallbacks {
  // NimBLE 1.x signature
  void onConnect(NimBLEServer* pServer) {
    deviceConnected = true;
    Serial.println("[BLE] Phone connected (v1 callback)");
    digitalWrite(PIN_LED, HIGH);
    delay(100);
    digitalWrite(PIN_LED, LOW);
  }

  // NimBLE 2.x signature
  void onConnect(NimBLEServer* pServer, NimBLEConnInfo& connInfo) {
    deviceConnected = true;
    Serial.println("[BLE] Phone connected (v2 callback)");
    digitalWrite(PIN_LED, HIGH);
    delay(100);
    digitalWrite(PIN_LED, LOW);
  }

  void onDisconnect(NimBLEServer* pServer) {
    deviceConnected = false;
    jobPending = false;
    trackMode = false;
    Serial.println("[BLE] Phone disconnected, restarting advertising");
    NimBLEDevice::startAdvertising();
  }

  void onDisconnect(NimBLEServer* pServer, NimBLEConnInfo& connInfo, int reason) {
    deviceConnected = false;
    jobPending = false;
    trackMode = false;
    Serial.println("[BLE] Phone disconnected, restarting advertising");
    NimBLEDevice::startAdvertising();
  }
};

class CommandCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* pCharacteristic) {
    deviceConnected = true; // If a write was received, device is definitely connected!
    std::string rxVal = pCharacteristic->getValue();
    if (rxVal.empty()) return;

    String cmd = String(rxVal.c_str());
    cmd.trim();
    Serial.printf("[BLE CMD] Received: '%s'\n", cmd.c_str());

    String upperCmd = cmd;
    upperCmd.toUpperCase();

    if (upperCmd.startsWith("ZONE ")) {
      // Format: ZONE <zone_name> <n_scans>
      int firstSpace = cmd.indexOf(' ');
      int secondSpace = cmd.indexOf(' ', firstSpace + 1);
      if (secondSpace > 0) {
        String zone = cmd.substring(firstSpace + 1, secondSpace);
        int n = cmd.substring(secondSpace + 1).toInt();
        if (n > 0) {
          strncpy(currentZone, zone.c_str(), sizeof(currentZone) - 1);
          currentZone[sizeof(currentZone) - 1] = '\0';
          targetScans = n;
          currentScanIndex = 0;
          trackMode = false;
          jobPending = true;
          Serial.printf("[BLE CMD] Accepted ZONE job: '%s', count: %d\n", currentZone, targetScans);
        }
      }
    } else if (upperCmd == "TRACK ON") {
      trackMode = true;
      jobPending = true;
      strncpy(currentZone, "track", sizeof(currentZone));
      currentScanIndex = 0;
      Serial.println("[BLE CMD] TRACK ON enabled");
    } else if (upperCmd == "TRACK OFF" || upperCmd == "STOP") {
      trackMode = false;
      jobPending = false;
      Serial.println("[BLE CMD] Stopped by client");
    } else if (upperCmd == "STATUS") {
      String statusLine = "STATUS ready\n";
      sendBLEChunked(statusLine);
    }
  }
};

// --- Execute a Single Wi-Fi Scan & Stream Result ---
void performScanAndStream(const char* zone, int scanId) {
  digitalWrite(PIN_LED, HIGH); // Blink LED during scan

  // Blocking scan, show hidden networks
  int nAPs = WiFi.scanNetworks(false, true);

  digitalWrite(PIN_LED, LOW);

  if (nAPs < 0) {
    sendBLEChunked("ERR scan_failed\n");
    return;
  }

  // Format: SCAN <zone> <scan_id> <ap_count> <bssid,rssi;...>*<chk>\n
  String payload = "SCAN " + String(zone) + " " + String(scanId) + " " + String(nAPs) + " ";
  for (int i = 0; i < nAPs; i++) {
    uint8_t* bssid = WiFi.BSSID(i);
    int32_t rssi = WiFi.RSSI(i);
    payload += formatBSSID(bssid) + "," + String(rssi);
    if (i < nAPs - 1) payload += ";";
  }

  // Add XOR checksum and newline
  String chk = calculateXORChecksum(payload);
  String completeLine = payload + "*" + chk + "\n";

  sendBLEChunked(completeLine);
  WiFi.scanDelete(); // Free scan memory
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n[RoomSense] Starting ESP32 Firmware...");

  // Setup pins
  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_LED, LOW);
  digitalWrite(PIN_BUZZER, LOW);

  // Initial power-on chirp
  beep(1200, 100);

  // Set Wi-Fi to station mode and disconnect from any AP
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  delay(100);

  // Initialize NimBLE
  NimBLEDevice::init("RoomSense");
  NimBLEDevice::setPower(ESP_PWR_LVL_P9); // Max TX power for good range

  pServer = NimBLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());

  NimBLEService* pService = pServer->createService(SERVICE_UUID);

  // Command Characteristic (Write)
  NimBLECharacteristic* pCmdChar = pService->createCharacteristic(
    CHAR_COMMAND_UUID,
    NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR
  );
  pCmdChar->setCallbacks(new CommandCallbacks());

  // Stream Characteristic (Notify)
  pStreamChar = pService->createCharacteristic(
    CHAR_STREAM_UUID,
    NIMBLE_PROPERTY::NOTIFY
  );

  pService->start();

  // Explicitly separate Advertisement and Scan Response to respect the 31-byte BLE limit
  NimBLEAdvertising* pAdvertising = NimBLEDevice::getAdvertising();

  NimBLEAdvertisementData advData;
  advData.setFlags(0x06); // General Discoverable + BR/EDR Not Supported
  advData.setName("RoomSense");
  pAdvertising->setAdvertisementData(advData);

  NimBLEAdvertisementData scanData;
  scanData.setCompleteServices(NimBLEUUID(SERVICE_UUID));
  pAdvertising->setScanResponseData(scanData);
  pAdvertising->enableScanResponse(true);
  pAdvertising->start();

  Serial.println("[RoomSense] BLE advertising started: 'RoomSense'");
}

void loop() {
  if (jobPending && isClientConnected()) {
    if (trackMode) {
      // Continuous tracking mode
      performScanAndStream("track", currentScanIndex++);
      delay(300); // Brief breath between continuous scans
    } else {
      // Fixed survey batch
      Serial.printf("[Survey] Scanning %s (%d/%d)...\n", currentZone, currentScanIndex + 1, targetScans);
      performScanAndStream(currentZone, currentScanIndex);
      currentScanIndex++;

      if (currentScanIndex >= targetScans) {
        jobPending = false;
        // Batch completed: notify phone and sound completion beep on GPIO15
        String doneMsg = "DONE " + String(currentZone) + " " + String(targetScans) + "\n";
        sendBLEChunked(doneMsg);
        beep(2000, 300); // 2 kHz completion tone
        Serial.printf("[Survey] Zone %s complete!\n", currentZone);
      }
    }
  }

  delay(20);
}
