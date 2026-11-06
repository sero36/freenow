/**
 * FREENOW-Empfang: nimmt die CSV aus GitHub entgegen und schreibt sie in den Tab "FreeNow".
 *
 * Einrichtung (einmalig):
 *  1. Diese Datei im Apps-Script-Projekt der Tabelle "automatik" als neue Datei einfügen.
 *  2. Funktion  freenowTokenErzeugen  ausführen. Im Protokoll steht ein langer Schlüssel.
 *     -> In GitHub als Secret SHEETS_TOKEN eintragen.
 *  3. Oben rechts "Bereitstellen" -> "Neue Bereitstellung" -> Typ "Web-App"
 *       Ausführen als: Ich
 *       Zugriff: Jeder
 *     -> Die angezeigte Web-App-URL in GitHub als Secret SHEETS_WEBHOOK_URL eintragen.
 *
 * Die CSV enthält die Einnahmen "Monat bis heute". Bei jedem Abruf werden die Zeilen
 * dieses Monats ersetzt, ältere Monate bleiben erhalten.
 */
const FN_TAB = "FreeNow";

function freenowTokenErzeugen() {
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, "");
  PropertiesService.getScriptProperties().setProperty("FREENOW_TOKEN", token);
  Logger.log("In GitHub als Secret SHEETS_TOKEN eintragen:\n" + token);
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const soll = PropertiesService.getScriptProperties().getProperty("FREENOW_TOKEN");
    if (!soll || body.token !== soll) return antwort({ ok: false, fehler: "Token ungültig" });
    if (body.quelle !== "freenow" || !body.csv) return antwort({ ok: false, fehler: "Keine CSV" });
    const n = freenowSchreiben(body.csv, body.datei || "", body.monat, body.von, body.bis);
    return antwort({ ok: true, zeilen: n, tab: FN_TAB });
  } catch (err) {
    return antwort({ ok: false, fehler: String(err && err.message || err).slice(0, 300) });
  }
}

function antwort(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function freenowSchreiben(csvText, datei, monatParam, von, bis) {
  const text = String(csvText).replace(/^﻿/, "");
  const ersteZeile = text.split(/\r?\n/)[0] || "";
  const zaehle = ch => ersteZeile.split(ch).length - 1;
  const trenner = [";", ",", "\t"].sort((x, y) => zaehle(y) - zaehle(x))[0];
  const zeilen = csvLesen(text, trenner).filter(r => r.some(c => String(c).trim() !== ""));
  if (zeilen.length < 1) return 0;
  const kopf = zeilen[0].map(String);
  const daten = zeilen.slice(1);

  const jetzt = new Date();
  const monat = /^\d{4}-\d{2}$/.test(String(monatParam || "")) ? String(monatParam) : Utilities.formatDate(jetzt, "Europe/Berlin", "yyyy-MM");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(FN_TAB) || ss.insertSheet(FN_TAB);
  const header = ["Monat", "Von", "Bis", "Abgerufen am", "Datei"].concat(kopf);

  // Vorhandene Zeilen anderer Monate behalten (nach Spaltennamen zugeordnet)
  let alt = [];
  if (sh.getLastRow() > 1) {
    const v = sh.getDataRange().getValues();
    const altKopf = v[0].map(String);
    const mk = x => x instanceof Date ? Utilities.formatDate(x, "Europe/Berlin", "yyyy-MM") : String(x);
    alt = v.slice(1).filter(r => mk(r[0]) !== monat).map(r => header.map(h => { const i = altKopf.indexOf(h); return i >= 0 ? r[i] : ""; }));
  }
  const neu = daten.map(r => [monat, von || "", bis || "", jetzt, datei].concat(kopf.map((_, i) => r[i] !== undefined ? r[i] : "")));
  const alle = [header].concat(alt, neu);
  sh.clearContents();
  // Monat, Von, Bis als Text speichern, sonst macht Google Datumswerte daraus
  sh.getRange(1, 1, alle.length, 3).setNumberFormat("@");
  alle.forEach(r => { r[0] = r[0] instanceof Date ? Utilities.formatDate(r[0], "Europe/Berlin", "yyyy-MM") : String(r[0]); });
  sh.getRange(1, 1, alle.length, header.length).setValues(alle);
  sh.getRange(1, 1, 1, header.length).setFontWeight("bold");
  sh.setFrozenRows(1);
  return neu.length;
}

/** Robuster CSV-Leser: Anführungszeichen, Zeilenumbrüche in Feldern, Trenner ; , oder Tab. */
function csvLesen(text, t) {
  const rows = []; let row = []; let f = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"' && f.trim() === "") { q = true; f = ""; }
    else if (c === t) { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(f); rows.push(row); row = []; f = "";
    } else f += c;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  return rows.map(r => r.map(v => v.trim()));
}
