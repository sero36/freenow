# Feste Regeln für Flottencockpit (personalakte.html)

1. **Jede Programmierung wird vor dem Veröffentlichen simuliert** – mit den echten Daten
   (aktuellen Stand aus der App-Datenbank laden) und in der Handy-Ansicht (390 px Breite).
   Prüfen: keine Fehler in der Konsole, das gewünschte Ergebnis tritt bei den echten
   Fahrzeugen/Fahrern ein, keine Nebenwirkungen (andere Autos/Firmen dürfen sich nicht ändern).
   Erst dann veröffentlichen und dem Nutzer sagen, was simuliert wurde.
2. **Keine Änderungen direkt in der Datenbank**, wenn die App den Wert selbst setzen kann –
   ein noch offenes App-Fenster speichert sonst den alten Stand zurück. Dauerhafte Änderungen
   als Regel in der App einbauen (läuft bei jedem Öffnen).
3. **Das neueste Dokument ist Gesetz** (Fahrzeugschein, Auszug, Eichschein, TÜV).
4. Alles bezieht sich auf die **mobile Ansicht**; Design klein und minimalistisch.
5. Feste Anweisung GF (26.11.2026): alle bisherigen SFK-Autos gehören zu HeimDrive.
7. **Nie `confirm()`, `alert()` oder `prompt()` verwenden** – im claude.ai-Rahmen sind sie gesperrt
   (confirm liefert sofort „Abbrechen“). Immer das eigene Fenster `appFrage(text, okText)` nutzen.
   In der Simulation Browser-Dialoge sperren (`window.confirm=()=>false`), nicht automatisch bestätigen.
6. **Firmendaten strikt trennen** (Bankverbindung, IBAN, Steuernummer, E-Mail, Anschrift, GF):
   immer aus der gewählten Firma nehmen (Firmendatensatz bzw. `fiDefaults` in der App),
   nie aus alten Formularen oder einer anderen Firma. Kontodaten nie ins Repository schreiben.
