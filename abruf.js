/**
 * FREENOW-Abruf (läuft täglich in GitHub Actions)
 *
 * 1. Meldet sich im FREENOW-Unternehmensportal an
 * 2. Öffnet "Einnahmen"
 * 3. Lädt je Monat eine CSV-Datei herunter: laufender Monat + Vormonat
 *    (mit MONATE=6 z. B. die letzten 6 Monate, für das einmalige Nachladen)
 * 4. Schickt jede Datei an die Google-Tabelle (Apps-Script-Web-App)
 *
 * Benötigte Umgebungsvariablen (in GitHub unter Settings -> Secrets -> Actions):
 *   FREENOW_EMAIL, FREENOW_PASSWORT, SHEETS_WEBHOOK_URL, SHEETS_TOKEN
 */
const { chromium } = require("playwright");
const AdmZip = require("adm-zip");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "ausgabe");
fs.mkdirSync(OUT, { recursive: true });
const log = t => console.log(new Date().toISOString() + "  " + t);

function env(name, pflicht = true) {
  const v = process.env[name];
  if (pflicht && !v) throw new Error("Secret " + name + " fehlt (GitHub -> Settings -> Secrets and variables -> Actions)");
  return v;
}

async function anmelden(page) {
  log("Anmeldung …");
  await page.goto("https://portal.free-now.com/login", { waitUntil: "domcontentloaded" });
  const unternehmen = page.getByRole("button", { name: /^Unternehmen$/ });
  if (await unternehmen.count()) await unternehmen.first().click();
  await page.getByLabel(/E-Mail-Adresse/i).fill(env("FREENOW_EMAIL"));
  await page.getByLabel("Passwort", { exact: true }).fill(env("FREENOW_PASSWORT"));
  await page.getByRole("button", { name: /Einloggen/i }).click();
  await page.waitForURL(u => !String(u).includes("/login"), { timeout: 45000 });
  log("Angemeldet.");
}

async function downloadKnopf(page) {
  const kandidaten = [
    page.getByTestId("download-csv-file"),
    page.getByRole("button", { name: /CSV|herunterladen|download/i }),
    page.locator('[title*="CSV" i], [aria-label*="CSV" i], [aria-label*="herunterladen" i], [aria-label*="download" i]'),
    page.locator('xpath=//*[normalize-space(text())="Zeitraum"]/ancestor::*[self::div or self::fieldset][2]/following::button[1]'),
  ];
  for (const k of kandidaten) if (await k.count()) return k.first();
  throw new Error("Download-Knopf nicht gefunden");
}

const MONATSNAMEN = ["Januar","Februar","März","April","Mai","Juni","Juli","August","September","Oktober","November","Dezember"];
const zwei = n => String(n).padStart(2, "0");
const ddmmyyyy = d => zwei(d.getDate()) + "/" + zwei(d.getMonth() + 1) + "/" + d.getFullYear();

/** Liest alle sichtbaren Datumswerte (aus Eingabefeldern und Text). */
async function datumsWerte(page) {
  return page.evaluate(() => {
    const re = /\b\d{2}\/\d{2}\/\d{4}\b/g, out = [];
    document.querySelectorAll("input").forEach(i => { (i.value || "").replace(re, m => out.push(m)); });
    document.querySelectorAll("body *").forEach(e => { if (e.childElementCount === 0) (e.textContent || "").replace(re, m => out.push(m)); });
    return out;
  });
}

/** Schreibt den HTML-Aufbau rund um "Zeitraum" bzw. den Kalender ins Protokoll (zur Fehlersuche). */
async function aufbauProtokollieren(page, wo) {
  const html = await page.evaluate(() => {
    const blatt = [...document.querySelectorAll("body *")].filter(e => e.childElementCount === 0);
    const ziel = blatt.find(e => /^(Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember) \d{4}$/.test(e.textContent.trim()))
      || blatt.find(e => e.textContent.trim() === "Zeitraum");
    let a = ziel; for (let i = 0; i < 5 && a && a.parentElement; i++) a = a.parentElement;
    return a ? a.outerHTML.replace(/\s+/g, " ").replace(/<path[^>]*>/g, "").slice(0, 5000) : "(nichts gefunden)";
  }).catch(e => "(Fehler: " + e.message + ")");
  log("AUFBAU " + wo + ": " + html);
}

