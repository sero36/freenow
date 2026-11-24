/**
 * Bolt-Abruf über die offizielle Bolt Fleet API – mit echter Provision je Fahrt.
 * Alle Namen haben das Präfix fcb/FCB bzw. flottenBolt…, damit sie nicht mit anderen Bolt-Skripten im selben Projekt kollidieren.
 *
 * Schreibt alle Fahrten in das Blatt „Bolt API“ der Tabelle „automatik“ (Spalten unten).
 * Das Flottencockpit liest dieses Blatt bevorzugt; die Provision wird dann nicht mehr geschätzt.
 *
 * EINRICHTUNG (einmalig, im Apps-Script-Projekt der Tabelle „automatik“ oder eigenständig):
 *  1. Diese Datei als neue Skriptdatei einfügen.
 *  2. Projekteinstellungen → Script-Eigenschaften:
 *       BOLT_V1_CLIENT_ID     = Kunden-ID des v1-Schlüssels (Bolt Fleet Portal → API-Verbindungen)
 *       BOLT_V1_CLIENT_SECRET = Passwort des v1-Schlüssels
 *       (eigene Namen, damit der v2-Abruf mit BOLT_CLIENT_ID/BOLT_CLIENT_SECRET unberührt bleibt)
 *       BOLT_COMPANY_ID     = Bolt-Firmen-ID (mehrere mit Komma trennen); leer = alle freigegebenen Firmen
 *     (optional) BOLT_SHEET_ID = ID der Zieltabelle, Standard: Tabelle „automatik“
 *     Weitere Bolt-Zugänge (z. B. HDP Drive Plus): BOLT_V1_CLIENT_ID_2 + BOLT_V1_CLIENT_SECRET_2 (optional BOLT_COMPANY_ID_2),
 *     ein dritter mit _3 usw. – alle landen im selben Blatt, die Spalte „Firma“ zeigt, woher die Fahrt kommt.
 *     Zugangsdaten NUR hier eintragen – nicht in ein Tabellenblatt und nicht in den Code.
 *  3. Funktion flottenBoltEinrichten() einmal ausführen (Berechtigungen bestätigen).
 *     → lädt Vormonat + laufenden Monat nach und legt einen täglichen Abruf (ca. 6 Uhr) an.
 *
 * Quelle der Schnittstelle: developer.bolt.eu/fleet-integration (Fleet API, OAuth Client Credentials).
 */

var FCB_TOKEN_URL = 'https://oidc.bolt.eu/token';
var FCB_API = 'https://node.bolt.eu/fleet-integration-gateway/fleetIntegration/v1/';
var FCB_STANDARD_SHEET = '1QOxY10TAa05cjQzmvwUXHZ2XzoY54b208Zh7xX4uqpg'; // „automatik“
var FCB_TAB = 'Bolt API';
var FCB_KOPF = ['Auftrags-Nr', 'Datum', 'Fahrer', 'Fahrer-UUID', 'Status', 'Zahlungsart', 'Kategorie',
  'Bestellt', 'Abholung', 'Ende', 'km', 'Kennzeichen', 'Fahrpreis', 'Trinkgeld', 'Provision', 'Netto',
  'Buchungsgebühr', 'Maut', 'Stornogebühr', 'Rabatt bar', 'Rabatt App', 'Firma', 'Abgerufen am'];

/** Einmal ausführen: Nachladen (Vormonat + laufender Monat) und täglichen Abruf anlegen. */
function flottenBoltEinrichten() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'flottenBoltTaeglich') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('flottenBoltTaeglich').timeBased().everyDays(1).atHour(6).create();
  flottenBoltNachladen();
}

/** Täglich: die letzten 4 Tage neu laden (Preise werden bei Bolt teils nachträglich korrigiert). */
function flottenBoltTaeglich() {
  var jetzt = Math.floor(Date.now() / 1000);
  fcbLaden_(jetzt - 4 * 86400, jetzt);
}

