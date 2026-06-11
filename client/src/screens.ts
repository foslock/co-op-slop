import { COSMETIC_COLORS, type Cosmetics, type PlayerInfo, type RunRow } from 'shared';
import { formatTime } from './hud';
import type { FinishInfo } from './game/game';
import { CharacterPreview } from './preview';

const HAT_NAMES = ['None', 'Cap', 'Cone', 'Crown', 'Chef', 'Halo'];
const EYE_NAMES = ['Round', 'Happy', 'Sleepy'];

export interface UICallbacks {
  onCreate(name: string): void;
  onJoin(name: string, code: string): void;
  onReady(ready: boolean): void;
  onCosmetics(cos: Cosmetics): void;
  onSeed(seed: string): void;
  onStart(): void;
  onPlayAgain(): void;
}

export class UI {
  private root: HTMLElement;
  private cb: UICallbacks;
  private screen: HTMLDivElement | null = null;
  private preview: CharacterPreview | null = null;
  cosmetics: Cosmetics;
  name: string;
  private ready = false;

  constructor(root: HTMLElement, cb: UICallbacks) {
    this.root = root;
    this.cb = cb;
    const saved = localStorage.getItem('onlyus.profile');
    const profile = saved ? JSON.parse(saved) : {};
    this.name = profile.name ?? '';
    this.cosmetics = profile.cosmetics ?? { color: Math.floor(Math.random() * COSMETIC_COLORS.length), hat: 0, eyes: 0 };
  }

  private saveProfile() {
    localStorage.setItem('onlyus.profile', JSON.stringify({ name: this.name, cosmetics: this.cosmetics }));
  }

  private setScreen(html: string): HTMLDivElement {
    this.clear();
    const div = document.createElement('div');
    div.className = 'screen';
    div.innerHTML = html;
    this.root.appendChild(div);
    this.screen = div;
    return div;
  }

  clear() {
    this.preview?.dispose();
    this.preview = null;
    this.screen?.remove();
    this.screen = null;
  }

  errorToast(msg: string) {
    const div = document.createElement('div');
    div.className = 'error-toast';
    div.textContent = msg;
    this.root.appendChild(div);
    setTimeout(() => div.remove(), 4000);
  }

