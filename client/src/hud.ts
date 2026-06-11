import type { ItemType } from 'shared';

const ITEM_META: Record<ItemType, { icon: string; name: string; hint: string }> = {
  doublejump: { icon: '🥾', name: 'Double Jump', hint: 'passive — jump again in midair · G to give' },
  telescope: { icon: '🔭', name: 'Telescope', hint: 'hold Right Click to zoom · G to give' },
  grapple: { icon: '🪝', name: 'Grappling Hook', hint: 'Q: throw a rope where you aim · G to give' },
};

export function formatTime(ms: number): string {
  ms = Math.max(0, ms);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

export interface HudCallbacks {
  onClickToPlay: () => void;
  onResume: () => void;
  onLeave: () => void;
}

export class Hud {
  root: HTMLDivElement;
  private timer: HTMLDivElement;
  private zone: HTMLDivElement;
  private height: HTMLDivElement;
  private team: HTMLDivElement;
  private item: HTMLDivElement;
  private center: HTMLDivElement;
  private toasts: HTMLDivElement;
  private clickOverlay: HTMLDivElement;
  private pauseEl: HTMLDivElement;
  private lastCountdown = -1;

  constructor(parent: HTMLElement, callbacks: HudCallbacks) {
    this.root = document.createElement('div');
    this.root.innerHTML = `
      <div class="hud-top">
        <div class="hud-left">
          <div class="hud-zone"></div>
          <div class="hud-height"></div>
        </div>
        <div class="hud-timer">0:00.00</div>
        <div class="hud-team"></div>
      </div>
      <div class="hud-center"></div>
      <div class="toast"></div>
      <div class="hud-item" style="display:none"></div>
      <div class="hud-help">
        <b>WASD</b> move &nbsp;<b>Space</b> jump &nbsp;<b>Mouse</b> look<br>
        ropes/ladders grab on touch &nbsp;<b>E</b> let go &nbsp;<b>F</b> hold hands &nbsp;<b>Z</b> dive<br>
        <b>Q</b> use item &nbsp;<b>G</b> give item &nbsp;<b>B</b> ping
      </div>
      <div class="click-to-play" style="display:none">Click to look around 🔍</div>
      <div class="pause-overlay" style="display:none">
        <div class="panel" style="align-items:center;min-width:320px">
          <h2>⏸ PAUSED</h2>
          <div style="color:var(--muted);font-size:13px;text-align:center">
            The climb keeps going for your team —<br>the timer doesn't stop!
          </div>
          <button id="resume" style="width:100%">Resume</button>
          <button id="leave" class="secondary" style="width:100%">Leave Game</button>
        </div>
      </div>
    `;
    parent.appendChild(this.root);
    this.timer = this.root.querySelector('.hud-timer')!;
    this.zone = this.root.querySelector('.hud-zone')!;
    this.height = this.root.querySelector('.hud-height')!;
    this.team = this.root.querySelector('.hud-team')!;
    this.item = this.root.querySelector('.hud-item')!;
    this.center = this.root.querySelector('.hud-center')!;
    this.toasts = this.root.querySelector('.toast')!;
    this.clickOverlay = this.root.querySelector('.click-to-play')!;
    this.clickOverlay.addEventListener('click', callbacks.onClickToPlay);
    this.pauseEl = this.root.querySelector('.pause-overlay')!;
    this.pauseEl.querySelector('#resume')!.addEventListener('click', callbacks.onResume);
    this.pauseEl.querySelector('#leave')!.addEventListener('click', callbacks.onLeave);
  }

  showPause() {
    this.pauseEl.style.display = 'flex';
  }

  hidePause() {
    this.pauseEl.style.display = 'none';
  }

  setTimer(ms: number) {
    this.timer.textContent = formatTime(ms);
  }

  setZoneInfo(label: string, heightM: number, totalM: number, gravityScale = 1) {
    this.zone.textContent = label;
    const gravity = gravityScale < 0.995 ? ` · 🌙 gravity ${Math.round(gravityScale * 100)}%` : '';
    this.height.textContent = `${Math.max(0, heightM).toFixed(0)}m / ${totalM.toFixed(0)}m${gravity}`;
  }

  setTeam(rows: { name: string; color: string; height: number; finished: boolean }[]) {
    this.team.innerHTML = rows
      .map(
        (r) =>
          `<div class="hud-mate"><span>${r.finished ? '🚩 ' : ''}${r.name}</span>` +
          `<span style="opacity:.75">${r.height.toFixed(0)}m</span>` +
          `<span class="dot" style="background:${r.color}"></span></div>`,
      )
      .join('');
  }

  setItem(item: ItemType | null) {
    if (!item) {
      this.item.style.display = 'none';
      return;
    }
    const meta = ITEM_META[item];
    this.item.style.display = 'flex';
    this.item.innerHTML = `<span class="icon">${meta.icon}</span><div><div><b>${meta.name}</b></div><div class="hint">${meta.hint}</div></div>`;
  }

  countdown(secondsLeft: number) {
    const n = Math.ceil(secondsLeft);
    if (n !== this.lastCountdown) {
      this.lastCountdown = n;
      this.center.innerHTML = n > 0 ? `<div class="countdown">${n}</div>` : `<div class="countdown" style="color:#69db7c">GO!</div>`;
      if (n <= 0) setTimeout(() => (this.center.innerHTML = ''), 900);
      return n;
    }
    return null;
  }

  toast(text: string, cls = '') {
    const div = document.createElement('div');
    if (cls) div.className = cls;
    div.textContent = text;
    this.toasts.appendChild(div);
    setTimeout(() => div.remove(), 3500);
  }

  setPointerLocked(locked: boolean, playing: boolean) {
    this.clickOverlay.style.display = !locked && playing ? 'flex' : 'none';
  }

  dispose() {
    this.root.remove();
  }
}