/** Vormonat + laufenden Monat komplett laden (z. B. nach der Einrichtung oder zum Reparieren). */
function flottenBoltNachladen() {
  var d = new Date();
  var start = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  fcbLaden_(Math.floor(start.getTime() / 1000), Math.floor(Date.now() / 1000));
}

function fcbLaden_(startTs, endTs) {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty('BOLT_SHEET_ID') || FCB_STANDARD_SHEET;
  var status = {zeit: new Date(), ergebnis: 'OK', details: ''};
  try {
    // Mehrere Bolt-Zugänge möglich (z. B. Taxi und HDP Drive Plus): BOLT_V1_CLIENT_ID / _2 / _3 …
    var alle = [], zugaenge = [], fehlerZ = [];
    fcbKonten_().forEach(function (sfx) {
      FCB_KONTO = sfx;
      try {
        var token = fcbToken_();
        var eigene = String(props.getProperty('BOLT_COMPANY_ID' + sfx) || '').split(/[,;\s]+/).map(function (x) { return x.trim(); }).filter(function (x) { return /^\d+$/.test(x); }).map(Number);
        var firmen = eigene.length ? eigene : fcbFirmen_(token);
        if (!firmen.length) throw new Error('Zugang' + (sfx || ' 1') + ' hat keine Firma freigegeben.');
        firmen.forEach(function (cid) {
          // Bolt erlaubt höchstens 31 Tage je Abfrage → in 30-Tage-Stücken laden
          for (var a = startTs; a < endTs; a += 30 * 86400) {
            var b = Math.min(endTs, a + 30 * 86400);
            alle = alle.concat(fcbFahrten_(token, cid, a, b));
          }
        });
        zugaenge.push({sfx: sfx, token: token, firmen: firmen});
      } catch (ez) { fehlerZ.push('Zugang' + (sfx || ' 1') + ': ' + String(ez && ez.message || ez).slice(0, 150)); }
    });
    FCB_KONTO = '';
    if (!zugaenge.length) throw new Error(fehlerZ.join(' | ') || 'Kein Bolt-Zugang eingerichtet.');
    var n = fcbSchreiben_(sheetId, alle);
    var nFirmen = zugaenge.reduce(function (s0, z) { return s0 + z.firmen.length; }, 0);
    status.details = alle.length + ' Fahrten geladen, ' + n.neu + ' neu, ' + n.aktualisiert + ' aktualisiert (' + zugaenge.length + ' Zugang/Zugänge, ' + nFirmen + ' Firma/Firmen)' + (fehlerZ.length ? ' · ACHTUNG ' + fehlerZ.join(' | ') : '');
    try { var nk = fcbKontakte_(zugaenge, sheetId, alle); status.details += ' · ' + nk + ' Fahrer-Kontakte'; } catch (ek) { Logger.log('Fahrer-Kontakte nicht geladen: ' + ek); }
  } catch (e) {
    status.ergebnis = 'FEHLER';
    status.details = String(e && e.message || e).slice(0, 400);
    Logger.log(status.details);
  }
  fcbStatus_(sheetId, status);
  if (status.ergebnis !== 'OK') throw new Error('Bolt-Abruf: ' + status.details);
}

