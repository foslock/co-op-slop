import type { ItemType } from 'shared';

/** Escape untrusted text (player names, seeds, room codes) before it goes anywhere near innerHTML. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}
const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function formatTime(ms: number): string {
  ms = Math.max(0, ms);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

// ---------- public data shapes for the per-frame HUD widgets ----------

export interface AltimeterData {
  total: number; // summit height in metres
  checkpoints: { height: number; label: string; reached: boolean }[]; // zone start heights, ascending
  players: { id: string; name: string; color: string; height: number; me: boolean; finished: boolean }[];
}

export interface TeamMarker {
  id: string;
  name: string;
  color: string; // css color
  ndcX: number; // projected head position, normalized device coords (-1..1 on screen)
  ndcY: number; // +1 = top of screen
  behind: boolean; // behind the camera (ndc mirrored — treat as off-screen, flip direction)
  distance: number; // metres from the local player
}

export type CrosshairMode = 'hidden' | 'dot' | 'aim-ok' | 'aim-bad';

export interface Prompt {
  key: string;
  text: string;
}

// ---------- static content ----------

const ITEM_META: Record<ItemType, { icon: string; name: string; desc: string; keys: [string, string][] }> = {
  doublejump: { icon: '🥾', name: 'Double Jump', desc: 'Passive — jump again in midair', keys: [['G', 'give']] },
  telescope: { icon: '🔭', name: 'Telescope', desc: 'Scout the route ahead', keys: [['Right-click', 'zoom'], ['G', 'give']] },
  grapple: { icon: '🪝', name: 'Grappling Hook', desc: 'Hang a rope everyone can climb', keys: [['Q', 'throw'], ['G', 'give']] },
};

// Grouped key reference, shared by the pause screen and the "How to play" modal.
// Each entry in `keys` is one cap; "W/S" renders as two caps with a slash.
export const CONTROL_GROUPS: { title: string; icon: string; rows: [string[], string][] }[] = [
  {
    title: 'Move',
    icon: '🏃',
    rows: [
      [['W', 'A', 'S', 'D'], 'Walk'],
      [['Space'], 'Jump'],
      [['Mouse'], 'Look around'],
      [['Z'], 'Dive'],
    ],
  },
  {
    title: 'Climb',
    icon: '🧗',
    rows: [
      [['Shift'], 'Hold to grab a rope or ladder'],
      [['Shift'], 'Hold while jumping at a ledge — hang on for up to 5 s'],
      [['W/S'], 'Climb up · shimmy across'],
      [['A/D'], 'Swing on a hanging rope'],
      [['Space'], 'Jump off'],
      [['Shift'], 'Release to let go'],
    ],
  },
  {
    title: 'Team',
    icon: '🤝',
    rows: [
      [['F'], 'Hold hands'],
      [['G'], 'Give item (drops it if nobody is near)'],
      [['Shift'], 'Next to a hanging teammate — pull them up'],
      [['B'], 'Ping your position'],
    ],
  },
  {
    title: 'Other',
    icon: '🎒',
    rows: [
      [['Q'], 'Use item (grappling hook)'],
      [['Right-click'], 'Zoom (with telescope)'],
      [['R'], 'Reset to checkpoint'],
      [['Esc'], 'Pause'],
    ],
  },
];

const kbd = (k: string) =>
  k
    .split('/')
    .map((part) => `<kbd>${escapeHtml(part)}</kbd>`)
    .join('<span class="kbd-or">/</span>');

/** Markup for the grouped controls reference (static text only). */
export function controlsHtml(): string {
  return CONTROL_GROUPS.map(
    (g) =>
      `<section class="ctrl-group"><h3><span class="ctrl-icon">${g.icon}</span>${g.title}</h3>${g.rows
        .map(([keys, label]) => `<div class="ctrl-row"><span class="ctrl-keys">${keys.map(kbd).join('')}</span><span class="ctrl-label">${label}</span></div>`)
        .join('')}</section>`,
  ).join('');
}

