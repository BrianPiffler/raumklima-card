/*
 * Raumklima Card – Stockwerke × Räume mit Temperatur-Farbverlauf und Sollwert-Popup.
 * https://github.com/BrianPiffler/raumklima-card
 */
const VERSION = '0.4.0';
const DEFAULT_STOPS = [16, 18, 19.5, 21, 22.5, 24, 26];

// Catppuccin Latte (hell) / Mocha (dunkel); per Theme-Variable --raumklima-* überschreibbar
const TOKENS = `
  :host {
    --rc-t1: var(--raumklima-temp-1, #1e66f5); --rc-t2: var(--raumklima-temp-2, #209fb5);
    --rc-t3: var(--raumklima-temp-3, #179299); --rc-t4: var(--raumklima-temp-4, #40a02b);
    --rc-t5: var(--raumklima-temp-5, #df8e1d); --rc-t6: var(--raumklima-temp-6, #fe640b);
    --rc-t7: var(--raumklima-temp-7, #d20f39);
    --rc-mix: var(--raumklima-tint, 17%);
    --rc-heat: var(--raumklima-heat-color, #fe640b);
    --rc-ok: var(--raumklima-ok-color, #40a02b);
    --rc-fg: var(--primary-text-color, #4c4f69);
    --rc-muted: var(--secondary-text-color, #6c6f85);
    --rc-line: var(--divider-color, rgba(127, 127, 127, .25));
    --rc-accent: var(--primary-color, #7287fd);
    --rc-surface: var(--card-background-color, var(--ha-card-background, #eff1f5));
    --rc-floor: color-mix(in srgb, var(--rc-fg) 4%, transparent);
  }
  :host([dark]) {
    --rc-t1: var(--raumklima-temp-1, #89b4fa); --rc-t2: var(--raumklima-temp-2, #74c7ec);
    --rc-t3: var(--raumklima-temp-3, #94e2d5); --rc-t4: var(--raumklima-temp-4, #a6e3a1);
    --rc-t5: var(--raumklima-temp-5, #f9e2af); --rc-t6: var(--raumklima-temp-6, #fab387);
    --rc-t7: var(--raumklima-temp-7, #f38ba8);
    --rc-mix: var(--raumklima-tint, 21%);
    --rc-heat: var(--raumklima-heat-color, #fab387);
    --rc-ok: var(--raumklima-ok-color, #a6e3a1);
  }
`;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const haptic = () => window.dispatchEvent(new CustomEvent('haptic', { detail: 'light' }));

class RaumklimaCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._pending = {};
    this._timers = {};
    this._sig = '';
    this.shadowRoot.addEventListener('click', (e) => {
      if (e.target.closest('.hist-btn')) return this._toggleHistory();
      const t = e.target.closest('.tile');
      if (t) this._openDialog(+t.dataset.f, +t.dataset.r, t);
    });
  }

  static getStubConfig(hass) {
    const climates = Object.keys(hass?.states ?? {}).filter((id) => id.startsWith('climate.')).slice(0, 3);
    return {
      title: 'Thermostate',
      floors: [{ name: 'EG', rooms: climates.length ? climates.map((id) => ({ climate: id })) : [{ name: 'Wohnzimmer', climate: 'climate.wohnzimmer' }] }],
    };
  }

  setConfig(config) {
    if (!config || !Array.isArray(config.floors) || !config.floors.length) throw new Error('raumklima-card: "floors" fehlt');
    config.floors.forEach((f, i) => {
      if (!Array.isArray(f.rooms) || !f.rooms.length) throw new Error(`raumklima-card: Stockwerk ${f.name ?? i + 1} hat keine "rooms"`);
      f.rooms.forEach((r) => {
        if (!r.climate && !r.temperature) throw new Error(`raumklima-card: Raum "${r.name ?? '?'}" braucht "climate" oder "temperature"`);
      });
    });
    if (config.color_stops && (!Array.isArray(config.color_stops) || config.color_stops.length !== 7)) {
      throw new Error('raumklima-card: "color_stops" braucht genau 7 Temperaturen');
    }
    if (config.history_hours != null && !(num(config.history_hours) >= 0)) throw new Error('raumklima-card: "history_hours" muss eine Zahl ≥ 0 sein');
    this._config = { temperature_colors: true, history_hours: 12, ...config };
    this._sig = '';
    this._hist = null;
    this._histFetched = 0;
    // Kurven standardmäßig aus; der Schalter in der Kopfzeile wird pro Gerät gemerkt
    try { this._showHist = localStorage.getItem(this._histStoreKey()) === '1'; } catch { this._showHist = false; }
    if (this._hass) this._render();
  }

  set hass(hass) {
    this._hass = hass;
    const dark = !!hass.themes?.darkMode;
    this.toggleAttribute('dark', dark);
    this._dialog?.toggleAttribute('dark', dark);
    this._expirePending();
    if (this._histActive() && Date.now() - this._histFetched > 15 * 60000) this._fetchHistory();
    else this._appendLive();
    const sig = this._signature();
    if (sig !== this._sig) {
      this._sig = sig;
      this._render();
      this._dialog?.update();
    }
  }

  getCardSize() { return 1 + (this._config?.floors.length ?? 1) * 2; }
  getGridOptions() { return { columns: 12, min_columns: 6 }; }

  // ---------- Daten ----------
  _entityIds() {
    return this._config.floors.flatMap((f) => f.rooms.flatMap((r) => [r.climate, r.temperature, r.humidity, r.window, r.history_entity, ...(r.entities ?? [])])).filter(Boolean);
  }

  _signature() {
    const h = this._hass;
    return this._entityIds().map((id) => h.states[id]?.last_updated ?? '-').join('|')
      + (h.themes?.darkMode ? 'd' : 'l') + (h.locale?.language ?? '');
  }

  // ---------- Verlauf ----------
  _hours() { return num(this._config?.history_hours) ?? 0; }
  _histActive() { return this._hours() > 0 && this._showHist; }
  _histStoreKey() { return `raumklima-card:history:${this._config?.title ?? ''}`; }

  _toggleHistory() {
    haptic();
    this._showHist = !this._showHist;
    try { localStorage.setItem(this._histStoreKey(), this._showHist ? '1' : '0'); } catch { /* privater Modus o. Ä. */ }
    if (this._showHist && Date.now() - this._histFetched > 15 * 60000) this._fetchHistory();
    else this._render();
  }
  _histKey(r) { return r.history_entity ?? r.temperature ?? r.climate; }

  _histValue(r) {
    const id = this._histKey(r);
    const s = this._hass.states[id];
    return id === r.climate && !r.history_entity && !r.temperature ? num(s?.attributes.current_temperature) : num(s?.state);
  }

  // Sensoren ohne Attribute (klein); Thermostate brauchen die Attribute für current_temperature
  async _fetchHistory() {
    if (this._histLoading) return;
    this._histLoading = true;
    this._histFetched = Date.now();
    const end = new Date();
    const start = new Date(end.getTime() - this._hours() * 3600000);
    const rooms = this._config.floors.flatMap((f) => f.rooms);
    const sensors = [...new Set(rooms.map((r) => r.history_entity ?? r.temperature).filter(Boolean))];
    const climates = [...new Set(rooms.filter((r) => !r.history_entity && !r.temperature && r.climate).map((r) => r.climate))];
    const req = (ids, attrs) => (ids.length ? this._hass.callWS({
      type: 'history/history_during_period', start_time: start.toISOString(), end_time: end.toISOString(),
      entity_ids: ids, minimal_response: !attrs, no_attributes: !attrs, significant_changes_only: attrs,
    }) : Promise.resolve({}));
    try {
      const [s, c] = await Promise.all([req(sensors, false), req(climates, true)]);
      const hist = {};
      for (const [id, rows] of Object.entries({ ...s, ...c })) {
        const isClimate = climates.includes(id);
        let last = null;
        hist[id] = rows.map((row) => {
          last = isClimate ? num(row.a?.current_temperature) ?? last : num(row.s);
          return { t: (row.lu ?? row.lc) * 1000, v: last };
        }).filter((p) => p.v != null && Number.isFinite(p.t));
      }
      this._hist = hist;
    } catch (err) {
      console.warn('raumklima-card: Verlauf nicht ladbar', err);
    } finally {
      this._histLoading = false;
      this._sig = '';
      this._render();
    }
  }

  _appendLive() {
    if (!this._hist) return;
    const now = Date.now();
    const cutoff = now - this._hours() * 3600000;
    for (const r of this._config.floors.flatMap((f) => f.rooms)) {
      const v = this._histValue(r);
      if (v == null) continue;
      const arr = (this._hist[this._histKey(r)] ??= []);
      if (arr[arr.length - 1]?.v !== v) arr.push({ t: now, v });
      while (arr.length > 1 && arr[1].t < cutoff) arr.shift();
    }
  }

  // Zeitachse echt (unregelmäßige Messpunkte), eigene Skala pro Raum mit mindestens 2 °C Spanne
  _sparkHTML(r) {
    const arr = this._hist?.[this._histKey(r)];
    if (!arr?.length) return '';
    const now = Date.now();
    const start = now - this._hours() * 3600000;
    const pts = arr.map((p) => [Math.max(p.t, start), p.v]);
    pts.push([now, pts[pts.length - 1][1]]);
    let lo = Math.min(...pts.map((p) => p[1]));
    let hi = Math.max(...pts.map((p) => p[1]));
    if (hi - lo < 2) { const m = (hi + lo) / 2; lo = m - 1; hi = m + 1; }
    const line = 'M' + pts.map(([t, v]) => `${((t - start) / (now - start) * 100).toFixed(2)},${(38 - (v - lo) / (hi - lo) * 32).toFixed(2)}`).join(' L');
    return `<svg class="spark" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true"><path class="a" d="${line} L100,40 L0,40 Z"/><path class="l" d="${line}"/></svg>`;
  }

  _expirePending() {
    const now = Date.now();
    for (const [id, p] of Object.entries(this._pending)) {
      const st = this._hass.states[id];
      if ((p.sent && num(st?.attributes.temperature) === p.value) || now - p.at > 15000) delete this._pending[id];
    }
  }

  _room(r) {
    const h = this._hass;
    const c = r.climate ? h.states[r.climate] : undefined;
    const ts = r.temperature ? h.states[r.temperature] : undefined;
    const cur = ts ? num(ts.state) : num(c?.attributes.current_temperature);
    const hum = r.humidity ? num(h.states[r.humidity]?.state) : null;
    // eigener Kontaktsensor hat Vorrang, sonst das window_open-Attribut (z. B. Better Thermostat)
    const ws = r.window ? h.states[r.window] : undefined;
    const windowOpen = ws ? ws.state === 'on' : c?.attributes.window_open === true;
    const base = {
      cfg: r, cur, hum, windowOpen,
      windowSince: windowOpen && ws ? new Date(ws.last_changed) : null,
      name: r.name ?? c?.attributes.friendly_name ?? ts?.attributes.friendly_name ?? r.climate ?? r.temperature,
    };
    if (!r.climate) return { ...base, kind: windowOpen ? 'window' : 'sensor' };
    if (!c || c.state === 'unavailable' || c.state === 'unknown') return { ...base, kind: windowOpen ? 'window' : 'unavailable' };
    const a = c.attributes;
    const target = this._pending[r.climate]?.value ?? num(a.temperature);
    const off = c.state === 'off';
    const heating = !off && (a.hvac_action ? a.hvac_action === 'heating' : cur != null && target != null && cur < target - 0.2);
    return {
      ...base, stateObj: c, target,
      kind: windowOpen ? 'window' : off ? 'off' : heating ? 'heating' : 'idle',
      hvacOff: off,
      min: num(a.min_temp) ?? 5, max: num(a.max_temp) ?? 30,
      step: num(this._config.step) ?? num(a.target_temp_step) ?? 0.5,
    };
  }

  _fmt(n) {
    if (n == null) return '–';
    const lang = this._hass?.locale?.language ?? navigator.language;
    if (this._nfLang !== lang) {
      this._nfLang = lang;
      this._nf = new Intl.NumberFormat(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    }
    return this._nf.format(n);
  }

  // Farbe per color-mix aus den Tokens, damit Hell/Dunkel ohne Neuberechnung mitwechselt
  _tempColor(v) {
    const s = this._config.color_stops ?? DEFAULT_STOPS;
    if (v == null) return 'var(--rc-muted)';
    if (v <= s[0]) return 'var(--rc-t1)';
    const i = s.findIndex((t) => v < t);
    if (i < 0) return 'var(--rc-t7)';
    const p = (v - s[i - 1]) / (s[i] - s[i - 1]);
    return `color-mix(in oklab, var(--rc-t${i}) ${Math.round((1 - p) * 100)}%, var(--rc-t${i + 1}))`;
  }

  // Jeder Raum hält seine Farbe über die mittleren 60 %, an den Trennstrichen fließen die Nachbarn ineinander
  _floorBg(rooms) {
    if (!this._config.temperature_colors) return 'var(--rc-floor)';
    const n = rooms.length;
    const stops = rooms.flatMap((r, i) => {
      const c = r.cur == null ? 'transparent' : `color-mix(in srgb, ${this._tempColor(r.cur)} var(--rc-mix), transparent)`;
      return [`${c} ${((i + 0.2) / n * 100).toFixed(1)}%`, `${c} ${((i + 0.8) / n * 100).toFixed(1)}%`];
    });
    return `linear-gradient(90deg, ${stops.join(', ')}), var(--rc-floor)`;
  }

  // ---------- Darstellung ----------
  _tileHTML(m, fi, ri) {
    const colored = this._config.temperature_colors && m.cur != null;
    const tint = colored ? `color-mix(in oklab, ${this._tempColor(m.cur)} 72%, var(--rc-fg))` : 'var(--rc-muted)';
    const nameStyle = colored ? ` style="color:${tint}"` : '';
    let set = '';
    if (m.kind === 'window') set = '<span class="set">offen</span>';
    else if (m.kind === 'off') set = '<span class="set">Aus</span>';
    else if (m.kind === 'unavailable') set = '<span class="set">offline</span>';
    else if (m.kind !== 'sensor') set = `<span class="set">${this._fmt(m.target)}°</span>`;
    // immer anzeigen, damit alle Kacheln gleich aufgebaut sind; ohne Wert „–%"
    const hum = `<span class="hum">${m.hum != null ? Math.round(m.hum) : '–'}%</span>`;
    return `<button class="tile ${m.kind}" data-f="${fi}" data-r="${ri}" style="--spark:${tint}" aria-label="${esc(m.name)}, ${this._fmt(m.cur)} °C">
      ${this._histActive() ? this._sparkHTML(m.cfg) : ''}
      <div class="t-name"${nameStyle}>${esc(m.name)}</div>
      <div class="t-temp"><span class="num">${this._fmt(m.cur)}<span class="unit">°C</span></span></div>
      <div class="t-meta">${set}${hum}</div>
    </button>`;
  }

  _render() {
    if (!this._config || !this._hass) return;
    const floors = this._config.floors.map((f) => ({ f, rooms: f.rooms.map((r) => this._room(r)) }));
    let head = '';
    if (this._config.title) {
      const all = floors.flatMap((x) => x.rooms);
      const heating = all.filter((m) => m.kind === 'heating').length;
      const open = all.filter((m) => m.windowOpen).length;
      const temps = all.map((m) => m.cur).filter((v) => v != null);
      const avg = temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null;
      head = `<div class="head"><ha-icon icon="${esc(this._config.icon ?? 'mdi:thermometer')}"></ha-icon>
        <span class="title">${esc(this._config.title)}</span>
        ${this._hours() ? `<button class="hist-btn" aria-pressed="${this._showHist}" aria-label="Verlauf der letzten ${this._hours()} h"
          title="Verlauf der letzten ${this._hours()} h"><ha-icon icon="mdi:chart-bell-curve-cumulative"></ha-icon></button>` : ''}
        <span class="sum">${open ? `<b class="win">${open} Fenster offen</b> · ` : ''}${heating ? `<b>${heating} heizen</b> · ` : ''}Ø ${this._fmt(avg)} °C</span></div>`;
    }
    const grids = floors.map(({ f, rooms }, fi) => {
      const cols = f.columns ?? Math.min(rooms.length, 4);
      return `<div class="grid" data-cols="${cols}" style="--cols:${cols};background:${this._floorBg(rooms)}">${rooms.map((m, ri) => this._tileHTML(m, fi, ri)).join('')}</div>`;
    }).join('');
    this.shadowRoot.innerHTML = `<style>${TOKENS}${CARD_CSS}</style><ha-card>${head}${grids}</ha-card>`;
  }

  // ---------- Aktionen ----------
  _openDialog(fi, ri, tile) {
    haptic();
    this._dialog?.close(true);
    const d = document.createElement('raumklima-card-dialog');
    d.card = this;
    d.floor = this._config.floors[fi];
    d.roomCfg = d.floor.rooms[ri];
    d.opener = tile;
    d.toggleAttribute('dark', this.hasAttribute('dark'));
    this._dialog = d;
    document.body.appendChild(d);
  }

  _dialogClosed(d) {
    if (this._dialog === d) this._dialog = null;
  }

  _setTarget(entityId, value) {
    this._pending[entityId] = { value, at: Date.now(), sent: false };
    clearTimeout(this._timers[entityId]);
    this._render();
    this._dialog?.update('Wird gesendet …');
    this._timers[entityId] = setTimeout(async () => {
      try {
        await this._hass.callService('climate', 'set_temperature', { entity_id: entityId, temperature: value });
        const p = this._pending[entityId];
        if (p) { p.sent = true; p.at = Date.now(); }
        this._dialog?.update(`Gesetzt: ${this._fmt(value)} °C`, 'done');
      } catch (err) {
        delete this._pending[entityId];
        this._render();
        this._dialog?.update(`Fehler: ${err.message ?? err}`, 'error');
      }
    }, 1000);
  }

  async _setMode(entityId, mode) {
    this._dialog?.update('Wird gesendet …');
    try {
      await this._hass.callService('climate', 'set_hvac_mode', { entity_id: entityId, hvac_mode: mode });
      this._dialog?.update(mode === 'off' ? 'Ausgeschaltet' : 'Heizen eingeschaltet', 'done');
    } catch (err) {
      this._dialog?.update(`Fehler: ${err.message ?? err}`, 'error');
    }
  }

  _moreInfo(entityId) {
    this.dispatchEvent(new CustomEvent('hass-more-info', { detail: { entityId }, bubbles: true, composed: true }));
  }
}