/** Fehlersuche: zeigt im Ausführungsprotokoll, was Bolt zum Zugang sagt (ohne Geheimnisse auszugeben). */
function flottenBoltTest() {
  var props = PropertiesService.getScriptProperties();
  var id = String(props.getProperty('BOLT_V1_CLIENT_ID' + FCB_KONTO) || ''), secret = String(props.getProperty('BOLT_V1_CLIENT_SECRET' + FCB_KONTO) || '');
  Logger.log('Bolt-Zugang ' + (FCB_KONTO || '1 (ohne Endung)'));
  Logger.log('BOLT_V1_CLIENT_ID: ' + (id ? id.length + ' Zeichen' + (id !== id.trim() ? ' – ACHTUNG Leerzeichen am Anfang/Ende!' : '') : 'FEHLT'));
  Logger.log('BOLT_V1_CLIENT_SECRET: ' + (secret ? secret.length + ' Zeichen' + (secret !== secret.trim() ? ' – ACHTUNG Leerzeichen am Anfang/Ende!' : '') : 'FEHLT'));
  Logger.log('BOLT_COMPANY_ID' + FCB_KONTO + ': ' + (props.getProperty('BOLT_COMPANY_ID' + FCB_KONTO) || '(leer)'));
  CacheService.getScriptCache().remove('fcb_token' + FCB_KONTO);
  var r = UrlFetchApp.fetch(FCB_TOKEN_URL, {method: 'post', muteHttpExceptions: true,
    payload: {client_id: id.trim(), client_secret: secret.trim(), grant_type: 'client_credentials', scope: 'fleet-integration:api'}});
  Logger.log('Token-Antwort HTTP ' + r.getResponseCode());
  var j = {}; try { j = JSON.parse(r.getContentText()); } catch (e) { Logger.log('Token-Antwort nicht lesbar: ' + r.getContentText().slice(0, 200)); return; }
  if (!j.access_token) { Logger.log('Kein Token: ' + JSON.stringify(j).slice(0, 300)); return; }
  Logger.log('Token erhalten · token_type=' + j.token_type + ' · scope=' + j.scope + ' · expires_in=' + j.expires_in);
  try { var teil = j.access_token.split('.')[1]; if (teil) { var pl = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(teil + '==='.slice((teil.length + 3) % 4))).getDataAsString());
    Logger.log('Token-Inhalt · scope=' + (pl.scope || pl.scp) + ' · aud=' + pl.aud + ' · iss=' + pl.iss + ' · exp=' + (pl.exp ? new Date(pl.exp * 1000) : '')); } } catch (e) { Logger.log('Token ist kein JWT (ok).'); }
  ['getCompanies'].forEach(function (pfad) {
    var rr = UrlFetchApp.fetch(FCB_API + pfad, {method: 'get', muteHttpExceptions: true, headers: {Authorization: 'Bearer ' + j.access_token}});
    Logger.log(pfad + ' → HTTP ' + rr.getResponseCode() + ' · ' + rr.getContentText().slice(0, 300));
  });
  var cid = Number(String(props.getProperty('BOLT_COMPANY_ID' + FCB_KONTO) || '').split(/[,;\s]+/)[0]) || null;
  if (cid) {
    var jetzt = Math.floor(Date.now() / 1000);
    var r2 = UrlFetchApp.fetch(FCB_API + 'getFleetOrders', {method: 'post', muteHttpExceptions: true, contentType: 'application/json', headers: {Authorization: 'Bearer ' + j.access_token},
      payload: JSON.stringify({company_id: cid, company_ids: [cid], start_ts: jetzt - 86400, end_ts: jetzt, limit: 5, offset: 0})});
    var t2 = r2.getContentText(); var j2 = {}; try { j2 = JSON.parse(t2); } catch (e) {}
    Logger.log('getFleetOrders (Firma ' + cid + ', letzte 24 h) → HTTP ' + r2.getResponseCode() + ' · code=' + j2.code + ' ' + (j2.message || '') + (j2.data ? ' · ' + ((j2.data.orders || []).length) + ' Fahrten, Firma: ' + j2.data.company_name : '') + (j2.error_hint ? ' · hint ' + j2.error_hint : ''));
  }
}

