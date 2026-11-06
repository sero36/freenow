/**
 * FREENOW-Abruf (läuft täglich in GitHub Actions)
 *
 * 1. Meldet sich im FREENOW-Unternehmensportal an
 * 2. Öffnet "Einnahmen" (Zeitraum: aktueller Monat bis heute)
 * 3. Lädt die CSV-Datei herunter
 * 4. Schickt sie an die Google-Tabelle (Apps-Script-Web-App)
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

async function anTabelleSenden(datei, csv) {
  const url = env("SHEETS_WEBHOOK_URL");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: env("SHEETS_TOKEN"), quelle: "freenow", datei, csv }),
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

    const knopf = await downloadKnopf(page);
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), knopf.click()]);
    const heute = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
    const datei = "FREENOW Einnahmen " + heute + ".csv";
    const ziel = path.join(OUT, datei);
    await download.saveAs(ziel);
    const csv = fs.readFileSync(ziel, "utf8");
    log("CSV geladen: " + datei + " (" + csv.split(/\r?\n/).filter(Boolean).length + " Zeilen)");
    await anTabelleSenden(datei, csv);
  } catch (e) {
    log("FEHLER: " + (e && e.message ? e.message : e));
    try { if (page) await page.screenshot({ path: path.join(OUT, "fehler.png"), fullPage: true }); } catch (_) {}
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
})();