export interface HudCallbacks {
  onClickToPlay: () => void;
  onResume: () => void;
  onLeave: () => void;
}

interface MateRow {
  el: HTMLDivElement;
  dot: HTMLSpanElement;
  name: HTMLSpanElement;
  falls: HTMLSpanElement;
  height: HTMLSpanElement;
  bar: HTMLSpanElement;
  v: { name: string; me: boolean; color: string; falls: number; height: number; finished: boolean; p: number; order: number };
}

interface AltPlayer {
  wrap: HTMLDivElement;
  dot: HTMLDivElement;
  v: { color: string; me: boolean; finished: boolean; p: number; name: string };
}

interface MarkerEl {
  el: HTMLDivElement;
  arrow: HTMLDivElement;
  initial: HTMLSpanElement;
  label: HTMLSpanElement;
  dist: HTMLSpanElement;
  v: { mode: string; name: string; color: string; d: number; x: number; y: number; a: number; flip: boolean };
}

const TOAST_LIFE_MS = 3500;
const TOAST_MAX = 5;
const BANNER_MS = 2800;
const FAR_MARKER_M = 25;

export class Hud {
  root: HTMLDivElement;
  private timerDigits: HTMLSpanElement;
  private zone: HTMLDivElement;
  private heightNow: HTMLSpanElement;
  private heightTotal: HTMLSpanElement;
  private gravity: HTMLDivElement;
  private gravityText: HTMLSpanElement;
  private team: HTMLDivElement;
  private item: HTMLDivElement;
  private center: HTMLDivElement;
  private toasts: HTMLDivElement;
  private clickOverlay: HTMLDivElement;
  private pauseEl: HTMLDivElement;
  private controlsSheet: HTMLDivElement;
  private controlsBtn: HTMLButtonElement;
  private alt: HTMLDivElement;
  private altFill: HTMLDivElement;
  private altTicks: HTMLDivElement;
  private altPlayers: HTMLDivElement;
  private altNext: HTMLDivElement;
  private markersEl: HTMLDivElement;
  private crosshair: HTMLDivElement;
  private promptEl: HTMLDivElement;
  private promptKey: HTMLElement;
  private promptText: HTMLSpanElement;
  private banner: HTMLDivElement;
  private flashEl: HTMLDivElement;
  private hangEl: HTMLDivElement;
  private hangArc: SVGCircleElement;
  private hangSecs: HTMLSpanElement;

  // diff caches — per-frame setters only touch the DOM when something changed
  private lastCountdown = -1;
  private countdownTimer: number | null = null;
  private timerStr = '';
  private timerChars: HTMLSpanElement[] = [];
  private zoneV = { label: '\u0000', h: -1, total: -1, g: -1 };
  private totalM = 0;
  private mates: MateRow[] = [];
  private itemV: ItemType | null | undefined = undefined;
  private lockV: boolean | null = null;
  private altV = { visible: false, total: -1, firstH: NaN, lastH: NaN, next: -2, fill: -1 };
  private altTickEls: { el: HTMLDivElement; reached: boolean }[] = [];
  private altPlayerEls = new Map<string, AltPlayer>();
  private altSeen = new Set<string>();
  private markerEls = new Map<string, MarkerEl>();
  private markerSeen = new Set<string>();
  private crosshairV: CrosshairMode = 'hidden';
  private promptV = '';
  private bannerTimer: number | null = null;
  private hangV = { show: false, secs: '', p: -1, urgent: false };
  private lastToast: { el: HTMLDivElement; text: string; cls: string; count: number; timers: number[] } | null = null;
  private vw = window.innerWidth;
  private vh = window.innerHeight;
  private onResize = () => {
    this.vw = window.innerWidth;
    this.vh = window.innerHeight;
  };