/** Findet das anklickbare Datumsfeld neben "Zeitraum". */
async function datumsFeld(page) {
  const inputs = page.locator("input");
  const n = await inputs.count();
  for (let i = 0; i < n; i++) {
    const v = (await inputs.nth(i).inputValue().catch(() => "")).trim();
    if (/\d{2}\/\d{2}\/\d{4}/.test(v)) return inputs.nth(i);
  }
  const t = page.getByText(/\d{2}\/\d{2}\/\d{4}/);
  if (await t.count()) return t.first();
  const label = page.getByText("Zeitraum", { exact: true }).first();
  return label.locator("xpath=following::*[1]");
}

/** Wählt im Kalender den Zeitraum von..bis (beide im selben Monat). */
async function zeitraumSetzen(page, von, bis) {
  // 1. Weg: Datum direkt in die beiden Felder tippen
  try { await zeitraumTippen(page, von, bis); return; }
  catch (e) { log("Eintippen klappte nicht (" + e.message + "), versuche den Kalender …"); }
  // 2. Weg: über den Kalender klicken
  try { await zeitraumSetzenIntern(page, von, bis); }
  catch (e) { await aufbauProtokollieren(page, "bei Fehler"); throw e; }
}

async function zeitraumTippen(page, von, bis) {
  const start = page.getByTestId("start-date-input");
  const ende = page.getByTestId("end-date-input");
  for (const [feld, wert] of [[start, ddmmyyyy(von)], [ende, ddmmyyyy(bis)]]) {
    await feld.click();
    await feld.press("Control+a");
    await feld.pressSequentially(wert, { delay: 40 });
    await feld.press("Enter");
    await page.waitForTimeout(400);
  }
  await page.keyboard.press("Escape").catch(() => {});
  await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.waitForLoadState("networkidle").catch(() => {});
  const s = await start.inputValue(), e = await ende.inputValue();
  if (s !== ddmmyyyy(von) || e !== ddmmyyyy(bis)) throw new Error("Felder zeigen " + s + " > " + e);
  log("Zeitraum eingetippt: " + s + " bis " + e);
}

async function zeitraumSetzenIntern(page, von, bis) {
  const feld = await datumsFeld(page);
  await feld.click({ timeout: 10000 });
  const ziel = MONATSNAMEN[von.getMonth()] + " " + von.getFullYear();
  const kopf = page.getByText(new RegExp("^(" + MONATSNAMEN.join("|") + ") \\d{4}$"));
  await kopf.first().waitFor({ timeout: 10000 });
  for (let i = 0; i < 24; i++) {
    const sichtbar = (await kopf.allInnerTexts()).map(t => t.trim());
    if (sichtbar.includes(ziel)) break;
    // Pfeil nach links: erster Knopf im Kalender vor der ersten Monatsüberschrift
    const links = kopf.first().locator("xpath=preceding::*[self::button or @role='button' or self::svg][1]");
    await links.click();
    await page.waitForTimeout(300);
  }
  const monat = page.getByText(ziel, { exact: true }).first();
  const block = monat.locator("xpath=ancestor::*[.//*[normalize-space(text())='28']][1]");
  const tag = n => block.getByText(zwei(n), { exact: true }).first();
  await tag(von.getDate()).click();
  await page.waitForTimeout(300);
  await tag(bis.getDate()).click();
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(1500);
  await page.waitForLoadState("networkidle").catch(() => {});
  const texte = await datumsWerte(page);
  if (!texte.includes(ddmmyyyy(von)) || !texte.includes(ddmmyyyy(bis)))
    throw new Error("Zeitraum ließ sich nicht setzen (angezeigt: " + texte.join(" > ") + ")");
  log("Zeitraum gesetzt: " + ddmmyyyy(von) + " bis " + ddmmyyyy(bis));
}

