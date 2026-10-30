# Raumklima Card

Kompakte Lovelace-Karte für Home Assistant: Stockwerke als Reihen, Räume darin nebeneinander, getrennt durch Striche.
Jeder Raum zeigt Name, Ist-Temperatur, Sollwert und Luftfeuchte. Der Hintergrund färbt sich nach der Ist-Temperatur
(Catppuccin-Farben), benachbarte Räume gehen fließend ineinander über. Antippen öffnet ein Popup zum Verstellen des Sollwerts.

## Installation

### HACS (empfohlen)
1. HACS → ⋮ → **Benutzerdefinierte Repositories** → `https://github.com/BrianPiffler/raumklima-card`, Typ **Dashboard**.
2. „Raumklima Card" herunterladen. Die Dashboard-Ressource legt HACS selbst an.
3. Browser bzw. Companion-App neu laden.

### Manuell
`raumklima-card.js` nach `/config/www/` kopieren und als Ressource `/local/raumklima-card.js?v=0.1.0` (Typ *JavaScript-Modul*) eintragen.

## Konfiguration

```yaml
type: custom:raumklima-card
title: Thermostate            # optional, mit Zusammenfassung „x heizen · Ø"
temperature_colors: true      # Hintergrund + Raumname nach Ist-Temperatur (Standard: true)
floors:
  - name: DG
    rooms:
      - name: Gästezimmer
        climate: climate.thermostat_better_gastezimmer
      - name: Büro
        climate: climate.thermostat_better_buro
        humidity: sensor.buro_humidity
        entities:              # zusätzlich im Popup
          - binary_sensor.buro_fenster
  - name: OG
    columns: 4
    rooms:
      - name: Schlafzimmer     # nur Sensor, kein Thermostat
        temperature: sensor.schlafzimmer_temperature
        humidity: sensor.schlafzimmer_humidity
```

### Karte

| Option | Standard | Beschreibung |
|---|---|---|
| `floors` | – | Liste der Stockwerke (Pflicht) |
| `title` | – | Kopfzeile mit Anzahl heizender Räume und Durchschnitt |
| `icon` | `mdi:thermometer` | Icon der Kopfzeile |
| `temperature_colors` | `true` | Temperatur-Farbverlauf an/aus |
| `color_stops` | `[16, 18, 19.5, 21, 22.5, 24, 26]` | 7 Temperaturen für Blau → Sapphire → Teal → Grün → Gelb → Peach → Rot |
| `step` | vom Thermostat | Schrittweite im Popup |

### Stockwerk

| Option | Standard | Beschreibung |
|---|---|---|
| `name` | – | Wird im Popup angezeigt |
| `rooms` | – | Liste der Räume (Pflicht) |
| `columns` | Anzahl Räume, max. 4 | Räume pro Zeile |

### Raum

| Option | Beschreibung |
|---|---|
| `climate` | Thermostat. Liefert Ist (`current_temperature`), Soll, Modus und Heizstatus (`hvac_action`) |
| `temperature` | Eigener Temperatursensor. Ersetzt den Ist-Wert des Thermostats, oder allein für Räume ohne Thermostat |
| `humidity` | Feuchtesensor |
| `entities` | Weitere Entitäten, die im Popup gelistet werden |
| `name` | Anzeigename, sonst `friendly_name` |

Ein Raum braucht `climate` oder `temperature`.

## Bedienung
- **Kachel:** Sollwert links (orange = heizt, „Aus" = Thermostat aus), Luftfeuchte rechts.
- **Popup:** −/+ ändert den Sollwert sofort in der Anzeige und schickt `climate.set_temperature` 1 s nach dem letzten Tipp.
  Heizen/Aus schaltet per `climate.set_hvac_mode`. Meldet das Thermostat `window_open`, steht „Fenster offen" im Popup.
  „Details in Home Assistant" öffnet den normalen Mehr-Infos-Dialog.

## Farben anpassen
Die Farben kommen aus dem HA-Theme (`primary-text-color`, `divider-color`, `primary-color`, `card-background-color`).
Die Temperatur-Skala ist Catppuccin Latte/Mocha und lässt sich per Theme-Variable überschreiben:
`raumklima-temp-1` … `raumklima-temp-7`, `raumklima-heat-color`, `raumklima-ok-color`, `raumklima-tint` (Deckkraft, z. B. `21%`).

## Entwicklung
```bash
node dev/serve.mjs
```
Öffnet unter `http://localhost:5174/dev/harness.html` eine Vorschau mit simulierten Thermostaten.

## Lizenz
MIT