var FCB_KONTO = ''; // '' = erster Zugang, '_2' = zweiter Zugang (z. B. HDP Drive Plus) …
/** Welche Bolt-Zugänge eingerichtet sind: BOLT_V1_CLIENT_ID, BOLT_V1_CLIENT_ID_2, _3 … */
function fcbKonten_() {
  var props = PropertiesService.getScriptProperties(), out = [];
  ['', '_2', '_3', '_4'].forEach(function (sfx) { if (props.getProperty('BOLT_V1_CLIENT_ID' + sfx) && props.getProperty('BOLT_V1_CLIENT_SECRET' + sfx)) out.push(sfx); });
  return out.length ? out : [''];
}
/** Fehlersuche für den zweiten Bolt-Zugang (HDP Drive Plus): Werte mit Endung _2. */
function flottenBoltTest2() { FCB_KONTO = '_2'; try { flottenBoltTest(); } finally { FCB_KONTO = ''; } }
function fcbToken_() {
  var cache = CacheService.getScriptCache();
  var t = cache.get('fcb_token' + FCB_KONTO);
  if (t) return t;
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('BOLT_V1_CLIENT_ID' + FCB_KONTO), secret = props.getProperty('BOLT_V1_CLIENT_SECRET' + FCB_KONTO);
  if (!id || !secret) throw new Error('Script-Eigenschaften BOLT_V1_CLIENT_ID' + FCB_KONTO + ' und BOLT_V1_CLIENT_SECRET' + FCB_KONTO + ' fehlen.');
  var r = UrlFetchApp.fetch(FCB_TOKEN_URL, {
    method: 'post', muteHttpExceptions: true,
    payload: {client_id: String(id).trim(), client_secret: String(secret).trim(), grant_type: 'client_credentials', scope: 'fleet-integration:api'}
  });
  if (r.getResponseCode() !== 200) throw new Error('Bolt-Anmeldung fehlgeschlagen (HTTP ' + r.getResponseCode() + '): ' + r.getContentText().slice(0, 200));
  var j = JSON.parse(r.getContentText());
  if (!j.access_token) throw new Error('Bolt-Anmeldung: kein Token erhalten.');
  cache.put('fcb_token' + FCB_KONTO, j.access_token, Math.max(60, Math.min(540, (j.expires_in || 600) - 60))); // Token gilt 10 Minuten
  return j.access_token;
}

function fcbAufruf_(token, pfad, body) {
  for (var versuch = 0; versuch < 5; versuch++) {
    var opt = {method: body ? 'post' : 'get', muteHttpExceptions: true, headers: {Authorization: 'Bearer ' + token}};
    if (body) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(body); }
    var r = UrlFetchApp.fetch(FCB_API + pfad, opt);
    var http = r.getResponseCode();
    if (http === 429) { Utilities.sleep(2000 * (versuch + 1)); continue; } // TOO_MANY_REQUESTS
    var j;
    try { j = JSON.parse(r.getContentText()); } catch (e) { throw new Error(pfad + ': keine gültige Antwort (HTTP ' + http + ')'); }
    if (j.code === 0) return j.data;
    if (j.code === 503 && versuch === 0) { CacheService.getScriptCache().remove('fcb_token' + FCB_KONTO); token = fcbToken_(); continue; } // Token abgelaufen
    if (j.code === 999 && versuch < 4) { Utilities.sleep(3000); continue; } // SERVER_ERROR → später nochmal
    throw new Error(pfad + ': ' + j.code + ' ' + j.message + (j.error_hint ? ' (' + j.error_hint + ')' : ''));
  }
  throw new Error(pfad + ': zu viele Anfragen, bitte später erneut versuchen.');
}

function fcbFirmen_(token) {
  var d = fcbAufruf_(token, 'getCompanies', null);
  return (d && d.company_ids) || [];
}

function fcbFahrten_(token, companyId, startTs, endTs) {
  var aus = [], offset = 0, limit = 1000;
  while (true) {
    var d = fcbAufruf_(token, 'getFleetOrders', {company_id: companyId, company_ids: [companyId], start_ts: startTs, end_ts: endTs, limit: limit, offset: offset});
    var L = (d && d.orders) || [];
    L.forEach(function (o) { o.__firma = d.company_name || String(companyId); });
    aus = aus.concat(L);
    if (L.length < limit) break;
    offset += limit;
    if (offset > 50000) break; // Sicherheitsgrenze
  }
  return aus;
}

function fcbZeit_(ts) {
  return ts ? Utilities.formatDate(new Date(ts * 1000), 'Europe/Berlin', 'dd.MM.yyyy HH:mm') : '';
}
function fcbZahl_(v) { return (v === null || v === undefined || v === '') ? '' : Number(v); }