const CARD_CSS = `
  ha-card { padding: 12px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; }
  .head { display: flex; align-items: center; gap: 8px; padding-bottom: 4px; color: var(--rc-fg); }
  .head ha-icon { --mdc-icon-size: 20px; color: var(--rc-muted); }
  .head .title { font-size: 17px; font-weight: 500; }
  .hist-btn {
    width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; cursor: pointer; padding: 0;
    background: transparent; border: 1px solid var(--rc-line); color: var(--rc-muted); --mdc-icon-size: 16px;
    transition: background-color 150ms ease, color 150ms ease, border-color 150ms ease; -webkit-tap-highlight-color: transparent;
  }
  .hist-btn[aria-pressed="true"] { color: var(--rc-accent); border-color: color-mix(in srgb, var(--rc-accent) 50%, transparent);
    background: color-mix(in srgb, var(--rc-accent) 14%, transparent); }
  .hist-btn:active { transform: scale(.92); }
  .hist-btn:focus-visible { outline: 2px solid var(--rc-accent); outline-offset: 2px; }
  .head .sum { margin-left: auto; text-align: right; font-size: 12px; color: var(--rc-muted); font-variant-numeric: tabular-nums; }
  .head .sum b { color: var(--rc-heat); font-weight: 500; }
  .grid {
    display: grid; grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
    border: 1px solid var(--rc-line); border-radius: 11px; overflow: hidden; --big: 29px;
    /* lange Raumnamen dürfen die Karte nicht breiter machen, sie werden gekürzt */
    contain: inline-size;
  }
  .grid[data-cols="4"] { --big: 24px; }
  .grid[data-cols="5"], .grid[data-cols="6"] { --big: 20px; }
  .tile {
    font: inherit; color: var(--rc-fg); text-align: center; cursor: pointer;
    background: transparent; border: 0; border-radius: 0; margin: 0;
    padding: 7px 9px 6px; display: grid; grid-template-rows: auto 1fr auto; gap: 1px; min-width: 0;
    transition: box-shadow 120ms ease; -webkit-tap-highlight-color: transparent;
  }
  .tile { position: relative; isolation: isolate; overflow: hidden; }
  .tile + .tile { border-left: 1px solid var(--rc-line); }
  /* Verlauf hinter dem Inhalt; width explizit, sonst gibt das viewBox-Seitenverhältnis die Breite vor */
  .spark { position: absolute; left: 0; bottom: 0; width: 100%; height: 62%; z-index: -1; pointer-events: none; }
  .spark .a { fill: var(--spark); opacity: .08; }
  .spark .l { fill: none; stroke: var(--spark); stroke-width: 1.25; opacity: .45; vector-effect: non-scaling-stroke; stroke-linejoin: round; }
  .tile:active { box-shadow: inset 0 0 0 100vmax color-mix(in srgb, var(--rc-fg) 8%, transparent); }
  .tile:focus-visible { outline: 2px solid var(--rc-accent); outline-offset: -2px; }
  .t-name { font-size: 11.5px; font-weight: 500; letter-spacing: .02em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .t-temp { display: flex; justify-content: center; align-self: center; font-variant-numeric: tabular-nums; line-height: 1; padding-block: 4px 3px; }
  /* Einheit absolut, damit die Zahl selbst exakt mittig steht */
  .t-temp .num { position: relative; font-size: var(--big); font-weight: 700; letter-spacing: -.02em; }
  .t-temp .unit { position: absolute; left: 100%; top: 2px; margin-left: 1px; font-size: calc(var(--big) * .42); font-weight: 400; color: var(--rc-muted); }
  .tile.off .t-temp, .tile.unavailable .t-temp { color: var(--rc-muted); }
  .t-meta { display: flex; gap: 5px; font-size: 11px; color: var(--rc-muted); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; min-height: 1.3em; }
  .t-meta .hum { margin-left: auto; }
  .tile.heating .t-meta .set { color: var(--rc-heat); font-weight: 500; }
  .head .sum .win { color: var(--rc-t2); }
  /* Fenster offen: kühle Schraffur zieht langsam durch den Raum */
  .tile.window::after {
    content: ""; position: absolute; inset: 0; pointer-events: none;
    --d: color-mix(in srgb, var(--rc-t2) 18%, transparent);
    background-image: linear-gradient(45deg, var(--d) 25%, transparent 25%, transparent 50%, var(--d) 50%, var(--d) 75%, transparent 75%);
    background-size: 14px 14px; animation: rc-draft 1.8s linear infinite;
    -webkit-mask-image: linear-gradient(transparent, #000 35%, #000 65%, transparent);
    mask-image: linear-gradient(transparent, #000 35%, #000 65%, transparent);
  }
  @keyframes rc-draft { to { background-position: 14px 0; } }
  .tile.window .t-meta .set { color: var(--rc-t2); font-weight: 500; }
  @media (prefers-reduced-motion: reduce) { .tile { transition: none; } .tile.window::after { animation: none; } }
`;

