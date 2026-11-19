/**
 * TaxiFusion -> Google Tabelle (eigener Tab "TF Schichten")
 *
 * WICHTIG: Als NEUE Datei einfügen (z. B. "taxifusion_neu"). Dein bisheriges Script und
 * der Tab "Schichten" bleiben unverändert, deine Auswertungen rechnen weiter wie gewohnt.
 * Die Daten landen in einer eigenen Tabelle "Umsatzdaten App" (wird automatisch angelegt).
 *
 * Unterschiede zur alten Version:
 *  - Keine Passwörter im Code. Sie liegen in den Script-Eigenschaften (siehe einrichten()).
 *  - Nichts wird gelöscht: Schichten werden anhand einer eindeutigen ID aktualisiert oder angehängt.
 *    So bleibt die Historie erhalten, auch über den Monatswechsel.
 *  - Es wird immer der komplette Vormonat plus der laufende Monat abgerufen, damit nachträgliche Korrekturen
 *    und der letzte Tag des Vormonats nicht verloren gehen.
 *  - Jede Zeile hat die Spalten "Firma" und "Konto", damit die Personal-App die Schichten
 *    der richtigen Gesellschaft zuordnen kann.
 *  - Ein Tab "TF Status" zeigt, wann zuletzt abgerufen wurde und ob es Fehler gab.
 *  - Der funktionierende Login-Weg wird gemerkt, statt jedes Mal 15 Varianten durchzuprobieren.
 *
 * Einmalig ausführen:  tfEinrichten()   -> danach Passwörter eintragen (siehe unten)
 * Täglicher Abruf:     tfTaeglichLaden()  -> Vormonat + laufender Monat
 * Einmalig Historie:   taxifusionVergangenheitLaden()  -> die letzten 6 Monate, Monat für Monat
 */

// Konten ohne Passwörter. Die Passwörter liegen in den Script-Eigenschaften TF_PW_<Kundennummer>.
const TF_KONTEN = [
  { kunde: "42902", firma: "SFK Drivers GmbH" },
  { kunde: "42905", firma: "HeimDrive GmbH" },
];
const TF_BLATT = "TF Schichten";
const TF_API = "https://api.app.taxifusion.de";

const TF_HEADER = [
  "Schicht-ID", "Firma", "Konto",
  "Fahrer", "Kennzeichen", "Schicht Nr", "Signal Nr", "Abfahrt", "Ankunft",
  "Gesamt KM", "Besetzt KM", "Leer KM", "Umsatz (€)",
  "Fahrer-Nr", "Dauer (min)", "Touren",
  "ForHire KM", "Rohumsatz (€)", "Fehlbetrag (€)", "Zuschläge (€)", "Endzuschlag (€)",
  "Abgerufen am"
];

/** Einmalig ausführen: legt den täglichen Zeitplan an und zeigt, welche Passwörter fehlen. */
function tfEinrichten() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === "tfTaeglichLaden")
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("tfTaeglichLaden").timeBased().everyDays(1).atHour(5).create();

  const props = PropertiesService.getScriptProperties();
  const fehlend = TF_KONTEN.filter(k => !props.getProperty("TF_PW_" + k.kunde)).map(k => "TF_PW_" + k.kunde);
  Logger.log("Täglicher Abruf um ca. 5 Uhr ist eingerichtet.");
  if (fehlend.length) {
    Logger.log("Bitte unter Projekteinstellungen > Script-Eigenschaften eintragen: " + fehlend.join(", "));
  }
}

/** Täglich: Vormonat komplett + laufender Monat (damit die Abrechnung immer vollständig ist). */
function tfTaeglichLaden() {
  const j = new Date();
  taxifusionAbrufen(new Date(j.getFullYear(), j.getMonth() - 1, 1), j);
}

