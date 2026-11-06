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

/** Wählt im Kalender den Zeitraum von..bis (beide im selben Monat). */
async function zeitraumSetzen(page, von, bis) {
  const feld = page.getByText(/^\d{2}\/\d{2}\/\d{4}$/).first();
  await feld.click();
  const ziel = MONATSNAMEN[von.getMonth()] + " " + von.getFullYear();
  const kopf = page.getByText(new RegExp("^(" + MONATSNAMEN.join("|") + ") \\d{4}$"));
  await kopf.first().waitFor({ timeout: 10000 });
  for (let i = 0; i < 24; i++) {
    const sichtbar = (await kopf.allInnerTexts()).map(t => t.trim());
    if (sichtbar.includes(ziel)) break;
    // Pfeil nach links: erster Knopf im Kalender vor der ersten Monatsüberschrift
    const links = kopf.first().locator("xpath=preceding::button[1]");
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
  const texte = (await page.getByText(/^\d{2}\/\d{2}\/\d{4}$/).allInnerTexts()).map(t => t.trim());
  if (!texte.includes(ddmmyyyy(von)) || !texte.includes(ddmmyyyy(bis)))
    throw new Error("Zeitraum ließ sich nicht setzen (angezeigt: " + texte.join(" > ") + ")");
  log("Zeitraum gesetzt: " + ddmmyyyy(von) + " bis " + ddmmyyyy(bis));
}

async function monatHerunterladen(page, von, bis, monatKey) {
  const knopf = await downloadKnopf(page);
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), knopf.click()]);
  const datei = "FREENOW Einnahmen " + monatKey + ".csv";
  const ziel = path.join(OUT, datei);
  await download.saveAs(ziel);
  const csv = fs.readFileSync(ziel, "utf8");
  log("CSV geladen: " + datei + " (" + csv.split(/\r?\n/).filter(Boolean).length + " Zeilen)");
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
