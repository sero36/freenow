/**
 * Zettle (iZettle / PayPal) -> Google Tabelle (Tab "Zettle")
 *
 * Als ZWEITE Datei in dasselbe Apps-Script-Projekt einfügen wie taxifusion_import.gs.
 *
 * Einmalig:
 *  1. Bei Zettle anmelden: https://my.zettle.com/apps/api-keys -> "API-Schlüssel erstellen"
 *     Berechtigungen: "READ:PURCHASE" (Käufe lesen) und "READ:FINANCE" (für die Kartengebühren).
 *     Ohne READ:FINANCE läuft alles weiter, nur die Spalte "Gebühr (€)" bleibt leer.
 *     Zettle zeigt danach eine Client-ID und den API-Schlüssel (nur einmal sichtbar).
 *  2. Im Apps-Script-Editor: Projekteinstellungen -> Script-Eigenschaften:
 *       ZETTLE_CLIENT_ID_<KURZ>  = Client-ID
 *       ZETTLE_API_KEY_<KURZ>    = API-Schlüssel
 *     <KURZ> ist das Kürzel aus ZETTLE_KONTEN unten, z. B. ZETTLE_API_KEY_HD
 *  3. Funktion zettleEinrichten() einmal ausführen (legt den täglichen Abruf an).
 *  4. Funktion ladeZettleDaten() einmal ausführen und den Tab "Zettle" prüfen.
 */

// Ein Eintrag pro Zettle-Konto. Hat nur eine Firma Zettle, den anderen Eintrag löschen.
const ZETTLE_KONTEN = [
  { kurz: "HD",  firma: "HeimDrive GmbH" },
];
const ZETTLE_BLATT = "Zettle";
const ZETTLE_HEADER = ["Kauf-ID", "Firma", "Zeitpunkt", "Betrag (€)", "MwSt (€)", "Trinkgeld (€)", "Zahlart", "Kartentyp", "Karte", "Nutzer", "Erstattung", "Artikel", "Abgerufen am", "Gebühr (€)"];

function zettleEinrichten() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === "ladeZettleDaten")
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("ladeZettleDaten").timeBased().everyDays(1).atHour(5).create();
  const p = PropertiesService.getScriptProperties();
  const fehlend = [];
  ZETTLE_KONTEN.forEach(k => {
    if (!p.getProperty("ZETTLE_CLIENT_ID_" + k.kurz)) fehlend.push("ZETTLE_CLIENT_ID_" + k.kurz);
    if (!p.getProperty("ZETTLE_API_KEY_" + k.kurz)) fehlend.push("ZETTLE_API_KEY_" + k.kurz);
  });
  Logger.log("Täglicher Zettle-Abruf um ca. 5 Uhr eingerichtet.");
  if (fehlend.length) Logger.log("Bitte noch eintragen: " + fehlend.join(", "));
}

/** Täglich: Vormonat komplett + laufender Monat. */
function ladeZettleDaten() {
  const j = new Date();
  zettleAbrufen(new Date(j.getFullYear(), j.getMonth() - 1, 1), new Date(j.getTime() + 86400000));
}

/** Einmalig ausführen: lädt die letzten 12 Monate Monat für Monat nach. */
function zettleVergangenheitLaden() {
  const j = new Date();
  for (let m = 12; m >= 0; m--) {
    const von = new Date(j.getFullYear(), j.getMonth() - m, 1);
    const bis = m === 0 ? new Date(j.getTime() + 86400000) : new Date(j.getFullYear(), j.getMonth() - m + 1, 1);
    zettleAbrufen(von, bis);
  }
}

function zettleAbrufen(von, bis) {
  const ss = zettleZielTabelle();
  const sheet = ss.getSheetByName(ZETTLE_BLATT) || ss.insertSheet(ZETTLE_BLATT);
  const p = PropertiesService.getScriptProperties();
  const jetzt = new Date();
  let zeilen = [];
  const status = [];

  for (const k of ZETTLE_KONTEN) {
    try {
      const cid = p.getProperty("ZETTLE_CLIENT_ID_" + k.kurz);
      const key = p.getProperty("ZETTLE_API_KEY_" + k.kurz);
      if (!cid || !key) throw new Error("Client-ID oder API-Schlüssel fehlt in den Script-Eigenschaften");
      const token = zettleToken(cid, key);
      const kaeufe = zettleKaeufe(token, von, bis);
      let gebuehren = null, gebHinweis = "";
      try { gebuehren = zettleGebuehren(token, von, bis); }
      catch (e) { gebHinweis = " · Gebühren nicht abrufbar (" + String(e.message || e).slice(0, 80) + ")"; }
      kaeufe.forEach(kauf => zeilen.push(zettleZeile(kauf, k, jetzt, gebuehren)));
      status.push(["Zettle " + k.firma, k.kurz, "OK", kaeufe.length + " Zahlungen" + (gebuehren ? " · Gebühren übernommen" : gebHinweis), jetzt]);
    } catch (e) {
      status.push(["Zettle " + k.firma, k.kurz, "FEHLER", String(e.message || e).slice(0, 300), jetzt]);
      Logger.log("Zettle-Fehler " + k.kurz + ": " + e);
    }
  }

  mitWiederholung(() => zettleZusammenfuehren(sheet, zeilen));
  zettleStatus(ss, status);
}