  constructor(parent: HTMLElement, callbacks: HudCallbacks) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="hud-flash"></div>
      <div class="hud-markers"></div>
      <div class="hud-crosshair" data-mode="hidden">
        <span class="ch-dot"></span>
        <span class="ch-ring"><i></i><i></i><i></i><i></i></span>
      </div>
      <div class="hud-zonebox">
        <div class="hud-zone"></div>
        <div class="hud-height"><span class="hud-h-now">0</span><span class="hud-h-unit">m</span><span class="hud-h-total"></span></div>
        <div class="hud-gravity" hidden><span class="hud-gravity-icon">🌙</span><span class="hud-gravity-text"></span></div>
      </div>
      <div class="hud-timer"><span class="hud-timer-icon" aria-hidden="true">⏱</span><span class="hud-timer-digits"></span></div>
      <div class="hud-team"></div>
      <div class="hud-alt" hidden>
        <div class="alt-flag" aria-hidden="true">🚩</div>
        <div class="alt-track">
          <div class="alt-fill"></div>
          <div class="alt-ticks"></div>
          <div class="alt-next"></div>
          <div class="alt-players"></div>
        </div>
      </div>
      <div class="hud-banner"><div class="zb-card"><div class="zb-num"></div><div class="zb-label"></div><div class="zb-flavor"></div></div></div>
      <div class="hud-center"></div>
      <div class="hud-toasts"></div>
      <div class="hud-hang" aria-live="off">
        <div class="hang-ring">
          <svg viewBox="0 0 52 52" aria-hidden="true">
            <circle class="hang-track" cx="26" cy="26" r="22" pathLength="100" />
            <circle class="hang-arc" cx="26" cy="26" r="22" pathLength="100" />
          </svg>
          <span class="hang-secs">5.0</span>
        </div>
        <div class="hang-label">Hanging on<span>!</span></div>
      </div>
      <div class="hud-prompt"><kbd class="prompt-key"></kbd><span class="prompt-text"></span></div>
      <div class="hud-item"></div>
      <div class="click-to-play">
        <div class="ctp-card">
          <div class="ctp-mouse" aria-hidden="true"><span></span></div>
          <div class="ctp-title">Click to look around</div>
          <div class="ctp-sub"><kbd>Esc</kbd> pause &amp; controls</div>
        </div>
      </div>
      <div class="pause-overlay">
        <div class="pause-panel">
          <div class="pause-head">
            <div class="pause-title">PAUSED</div>
            <div class="pause-sub">⏱ The clock is still running for your team</div>
          </div>
          <div class="pause-buttons">
            <button id="resume" class="big">Resume</button>
            <button id="controls-toggle" class="secondary">Controls</button>
            <button id="leave" class="ghost danger">Leave Game</button>
          </div>
          <div class="controls-sheet" id="controls-sheet" hidden>${controlsHtml()}</div>
        </div>
      </div>
    `;
    parent.appendChild(this.root);
    const q = <T extends Element>(sel: string) => this.root.querySelector<T>(sel)!;
    this.timerDigits = q('.hud-timer-digits');
    this.zone = q('.hud-zone');
    this.heightNow = q('.hud-h-now');
    this.heightTotal = q('.hud-h-total');
    this.gravity = q('.hud-gravity');
    this.gravityText = q('.hud-gravity-text');
    this.team = q('.hud-team');
    this.item = q('.hud-item');
    this.center = q('.hud-center');
    this.toasts = q('.hud-toasts');
    this.alt = q('.hud-alt');
    this.altFill = q('.alt-fill');
    this.altTicks = q('.alt-ticks');
    this.altPlayers = q('.alt-players');
    this.altNext = q('.alt-next');
    this.markersEl = q('.hud-markers');
    this.crosshair = q('.hud-crosshair');
    this.promptEl = q('.hud-prompt');
    this.promptKey = q('.prompt-key');
    this.promptText = q('.prompt-text');
    this.banner = q('.hud-banner');
    this.flashEl = q('.hud-flash');
    this.hangEl = q('.hud-hang');
    this.hangArc = q('.hang-arc');
    this.hangSecs = q('.hang-secs');
    this.clickOverlay = q('.click-to-play');
    this.clickOverlay.addEventListener('click', callbacks.onClickToPlay);
    this.pauseEl = q('.pause-overlay');
    this.pauseEl.querySelector('#resume')!.addEventListener('click', callbacks.onResume);
    this.pauseEl.querySelector('#leave')!.addEventListener('click', callbacks.onLeave);
    this.controlsSheet = q('#controls-sheet');
    this.controlsBtn = q('#controls-toggle');
    this.controlsBtn.addEventListener('click', () => this.setControlsOpen(this.controlsSheet.hidden));
    window.addEventListener('resize', this.onResize);
    this.setTimer(0);
  }

  // ---------- pause ----------

  /** Show/hide the key reference; the choice sticks for the rest of the run. */
  private setControlsOpen(open: boolean) {
    this.controlsSheet.hidden = !open;
    this.controlsBtn.textContent = open ? 'Hide Controls' : 'Controls';
    this.controlsBtn.classList.toggle('active', open);
  }

  showPause() {
    this.pauseEl.classList.add('show');
    this.root.classList.add('paused');
  }

  hidePause() {
    this.pauseEl.classList.remove('show');
    this.root.classList.remove('paused');
  }

  // ---------- top bar ----------

  setTimer(ms: number) {
    const s = formatTime(ms);
    if (s === this.timerStr) return;
    if (s.length !== this.timerStr.length) {
      // (re)build one fixed-width cell per character so the digits never jitter
      this.timerDigits.textContent = '';
      this.timerChars = [];
      const dot = s.indexOf('.');
      for (let i = 0; i < s.length; i++) {
        const span = document.createElement('span');
        const ch = s[i];
        span.className = (ch === ':' || ch === '.' ? 'tp' : 'td') + (i > dot ? ' tcs' : '');
        span.textContent = ch;
        this.timerDigits.appendChild(span);
        this.timerChars.push(span);
      }
    } else {
      for (let i = 0; i < s.length; i++) if (s[i] !== this.timerStr[i]) this.timerChars[i].textContent = s[i];
    }
    this.timerStr = s;
  }

  setZoneInfo(label: string, heightM: number, totalM: number, gravityScale = 1) {
    const v = this.zoneV;
    this.totalM = totalM;
    if (label !== v.label) {
      v.label = label;
      this.zone.textContent = label;
    }
    const h = Math.max(0, Math.round(heightM));
    if (h !== v.h) {
      v.h = h;
      this.heightNow.textContent = String(h);
    }
    const t = Math.round(totalM);
    if (t !== v.total) {
      v.total = t;
      this.heightTotal.textContent = `/ ${t} m`;
    }
    const g = gravityScale < 0.995 ? Math.round(gravityScale * 100) : 100;
    if (g !== v.g) {
      v.g = g;
      this.gravity.hidden = g >= 100;
      this.gravityText.textContent = `${g}% gravity`;
    }
  }

  setTeam(rows: { name: string; color: string; height: number; finished: boolean; falls: number }[]) {
    if (rows.length !== this.mates.length) this.buildMates(rows.length);
    // wall of shame: most falls at the top (stable for ties)
    const order = rows.map((_, i) => i).sort((a, b) => rows[b].falls - rows[a].falls || a - b);
    for (let pos = 0; pos < order.length; pos++) {
      const m = this.mates[order[pos]];
      if (m.v.order !== pos) {
        m.v.order = pos;
        m.el.style.order = String(pos);
      }
    }
    const total = this.totalM;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const m = this.mates[i];
      const v = m.v;
      let name = r.name;
      const me = name.endsWith(' (you)');
      if (me) name = name.slice(0, -6);
      if (name !== v.name) {
        v.name = name;
        m.name.textContent = name;
      }
      if (me !== v.me) {
        v.me = me;
        m.el.classList.toggle('me', me);
      }
      if (r.color !== v.color) {
        v.color = r.color;
        m.el.style.setProperty('--c', r.color);
      }
      if (r.falls !== v.falls) {
        const bumped = v.falls >= 0 && r.falls > v.falls;
        v.falls = r.falls;
        m.falls.textContent = `💀 ${r.falls}`;
        if (bumped) restartAnim(m.falls, 'bump');
      }
      const h = Math.max(0, Math.round(r.height));
      if (h !== v.height) {
        v.height = h;
        m.height.textContent = `${h} m`;
      }
      if (r.finished !== v.finished) {
        v.finished = r.finished;
        m.el.classList.toggle('done', r.finished);
      }
      const p = r.finished ? 1 : total > 0 ? clamp01(r.height / total) : 0;
      if (Math.abs(p - v.p) > 0.002) {
        v.p = p;
        m.bar.style.transform = `scaleX(${p.toFixed(3)})`;
      }
    }
  }

  private buildMates(n: number) {
    this.team.textContent = '';
    this.mates = [];
    for (let i = 0; i < n; i++) {
      const el = document.createElement('div');
      el.className = 'hud-mate';
      el.innerHTML =
        '<span class="mate-dot"></span><span class="mate-name"></span><span class="mate-you">you</span>' +
        '<span class="mate-flag" aria-hidden="true">🚩</span><span class="mate-falls"></span><span class="mate-height"></span>' +
        '<span class="mate-bar"><span></span></span>';
      this.team.appendChild(el);
      this.mates.push({
        el,
        dot: el.querySelector('.mate-dot')!,
        name: el.querySelector('.mate-name')!,
        falls: el.querySelector('.mate-falls')!,
        height: el.querySelector('.mate-height')!,
        bar: el.querySelector('.mate-bar > span')!,
        v: { name: '\u0000', me: false, color: '', falls: -1, height: -1, finished: false, p: -1, order: -1 },
      });
    }
  }

  // ---------- item slot ----------

  setItem(item: ItemType | null) {
    if (item === this.itemV) return;
    this.itemV = item;
    this.root.classList.toggle('has-item', !!item);
    if (!item) {
      this.item.classList.remove('show');
      return;
    }
    const meta = ITEM_META[item];
    this.item.innerHTML =
      `<div class="item-icon">${meta.icon}</div>` +
      `<div class="item-body"><div class="item-name">${meta.name}</div><div class="item-desc">${meta.desc}</div>` +
      `<div class="item-keys">${meta.keys.map(([k, what]) => `<span><kbd>${k}</kbd>${what}</span>`).join('')}</div></div>`;
    this.item.classList.add('show');
    restartAnim(this.item, 'pop');
  }

  // ---------- countdown / toasts ----------

  countdown(secondsLeft: number): number | null {
    const n = Math.ceil(secondsLeft);
    if (n === this.lastCountdown) return null;
    this.lastCountdown = n;
    if (this.countdownTimer !== null) {
      clearTimeout(this.countdownTimer);
      this.countdownTimer = null;
    }
    const div = document.createElement('div');
    div.className = n > 0 ? `countdown n${Math.min(n, 3)}` : 'countdown go';
    div.textContent = n > 0 ? String(n) : 'GO!';
    this.center.replaceChildren(div);
    if (n <= 0) {
      this.countdownTimer = window.setTimeout(() => {
        this.countdownTimer = null;
        this.center.replaceChildren();
      }, 1000);
    }
    return n;
  }

  toast(text: string, cls: '' | 'good' | 'bad' = '') {
    // the same message again while it's still up just bumps a ×N counter
    const last = this.lastToast;
    if (last && last.text === text && last.cls === cls && last.el.isConnected && !last.el.classList.contains('out')) {
      last.count++;
      let badge = last.el.querySelector<HTMLSpanElement>('.toast-count');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'toast-count';
        last.el.appendChild(badge);
      }
      badge.textContent = `×${last.count}`;
      restartAnim(badge, 'bump');
      last.timers.forEach(clearTimeout);
      last.timers = this.scheduleToastExit(last.el);
      return;
    }
    const div = document.createElement('div');
    div.className = `hud-toast${cls ? ` ${cls}` : ''}`;
    const label = document.createElement('span');
    label.className = 'toast-text';
    label.textContent = text;
    div.appendChild(label);
    this.toasts.appendChild(div);
    while (this.toasts.childElementCount > TOAST_MAX) this.toasts.firstElementChild!.remove();
    this.lastToast = { el: div, text, cls, count: 1, timers: this.scheduleToastExit(div) };
  }

  private scheduleToastExit(el: HTMLDivElement): number[] {
    return [
      window.setTimeout(() => el.classList.add('out'), TOAST_LIFE_MS - 350),
      window.setTimeout(() => el.remove(), TOAST_LIFE_MS),
    ];
  }

  setPointerLocked(locked: boolean, playing: boolean) {
    const show = !locked && playing;
    if (show === this.lockV) return;
    this.lockV = show;
    this.clickOverlay.classList.toggle('show', show);
  }

  // ---------- altimeter ----------

  setAltimeter(d: AltimeterData) {
    const v = this.altV;
    const visible = !!d && d.total > 0;
    if (visible !== v.visible) {
      v.visible = visible;
      this.alt.hidden = !visible;
    }
    if (!visible) return;

    const cps = d.checkpoints;
    const firstH = cps.length ? cps[0].height : NaN;
    const lastH = cps.length ? cps[cps.length - 1].height : NaN;
    if (d.total !== v.total || cps.length !== this.altTickEls.length || !sameNum(firstH, v.firstH) || !sameNum(lastH, v.lastH)) {
      v.total = d.total;
      v.firstH = firstH;
      v.lastH = lastH;
      v.next = -2;
      this.altTicks.textContent = '';
      this.altTickEls = cps.map((c) => {
        const el = document.createElement('div');
        el.className = 'alt-tick';
        el.style.bottom = `${(clamp01(c.height / d.total) * 100).toFixed(2)}%`;
        this.altTicks.appendChild(el);
        return { el, reached: false };
      });
    }
    let next = -1;
    for (let i = 0; i < cps.length; i++) {
      const t = this.altTickEls[i];
      if (t.reached !== cps[i].reached) {
        t.reached = cps[i].reached;
        t.el.classList.toggle('on', t.reached);
      }
      if (next < 0 && !cps[i].reached) next = i;
    }
    if (next !== v.next) {
      v.next = next;
      if (next < 0) this.altNext.hidden = true;
      else {
        this.altNext.hidden = false;
        this.altNext.textContent = cps[next].label;
        this.altNext.style.bottom = `${(clamp01(cps[next].height / d.total) * 100).toFixed(2)}%`;
      }
    }

    const seen = this.altSeen;
    seen.clear();
    let myP = -1;
    for (const p of d.players) {
      seen.add(p.id);
      let e = this.altPlayerEls.get(p.id);
      if (!e) {
        const wrap = document.createElement('div');
        wrap.className = 'alt-player';
        const dot = document.createElement('div');
        dot.className = 'alt-dot';
        wrap.appendChild(dot);
        this.altPlayers.appendChild(wrap);
        e = { wrap, dot, v: { color: '', me: false, finished: false, p: -1, name: '' } };
        this.altPlayerEls.set(p.id, e);
      }
      const ev = e.v;
      if (p.color !== ev.color) {
        ev.color = p.color;
        e.wrap.style.setProperty('--c', p.color);
      }
      if (p.me !== ev.me) {
        ev.me = p.me;
        e.wrap.classList.toggle('me', p.me);
      }
      if (p.finished !== ev.finished) {
        ev.finished = p.finished;
        e.wrap.classList.toggle('done', p.finished);
      }
      if (p.name !== ev.name) {
        ev.name = p.name;
        e.dot.title = p.name;
      }
      const frac = p.finished ? 1 : clamp01(p.height / d.total);
      if (Math.abs(frac - ev.p) > 0.0008) {
        ev.p = frac;
        // the wrapper spans the whole track, so a % translate is a fraction of the track height
        e.wrap.style.transform = `translate3d(0, ${(-frac * 100).toFixed(2)}%, 0)`;
      }
      if (p.me) myP = frac;
    }
    for (const [id, e] of this.altPlayerEls) {
      if (!seen.has(id)) {
        e.wrap.remove();
        this.altPlayerEls.delete(id);
      }
    }
    const fill = Math.max(0, myP);
    if (Math.abs(fill - v.fill) > 0.0008) {
      v.fill = fill;
      this.altFill.style.transform = `scaleY(${fill.toFixed(4)})`;
    }
  }

  // ---------- off-screen teammate markers ----------

  setMarkers(markers: TeamMarker[]) {
    const W = this.vw;
    const H = this.vh;
    const cx = W / 2;
    const cy = H / 2;
    // keep edge chips clear of the altimeter (left), team list (top-right) and item slot (bottom)
    const left = 100;
    const right = W - 70;
    const top = 70;
    const bottom = H - 96;
    const seen = this.markerSeen;
    seen.clear();
    for (const mk of markers) {
      seen.add(mk.id);
      let e = this.markerEls.get(mk.id);
      if (!e) e = this.createMarker(mk.id);
      const v = e.v;
      let x = mk.ndcX;
      let y = mk.ndcY;
      const onScreen = !mk.behind && x >= -1 && x <= 1 && y >= -1 && y <= 1;
      const mode = onScreen ? (mk.distance > FAR_MARKER_M ? 'far' : 'none') : 'edge';
      if (mode !== v.mode) {
        v.mode = mode;
        e.el.dataset.mode = mode;
      }
      if (mode === 'none') continue;

      if (mk.name !== v.name) {
        v.name = mk.name;
        e.label.textContent = mk.name;
        e.initial.textContent = (Array.from(mk.name.trim())[0] ?? '?').toUpperCase();
      }
      if (mk.color !== v.color) {
        v.color = mk.color;
        e.el.style.setProperty('--c', mk.color);
      }
      const dist = Math.round(mk.distance);
      if (dist !== v.d) {
        v.d = dist;
        e.dist.textContent = `${dist} m`;
      }

      let px: number;
      let py: number;
      if (mode === 'far') {
        px = (x * 0.5 + 0.5) * W;
        py = (-y * 0.5 + 0.5) * H - 46; // float above the 3D name tag
        px = Math.min(Math.max(px, 40), W - 40);
        py = Math.min(Math.max(py, 20), H - 20);
      } else {
        if (mk.behind) {
          x = -x;
          y = -y;
        }
        const dx = x * cx;
        let dy = -y * cy;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) dy = 1; // dead behind: point down
        // walk out from the centre along (dx, dy) until we hit the inset rectangle
        const sx = dx > 0 ? (right - cx) / dx : dx < 0 ? (left - cx) / dx : Infinity;
        const sy = dy > 0 ? (bottom - cy) / dy : dy < 0 ? (top - cy) / dy : Infinity;
        const s = Math.min(sx, sy);
        px = cx + dx * s;
        py = cy + dy * s;
        const a = Math.atan2(dy, dx);
        if (Math.abs(a - v.a) > 0.015) {
          v.a = a;
          e.arrow.style.transform = `rotate(${a.toFixed(3)}rad)`;
        }
        // label goes on the side facing the screen centre
        const flip = py > cy;
        if (flip !== v.flip) {
          v.flip = flip;
          e.el.classList.toggle('flip', flip);
        }
      }
      const rx = Math.round(px);
      const ry = Math.round(py);
      if (rx !== v.x || ry !== v.y) {
        v.x = rx;
        v.y = ry;
        e.el.style.transform = `translate3d(${rx}px, ${ry}px, 0)`;
      }
    }
    for (const [id, e] of this.markerEls) {
      if (!seen.has(id)) {
        e.el.remove();
        this.markerEls.delete(id);
      }
    }
  }

  private createMarker(id: string): MarkerEl {
    const el = document.createElement('div');
    el.className = 'hud-marker';
    el.dataset.mode = 'none';
    el.innerHTML =
      '<div class="mk-edge"><div class="mk-arrow"><i></i></div><span class="mk-initial"></span></div>' +
      '<div class="mk-tag"><span class="mk-name"></span><span class="mk-dist"></span></div>';
    this.markersEl.appendChild(el);
    const e: MarkerEl = {
      el,
      arrow: el.querySelector('.mk-arrow')!,
      initial: el.querySelector('.mk-initial')!,
      label: el.querySelector('.mk-name')!,
      dist: el.querySelector('.mk-dist')!,
      v: { mode: 'none', name: '\u0000', color: '', d: -1, x: NaN, y: NaN, a: NaN, flip: false },
    };
    this.markerEls.set(id, e);
    return e;
  }

  // ---------- crosshair / prompt ----------

  setCrosshair(mode: CrosshairMode) {
    if (mode === this.crosshairV) return;
    this.crosshairV = mode;
    this.crosshair.dataset.mode = mode;
  }

  setPrompt(p: Prompt | null) {
    const key = p ? `${p.key}\u0000${p.text}` : '';
    if (key === this.promptV) return;
    this.promptV = key;
    if (!p) {
      this.promptEl.classList.remove('show');
      return;
    }
    this.promptKey.textContent = p.key;
    this.promptText.textContent = p.text;
    this.promptEl.classList.add('show');
  }

  // ---------- ledge hang ----------

  setHangTimer(state: { remaining: number; total: number } | null) {
    const v = this.hangV;
    const show = !!state && state.total > 0;
    if (show !== v.show) {
      v.show = show;
      this.hangEl.classList.toggle('show', show);
      if (!show) {
        v.p = -1;
        v.secs = '';
      }
    }
    if (!state || !show) return;
    const rem = Math.max(0, state.remaining);
    const p = clamp01(rem / state.total);
    if (Math.abs(p - v.p) > 0.002) {
      v.p = p;
      // pathLength=100, so the offset is simply the drained percentage
      this.hangArc.style.strokeDashoffset = ((1 - p) * 100).toFixed(2);
    }
    const secs = rem.toFixed(1);
    if (secs !== v.secs) {
      v.secs = secs;
      this.hangSecs.textContent = secs;
    }
    const urgent = rem < 1.5;
    if (urgent !== v.urgent) {
      v.urgent = urgent;
      this.hangEl.classList.toggle('urgent', urgent);
    }
  }

  // ---------- one-shots ----------

  zoneBanner(zoneNumber: number, label: string, flavor: string) {
    const card = this.banner.firstElementChild as HTMLDivElement;
    (card.children[0] as HTMLElement).textContent = `ZONE ${zoneNumber}`;
    (card.children[1] as HTMLElement).textContent = label;
    const fl = card.children[2] as HTMLElement;
    fl.textContent = flavor;
    fl.hidden = !flavor;
    if (this.bannerTimer !== null) clearTimeout(this.bannerTimer);
    restartAnim(this.banner, 'show');
    this.bannerTimer = window.setTimeout(() => {
      this.bannerTimer = null;
      this.banner.classList.remove('show');
    }, BANNER_MS);
  }

  flash(kind: 'good' | 'bad' | 'launch') {
    this.flashEl.dataset.kind = kind;
    restartAnim(this.flashEl, 'go');
  }

  dispose() {
    window.removeEventListener('resize', this.onResize);
    if (this.countdownTimer !== null) clearTimeout(this.countdownTimer);
    if (this.bannerTimer !== null) clearTimeout(this.bannerTimer);
    this.lastToast?.timers.forEach(clearTimeout);
    this.root.remove();
  }
}

function clamp01(x: number): number {
  return x > 0 ? (x < 1 ? x : 1) : 0;
}

function sameNum(a: number, b: number): boolean {
  return a === b || (Number.isNaN(a) && Number.isNaN(b));
}

/** Re-trigger a CSS animation bound to `cls` (one forced reflow, only on events). */
function restartAnim(el: HTMLElement, cls: string) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}
