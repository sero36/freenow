# FREENOW-Abruf

Lädt jeden Abend die Einnahmen-CSV aus dem FREENOW-Unternehmensportal und schreibt sie
in die Google-Tabelle (Tab „FreeNow“). Läuft in GitHub Actions, kein PC nötig.

## Einrichtung

1. **Apps Script:** `apps-script/freenow_empfang.gs` in das Apps-Script-Projekt der Tabelle einfügen,
   `freenowTokenErzeugen` ausführen und als Web-App bereitstellen (siehe Kommentar oben in der Datei).
2. **GitHub-Secrets** (Settings → Secrets and variables → Actions → New repository secret):
   - `FREENOW_EMAIL` – Login-E-Mail des Unternehmensportals
   - `FREENOW_PASSWORT` – Passwort
   - `SHEETS_WEBHOOK_URL` – URL der Web-App aus Schritt 1
   - `SHEETS_TOKEN` – Schlüssel aus `freenowTokenErzeugen`
3. **Testlauf:** Actions → „FREENOW Abruf“ → „Run workflow“.

Bei einem Fehler liegen die CSV und ein Bildschirmfoto `fehler.png` unter dem Lauf bei „Artifacts“.