function zettleToken(clientId, apiKey) {
  const res = UrlFetchApp.fetch("https://oauth.zettle.com/token", {
    method: "post",
    contentType: "application/x-www-form-urlencoded",
    payload: {
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      client_id: clientId,
      assertion: apiKey
    },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error("Zettle-Anmeldung: HTTP " + res.getResponseCode() + " " + res.getContentText().slice(0, 200));
  return JSON.parse(res.getContentText()).access_token;
}

function zettleKaeufe(token, von, bis) {
  const fmt = d => Utilities.formatDate(d, "Europe/Berlin", "yyyy-MM-dd");
  const alle = [];
  let lastHash = null;
  for (let seite = 0; seite < 50; seite++) {
    let url = "https://purchase.izettle.com/purchases/v2?startDate=" + fmt(von) + "&endDate=" + fmt(bis) + "&limit=1000&descending=false";
    if (lastHash) url += "&lastPurchaseHash=" + encodeURIComponent(lastHash);
    const res = UrlFetchApp.fetch(url, { headers: { Authorization: "Bearer " + token }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error("Zettle-Käufe: HTTP " + res.getResponseCode());
    const data = JSON.parse(res.getContentText());
    const liste = data.purchases || [];
    liste.forEach(x => alle.push(x));
    if (liste.length < 1000 || !data.lastPurchaseHash || data.lastPurchaseHash === lastHash) break;
    lastHash = data.lastPurchaseHash;
  }
  return alle;
}

/**
 * Kartengebühren aus der Zettle-Finanzschnittstelle (Buchungsart PAYMENT_FEE).
 * Ergebnis: { Zahlungs-UUID: Gebühr in € }. Braucht die Berechtigung READ:FINANCE.
 */
function zettleGebuehren(token, von, bis) {
  const map = {};
  for (let offset = 0, seite = 0; seite < 50; seite++, offset += 1000) {
    const url = "https://finance.izettle.com/v2/accounts/liquid/transactions?start=" + encodeURIComponent(von.toISOString()) +
      "&end=" + encodeURIComponent(bis.toISOString()) + "&includeTransactionType=PAYMENT_FEE&limit=1000&offset=" + offset;
    const res = UrlFetchApp.fetch(url, { headers: { Authorization: "Bearer " + token }, muteHttpExceptions: true });
    const code = res.getResponseCode();
    if (code === 401 || code === 403) throw new Error("Berechtigung READ:FINANCE fehlt im API-Schlüssel");
    if (code !== 200) throw new Error("HTTP " + code);
    const data = JSON.parse(res.getContentText());
    const liste = Array.isArray(data) ? data : (data.data || data.transactions || []);
    liste.forEach(t => {
      const id = t.originatingTransactionUuid; if (!id) return;
      map[id] = (map[id] || 0) - (t.amount || 0) / 100; // Gebühr ist negativ gebucht, bei Erstattung positiv
    });
    if (liste.length < 1000) break;
  }
  return map;
}

function zettleZeile(kauf, konto, jetzt, gebuehren) {
  const zahlung = (kauf.payments && kauf.payments[0]) || {};
  const pid = zahlung.uuid || zahlung.uuid1 || "";
  const att = zahlung.attributes || {};
  const typ = String(zahlung.type || "").replace("IZETTLE_", "").replace("_ONLINE", " online");
  const artikel = (kauf.products || []).map(p => (p.quantity && p.quantity !== "1" ? p.quantity + "x " : "") + (p.name || "")).join(", ");
  return [
    String(kauf.purchaseUUID1 || kauf.purchaseUUID || kauf.globalPurchaseNumber || ""),
    konto.firma,
    kauf.timestamp ? new Date(kauf.timestamp) : "",
    (kauf.amount || 0) / 100,
    (kauf.vatAmount || 0) / 100,
    (kauf.gratuityAmount || 0) / 100,
    typ === "CARD" ? "Karte" : typ === "CASH" ? "Bar" : typ,
    att.cardType || "",
    att.maskedPan ? String(att.maskedPan).slice(-4) : "",
    kauf.userDisplayName || "",
    kauf.refund ? "ja" : "",
    artikel.slice(0, 200),
    jetzt,
    gebuehren && pid && gebuehren[pid] != null ? Math.round(gebuehren[pid] * 100) / 100 : ""
  ];
}

function zettleZusammenfuehren(sheet, neue) {
  const n0 = sheet.getLastRow();
  const alt = n0 > 1 ? sheet.getRange(2, 1, n0 - 1, ZETTLE_HEADER.length).getValues() : [];
  const index = new Map(alt.map((r, i) => [String(r[0]), i]));
  for (const z of neue) {
    if (!z[0]) { alt.push(z); continue; }
    if (index.has(z[0])) alt[index.get(z[0])] = z; else { index.set(z[0], alt.length); alt.push(z); }
  }
  alt.sort((a, b) => (a[2] instanceof Date ? a[2].getTime() : 0) - (b[2] instanceof Date ? b[2].getTime() : 0));
  sheet.clearContents();
  sheet.getRange(1, 1, 1, ZETTLE_HEADER.length).setValues([ZETTLE_HEADER]).setFontWeight("bold");
  sheet.setFrozenRows(1);
  if (!alt.length) return;
  sheet.getRange(2, 1, alt.length, ZETTLE_HEADER.length).setValues(alt);
  sheet.getRange(2, 3, alt.length, 1).setNumberFormat("dd.mm.yyyy hh:mm");
  sheet.getRange(2, 4, alt.length, 3).setNumberFormat("0.00 €");
  sheet.getRange(2, 13, alt.length, 1).setNumberFormat("dd.mm.yyyy hh:mm");
  sheet.getRange(2, 14, alt.length, 1).setNumberFormat("0.00 €");
}

/**
 * Schreibt den Zettle-Status in einen eigenen kleinen Tab "Zettle Status".
 * Der große Tab "Status" wird nicht angefasst. Ein Fehler hier bricht den Abruf nicht mehr ab.
 */
function zettleStatus(ss, zeilen) {
  try {
    mitWiederholung(() => {
      const st = ss.getSheetByName("Zettle Status") || ss.insertSheet("Zettle Status");
      const werte = [["Firma", "Konto", "Ergebnis", "Details", "Zeitpunkt"]].concat(zeilen);
      st.getRange(1, 1, Math.max(st.getLastRow(), werte.length), 5).clearContent();
      st.getRange(1, 1, werte.length, 5).setValues(werte);
    });
  } catch (e) {
    Logger.log("Status konnte nicht geschrieben werden (Daten sind trotzdem gespeichert): " + e);
  }
}

/** Wiederholt einen Tabellenzugriff bis zu 3-mal, wenn Google eine Zeitüberschreitung meldet. */
function mitWiederholung(fn) {
  for (let i = 0; i < 3; i++) {
    try { return fn(); }
    catch (e) {
      const t = String(e && e.message || e);
      if (i === 2 || !/Zeit überschritten|timed out|Service|Dienst/i.test(t)) throw e;
      Utilities.sleep(5000 * (i + 1));
    }
  }
}

/**
 * Ziel-Tabelle für alle App-Daten: eine eigene, schlanke Tabelle "Umsatzdaten App".
 * Wird beim ersten Lauf automatisch angelegt (in deinem Google Drive). So bleibt die
 * große Tabelle "automatik" unberührt und es gibt keine Zeitüberschreitungen.
 */
function zettleZielTabelle() {
  const p = PropertiesService.getScriptProperties();
  const oeffnen = id => { try { return SpreadsheetApp.openById(id); } catch (e) { return null; } };
  let ss = p.getProperty("APP_TABELLE_ID") && oeffnen(p.getProperty("APP_TABELLE_ID"));
  if (ss) return ss;
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    ss = p.getProperty("APP_TABELLE_ID") && oeffnen(p.getProperty("APP_TABELLE_ID"));
    if (ss) return ss;
    ss = SpreadsheetApp.create("Umsatzdaten App");
    p.setProperty("APP_TABELLE_ID", ss.getId());
    Logger.log("Neue Tabelle 'Umsatzdaten App' angelegt: " + ss.getUrl());
    return ss;
  } finally { lock.releaseLock(); }
}