/** Einmalig ausführen: lädt die letzten 6 Monate Monat für Monat nach. */
function taxifusionVergangenheitLaden() {
  const j = new Date();
  for (let m = 6; m >= 0; m--) {
    const von = new Date(j.getFullYear(), j.getMonth() - m, 1);
    const bis = m === 0 ? j : new Date(j.getFullYear(), j.getMonth() - m + 1, 0);
    taxifusionAbrufen(von, bis);
  }
}

function taxifusionAbrufen(von, bis) {
  const ss = tfZielTabelle();
  const sheet = ss.getSheetByName(TF_BLATT) || ss.insertSheet(TF_BLATT);
  const props = PropertiesService.getScriptProperties();
  const jetzt = new Date();
  const status = [];
  let neueZeilen = [];

  for (const konto of TF_KONTEN) {
    try {
      const pw = props.getProperty("TF_PW_" + konto.kunde);
      if (!pw) throw new Error("Passwort fehlt (Script-Eigenschaft TF_PW_" + konto.kunde + ")");
      const cookie = tfLogin(konto.kunde, pw);
      const shifts = tfLadeSchichten(cookie, von, bis);
      const zeilen = shifts.map(s => tfZeile(s, konto, jetzt));
      try { tfRohSpeichern(shifts, konto, jetzt); } catch (e) { Logger.log("Rohdaten nicht gespeichert (Schichten sind gespeichert): " + e); }
      neueZeilen = neueZeilen.concat(zeilen);
      status.push([konto.firma, konto.kunde, "OK", zeilen.length + " Schichten", jetzt]);
    } catch (e) {
      status.push([konto.firma, konto.kunde, "FEHLER", String(e.message || e).slice(0, 300), jetzt]);
      Logger.log("Fehler bei " + konto.kunde + ": " + e);
    }
  }

  tfWiederholung(() => tfZusammenfuehren(sheet, neueZeilen));
  try { tfWiederholung(() => tfStatus(ss, status)); } catch (e) { Logger.log("Status nicht geschrieben (Daten sind gespeichert): " + e); }
}

/** Login. Merkt sich den funktionierenden Weg in den Script-Eigenschaften. */
function tfLogin(kunde, passwort) {
  const props = PropertiesService.getScriptProperties();
  const gemerkt = props.getProperty("TF_LOGIN_WEG");
  const urls = [TF_API + "/login", "https://app.taxifusion.de/api/login", TF_API + "/cpanel/login", TF_API + "/auth/login", "https://app.taxifusion.de/login"];
  const felder = ["customerNumber", "username", "clientNumber"];
  const wege = [];
  if (gemerkt) wege.push(JSON.parse(gemerkt));
  urls.forEach(u => felder.forEach(f => wege.push({ url: u, feld: f })));

  for (const weg of wege) {
    const body = { password: passwort };
    body[weg.feld] = kunde;
    let res;
    try {
      res = UrlFetchApp.fetch(weg.url, { method: "post", contentType: "application/json", payload: JSON.stringify(body), muteHttpExceptions: true, followRedirects: false });
    } catch (e) { continue; }
    const cookie = tfSessionCookie(res);
    if (cookie && res.getResponseCode() < 400) {
      props.setProperty("TF_LOGIN_WEG", JSON.stringify(weg));
      return cookie;
    }
  }
  throw new Error("Login fehlgeschlagen. Passwort prüfen.");
}

/** Holt nur "name=wert" der Session-Cookies aus Set-Cookie (ohne Path, Expires usw.). */
function tfSessionCookie(res) {
  const h = res.getAllHeaders();
  let sc = h["Set-Cookie"] || h["set-cookie"];
  if (!sc) return null;
  if (!Array.isArray(sc)) sc = [sc];
  const paare = sc.map(c => String(c).split(";")[0].trim()).filter(Boolean);
  if (!paare.some(p => p.indexOf("tf-session") === 0)) return null;
  return paare.join("; ");
}