async function monatHerunterladen(page, von, bis, monatKey) {
  const knopf = await downloadKnopf(page);
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), knopf.click()]);
  const roh = path.join(OUT, "FREENOW " + monatKey + ".download");
  await download.saveAs(roh);
  const bytes = fs.readFileSync(roh);
  let datei = "FREENOW Einnahmen " + monatKey + ".csv", csv;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    // FREENOW liefert eine ZIP-Datei mit CSV(s) darin
    const eintraege = new AdmZip(bytes).getEntries().filter(e => !e.isDirectory && /\.csv$/i.test(e.entryName));
    log("ZIP enthält: " + eintraege.map(e => e.entryName).join(", "));
    const wahl = eintraege.find(e => /with_VAT/i.test(e.entryName) && !/without/i.test(e.entryName))
      || eintraege.find(e => /inkl|brutto|gross/i.test(e.entryName)) || eintraege[0];
    if (!wahl) throw new Error("ZIP enthält keine CSV-Datei");
    datei = wahl.entryName;
    csv = wahl.getData().toString("utf8");
  } else {
    csv = bytes.toString("utf8");
  }
  fs.writeFileSync(path.join(OUT, datei), csv);
  log("CSV geladen: " + datei + " (" + csv.split(/\r?\n/).filter(Boolean).length + " Zeilen)");
  if (process.env.AUFBAU === "1") {
    const zeilen = csv.replace(/^\uFEFF/, "").split(/\r?\n/);
    log("KOPFZEILE: " + zeilen[0]);
    log("SPALTEN JE ZEILE: " + zeilen.map(z => (z.match(/[;,]/g) || []).length).join(" "));
  }
  await anTabelleSenden(datei, csv, monatKey, ddmmyyyy(von), ddmmyyyy(bis));
}

async function anTabelleSenden(datei, csv, monat, von, bis) {
  const url = env("SHEETS_WEBHOOK_URL");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: env("SHEETS_TOKEN"), quelle: "freenow", datei, csv, monat, von, bis }),
    redirect: "follow",
  });
  const text = await res.text();
  let antwort; try { antwort = JSON.parse(text); } catch (_) { antwort = { ok: false, fehler: text.slice(0, 300) }; }
  if (!res.ok || !antwort.ok) throw new Error("Google-Tabelle hat abgelehnt: " + (antwort.fehler || res.status));
  log("In Google-Tabelle geschrieben: " + antwort.zeilen + " Zeilen (Tab \"" + antwort.tab + "\").");
}

(async () => {
  let browser, page;
  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ acceptDownloads: true, locale: "de-DE", timezoneId: "Europe/Berlin" });
    page = await ctx.newPage();
    await anmelden(page);
    await page.goto("https://portal.free-now.com/earnings", { waitUntil: "domcontentloaded" });
    await page.getByText("Zeitraum").first().waitFor({ timeout: 30000 });
    await page.waitForLoadState("networkidle").catch(() => {});

    const monate = Math.max(1, Math.min(24, parseInt(process.env.MONATE || "2", 10) || 2));
    const heute = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
    let fehler = 0;
    for (let m = 0; m < monate; m++) {
      const von = new Date(heute.getFullYear(), heute.getMonth() - m, 1);
      const bis = m === 0 ? heute : new Date(heute.getFullYear(), heute.getMonth() - m + 1, 0);
      const key = von.getFullYear() + "-" + zwei(von.getMonth() + 1);
      try {
        if (m > 0) {
          await page.goto("https://portal.free-now.com/earnings", { waitUntil: "domcontentloaded" });
          await page.getByText("Zeitraum").first().waitFor({ timeout: 30000 });
          await page.waitForLoadState("networkidle").catch(() => {});
          await zeitraumSetzen(page, von, bis);
        }
        await monatHerunterladen(page, von, bis, key);
      } catch (e) {
        fehler++;
        log("FEHLER bei Monat " + key + ": " + (e && e.message ? e.message : e));
        try { await page.screenshot({ path: path.join(OUT, "fehler-" + key + ".png"), fullPage: true }); } catch (_) {}
      }
    }
    if (fehler) process.exitCode = 1;
  } catch (e) {
    log("FEHLER: " + (e && e.message ? e.message : e));
    try { if (page) await page.screenshot({ path: path.join(OUT, "fehler.png"), fullPage: true }); } catch (_) {}
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
})();
