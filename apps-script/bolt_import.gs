/**
 * Bolt-Abruf über die offizielle Bolt Fleet API – mit echter Provision je Fahrt.
 *
 * Schreibt alle Fahrten in das Blatt „Bolt API“ der Tabelle „automatik“ (Spalten unten).
 * Das Flottencockpit liest dieses Blatt bevorzugt; die Provision wird dann nicht mehr geschätzt.
 *
 * EINRICHTUNG (einmalig, im Apps-Script-Projekt der Tabelle „automatik“ oder eigenständig):
 *  1. Diese Datei als neue Skriptdatei einfügen.
 *  2. Projekteinstellungen → Script-Eigenschaften:
 *       BOLT_CLIENT_ID      = Client-ID aus dem Bolt Fleet Portal (API-Zugang)
 *       BOLT_CLIENT_SECRET  = Client-Secret
 *     (optional) BOLT_SHEET_ID = ID der Zieltabelle, Standard: Tabelle „automatik“
 *     Zugangsdaten NUR hier eintragen – nicht in ein Tabellenblatt und nicht in den Code.
 *  3. Funktion boltApiEinrichten() einmal ausführen (Berechtigungen bestätigen).
 *     → lädt Vormonat + laufenden Monat nach und legt einen täglichen Abruf (ca. 6 Uhr) an.
 *
 * Quelle der Schnittstelle: developer.bolt.eu/fleet-integration (Fleet API, OAuth Client Credentials).
 */

var BOLT_TOKEN_URL = 'https://oidc.bolt.eu/token';
var BOLT_API = 'https://node.bolt.eu/fleet-integration-gateway/fleetIntegration/v1/';
var BOLT_STANDARD_SHEET = '1QOxY10TAa05cjQzmvwUXHZ2XzoY54b208Zh7xX4uqpg'; // „automatik“
var BOLT_TAB = 'Bolt API';
var BOLT_KOPF = ['Auftrags-Nr', 'Datum', 'Fahrer', 'Fahrer-UUID', 'Status', 'Zahlungsart', 'Kategorie',
  'Bestellt', 'Abholung', 'Ende', 'km', 'Kennzeichen', 'Fahrpreis', 'Trinkgeld', 'Provision', 'Netto',
  'Buchungsgebühr', 'Maut', 'Stornogebühr', 'Rabatt bar', 'Rabatt App', 'Firma', 'Abgerufen am'];

/** Einmal ausführen: Nachladen (Vormonat + laufender Monat) und täglichen Abruf anlegen. */
function boltApiEinrichten() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'boltApiTaeglich') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('boltApiTaeglich').timeBased().everyDays(1).atHour(6).create();
  boltApiNachladen();
}

/** Täglich: die letzten 4 Tage neu laden (Preise werden bei Bolt teils nachträglich korrigiert). */
function boltApiTaeglich() {
  var jetzt = Math.floor(Date.now() / 1000);
  boltApiLaden_(jetzt - 4 * 86400, jetzt);
}

/** Vormonat + laufenden Monat komplett laden (z. B. nach der Einrichtung oder zum Reparieren). */
function boltApiNachladen() {
  var d = new Date();
  var start = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  boltApiLaden_(Math.floor(start.getTime() / 1000), Math.floor(Date.now() / 1000));
}

function boltApiLaden_(startTs, endTs) {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty('BOLT_SHEET_ID') || BOLT_STANDARD_SHEET;
  var status = {zeit: new Date(), ergebnis: 'OK', details: ''};
  try {
    var token = boltToken_();
    var firmen = boltFirmen_(token);
    if (!firmen.length) throw new Error('Der API-Zugang hat keine Firma freigegeben.');
    var alle = [];
    firmen.forEach(function (cid) {
      // Bolt erlaubt höchstens 31 Tage je Abfrage → in 30-Tage-Stücken laden
      for (var a = startTs; a < endTs; a += 30 * 86400) {
        var b = Math.min(endTs, a + 30 * 86400);
        alle = alle.concat(boltFahrten_(token, cid, a, b));
      }
    });
    var n = boltSchreiben_(sheetId, alle);
    status.details = alle.length + ' Fahrten geladen, ' + n.neu + ' neu, ' + n.aktualisiert + ' aktualisiert (' + firmen.length + ' Firma/Firmen)';
  } catch (e) {
    status.ergebnis = 'FEHLER';
    status.details = String(e && e.message || e).slice(0, 400);
    Logger.log(status.details);
  }
  boltStatus_(sheetId, status);
  if (status.ergebnis !== 'OK') throw new Error('Bolt-Abruf: ' + status.details);
}