  // ---------- home ----------
  showHome() {
    const s = this.setScreen(`
      <div class="title">ONLY US</div>
      <div class="subtitle">a cooperative climb to space · 1–4 players</div>
      <div class="panel">
        <h2>WHO ARE YOU?</h2>
        <input type="text" id="name" maxlength="16" placeholder="Your nickname" value="${this.name.replace(/"/g, '&quot;')}" />
        <button id="create">Create a Room</button>
        <div class="row">
          <input type="text" id="code" class="code grow" maxlength="4" placeholder="CODE" />
          <button id="join" class="secondary">Join</button>
        </div>
        <button id="leaderboard" class="secondary small">🏆 Best Times</button>
      </div>
      <div style="color:var(--muted);font-size:12.5px;max-width:460px;text-align:center;line-height:1.6">
        Climb a tower of giant household junk, from the kitchen floor to deep space.
        Stand on buttons, climb ropes, share items, hold hands across gaps —
        everyone must reach the flag. The clock is ticking. 🚩
      </div>
    `);
    const nameEl = s.querySelector<HTMLInputElement>('#name')!;
    const codeEl = s.querySelector<HTMLInputElement>('#code')!;
    const grabName = (): string | null => {
      const n = nameEl.value.trim();
      if (!n) {
        this.errorToast('Pick a nickname first!');
        nameEl.focus();
        return null;
      }
      this.name = n;
      this.saveProfile();
      return n;
    };
    s.querySelector('#create')!.addEventListener('click', () => {
      const n = grabName();
      if (n) this.cb.onCreate(n);
    });
    const join = () => {
      const n = grabName();
      const code = codeEl.value.trim().toUpperCase();
      if (n && code.length === 4) this.cb.onJoin(n, code);
      else if (n) this.errorToast('Room codes are 4 letters');
    };
    s.querySelector('#join')!.addEventListener('click', join);
    codeEl.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') join();
    });
    s.querySelector('#leaderboard')!.addEventListener('click', () => this.showLeaderboardModal());
  }

  private async showLeaderboardModal() {
    let rows: RunRow[] = [];
    try {
      rows = await (await fetch('/api/leaderboard?limit=20')).json();
    } catch {
      /* server offline */
    }
    const overlay = document.createElement('div');
    overlay.className = 'screen';
    overlay.style.background = 'rgba(5,9,22,0.8)';
    overlay.innerHTML = `
      <div class="panel" style="max-height:70vh;overflow:auto">
        <h2>🏆 BEST TIMES</h2>
        ${this.leaderboardTable(rows, -1)}
        <button class="secondary" id="close">Close</button>
      </div>`;
    this.root.appendChild(overlay);
    overlay.querySelector('#close')!.addEventListener('click', () => overlay.remove());
  }

  private leaderboardTable(rows: RunRow[], highlight: number): string {
    if (rows.length === 0) return `<div style="color:var(--muted)">No completed runs yet. Be the first!</div>`;
    return `<table class="results-table">
      <tr><th>#</th><th>Team</th><th>Time</th><th>Seed</th></tr>
      ${rows
        .map(
          (r, i) =>
            `<tr${i === highlight ? ' class="you"' : ''}><td>${i + 1}</td><td>${r.names.join(', ')}</td>` +
            `<td>${formatTime(r.durationMs)}</td><td style="color:var(--muted)">${r.seed}</td></tr>`,
        )
        .join('')}
    </table>`;
  }

  // ---------- lobby ----------
  showLobby(code: string) {
    const s = this.setScreen(`
      <div class="title" style="font-size:40px">ONLY US</div>
      <div class="panel" style="min-width:560px">
        <div class="code-display" id="codecopy" title="Click to copy">${code}</div>
        <div class="code-hint">share this code with your friends · click to copy</div>
        <div class="lobby-cols">
          <div style="display:flex;flex-direction:column;gap:8px;align-items:center">
            <canvas id="preview-canvas" width="170" height="200"></canvas>
            <div class="swatches" id="colors"></div>
            <div class="row wrap" id="hats" style="justify-content:center"></div>
            <div class="row wrap" id="eyes" style="justify-content:center"></div>
          </div>
          <div class="grow" style="display:flex;flex-direction:column;gap:10px">
            <div class="player-list" id="players"></div>
            <div class="row" id="seedrow" style="display:none">
              <input type="text" id="seed" placeholder="Custom seed (optional)" />
            </div>
            <div class="grow"></div>
            <button id="ready">I'm Ready</button>
            <button id="start" style="display:none" disabled>Start Climb 🚀</button>
            <div id="waitmsg" style="color:var(--muted);font-size:12.5px;text-align:center"></div>
          </div>
        </div>
      </div>
    `);
    this.ready = false;
    s.querySelector('#codecopy')!.addEventListener('click', () => {
      void navigator.clipboard?.writeText(code);
      this.errorToast('Code copied!');
    });
    const previewCanvas = s.querySelector<HTMLCanvasElement>('#preview-canvas')!;
    this.preview = new CharacterPreview(previewCanvas, this.cosmetics);

    const colorsEl = s.querySelector('#colors')!;
    COSMETIC_COLORS.forEach((c, i) => {
      const sw = document.createElement('div');
      sw.className = 'swatch' + (i === this.cosmetics.color ? ' sel' : '');
      sw.style.background = `#${c.toString(16).padStart(6, '0')}`;
      sw.addEventListener('click', () => {
        this.cosmetics.color = i;
        colorsEl.querySelectorAll('.swatch').forEach((el, j) => el.classList.toggle('sel', j === i));
        this.pushCosmetics();
      });
      colorsEl.appendChild(sw);
    });
    const chipRow = (parent: Element, names: string[], get: () => number, set: (i: number) => void) => {
      names.forEach((n, i) => {
        const chip = document.createElement('div');
        chip.className = 'chip' + (i === get() ? ' sel' : '');
        chip.textContent = n;
        chip.addEventListener('click', () => {
          set(i);
          parent.querySelectorAll('.chip').forEach((el, j) => el.classList.toggle('sel', j === i));
          this.pushCosmetics();
        });
        parent.appendChild(chip);
      });
    };
    chipRow(s.querySelector('#hats')!, HAT_NAMES, () => this.cosmetics.hat, (i) => (this.cosmetics.hat = i));
    chipRow(s.querySelector('#eyes')!, EYE_NAMES, () => this.cosmetics.eyes, (i) => (this.cosmetics.eyes = i));

    s.querySelector('#ready')!.addEventListener('click', () => {
      this.ready = !this.ready;
      (s.querySelector('#ready') as HTMLButtonElement).textContent = this.ready ? '✓ Ready! (click to unready)' : "I'm Ready";
      this.cb.onReady(this.ready);
    });
    s.querySelector('#start')!.addEventListener('click', () => this.cb.onStart());
    const seedEl = s.querySelector<HTMLInputElement>('#seed')!;
    seedEl.addEventListener('change', () => this.cb.onSeed(seedEl.value.trim()));
  }

  private pushCosmetics() {
    this.saveProfile();
    this.preview?.setCosmetics(this.cosmetics);
    this.cb.onCosmetics({ ...this.cosmetics });
  }

  updateLobby(players: PlayerInfo[], hostId: string, myId: string, seed: string) {
    if (!this.screen) return;
    const list = this.screen.querySelector('#players');
    if (!list) return;
    list.innerHTML = players
      .map((p) => {
        const color = COSMETIC_COLORS[p.cosmetics.color % COSMETIC_COLORS.length].toString(16).padStart(6, '0');
        const isHost = p.id === hostId;
        const status = isHost ? '<span class="status ready">HOST</span>' : p.ready ? '<span class="status ready">READY</span>' : '<span class="status waiting">waiting…</span>';
        return `<div class="player-card"><span class="dot" style="background:#${color}"></span>` +
          `<span class="who">${p.name}${p.id === myId ? '<span class="tag">(you)</span>' : ''}</span>${status}</div>`;
      })
      .join('') +
      Array.from({ length: 4 - players.length })
        .map(() => `<div class="player-card" style="opacity:.4"><span class="dot" style="background:#444"></span><span class="who" style="color:var(--muted)">empty slot</span></div>`)
        .join('');

    const amHost = myId === hostId;
    const startBtn = this.screen.querySelector<HTMLButtonElement>('#start');
    const readyBtn = this.screen.querySelector<HTMLButtonElement>('#ready');
    const seedRow = this.screen.querySelector<HTMLElement>('#seedrow');
    const waitMsg = this.screen.querySelector<HTMLElement>('#waitmsg');
    if (!startBtn || !readyBtn || !seedRow || !waitMsg) return;
    seedRow.style.display = amHost ? 'flex' : 'none';
    const seedEl = this.screen.querySelector<HTMLInputElement>('#seed')!;
    if (document.activeElement !== seedEl && seedEl.value !== seed) seedEl.value = seed;
    startBtn.style.display = amHost ? 'block' : 'none';
    readyBtn.style.display = amHost ? 'none' : 'block';
    const allReady = players.every((p) => p.ready || p.id === hostId);
    startBtn.disabled = !allReady;
    waitMsg.textContent = amHost
      ? allReady
        ? players.length === 1
          ? 'You can climb solo, but it’s better with friends!'
          : 'Everyone is ready — start when you like!'
        : 'Waiting for everyone to ready up…'
      : 'The host starts the game once everyone is ready';
  }

  // ---------- loading ----------
  showLoading(text: string) {
    this.setScreen(`
      <div class="title" style="font-size:40px">ONLY US</div>
      <div class="panel" style="align-items:center">
        <h2>${text}</h2>
        <div style="font-size:40px;animation:pop 1s infinite alternate">🧗</div>
      </div>
    `);
  }

  // ---------- results ----------
  showResults(info: FinishInfo, players: PlayerInfo[], amHost: boolean) {
    const fallLines = players
      .map((p) => `<div style="color:var(--muted);font-size:13px">${p.name}: fell ${info.falls[p.id] ?? 0} time${(info.falls[p.id] ?? 0) === 1 ? '' : 's'}</div>`)
      .join('');
    const highlight = info.rank !== null ? info.rank - 1 : -1;
    const s = this.setScreen(`
      <div class="panel" style="min-width:520px;max-height:84vh;overflow:auto;align-items:center">
        <h2>🚩 YOU MADE IT — ALL OF YOU!</h2>
        <div class="big-time">${formatTime(info.durationMs)}</div>
        ${info.rank !== null ? `<div style="color:var(--accent);font-weight:700">#${info.rank} on the all-time leaderboard</div>` : ''}
        <div>${fallLines}</div>
        <h2 style="margin-top:8px">BEST TIMES</h2>
        ${this.leaderboardTable(info.top, highlight)}
        ${amHost ? '<button id="again">Back to Lobby 🔄</button>' : '<div style="color:var(--muted)">Waiting for the host to return to the lobby…</div>'}
      </div>
    `);
    s.querySelector('#again')?.addEventListener('click', () => this.cb.onPlayAgain());
  }
}
