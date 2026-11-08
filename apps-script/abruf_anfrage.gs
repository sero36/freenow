/**
 * Flottencockpit – „Jetzt neu abrufen“
 *
 * Die App legt beim Tippen auf „Jetzt neu abrufen“ in deinem Google Drive eine kleine Datei
 * „Flottencockpit Abruf-Anfrage“ an. Dieses Script schaut alle 5 Minuten nach so einer Datei,
 * löscht sie und startet dann sofort die Abrufe:
 *   - TaxiFusion  (tfTaeglichLaden, aus taxifusion_import.gs)
 *   - iZettle     (ladeZettleDaten, aus zettle_import.gs)
 *   - Bolt        (boltTaeglichLaden, aus bolt_import.gs – falls vorhanden)
 *   - FREENOW     (startet den GitHub-Abruf; braucht GITHUB_TOKEN, siehe unten)
 * Das Ergebnis steht im Tab „Abruf Status“ der Tabelle „Umsatzdaten App“ – die App zeigt es an.
 *
 * Einrichten (einmalig):
 *   1. Diese Datei im selben Apps-Script-Projekt wie taxifusion_import.gs / zettle_import.gs anlegen.
 *   2. Funktion abrufAnfrageEinrichten einmal ausführen (legt den 5-Minuten-Auslöser an).
 *   3. Nur für FREENOW: unter Projekteinstellungen → Script-Eigenschaften
 *      GITHUB_TOKEN = ein GitHub-Token mit Recht „Actions: Read and write“ für das Repo sero36/freenow.
 *      (Den Token nur dort eintragen – niemals in einen Chat oder in die App.)
 *      Optional: GITHUB_REPO (Standard „sero36/freenow“), GITHUB_REF (Standard „main“).
 */

const ABRUF_DATEINAME = "Flottencockpit Abruf-Anfrage";

function abrufAnfrageEinrichten() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === "abrufAnfragePruefen")
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("abrufAnfragePruefen").timeBased().everyMinutes(5).create();
}

function abrufAnfragePruefen() {
  const it = DriveApp.searchFiles('title contains "' + ABRUF_DATEINAME + '" and trashed = false');
  const dateien = [];
  while (it.hasNext()) dateien.push(it.next());
  if (!dateien.length) return;
  dateien.forEach(f => { try { f.setTrashed(true); } catch (e) {} });

  const log = [];
  const lauf = (name, fn) => {
    try { fn(); log.push(name + ": OK"); }
    catch (e) { log.push(name + ": " + (e && e.message ? e.message : e)); }
  };
  if (typeof tfTaeglichLaden === "function") lauf("TaxiFusion", tfTaeglichLaden);
  if (typeof ladeZettleDaten === "function") lauf("iZettle", ladeZettleDaten);
  if (typeof boltTaeglichLaden === "function") lauf("Bolt", boltTaeglichLaden);
  lauf("FREENOW", freenowGithubStarten);
  abrufStatusSchreiben(log.join(" · "));
}

function freenowGithubStarten() {
  const p = PropertiesService.getScriptProperties();
  const token = p.getProperty("GITHUB_TOKEN");
  if (!token) throw new Error("nicht gestartet – GITHUB_TOKEN fehlt in den Script-Eigenschaften");
  const repo = p.getProperty("GITHUB_REPO") || "sero36/freenow";
  const ref = p.getProperty("GITHUB_REF") || "main";
  const r = UrlFetchApp.fetch("https://api.github.com/repos/" + repo + "/actions/workflows/freenow.yml/dispatches", {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" },
    payload: JSON.stringify({ ref: ref }),
    muteHttpExceptions: true,
  });
  if (r.getResponseCode() >= 300) throw new Error("GitHub antwortet " + r.getResponseCode());
  // Der FREENOW-Abruf läuft danach auf GitHub (ca. 3–5 Minuten) und schreibt selbst in die Tabelle.
}

function abrufStatusSchreiben(text) {
  const ss = (typeof tfZielTabelle === "function") ? tfZielTabelle() : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) return;
  const st = ss.getSheetByName("Abruf Status") || ss.insertSheet("Abruf Status");
  st.clear();
  st.getRange(1, 1, 2, 2).setValues([["Zeitpunkt", "Ergebnis"], [new Date(), text]]);
  st.getRange(2, 1).setNumberFormat("dd.MM.yyyy HH:mm");
}