function tfLadeSchichten(cookie, von, bis) {
  const fmt = d => Utilities.formatDate(d, "Europe/Berlin", "yyyy-MM-dd");
  const res = UrlFetchApp.fetch(TF_API + "/cpanel/shifts", {
    method: "post", contentType: "application/json",
    payload: JSON.stringify({ rangeStartAt: fmt(von), rangeEndAt: fmt(bis) }),
    headers: { cookie: cookie, accept: "application/json" },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 400) throw new Error("Schichten-Abruf: HTTP " + res.getResponseCode());
  const data = JSON.parse(tfJsonBlock(res.getContentText()));
  if (!Array.isArray(data)) throw new Error("Antwort ist keine Liste");
  return data;
}

function tfZeile(shift, konto, jetzt) {
  const ersteTour = Array.isArray(shift.trips) && shift.trips.length ? shift.trips[0] : null;
  const forHireKm = (shift.forHireDistance || 0) / 1000;
  const besetztKm = (shift.hiredDistance || 0) / 1000;
  const id = shift.id || shift._id || shift.uuid ||
    [konto.kunde, shift.driverNumber || "", shift.licenseNumber || "", shift.startAt || ""].join("|");
  return [
    String(id), konto.firma, konto.kunde,
    (shift.driver && shift.driver.name) || "", shift.licenseNumber || "",
    // Schicht-Nummer: bevorzugt von der Schicht selbst (gibt es auch bei Schichten ohne Tour, z. B. „Betrieb“), sonst von der ersten Tour
    shift.shiftSequenceNumber || shift.sequenceNumber || shift.shiftNumber || shift.number || (ersteTour ? (ersteTour.shiftSequenceNumber || "") : ""), ersteTour ? (ersteTour.sequenceNumber || "") : "",
    shift.startAt ? new Date(shift.startAt) : "", shift.endAt ? new Date(shift.endAt) : "",
    (shift.totalDistance || 0) / 1000, besetztKm, Math.max(0, forHireKm - besetztKm),
    (shift.finalTotalAmount != null ? shift.finalTotalAmount : (shift.totalAmount || 0)) / 100,
    shift.driverNumber || "", Math.round((shift.duration || 0) / 60), shift.tripsCount || 0,
    forHireKm, (shift.totalAmount || 0) / 100, (shift.subtractedTotalAmount || 0) / 100,
    (shift.extrasAmount || 0) / 100,
    (shift.finalExtrasAmount != null ? shift.finalExtrasAmount : (shift.extrasAmount || 0)) / 100,
    jetzt
  ];
}

/** Aktualisiert vorhandene Schichten anhand der Schicht-ID, hängt neue an, löscht nichts. */
function tfZusammenfuehren(sheet, neue) {
  const alt = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, TF_HEADER.length).getValues() : [];
  const index = new Map(alt.map((r, i) => [String(r[0]), i]));
  for (const z of neue) {
    if (index.has(z[0])) alt[index.get(z[0])] = z;
    else { index.set(z[0], alt.length); alt.push(z); }
  }
  alt.sort((a, b) => (a[7] instanceof Date ? a[7].getTime() : 0) - (b[7] instanceof Date ? b[7].getTime() : 0));
  sheet.clearContents();
  sheet.getRange(1, 1, 1, TF_HEADER.length).setValues([TF_HEADER]).setFontWeight("bold");
  sheet.setFrozenRows(1);
  if (!alt.length) return;
  sheet.getRange(2, 1, alt.length, TF_HEADER.length).setValues(alt);
  const n = alt.length;
  sheet.getRange(2, 8, n, 2).setNumberFormat("dd.mm.yyyy hh:mm");
  sheet.getRange(2, 10, n, 3).setNumberFormat("0.00");
  sheet.getRange(2, 13, n, 1).setNumberFormat("0.00 €");
  sheet.getRange(2, 15, n, 2).setNumberFormat("0");
  sheet.getRange(2, 17, n, 1).setNumberFormat("0.00");
  sheet.getRange(2, 18, n, 4).setNumberFormat("0.00 €");
  sheet.getRange(2, 22, n, 1).setNumberFormat("dd.mm.yyyy hh:mm");
}