function boltToken_() {
  var cache = CacheService.getScriptCache();
  var t = cache.get('bolt_token');
  if (t) return t;
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('BOLT_CLIENT_ID'), secret = props.getProperty('BOLT_CLIENT_SECRET');
  if (!id || !secret) throw new Error('Script-Eigenschaften BOLT_CLIENT_ID und BOLT_CLIENT_SECRET fehlen.');
  var r = UrlFetchApp.fetch(BOLT_TOKEN_URL, {
    method: 'post', muteHttpExceptions: true,
    payload: {client_id: id, client_secret: secret, grant_type: 'client_credentials', scope: 'fleet-integration:api'}
  });
  if (r.getResponseCode() !== 200) throw new Error('Bolt-Anmeldung fehlgeschlagen (HTTP ' + r.getResponseCode() + '): ' + r.getContentText().slice(0, 200));
  var j = JSON.parse(r.getContentText());
  if (!j.access_token) throw new Error('Bolt-Anmeldung: kein Token erhalten.');
  cache.put('bolt_token', j.access_token, Math.max(60, Math.min(540, (j.expires_in || 600) - 60))); // Token gilt 10 Minuten
  return j.access_token;
}

function boltAufruf_(token, pfad, body) {
  for (var versuch = 0; versuch < 5; versuch++) {
    var opt = {method: body ? 'post' : 'get', muteHttpExceptions: true, headers: {Authorization: 'Bearer ' + token}};
    if (body) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(body); }
    var r = UrlFetchApp.fetch(BOLT_API + pfad, opt);
    var http = r.getResponseCode();
    if (http === 429) { Utilities.sleep(2000 * (versuch + 1)); continue; } // TOO_MANY_REQUESTS
    var j;
    try { j = JSON.parse(r.getContentText()); } catch (e) { throw new Error(pfad + ': keine gültige Antwort (HTTP ' + http + ')'); }
    if (j.code === 0) return j.data;
    if (j.code === 503 && versuch === 0) { CacheService.getScriptCache().remove('bolt_token'); token = boltToken_(); continue; } // Token abgelaufen
    if (j.code === 999 && versuch < 4) { Utilities.sleep(3000); continue; } // SERVER_ERROR → später nochmal
    throw new Error(pfad + ': ' + j.code + ' ' + j.message + (j.error_hint ? ' (' + j.error_hint + ')' : ''));
  }
  throw new Error(pfad + ': zu viele Anfragen, bitte später erneut versuchen.');
}

function boltFirmen_(token) {
  var d = boltAufruf_(token, 'getCompanies', null);
  return (d && d.company_ids) || [];
}

function boltFahrten_(token, companyId, startTs, endTs) {
  var aus = [], offset = 0, limit = 1000;
  while (true) {
    var d = boltAufruf_(token, 'getFleetOrders', {company_id: companyId, company_ids: [companyId], start_ts: startTs, end_ts: endTs, limit: limit, offset: offset});
    var L = (d && d.orders) || [];
    L.forEach(function (o) { o.__firma = d.company_name || String(companyId); });
    aus = aus.concat(L);
    if (L.length < limit) break;
    offset += limit;
    if (offset > 50000) break; // Sicherheitsgrenze
  }
  return aus;
}

