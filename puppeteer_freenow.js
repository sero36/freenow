
// puppeteer_freenow.js

const puppeteer = require("puppeteer");
const { google } = require("googleapis");

// Umgebungsvariablen aus GitHub Secrets
const FREENOW_EMAIL = process.env.FREENOW_EMAIL;
const FREENOW_PASSWORD = process.env.FREENOW_PASSWORD;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

// Sicherheits-Check: sind alle Variablen da?
if (!FREENOW_EMAIL || !FREENOW_PASSWORD || !GOOGLE_SHEET_ID || !SERVICE_ACCOUNT_JSON) {
  console.error("FEHLENDE ENV VARS: Bitte FREENOW_EMAIL, FREENOW_PASSWORD, GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON als Secrets setzen.");
  process.exit(1);
}

// Google-Sheets-Client vorbereiten
async function getSheetsClient() {
  const credentials = JSON.parse(SERVICE_ACCOUNT_JSON);

  // Nur Debug-Ausgabe – keine Schlüsselwerte, nur Feldnamen
  console.log("Service-Account-Felder:", Object.keys(credentials));
  console.log("Hat private_key-Feld:", !!credentials.private_key);

  // Private Key Zeilenumbrüche fixen (\n -> echte Zeilenumbrüche)
  if (credentials.private_key) {
    credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");
  } else {
    throw new Error("In GOOGLE_SERVICE_ACCOUNT_JSON ist kein private_key enthalten.");
  }

  const auth = new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );


  await auth.authorize();
  return google.sheets({ version: "v4", auth });
}

// Test: eine Zeile ins Sheet schreiben
async function appendTestRow(message) {
  const sheets = await getSheetsClient();

  const now = new Date();
  const iso = now.toISOString();

  // Wir schreiben in das Tabellenblatt "FreeNow_Import" ab Zeile 2
  await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: "FreeNow_Import!A2:O2",
    valueInputOption: "RAW",
    requestBody: {
      values: [
        [
          iso,        // A: Datum (erstmal ISO-Zeitstempel)
          "",         // B: Fahrt-ID
          "",         // C: Fahrer
          "",         // D: Fahrzeug
          "",         // E: Startzeit
          "",         // F: Endzeit
          "",         // G: Dauer (Min)
          "",         // H: Abholort
          "",         // I: Zielort
          "",         // J: Brutto (€)
          "",         // K: Provision (€)
          "",         // L: Netto (€)
          "",         // M: Zahlungsart
          "",         // N: Status
          message     // O: Import-Zeitstempel / Kommentar
        ]
      ]
    }
  });

  console.log("Testzeile ins Sheet geschrieben:", iso, message);
}

// Login bei FreeNow – nur Grundversion, später erweitern wir um Daten-Export
async function loginToFreeNow() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage"
    ]
  });

  const page = await browser.newPage();

  const loginUrl = "https://portal.free-now.com/login";
  console.log("Öffne Login-Seite:", loginUrl);

  await page.goto(loginUrl, { waitUntil: "networkidle2" });

  // Selector können sich ändern – das ist eine erste Annäherung
  const emailSelector = 'input[type="email"], input[name="email"]';
  const passwordSelector = 'input[type="password"], input[name="password"]';
  const submitSelector = 'button[type="submit"]';

  try {
    await page.waitForSelector(emailSelector, { timeout: 20000 });
    await page.type(emailSelector, FREENOW_EMAIL, { delay: 50 });

    await page.waitForSelector(passwordSelector, { timeout: 20000 });
    await page.type(passwordSelector, FREENOW_PASSWORD, { delay: 50 });

    await page.waitForSelector(submitSelector, { timeout: 20000 });
    await page.click(submitSelector);

    // Warten, bis Dashboard geladen ist
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 });

    console.log("Login vermutlich erfolgreich – Dashboard geladen.");

    // TODO: Hier später die Fahrten-Seite öffnen und Daten scrapen.
    // Beispiel:
    // await page.goto("https://portal.free-now.com/rides", { waitUntil: "networkidle2" });
    // ... Tabelle auslesen, Werte ins Sheet schreiben ...

  } catch (err) {
    console.error("Fehler beim Login in FreeNow:", err.message || err);
    throw err;
  } finally {
    await browser.close();
  }
}

// Hauptfunktion
async function main() {
  console.log("FreeNow Bot gestartet…");

  // 1. Test, ob Google-Sheets-Zugriff funktioniert
  await appendTestRow("FreeNow Bot Testlauf");

  // 2. Login in FreeNow (noch ohne tatsächlichen Daten-Import)
  await loginToFreeNow();

  console.log("FreeNow Bot erfolgreich beendet.");
}

// Start
main().catch((err) => {
  console.error("FreeNow Bot Fehler:", err);
  process.exit(1);
});