class RaumklimaDialog extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._status = '';
    this._statusKind = '';
    this._onKey = (e) => { if (e.key === 'Escape') this.close(); };
    this.shadowRoot.addEventListener('click', (e) => this._onClick(e));
  }

  connectedCallback() {
    this.update();
    document.addEventListener('keydown', this._onKey);
    requestAnimationFrame(() => requestAnimationFrame(() => this.shadowRoot.querySelector('.scrim')?.classList.add('open')));
    this.shadowRoot.querySelector('[data-act="close"]')?.focus({ preventScroll: true });
  }

  disconnectedCallback() {
    document.removeEventListener('keydown', this._onKey);
  }

  close(immediate = false) {
    document.removeEventListener('keydown', this._onKey);
    this.card._dialogClosed(this);
    this.opener?.isConnected && this.opener.focus({ preventScroll: true });
    if (immediate) return this.remove();
    this.shadowRoot.querySelector('.scrim')?.classList.remove('open');
    setTimeout(() => this.remove(), 320);
  }

  update(status, kind = '') {
    if (status !== undefined) { this._status = status; this._statusKind = kind; }
    if (!this.isConnected) return;
    const focused = this.shadowRoot.activeElement?.dataset?.act;
    const wasOpen = this.shadowRoot.querySelector('.scrim')?.classList.contains('open');
    this.shadowRoot.innerHTML = `<style>${TOKENS}${DIALOG_CSS}</style>
      <div class="scrim${wasOpen ? ' open' : ''}"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="t">${this._body()}</div></div>`;
    if (focused) this.shadowRoot.querySelector(`[data-act="${focused}"]`)?.focus({ preventScroll: true });
  }

  _body() {
    const c = this.card;
    const m = c._room(this.roomCfg);
    const sub = [this.floor.name, this.roomCfg.climate ?? this.roomCfg.temperature].filter(Boolean).join(' · ');
    const head = `<div class="handle"></div>
      <div class="s-head"><div><h2 id="t">${esc(m.name)}</h2><p>${esc(sub)}</p></div>
      <button class="x" data-act="close" aria-label="Schließen"><ha-icon icon="mdi:close"></ha-icon></button></div>`;

    let banner = '';
    if (m.windowOpen) {
      const lang = c._hass.locale?.language ?? navigator.language;
      const since = m.windowSince ? ` seit ${m.windowSince.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })}` : '';
      const resume = m.stateObj
        ? ` Das Thermostat pausiert und heizt wieder${m.target != null ? ` auf ${c._fmt(m.target)} °C` : ''}, sobald es zu ist.` : '';
      banner = `<div class="banner"><ha-icon icon="mdi:window-open-variant"></ha-icon><span><b>Fenster${since} offen.</b>${resume}</span></div>`;
    }

    const rows = [];
    if (this.roomCfg.humidity) rows.push(['mdi:water-percent', 'Luftfeuchte', m.hum != null ? `${Math.round(m.hum)} %` : 'nicht verfügbar']);
    if (m.kind !== 'sensor') rows.push(['mdi:thermometer', 'Ist-Temperatur', `${c._fmt(m.cur)} °C`]);
    for (const id of this.roomCfg.entities ?? []) {
      const s = c._hass.states[id];
      if (!s) continue;
      const val = c._hass.formatEntityState ? c._hass.formatEntityState(s) : `${s.state} ${s.attributes.unit_of_measurement ?? ''}`;
      rows.push([s.attributes.icon ?? 'mdi:information-outline', s.attributes.friendly_name ?? id, val]);
    }
    const rowsHTML = rows.length ? `<div class="rows">${rows.map(([i, l, v]) =>
      `<div class="row"><ha-icon icon="${i}"></ha-icon><span>${esc(l)}</span><span class="v">${esc(v)}</span></div>`).join('')}</div>` : '';
    const more = `<button class="more" data-act="more">Details in Home Assistant</button>`;

    if (!m.stateObj) {
      const note = this.roomCfg.climate ? 'Thermostat nicht erreichbar' : 'Kein Thermostat in diesem Raum';
      return head + banner + `<div class="sensor-big"><div class="big">${c._fmt(m.cur)}<small> °C</small></div><p>${note}</p></div>` + rowsHTML + more;
    }

    const R = 96, CX = 120, CY = 120;
    const clamp = (v) => Math.min(Math.max(v ?? m.min, m.min), m.max);
    const ang = (v) => (135 + (clamp(v) - m.min) / (m.max - m.min) * 270) * Math.PI / 180;
    const pt = (a) => [CX + R * Math.cos(a), CY + R * Math.sin(a)];
    const pct = (v) => (clamp(v) - m.min) / (m.max - m.min) * 100;
    const [sx, sy] = pt(ang(m.min)), [ex, ey] = pt(ang(m.max));
    const arc = `M ${sx} ${sy} A ${R} ${R} 0 1 1 ${ex} ${ey}`;
    const [kx, ky] = pt(ang(m.target)), [cx, cy] = pt(ang(m.cur));
    const win = m.kind === 'window';
    const off = m.kind === 'off' || win;
    const stateText = { heating: 'Heizt', idle: 'Soll erreicht', off: 'Aus', window: 'Fenster offen' }[m.kind];

    return head + banner + `
      <div class="dial ${m.kind}">
        <svg viewBox="0 0 240 240" aria-hidden="true">
          <path class="track" d="${arc}" fill="none" stroke-width="14" stroke-linecap="round"/>
          <path class="val" d="${arc}" fill="none" stroke-width="14" stroke-linecap="round" pathLength="100" stroke-dasharray="${pct(m.target)} 100"/>
          ${m.cur != null ? `<circle class="cur" cx="${cx}" cy="${cy}" r="3.5"/>` : ''}
          <circle class="knob" cx="${kx}" cy="${ky}" r="11"/>
          <text class="ends" x="${sx + 4}" y="${sy + 26}" text-anchor="middle">${m.min}°</text>
          <text class="ends" x="${ex - 4}" y="${ey + 26}" text-anchor="middle">${m.max}°</text>
        </svg>
        <div class="center"><span class="lab">Soll</span>
          <span class="big">${win ? 'Pause' : off ? 'Aus' : `${c._fmt(m.target)}<small>°C</small>`}</span>
          <span class="ist">Ist ${c._fmt(m.cur)} °C</span></div>
      </div>
      <span class="pill ${m.kind}">${stateText}</span>
      <div class="ctrl">
        <button class="btn" data-act="minus" aria-label="Soll niedriger" ${off || m.target <= m.min ? 'disabled' : ''}><ha-icon icon="mdi:minus"></ha-icon></button>
        <span class="hint">${win ? 'Erst Fenster schließen' : off ? 'Zum Einstellen auf Heizen schalten' : `Schritt ${c._fmt(m.step)} °C`}</span>
        <button class="btn" data-act="plus" aria-label="Soll höher" ${off || m.target >= m.max ? 'disabled' : ''}><ha-icon icon="mdi:plus"></ha-icon></button>
      </div>
      <div class="seg" role="group" aria-label="Modus">
        <button class="h" data-act="heat" aria-pressed="${!m.hvacOff}"><ha-icon icon="mdi:fire"></ha-icon>Heizen</button>
        <button data-act="off" aria-pressed="${m.hvacOff}"><ha-icon icon="mdi:power"></ha-icon>Aus</button>
      </div>
      <div class="send ${this._statusKind}" aria-live="polite">${esc(this._status)}</div>` + rowsHTML + more;
  }

  _onClick(e) {
    if (e.target.classList?.contains('scrim')) return this.close();
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    const c = this.card;
    const id = this.roomCfg.climate;
    if (act === 'close') return this.close();
    if (act === 'more') { this.close(true); return c._moreInfo(id ?? this.roomCfg.temperature); }
    const m = c._room(this.roomCfg);
    haptic();
    if (act === 'plus' || act === 'minus') {
      const next = Math.round((m.target + (act === 'plus' ? m.step : -m.step)) / m.step) * m.step;
      c._setTarget(id, Math.min(m.max, Math.max(m.min, next)));
    }
    if ((act === 'heat' || act === 'off') && (act === 'off') !== m.hvacOff) c._setMode(id, act);
  }
}