function tfStatus(ss, zeilen) {
  const st = ss.getSheetByName("TF Status") || ss.insertSheet("TF Status");
  const n = st.getLastRow();
  // Zeilen anderer Abrufe (z. B. "Zettle ...") behalten
  const andere = n > 1 ? st.getRange(2, 1, n - 1, 5).getValues().filter(r => String(r[0]).startsWith("Zettle ")) : [];
  const alle = zeilen.concat(andere);
  st.clearContents();
  st.getRange(1, 1, 1, 5).setValues([["Firma", "Konto", "Ergebnis", "Details", "Zeitpunkt"]]).setFontWeight("bold");
  if (alle.length) {
    st.getRange(2, 1, alle.length, 5).setValues(alle);
    st.getRange(2, 5, alle.length, 1).setNumberFormat("dd.mm.yyyy hh:mm");
  }
}

/** Extrahiert den ersten JSON-Block aus einer Antwort (unverändert übernommen). */
function tfJsonBlock(text) {
  let s = String(text || "").trim().replace(/^﻿/, "");
  const start = s.search(/[\[{]/);
  if (start === -1) throw new Error("Antwort enthält kein JSON.");
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) { if (escape) escape = false; else if (ch === "\\") escape = true; else if (ch === '"') inString = false; continue; }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{" || ch === "[") depth++;
    if (ch === "}" || ch === "]") depth--;
    if (depth === 0) return s.slice(start, i + 1);
  }
  throw new Error("JSON-Block nicht vollständig.");
}

/**
 * Ziel-Tabelle für alle App-Daten: eine eigene, schlanke Tabelle "Umsatzdaten App".
 * Wird beim ersten Lauf automatisch angelegt (in deinem Google Drive). So bleibt die
 * große Tabelle "automatik" unberührt und es gibt keine Zeitüberschreitungen.
 */
function tfZielTabelle() {
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

/** Wiederholt einen Tabellenzugriff bis zu 3-mal bei Zeitüberschreitung. */
function tfWiederholung(fn) {
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
 * Rohdaten: komplette Antwort von TaxiFusion je Schicht (ohne die einzelnen Touren) in einer EIGENEN Tabelle
 * „Flottencockpit TaxiFusion Rohdaten“ (wird beim ersten Lauf in deinem Drive angelegt). So geht kein Feld verloren,
 * und die Umsatz-Tabelle, die die App lädt, bleibt klein und schnell.
 */
function tfRohSpeichern(shifts, konto, jetzt) {
  if (!shifts || !shifts.length) return;
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty("TF_ROH_SHEET"), ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) { ss = SpreadsheetApp.create("Flottencockpit TaxiFusion Rohdaten"); props.setProperty("TF_ROH_SHEET", ss.getId()); }
  const sh = ss.getSheets()[0];
  if (sh.getLastRow() === 0) { sh.appendRow(["Schicht-ID", "Konto", "Kennzeichen", "Abfahrt", "Abgerufen am", "Roh-JSON"]); sh.setFrozenRows(1); }
  const n = sh.getLastRow() - 1, index = {};
  if (n > 0) sh.getRange(2, 1, n, 1).getValues().forEach((r, i) => { index[String(r[0])] = i + 2; });
  const neu = [];
  shifts.forEach(shift => {
    const sid = String(shift.id || shift._id || shift.uuid || [konto.kunde, shift.driverNumber || "", shift.licenseNumber || "", shift.startAt || ""].join("|"));
    const o = {}; Object.keys(shift).forEach(k => { if (k !== "trips") o[k] = shift[k]; });
    o.tourenAnzahl = Array.isArray(shift.trips) ? shift.trips.length : 0;
    const z = [sid, konto.kunde, shift.licenseNumber || "", shift.startAt ? new Date(shift.startAt) : "", jetzt, JSON.stringify(o).slice(0, 45000)];
    if (index[sid]) sh.getRange(index[sid], 1, 1, z.length).setValues([z]); else neu.push(z);
  });
  if (neu.length) sh.getRange(sh.getLastRow() + 1, 1, neu.length, 6).setValues(neu);
}
