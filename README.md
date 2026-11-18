# KoiSignage

Digital Signage: Ein Webserver verwaltet Ressourcen (Videos, Bilder, Webseiten), Sequenzen und Bildschirme. Die Clients sind Browser im Vollbild (TV, Raspberry Pi, Mini-PC), es wird dort nichts installiert.

## Starten

Voraussetzung ist Node.js ab 22.13. Es gibt keine Fremdpakete, also kein `npm install`.

```bash
npm start
```

Dann `http://localhost:8080/` öffnen, ein Passwort setzen, Ressourcen hochladen, eine Sequenz bauen. Am Bildschirm `http://SERVER:8080/player/` öffnen und den angezeigten Code unter „Bildschirme" eingeben.

## Tests

```bash
npm test
```