function fcbZeile_(o, jetzt) {
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
    fcbZeit_(o.order_created_timestamp),
    fcbZeit_(o.order_pickup_timestamp),
    fcbZeit_(o.order_finished_timestamp || o.order_drop_off_timestamp),
    o.ride_distance != null ? Math.round(o.ride_distance / 10) / 100 : '', // Meter → km
    o.vehicle_license_plate || '',
    fcbZahl_(p.ride_price),
    fcbZahl_(p.tip),
    fcbZahl_(p.commission),
    fcbZahl_(p.net_earnings),
    fcbZahl_(p.booking_fee),
    fcbZahl_(p.toll_fee),
    fcbZahl_(p.cancellation_fee),
    fcbZahl_(p.cash_discount),
    fcbZahl_(p.in_app_discount),
    o.__firma || '',
    jetzt
  ];
}

/** Schreibt/aktualisiert Fahrten anhand der Auftrags-Nr (keine Doppelten). */
function fcbSchreiben_(sheetId, orders) {
  var ss = SpreadsheetApp.openById(sheetId);
  var sh = ss.getSheetByName(FCB_TAB) || ss.insertSheet(FCB_TAB);
  if (sh.getLastRow() === 0) { sh.appendRow(FCB_KOPF); sh.setFrozenRows(1); }
  var kopf = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  if (kopf.join('|') !== FCB_KOPF.join('|')) { sh.getRange(1, 1, 1, FCB_KOPF.length).setValues([FCB_KOPF]); }
  var n = sh.getLastRow() - 1;
  var vorhanden = {};
  if (n > 0) sh.getRange(2, 1, n, 1).getValues().forEach(function (r, i) { if (r[0]) vorhanden[String(r[0])] = i + 2; });
  var jetzt = Utilities.formatDate(new Date(), 'Europe/Berlin', 'dd.MM.yyyy HH:mm');
  var neu = [], aktualisiert = 0, gesehen = {};
  orders.forEach(function (o) {
    var ref = String(o.order_reference || '');
    if (!ref || gesehen[ref]) return; gesehen[ref] = true;
    var z = fcbZeile_(o, jetzt);
    if (vorhanden[ref]) { sh.getRange(vorhanden[ref], 1, 1, z.length).setValues([z]); aktualisiert++; }
    else neu.push(z);
  });
  if (neu.length) sh.getRange(sh.getLastRow() + 1, 1, neu.length, FCB_KOPF.length).setValues(neu);
  try { fcbRohSpeichern_(orders, jetzt); } catch (e) { Logger.log('Rohdaten nicht gespeichert (Fahrten sind gespeichert): ' + e); }
  // Text-Spalten als Text, Beträge als Zahl – verhindert, dass Sheets Beträge in Datumsangaben verwandelt
  sh.getRange(2, 13, Math.max(1, sh.getLastRow() - 1), 9).setNumberFormat('0.00');
  return {neu: neu.length, aktualisiert: aktualisiert};
}

function fcbStatus_(sheetId, s) {
  try {
    var ss = SpreadsheetApp.openById(sheetId);
    var sh = ss.getSheetByName('Bolt API Status') || ss.insertSheet('Bolt API Status');
    sh.clear();
    sh.getRange(1, 1, 2, 3).setValues([['Zeitpunkt', 'Ergebnis', 'Details'], [s.zeit, s.ergebnis, s.details]]);
  } catch (e) { Logger.log('Status konnte nicht geschrieben werden: ' + e); }
}


/**
 * Rohdaten: komplette Antwort von Bolt je Fahrt in einer EIGENEN Tabelle „Flottencockpit Bolt Rohdaten“
 * (wird beim ersten Lauf in deinem Drive angelegt). Nichts geht verloren, die Tabelle, die die App lädt, bleibt schnell.
 */