const DIALOG_CSS = `
  .scrim { position: fixed; inset: 0; z-index: 1000; background: rgba(17, 17, 27, .5); opacity: 0; transition: opacity 220ms ease;
    display: flex; align-items: flex-end; justify-content: center; font-family: var(--paper-font-body1_-_font-family, Roboto, system-ui, sans-serif); }
  .scrim.open { opacity: 1; }
  .sheet {
    width: 100%; max-width: 440px; max-height: 92vh; overflow-y: auto; box-sizing: border-box;
    background: var(--rc-surface); color: var(--rc-fg);
    border: 1px solid var(--rc-line); border-bottom: 0; border-radius: 22px 22px 0 0;
    padding-block: 8px calc(20px + env(safe-area-inset-bottom, 0px));
    padding-left: max(20px, env(safe-area-inset-left, 0px)); padding-right: max(20px, env(safe-area-inset-right, 0px));
    transform: translateY(100%); transition: transform 300ms cubic-bezier(.32, .72, 0, 1);
    display: grid; gap: 14px;
  }
  .scrim.open .sheet { transform: none; }
  .handle { width: 38px; height: 4px; border-radius: 2px; background: var(--rc-line); justify-self: center; }
  @media (min-width: 640px) {
    .scrim { align-items: center; }
    .sheet { border-radius: 18px; border-bottom: 1px solid var(--rc-line); padding-block: 18px 22px; transform: scale(.96); opacity: 0;
      transition: transform 200ms cubic-bezier(.2, .8, .2, 1), opacity 160ms ease; }
    .scrim.open .sheet { transform: none; opacity: 1; }
    .handle { display: none; }
  }
  button { font: inherit; color: inherit; }
  .s-head { display: flex; align-items: flex-start; gap: 12px; }
  .s-head h2 { margin: 0; font-size: 20px; font-weight: 500; }
  .s-head p { margin: 0; font-size: 12px; color: var(--rc-muted); word-break: break-all; }
  .x { margin-left: auto; flex: none; width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; cursor: pointer;
    background: var(--rc-floor); border: 1px solid var(--rc-line); --mdc-icon-size: 18px; }
  .dial { position: relative; width: 236px; max-width: 100%; aspect-ratio: 1; justify-self: center; }
  .dial svg { width: 100%; height: 100%; display: block; }
  .track { stroke: var(--rc-line); }
  .val { stroke: var(--rc-accent); transition: stroke-dasharray 220ms cubic-bezier(.2, .8, .2, 1); }
  .dial.heating .val { stroke: var(--rc-heat); }
  .dial.off .val { stroke: var(--rc-muted); opacity: .35; }
  .knob { fill: var(--rc-accent); stroke: var(--rc-surface); stroke-width: 4; }
  .dial.heating .knob { fill: var(--rc-heat); }
  .dial.off .knob { fill: var(--rc-muted); }
  .cur { fill: var(--rc-fg); }
  .ends { fill: var(--rc-muted); font-size: 11px; }
  .center { position: absolute; inset: 0; display: grid; place-content: center; text-align: center; gap: 2px; font-variant-numeric: tabular-nums; pointer-events: none; }
  .lab { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--rc-muted); }
  .center .big { font-size: 46px; font-weight: 500; line-height: 1.05; letter-spacing: -.02em; }
  .center .big small { font-size: 18px; color: var(--rc-muted); font-weight: 400; margin-left: 2px; }
  .ist { font-size: 13px; color: var(--rc-muted); }
  .pill { justify-self: center; font-size: 13px; font-weight: 500; padding: 4px 12px; border-radius: 999px; background: var(--rc-floor); color: var(--rc-muted); margin-top: -8px; }
  .pill.heating { color: var(--rc-heat); background: color-mix(in srgb, var(--rc-heat) 12%, transparent); }
  .pill.idle { color: var(--rc-ok); }
  .ctrl { display: grid; grid-template-columns: 64px minmax(0, 1fr) 64px; align-items: center; gap: 12px; }
  .btn { width: 64px; height: 64px; border-radius: 50%; border: 1px solid var(--rc-line); background: var(--rc-floor); display: grid; place-items: center;
    cursor: pointer; --mdc-icon-size: 26px; transition: transform 120ms cubic-bezier(.2, .8, .2, 1); -webkit-tap-highlight-color: transparent; }
  .btn:active { transform: scale(.92); }
  .btn:disabled { opacity: .35; cursor: default; transform: none; }
  .hint { text-align: center; font-size: 12px; color: var(--rc-muted); }
  .seg { display: grid; grid-template-columns: 1fr 1fr; background: var(--rc-floor); border: 1px solid var(--rc-line); border-radius: 12px; padding: 3px; gap: 3px; }
  .seg button { font-size: 14px; font-weight: 500; border: 0; border-radius: 9px; padding: 9px 0; background: transparent; color: var(--rc-muted); cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center; gap: 6px; --mdc-icon-size: 18px; }
  .seg button[aria-pressed="true"] { background: var(--rc-surface); color: var(--rc-fg); box-shadow: 0 1px 2px rgba(0, 0, 0, .15); }
  .seg button[aria-pressed="true"].h { color: var(--rc-heat); }
  .send { min-height: 18px; font-size: 12px; color: var(--rc-muted); text-align: center; }
  .send.done { color: var(--rc-ok); }
  .send.error { color: var(--error-color, #d20f39); }
  .rows { display: grid; border-top: 1px solid var(--rc-line); }
  .row { display: flex; align-items: center; gap: 10px; padding: 10px 2px; border-bottom: 1px solid var(--rc-line); font-size: 14px; --mdc-icon-size: 18px; }
  .row ha-icon { color: var(--rc-muted); }
  .row .v { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 500; }
  .banner { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-radius: 12px; font-size: 13px; line-height: 1.4;
    background: color-mix(in srgb, var(--rc-t2) 14%, transparent); border: 1px solid color-mix(in srgb, var(--rc-t2) 40%, transparent); --mdc-icon-size: 18px; }
  .banner ha-icon { color: var(--rc-t2); flex: none; }
  .banner b { font-weight: 500; }
  .dial.window .val { stroke: var(--rc-t2); opacity: .45; }
  .dial.window .knob { fill: var(--rc-t2); }
  .pill.window { color: var(--rc-t2); background: color-mix(in srgb, var(--rc-t2) 14%, transparent); }
  .more { justify-self: center; background: none; border: 0; color: var(--rc-accent); font-size: 13px; cursor: pointer; padding: 4px 8px; }
  .sensor-big { justify-self: center; text-align: center; font-variant-numeric: tabular-nums; padding-block: 12px; }
  .sensor-big .big { font-size: 56px; font-weight: 500; line-height: 1; }
  .sensor-big .big small { font-size: 20px; color: var(--rc-muted); font-weight: 400; }
  .sensor-big p { margin: 8px 0 0; font-size: 13px; color: var(--rc-muted); }
  button:focus-visible { outline: 2px solid var(--rc-accent); outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) { .scrim, .sheet, .val, .btn { transition-duration: 1ms !important; } }
`;

if (!customElements.get('raumklima-card')) customElements.define('raumklima-card', RaumklimaCard);
if (!customElements.get('raumklima-card-dialog')) customElements.define('raumklima-card-dialog', RaumklimaDialog);

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === 'raumklima-card')) {
  window.customCards.push({
    type: 'raumklima-card',
    name: 'Raumklima Card',
    description: 'Stockwerke und Räume mit Temperatur-Farbverlauf, Tap öffnet das Sollwert-Popup.',
    documentationURL: 'https://github.com/BrianPiffler/raumklima-card',
  });
}
console.info(`%c RAUMKLIMA-CARD %c ${VERSION} `, 'background:#89b4fa;color:#11111b;font-weight:700', 'background:#313244;color:#cdd6f4');
