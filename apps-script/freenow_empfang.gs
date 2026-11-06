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
    const n = freenowSchreiben(body.csv, body.datei || "");
    return antwort({ ok: true, zeilen: n, tab: FN_TAB });
  } catch (err) {
    return antwort({ ok: false, fehler: String(err && err.message || err).slice(0, 300) });
  }
}

function antwort(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function freenowSchreiben(csvText, datei) {
  const text = String(csvText).replace(/^﻿/, "");
  const ersteZeile = text.split(/\r?\n/)[0] || "";
  const trenner = (ersteZeile.match(/;/g) || []).length > (ersteZeile.match(/,/g) || []).length ? ";" : ",";
  const zeilen = Utilities.parseCsv(text, trenner).filter(r => r.some(c => String(c).trim() !== ""));
  if (zeilen.length < 1) return 0;
  const kopf = zeilen[0].map(String);
  const daten = zeilen.slice(1);

  const jetzt = new Date();
  const monat = Utilities.formatDate(jetzt, "Europe/Berlin", "yyyy-MM");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(FN_TAB) || ss.insertSheet(FN_TAB);
  const header = ["Monat", "Abgerufen am", "Datei"].concat(kopf);

  // Vorhandene Zeilen anderer Monate behalten (nach Spaltennamen zugeordnet)
  let alt = [];
  if (sh.getLastRow() > 1) {
    const v = sh.getDataRange().getValues();
    const altKopf = v[0].map(String);
    alt = v.slice(1).filter(r => String(r[0]) !== monat).map(r => header.map(h => { const i = altKopf.indexOf(h); return i >= 0 ? r[i] : ""; }));
  }
  const neu = daten.map(r => [monat, jetzt, datei].concat(kopf.map((_, i) => r[i] !== undefined ? r[i] : "")));
  const alle = [header].concat(alt, neu);
  sh.clearContents();
  sh.getRange(1, 1, alle.length, header.length).setValues(alle);
  sh.getRange(1, 1, 1, header.length).setFontWeight("bold");
  sh.setFrozenRows(1);
  return neu.length;
}