function fcbRohSpeichern_(orders, jetzt) {
  if (!orders || !orders.length) return;
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('BOLT_ROH_SHEET'), ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) { ss = SpreadsheetApp.create('Flottencockpit Bolt Rohdaten'); props.setProperty('BOLT_ROH_SHEET', ss.getId()); }
  var sh = ss.getSheets()[0];
  if (sh.getLastRow() === 0) { sh.appendRow(['Auftrags-Nr', 'Fahrer', 'Abgerufen am', 'Roh-JSON']); sh.setFrozenRows(1); }
  var n = sh.getLastRow() - 1, index = {};
  if (n > 0) sh.getRange(2, 1, n, 1).getValues().forEach(function (r, i) { if (r[0]) index[String(r[0])] = i + 2; });
  var neu = [], gesehen = {};
  orders.forEach(function (o) {
    var ref = String(o.order_reference || ''); if (!ref || gesehen[ref]) return; gesehen[ref] = true;
    var z = [ref, o.driver_name || '', jetzt, JSON.stringify(o).slice(0, 45000)];
    if (index[ref]) sh.getRange(index[ref], 1, 1, 4).setValues([z]); else neu.push(z);
  });
  if (neu.length) sh.getRange(sh.getLastRow() + 1, 1, neu.length, 4).setValues(neu);
}


/**
 * Fahrer-Kontakte (E-Mail, Telefon) für die Personalakten: Bolt-Fahrerliste (getDrivers) und – falls dort nichts
 * steht – die Telefonnummer aus den Fahrten. Schreibt das Blatt „Fahrer Kontakte“ (ohne „Bolt“ im Namen, damit es
 * nicht als Fahrtenblatt gelesen wird). Die App trägt daraus NUR fehlende Angaben in die Mitarbeiterakte ein.
 */
var FCB_KONTAKT_TAB = 'Fahrer Kontakte';
function fcbKontakte_(zugaenge, sheetId, orders) {
  var map = {}; // Schlüssel: UUID oder Name
  function setz(k, o) { if (!k) return; var m = map[k] || (map[k] = {}); Object.keys(o).forEach(function (x) { if (o[x] && !m[x]) m[x] = o[x]; }); }
  var jetzt = Math.floor(Date.now() / 1000);
  zugaenge.forEach(function (zg) { FCB_KONTO = zg.sfx; var token = zg.token; zg.firmen.forEach(function (cid) {
    for (var offset = 0; offset < 5000; offset += 500) {
      var d;
      try { d = fcbAufruf_(token, 'getDrivers', {company_id: cid, company_ids: [cid], start_ts: jetzt - 365 * 86400, end_ts: jetzt, limit: 500, offset: offset}); }
      catch (e) { Logger.log('getDrivers (Firma ' + cid + '): ' + e); break; }
      var L = (d && (d.drivers || d.list || d.items)) || [];
      L.forEach(function (x) {
        var name = [x.first_name, x.last_name].filter(Boolean).join(' ') || x.name || x.driver_name || '';
        setz(x.driver_uuid || x.uuid || name, {name: name, email: x.email || '', telefon: x.phone || x.phone_number || '', uuid: x.driver_uuid || x.uuid || '',
          status: x.state || x.status || x.portal_status || '', firma: (d && d.company_name) || String(cid)});
      });
      if (L.length < 500) break;
    }
  }); });
  FCB_KONTO = '';
  (orders || []).forEach(function (o) {
    if (!o.driver_name && !o.driver_uuid) return;
    setz(o.driver_uuid || o.driver_name, {name: o.driver_name || '', telefon: o.driver_phone || '', uuid: o.driver_uuid || '', firma: o.__firma || ''});
  });
  var z = Object.keys(map).map(function (k) { var m = map[k]; return [m.name || '', m.email || '', m.telefon ? "'" + m.telefon : '', m.uuid || '', m.status || '', m.firma || '', 'Bolt']; })
    .filter(function (r) { return r[0] && (r[1] || r[2]); });
  var ss = SpreadsheetApp.openById(sheetId);
  var sh = ss.getSheetByName(FCB_KONTAKT_TAB) || ss.insertSheet(FCB_KONTAKT_TAB);
  sh.clear();
  sh.getRange(1, 1, 1, 7).setValues([['Name', 'E-Mail', 'Telefon', 'Fahrer-UUID', 'Status', 'Firma', 'Quelle']]);
  sh.setFrozenRows(1);
  if (z.length) sh.getRange(2, 1, z.length, 7).setValues(z);
  return z.length;
}
