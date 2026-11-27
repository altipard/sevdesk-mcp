<p align="center">
  <img src="assets/logo/sevdesk-mcp.svg" alt="sevdesk-mcp Logo: eine Eule als Buchhalterin mit Brille" width="160">
</p>

<h1 align="center">sevdesk-mcp</h1>

<p align="center">
  <b>Frag deinen KI-Assistenten nach deiner Buchhaltung in sevdesk.</b><br>
  Standardmäßig nur lesend. Buchungen und Statusänderungen zeigen vorher eine Vorschau.
</p>

<p align="center">
  <a href="https://github.com/altipard/sevdesk-mcp/actions/workflows/ci.yml"><img src="https://github.com/altipard/sevdesk-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@altipard/sevdesk-mcp"><img src="https://img.shields.io/npm/v/@altipard/sevdesk-mcp" alt="npm-Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT-Lizenz"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white" alt="Node.js 24 oder neuer">
</p>

[English](README.md) · **Deutsch**

sevdesk-mcp verbindet dein [sevdesk](https://sevdesk.de)-Konto mit einem KI-Assistenten,
zum Beispiel Claude Desktop, Claude Code, Cursor oder VS Code. Du fragst ganz normal, und
der Assistent sucht die Antwort in sevdesk. Zum Beispiel:

- „Welche Rechnungen sind überfällig?“
- „Ist die Zahlung von ACME eingegangen?“
- „Welche Kunden schulden uns noch Geld, und wie viel?“
- „Zeig mir alle Belege vom letzten Monat, die noch nicht gebucht sind.“
- „Prüf meine Buchhaltung für Juni: Entwürfe, Zahlungen ohne Beleg, Umsatzsteuer-Probleme.“
- „Sind meine ausländischen Software-Abos als Reverse Charge gebucht?“
- „Erstelle einen Rechnungsentwurf für ACME: 8 Stunden Beratung zu 95 Euro.“ (braucht den
  Schreibmodus)

> [!IMPORTANT]
> **Inoffiziell.** Steht in keiner Verbindung zur sevdesk GmbH und wird von ihr weder
> empfohlen noch unterstützt.
> „sevdesk“ ist eine Marke der sevdesk GmbH.

Technisch ist sevdesk-mcp ein [Model Context Protocol](https://modelcontextprotocol.io)
(MCP) Server. MCP ist der Standard, über den KI-Programme mit anderen Diensten sprechen.

## Installation

Du brauchst einen API-Token von sevdesk (siehe [Dein API-Token](#dein-api-token)). Dann
wählst du dein Programm.

**Claude Desktop.** Lade `sevdesk-mcp.mcpb` aus dem
[neuesten Release](https://github.com/altipard/sevdesk-mcp/releases/latest) herunter und
öffne die Datei mit einem Doppelklick. Füge deinen Token in das Fenster ein, das sich
öffnet. Fertig.

**Claude Code.** Du brauchst Node.js 24 oder neuer. Leg deinen Token zuerst im
Schlüsselbund ab (siehe [Dein API-Token](#dein-api-token)). Dann führst du aus:

```sh
claude plugin install sevdesk --marketplace altipard/sevdesk-mcp
```

**Cursor, VS Code und andere** (macOS und Linux). Mit Node.js 24 oder neuer führst du den
npx-Befehl im Terminal aus, sonst den curl-Befehl:

```sh
npx -y @altipard/sevdesk-mcp setup
```

```sh
curl -fsSL https://raw.githubusercontent.com/altipard/sevdesk-mcp/main/install.sh | sh
```

Die Einrichtung wählt die gefundenen Programme schon aus. Mit der Leertaste änderst du die
Auswahl, mit Enter bestätigst du. Sie fragt nach Modus und Token, prüft den Token und legt
ihn in deinem Schlüsselbund ab. Sie richtet auch Claude Desktop und Claude Code ein. Wenn
du dort zusätzlich die Erweiterung oder das Plugin installierst, hast du zwei Server.

**Windows** (nicht getestet): Nimm die Erweiterung für Claude Desktop. Manuelle
Einrichtung, Prüfsummen und alle anderen Wege: [docs/install.md](docs/install.md) (auf
Englisch, wie alle Seiten unter docs/).

## Dein API-Token

Der Token ist dein Schlüssel zu sevdesk. Öffne in sevdesk **Einstellungen > Benutzer**,
wähle deinen Administrator-Benutzer und kopiere den **API-Token** (32 Zeichen, Ziffern und
die Buchstaben a bis f).

Claude Desktop speichert den Token in seinen eigenen geschützten Einstellungen. Claude
Code und die Einrichtung nutzen den Schlüsselbund deines Systems. So landet der Token
nicht in einer Konfigurationsdatei. Die Einrichtung legt ihn dort für dich ab. Auf dem
Mac kannst du ihn auch selbst ablegen. Dieser Befehl fragt nach dem Token:

```sh
security add-generic-password -U -s sevdesk-mcp -a api-token -w
```

Linux und weitere Details: [docs/install.md](docs/install.md#api-token).

## Nur lesen oder auch schreiben

Standardmäßig kann der Assistent nur **lesen**. Er kann in sevdesk nichts ändern.

Im Modus **write** (schreiben) kann er auch Entwürfe anlegen (Rechnungen, Angebote,
Belege), Kontakte anlegen und ändern und Zahlungen buchen. Entwürfe und Änderungen an
Kontakten passieren sofort. Ein Entwurf bleibt ein Entwurf: Er bekommt keine Nummer und
wird nicht verschickt. Eine Zahlung buchen oder einen Status ändern geht in zwei Schritten:
erst eine Vorschau, was sich ändert, dann die Bestätigung. Lies die Vorschau, bevor du
zustimmst. Die Bestätigung schützt dich nicht vor einem Assistenten, der in die Irre
geführt wurde. Bleib im Zweifel im Lesemodus ([warum](docs/security.md)).

Rechnungen per E-Mail verschicken, Rechnungen stornieren und Dokumente festschreiben lässt
sich nicht rückgängig machen. Das bleibt aus, bis du es bewusst einschaltest.

Den Modus änderst du in Claude Desktop und Claude Code in den Einstellungen der
Erweiterung oder des Plugins. Für andere Programme und alle Details siehe
[docs/security.md](docs/security.md#modes-per-client).

> [!CAUTION]
> Probier den Schreibmodus zuerst mit Testdaten aus. Prüf das Ergebnis in sevdesk, bevor
> du ihn für deine echte Buchhaltung nutzt.

Alles, was der Assistent liest, zum Beispiel Kundennamen, IBANs und Beträge, geht an dein
KI-Programm und von dort an dessen Anbieter.

## Was es kann

- **Rechnungen:** Rechnungen finden, sehen, was offen oder überfällig ist, das PDF holen,
  Entwürfe anlegen.
- **Angebote und Aufträge:** sie finden, Entwürfe anlegen, aus einem Angebot eine Rechnung
  machen.
- **Belege:** Eingangsrechnungen und Belege finden, neue mit angehängter Datei erfassen.
- **Kontakte:** Kunden und Lieferanten nachschlagen, neue anlegen, ihre Daten ändern.
- **Bank:** deine Konten und Salden sehen, Umsätze finden, Zahlungen buchen.
- **Auswertungen:** die Listen-Auswertungen von sevdesk als PDF, und welche Steuersätze
  und Buchungskonten zusammenpassen.
- **Prüfungen:** Umsatzsteuer- und Reverse-Charge-Prüfung (§13b), doppelte Belege, fehlende
  monatliche Abos, Bankumsätze ohne Beleg, Summen pro Monat oder Kunde, wie lange offene Posten
  überfällig sind. Das sind Hinweise zum Nachprüfen, keine Steuerberatung.

Alle Werkzeuge im Überblick: [docs/tools.md](docs/tools.md).

## Probleme?

- **Der Server startet nicht, oder es erscheinen keine sevdesk-Werkzeuge:** Der Token
  fehlt, oder Node.js ist älter als Version 24 (Claude Code, npx). Leg den Token erneut ab
  oder starte die Einrichtung noch einmal.
- **Fehler 401 von sevdesk:** Der Token ist falsch. Kopier ihn noch einmal aus sevdesk. In
  Claude Desktop fügst du ihn in den Einstellungen der Erweiterung ein. Sonst legst du ihn
  mit dem Befehl oben erneut ab oder führst
  `npx -y @altipard/sevdesk-mcp setup --replace-token` aus (Installation per curl:
  `sevdesk-mcp setup --replace-token`, siehe [Optionen](docs/install.md#setup-options)).
- **Einige Werkzeuge fehlen:** Du bist im Lesemodus. Werkzeuge zum Schreiben brauchen den
  [Schreibmodus](docs/security.md#modes-per-client).

Tipp: Bitte den Assistenten, die Verbindung zu sevdesk zu prüfen. Die Antwort nennt dir
auch den Modus. Mehr Hilfe: [docs/install.md](docs/install.md#troubleshooting), oder
[eröffne ein Issue](https://github.com/altipard/sevdesk-mcp/issues).

## Mehr

- [Installation](docs/install.md): alle Wege zur Installation, alle Programme, Windows,
  der Token, Fehlersuche
- [Werkzeuge](docs/tools.md): jedes Werkzeug und was es tut
- [Sicherheit](docs/security.md): Modi, Bestätigungen und wovor sie schützen
- [Remote (HTTP)](docs/remote-http.md): als gemeinsamen Server mit OAuth und Redis
  betreiben
- [Konfiguration](docs/configuration.md): alle Umgebungsvariablen
- [Entwicklung](docs/development.md): Build, Tests, Releases
- [Datenschutz](PRIVACY.md) (auf Englisch): welche Daten wohin gehen, und was die
  Einrichtung schreibt

## Lizenz

MIT, siehe [LICENSE](LICENSE). Copyright (c) 2026 Zilicon IT Services.