function boltZeit_(ts) {
  return ts ? Utilities.formatDate(new Date(ts * 1000), 'Europe/Berlin', 'dd.MM.yyyy HH:mm') : '';
}
function boltZahl_(v) { return (v === null || v === undefined || v === '') ? '' : Number(v); }

function boltZeile_(o, jetzt) {
  var p = o.order_price || {};
  var t = o.order_finished_timestamp || o.order_drop_off_timestamp || o.order_created_timestamp;
  return [
    o.order_reference || '',
    t ? Utilities.formatDate(new Date(t * 1000), 'Europe/Berlin', 'yyyy-MM-dd') : '',
    o.driver_name || '',
    o.driver_uuid || '',
    o.order_status || '',
    o.payment_method || '',
    (o.category_info && o.category_info.name) || '',
    boltZeit_(o.order_created_timestamp),
    boltZeit_(o.order_pickup_timestamp),
    boltZeit_(o.order_finished_timestamp || o.order_drop_off_timestamp),
    o.ride_distance != null ? Math.round(o.ride_distance / 10) / 100 : '', // Meter → km
    o.vehicle_license_plate || '',
    boltZahl_(p.ride_price),
    boltZahl_(p.tip),
    boltZahl_(p.commission),
    boltZahl_(p.net_earnings),
    boltZahl_(p.booking_fee),
    boltZahl_(p.toll_fee),
    boltZahl_(p.cancellation_fee),
    boltZahl_(p.cash_discount),
    boltZahl_(p.in_app_discount),
    o.__firma || '',
    jetzt
  ];
}

/** Schreibt/aktualisiert Fahrten anhand der Auftrags-Nr (keine Doppelten). */
function boltSchreiben_(sheetId, orders) {
  var ss = SpreadsheetApp.openById(sheetId);
  var sh = ss.getSheetByName(BOLT_TAB) || ss.insertSheet(BOLT_TAB);
  if (sh.getLastRow() === 0) { sh.appendRow(BOLT_KOPF); sh.setFrozenRows(1); }
  var kopf = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  if (kopf.join('|') !== BOLT_KOPF.join('|')) { sh.getRange(1, 1, 1, BOLT_KOPF.length).setValues([BOLT_KOPF]); }
  var n = sh.getLastRow() - 1;
  var vorhanden = {};
  if (n > 0) sh.getRange(2, 1, n, 1).getValues().forEach(function (r, i) { if (r[0]) vorhanden[String(r[0])] = i + 2; });
  var jetzt = Utilities.formatDate(new Date(), 'Europe/Berlin', 'dd.MM.yyyy HH:mm');
  var neu = [], aktualisiert = 0, gesehen = {};
  orders.forEach(function (o) {
    var ref = String(o.order_reference || '');
    if (!ref || gesehen[ref]) return; gesehen[ref] = true;
    var z = boltZeile_(o, jetzt);
    if (vorhanden[ref]) { sh.getRange(vorhanden[ref], 1, 1, z.length).setValues([z]); aktualisiert++; }
    else neu.push(z);
  });
  if (neu.length) sh.getRange(sh.getLastRow() + 1, 1, neu.length, BOLT_KOPF.length).setValues(neu);
  // Text-Spalten als Text, Beträge als Zahl – verhindert, dass Sheets Beträge in Datumsangaben verwandelt
  sh.getRange(2, 13, Math.max(1, sh.getLastRow() - 1), 9).setNumberFormat('0.00');
  return {neu: neu.length, aktualisiert: aktualisiert};
}

function boltStatus_(sheetId, s) {
  try {
    var ss = SpreadsheetApp.openById(sheetId);
    var sh = ss.getSheetByName('Bolt API Status') || ss.insertSheet('Bolt API Status');
    sh.clear();
    sh.getRange(1, 1, 2, 3).setValues([['Zeitpunkt', 'Ergebnis', 'Details'], [s.zeit, s.ergebnis, s.details]]);
  } catch (e) { Logger.log('Status konnte nicht geschrieben werden: ' + e); }
}
