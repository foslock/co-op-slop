import { COSMETIC_COLORS, type Cosmetics, type PlayerInfo, type RunRow } from 'shared';
import { controlsHtml, escapeHtml, formatTime } from './hud';
import type { FinishInfo } from './game/game';
import { CharacterPreview } from './preview';

const HAT_NAMES = ['None', 'Cap', 'Cone', 'Crown', 'Chef', 'Halo'];
const EYE_NAMES = ['Round', 'Happy', 'Sleepy'];
const CONFETTI_COLORS = ['#ffd24d', '#ff7a7a', '#69db7c', '#4dabf7', '#9775fa', '#f783ac', '#ffffff'];

const TIPS = [
  'Hold <kbd>Shift</kbd> near a rope or ladder to grab it, then <kbd>W</kbd>/<kbd>S</kbd> to climb.',
  'Press <kbd>F</kbd> to hold hands and haul a teammate across a gap.',
  'Some pressure plates only work with two climbers standing on them at once.',
  'The clock only stops when the <b>last</b> teammate reaches the flag.',
  'Press <kbd>G</kbd> to hand your item to a nearby teammate.',
  'Grappling Hook: aim high and press <kbd>Q</kbd> to hang a rope everyone can climb.',
  'Lost the group? Press <kbd>B</kbd> to ping your position.',
  'Stuck? <kbd>R</kbd> pops you back to your last checkpoint.',
  'The air thins as you climb: jumps get higher and floatier near the top.',
  'Seesaw catapult: drop onto the high end to fling a friend skyward.',
  'Hold <kbd>Right-click</kbd> with the Telescope to scout the route ahead.',
  'Hanging from a rope? <kbd>A</kbd>/<kbd>D</kbd> swings you, <kbd>Space</kbd> jumps off.',
  'Crank lift: stand on the crank plate to raise the lift for your friends.',
  'Jump came up short? Hold <kbd>Shift</kbd> at the ledge to hang on while a teammate pulls you up.',
  '<kbd>Z</kbd> dives forward. Good for stretching a jump that came up short.',
];

const logoLetters = (text: string) =>
  [...text]
    .map((ch, i) => (ch === ' ' ? '<span class="logo-gap"></span>' : `<span class="logo-ch" style="--i:${i}" data-ch="${ch}">${ch}</span>`))
    .join('');

const LOGO = `<div class="logo" role="img" aria-label="Only Us">${logoLetters('ONLY US')}<span class="logo-flag" aria-hidden="true">🚩</span></div>`;

function cosColor(idx: unknown): string {
  const n = COSMETIC_COLORS.length;
  const i = Number.isInteger(idx) ? (((idx as number) % n) + n) % n : 0;
  return `#${COSMETIC_COLORS[i].toString(16).padStart(6, '0')}`;
}

const safeIndex = (v: unknown, max: number) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < max ? (v as number) : 0);

/** A little CSS bean in the player's colour, hat and eyes. */
function miniBean(cos: Cosmetics | undefined, extra = ''): string {
  const c = cos ?? { color: 0, hat: 0, eyes: 0 };
  return (
    `<span class="mini-bean ${extra}" style="--bean:${cosColor(c.color)}" data-hat="${safeIndex(c.hat, HAT_NAMES.length)}" ` +
    `data-eyes="${safeIndex(c.eyes, EYE_NAMES.length)}" aria-hidden="true"><i class="eye"></i><i class="eye"></i></span>`
  );
}

export interface UICallbacks {
  onCreate(name: string): void;
  onJoin(name: string, code: string): void;
  onReady(ready: boolean): void;
  onCosmetics(cos: Cosmetics): void;
  onSeed(seed: string): void;
  onStart(): void;
  onPlayAgain(): void;
  onCloseRoom(): void; // host only: kick everyone back to the home screen
  onLeaveRoom(): void;
}

export class UI {
  private root: HTMLElement;
  private cb: UICallbacks;
  private screen: HTMLDivElement | null = null;
  private screenKind = '';
  private preview: CharacterPreview | null = null;
  private modal: { el: HTMLDivElement; close: () => void } | null = null;
  cosmetics: Cosmetics;
  name: string;
  private ready = false;
  private amHost = false;
  private closeArmed = false;
  private closeTimer: number | null = null;
  private tipTimer: number | null = null;
  private tipIndex = Math.floor(Math.random() * TIPS.length);
  // lobby entries we've already animated in, so updates don't replay the entrance
  private seenPlayers = new Set<string>();
  private seenReady = new Set<string>();

  constructor(root: HTMLElement, cb: UICallbacks) {
    this.root = root;
    this.cb = cb;
    let profile: { name?: unknown; cosmetics?: Partial<Cosmetics> } = {};
    try {
      profile = JSON.parse(localStorage.getItem('onlyus.profile') ?? '{}') ?? {};
    } catch {
      /* corrupted or blocked storage: start fresh */
    }
    this.name = typeof profile.name === 'string' ? profile.name : '';
    const saved = profile.cosmetics;
    this.cosmetics = saved
      ? { color: safeIndex(saved.color, COSMETIC_COLORS.length), hat: safeIndex(saved.hat, HAT_NAMES.length), eyes: safeIndex(saved.eyes, EYE_NAMES.length) }
      : { color: Math.floor(Math.random() * COSMETIC_COLORS.length), hat: 0, eyes: 0 };
  }

  private saveProfile() {
    try {
      localStorage.setItem('onlyus.profile', JSON.stringify({ name: this.name, cosmetics: this.cosmetics }));
    } catch {
      /* storage blocked: the profile just won't persist */
    }
  }

  private setScreen(kind: string, html: string): HTMLDivElement {
    this.clear();
    const div = document.createElement('div');
    div.className = `screen screen-${kind}`;
    div.innerHTML = `<div class="screen-inner">${html}</div>`;
    this.root.appendChild(div);
    this.screen = div;
    this.screenKind = kind;
    return div;
  }

  clear() {
    this.disarmClose();
    this.closeModal();
    if (this.tipTimer !== null) {
      clearInterval(this.tipTimer);
      this.tipTimer = null;
    }
    this.preview?.dispose();
    this.preview = null;
    this.screen?.remove();
    this.screen = null;
    this.screenKind = '';
  }

  errorToast(msg: string) {
    this.toast(msg, 'error');
  }

  private toast(msg: string, kind: 'error' | 'info') {
    const div = document.createElement('div');
    div.className = `ui-toast ${kind}`;
    div.setAttribute('role', 'status');
    div.textContent = msg;
    this.root.appendChild(div);
    setTimeout(() => div.classList.add('out'), 3600);
    setTimeout(() => div.remove(), 4000);
  }

  // ---------- modals ----------

  private openModal(cls: string, title: string, bodyHtml: string, footHtml = ''): HTMLDivElement {
    this.closeModal();
    const el = document.createElement('div');
    el.className = 'modal-backdrop';
    el.innerHTML = `
      <div class="modal panel ${cls}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title.replace(/<[^>]*>/g, ""))}">
        <header class="modal-head">
          <h2>${title}</h2>
          <button class="modal-x" aria-label="Close">✕</button>
        </header>
        <div class="modal-body">${bodyHtml}</div>
        ${footHtml ? `<footer class="modal-foot">${footHtml}</footer>` : ''}
      </div>`;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const close = () => {
      window.removeEventListener('keydown', onKey);
      el.remove();
      if (this.modal?.el === el) this.modal = null;
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.target === el) close();
    });
    el.querySelector('.modal-x')!.addEventListener('click', close);
    el.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    window.addEventListener('keydown', onKey);
    this.root.appendChild(el);
    this.modal = { el, close };
    el.querySelector<HTMLButtonElement>('.modal-x')!.focus({ preventScroll: true });
    return el;
  }

  private closeModal() {
    this.modal?.close();
    this.modal = null;
  }

  // ---------- home ----------
  showHome() {
    const s = this.setScreen(
      'home',
      `
      <header class="home-hero">
        ${LOGO}
        <div class="logo-sub">a cooperative climb to space</div>
        <div class="tag-row">
          <span class="tag-pill"><b>🧗</b> 1–4 players</span>
          <span class="tag-pill"><b>⏱</b> 15–25 min</span>
          <span class="tag-pill"><b>🎉</b> no account</span>
        </div>
      </header>
      <div class="panel panel-home">
        <label class="field-label" for="name">Your nickname</label>
        <div class="name-row">
          ${miniBean(this.cosmetics, 'lg')}
          <input type="text" id="name" maxlength="16" placeholder="e.g. Captain Bean" autocomplete="nickname" spellcheck="false" value="${escapeHtml(this.name)}" />
        </div>
        <button id="create" class="big">Create a Room <span class="btn-emoji">🚀</span></button>
        <div class="or-split"><span>or join a friend</span></div>
        <div class="row">
          <input type="text" id="code" class="code grow" maxlength="4" placeholder="CODE" autocomplete="off" spellcheck="false" aria-label="Room code" />
          <button id="join" class="sky">Join</button>
        </div>
        <div class="home-links">
          <button id="howto" class="ghost small"><span class="ico">❓</span>How to play</button>
          <button id="leaderboard" class="ghost small"><span class="ico">🏆</span>Best Times</button>
        </div>
      </div>
      <p class="blurb">
        Climb a tower of giant household junk, from the kitchen floor to deep space.
        Stand on plates, swing on ropes, share items, hold hands across gaps.
        <b>Everyone</b> has to reach the flag, and the clock is ticking. 🚩
      </p>
    `,
    );
    const nameEl = s.querySelector<HTMLInputElement>('#name')!;
    const codeEl = s.querySelector<HTMLInputElement>('#code')!;
    // remember the nickname as it's typed, not just on create/join
    nameEl.addEventListener('input', () => {
      this.name = nameEl.value.trim();
      this.saveProfile();
    });
    nameEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') s.querySelector<HTMLButtonElement>('#create')!.click();
    });
    codeEl.addEventListener('input', () => {
      const clean = codeEl.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (clean !== codeEl.value) codeEl.value = clean;
    });
    const grabName = (): string | null => {
      const n = nameEl.value.trim();
      if (!n) {
        this.errorToast('Pick a nickname first!');
        nameEl.focus();
        restartAnim(nameEl, 'shake');
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
      else if (n) {
        this.errorToast('Room codes are 4 characters');
        restartAnim(codeEl, 'shake');
      }
    };
    s.querySelector('#join')!.addEventListener('click', join);
    codeEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') join();
    });
    s.querySelector('#leaderboard')!.addEventListener('click', () => void this.showLeaderboardModal());
    s.querySelector('#howto')!.addEventListener('click', () => this.showHowToModal());
    if (!this.name) nameEl.focus({ preventScroll: true });
  }

  private async showLeaderboardModal() {
    const el = this.openModal('modal-board', '<span class="ico">🏆</span>Best Times', '<div class="board-loading"><span class="spinner"></span> Fetching the summit log…</div>');
    let rows: RunRow[] | null = null;
    try {
      const res = await fetch('/api/leaderboard?limit=20');
      const data: unknown = await res.json();
      rows = Array.isArray(data) ? (data as RunRow[]) : [];
    } catch {
      rows = null;
    }
    if (!el.isConnected) return;
    el.querySelector('.modal-body')!.innerHTML =
      rows === null ? '<div class="empty-note">📡 Couldn’t reach the server. Try again in a moment.</div>' : this.leaderboardTable(rows, -1);
  }

  private showHowToModal() {
    const tabs: [string, string, string][] = [
      ['goal', '🚩', 'Goal'],
      ['controls', '🎮', 'Controls'],
      ['gadgets', '⚙️', 'Contraptions'],
      ['items', '🎒', 'Items'],
    ];
    const card = (icon: string, title: string, text: string, badge = '', tone = '') =>
      `<div class="info-card ${tone}"><div class="info-icon">${icon}</div><div class="info-text"><h4>${title}${badge ? ` <span class="badge-duo">${badge}</span>` : ''}</h4><p>${text}</p></div></div>`;
    const panels: Record<string, string> = {
      goal: `
        <div class="goal-hero">
          <div class="goal-flag" aria-hidden="true">🚩</div>
          <div>
            <h3>Everyone reaches the flag</h3>
            <p>The climb is over only when the <b>whole crew</b> is standing at the summit flag.
            The clock keeps running until the <b>last teammate</b> arrives, so nobody gets left behind.</p>
          </div>
        </div>
        <div class="info-grid">
          ${card('🧗', 'Climb together', 'Ten zones of giant household junk, from the kitchen floor all the way to deep space.', '', 'tone-sun')}
          ${card('🏁', 'Checkpoints', 'Each zone’s arch saves your spot. Fall too far, or press <kbd>R</kbd>, and you pop back there.', '', 'tone-mint')}
          ${card('🌙', 'Thinning air', 'Gravity drops as you climb. Jumps get higher and floatier near the top, and so do the gaps.', '', 'tone-lav')}
          ${card('⏱', 'Beat the clock', 'Fast crews land on the all-time Best Times board. Teamwork beats speedrunning.', '', 'tone-sky')}
        </div>`,
      controls: `<div class="controls-sheet in-modal">${controlsHtml()}</div>`,
      gadgets: `
        <div class="info-grid">
          ${card('🟡', 'Pressure plates', 'Stand on them to raise bridges. Some need two climbers on them at once.', '', 'tone-sun')}
          ${card('🪢', 'Ropes &amp; ladders', 'Hold <kbd>Shift</kbd> to grab. Strung ropes let you shimmy across gaps.', '', 'tone-sky')}
          ${card('🛗', 'Moving platforms', 'Ride shuttles and lifts across gaps. Mind your timing.', '', 'tone-mint')}
          ${card('🤸', 'Seesaw catapult', 'One climber sits on the seat while a teammate drops onto the high end to fling them up. Whoever’s on top pulls the lever to drop a weight and launch the next.', '2+ players', 'tone-lav')}
          ${card('⚙️', 'Crank lift', 'Someone stands on a crank plate to raise the lift for the others. The climber on top can crank it for the last one.', '2+ players', 'tone-coral')}
          ${card('🙌', 'Ledge saves', 'Hold <kbd>Shift</kbd> as you jump at a ledge just out of reach to grab the edge and hang for up to 5 s. A teammate standing on top presses <kbd>Shift</kbd> to pull you up. Let go, or wait too long, and you drop.', '2+ players', 'tone-sky')}
        </div>
        <p class="modal-note">🧍 Climbing solo? The <b>2+ player</b> contraptions are left out of your tower, and ledge saves are switched off.</p>`,
      items: `
        <div class="info-grid">
          ${card('🥾', 'Double Jump boots', 'Passive. Jump again in midair.', '', 'tone-coral')}
          ${card('🔭', 'Telescope', 'Hold <kbd>Right-click</kbd> to zoom in and scout the route.', '', 'tone-sky')}
          ${card('🪝', 'Grappling Hook', 'Press <kbd>Q</kbd> to hang a rope that <b>everyone</b> can climb.', '', 'tone-sun')}
          ${card('🎁', 'Share the loot', 'One slot each. <kbd>G</kbd> gives your item to a nearby teammate, or drops it if nobody’s close.', '', 'tone-mint')}
        </div>`,
    };
    const el = this.openModal(
      'modal-howto',
      'How to play',
      `<div class="tabs" role="tablist">${tabs
        .map(([id, icon, label], i) => `<button class="tab${i === 0 ? ' sel' : ''}" role="tab" data-tab="${id}" aria-selected="${i === 0}"><span>${icon}</span>${label}</button>`)
        .join('')}</div>
       ${tabs.map(([id], i) => `<div class="tab-panel" data-panel="${id}" role="tabpanel"${i === 0 ? '' : ' hidden'}>${panels[id]}</div>`).join('')}`,
      `<button class="big" data-close>Got it, let’s climb!</button>`,
    );
    const tabBtns = [...el.querySelectorAll<HTMLButtonElement>('.tab')];
    const select = (i: number) => {
      tabBtns.forEach((b, j) => {
        b.classList.toggle('sel', i === j);
        b.setAttribute('aria-selected', String(i === j));
      });
      el.querySelectorAll<HTMLElement>('.tab-panel').forEach((p, j) => (p.hidden = i !== j));
    };
    tabBtns.forEach((b, i) => {
      b.addEventListener('click', () => select(i));
      b.addEventListener('keydown', (e) => {
        const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        const n = (i + d + tabBtns.length) % tabBtns.length;
        select(n);
        tabBtns[n].focus();
      });
    });
  }

  private leaderboardTable(rows: RunRow[], highlight: number): string {
    if (rows.length === 0) return `<div class="empty-note">🏔️ No completed climbs yet. Be the first crew on the board!</div>`;
    const medal = (i: number) => (i < 3 ? `<span class="medal m${i + 1}">${i + 1}</span>` : `<span class="rank-num">${i + 1}</span>`);
    return `<table class="board-table">
      <thead><tr><th>#</th><th>Crew</th><th class="t-time">Time</th><th class="t-seed">Seed</th></tr></thead>
      <tbody>
      ${rows
        .map((r, i) => {
          const names = Array.isArray(r.names) ? r.names.map((n) => escapeHtml(n)).join('<span class="sep">·</span>') : '';
          const when = r.date ? new Date(r.date) : null;
          const title = when && !Number.isNaN(when.getTime()) ? ` title="${escapeHtml(when.toLocaleDateString())}"` : '';
          return (
            `<tr class="${i === highlight ? 'you' : ''}"${title}><td>${medal(i)}</td><td class="t-crew">${names}${i === highlight ? '<span class="you-tag">you!</span>' : ''}</td>` +
            `<td class="t-time">${formatTime(Number(r.durationMs) || 0)}</td><td class="t-seed">${escapeHtml(r.seed)}</td></tr>`
          );
        })
        .join('')}
      </tbody>
    </table>`;
  }

  // ---------- lobby ----------
  showLobby(code: string) {
    const s = this.setScreen(
      'lobby',
      `
      <div class="lobby-head">
        <div class="logo-sm-wrap">${LOGO}</div>
        <button class="code-block" id="codecopy" title="Click to copy the room code">
          <span class="code-label">Room code</span>
          <span class="code-tiles">${[...code].map((ch, i) => `<span class="code-tile" style="--i:${i}">${escapeHtml(ch)}</span>`).join('')}</span>
          <span class="code-hint"><span class="ico">📋</span>click to copy &amp; share</span>
        </button>
      </div>
      <div class="panel panel-lobby">
        <div class="lobby-cols">
          <section class="lobby-col dressing-room">
            <div class="col-label">Your bean</div>
            <div class="preview-stage"><canvas id="preview-canvas"></canvas><span class="preview-hint">drag to spin</span></div>
            <div class="picker"><div class="picker-label">Color</div><div class="swatches" id="colors"></div></div>
            <div class="picker"><div class="picker-label">Hat</div><div class="chip-row" id="hats"></div></div>
            <div class="picker"><div class="picker-label">Eyes</div><div class="chip-row" id="eyes"></div></div>
          </section>
          <section class="lobby-col crew">
            <div class="col-label">The crew <span class="crew-count" id="crewcount"></span></div>
            <div class="player-list" id="players"></div>
            <div class="seed-row" id="seedrow" hidden>
              <label for="seed"><span class="ico">🎲</span>Seed</label>
              <input type="text" id="seed" maxlength="32" placeholder="random tower" spellcheck="false" autocomplete="off" />
            </div>
            <div class="grow"></div>
            <div id="waitmsg" class="waitmsg"></div>
            <button id="ready" class="big">I'm Ready</button>
            <button id="start" class="big mint" hidden disabled>Start Climb <span class="btn-emoji">🚀</span></button>
            <button id="exitroom" class="ghost small">Leave Lobby</button>
          </section>
        </div>
      </div>
    `,
    );
    this.ready = false;
    this.seenPlayers.clear();
    this.seenReady.clear();
    // matches the button's default label; updateLobby relabels it if we're the host
    this.amHost = false;
    const codeBtn = s.querySelector<HTMLButtonElement>('#codecopy')!;
    codeBtn.addEventListener('click', () => {
      restartAnim(codeBtn, 'copied');
      const done = () => this.toast(`Code ${code} copied! 📋`, 'info');
      if (navigator.clipboard) navigator.clipboard.writeText(code).then(done, () => this.toast(`Room code: ${code}`, 'info'));
      else this.toast(`Room code: ${code}`, 'info');
    });
    const previewCanvas = s.querySelector<HTMLCanvasElement>('#preview-canvas')!;
    this.preview = new CharacterPreview(previewCanvas, this.cosmetics);

    const colorsEl = s.querySelector('#colors')!;
    COSMETIC_COLORS.forEach((_, i) => {
      const sw = document.createElement('button');
      sw.className = 'swatch' + (i === this.cosmetics.color ? ' sel' : '');
      sw.style.setProperty('--sw', cosColor(i));
      sw.setAttribute('aria-label', `Color ${i + 1}`);
      sw.addEventListener('click', () => {
        this.cosmetics.color = i;
        colorsEl.querySelectorAll('.swatch').forEach((el, j) => el.classList.toggle('sel', j === i));
        this.pushCosmetics();
      });
      colorsEl.appendChild(sw);
    });
    const chipRow = (parent: Element, names: string[], get: () => number, set: (i: number) => void) => {
      names.forEach((n, i) => {
        const chip = document.createElement('button');
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

    const readyBtn = s.querySelector<HTMLButtonElement>('#ready')!;
    readyBtn.addEventListener('click', () => {
      this.ready = !this.ready;
      readyBtn.textContent = this.ready ? '✓ Ready! (click to unready)' : "I'm Ready";
      readyBtn.classList.toggle('mint', this.ready);
      this.cb.onReady(this.ready);
    });
    s.querySelector('#start')!.addEventListener('click', () => this.cb.onStart());
    const seedEl = s.querySelector<HTMLInputElement>('#seed')!;
    seedEl.addEventListener('change', () => this.cb.onSeed(seedEl.value.trim()));
    seedEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') seedEl.blur();
    });

    const exitBtn = s.querySelector<HTMLButtonElement>('#exitroom')!;
    exitBtn.addEventListener('click', () => {
      if (!this.amHost) {
        this.cb.onLeaveRoom();
        return;
      }
      // closing boots everyone else, so make the host click twice
      if (!this.closeArmed) {
        this.armClose(exitBtn);
        return;
      }
      this.disarmClose();
      this.cb.onCloseRoom();
    });
  }

  private armClose(btn: HTMLButtonElement) {
    this.closeArmed = true;
    btn.textContent = 'Close for everyone? Click again';
    btn.classList.add('armed');
    this.closeTimer = window.setTimeout(() => {
      this.disarmClose();
      const el = this.screen?.querySelector<HTMLButtonElement>('#exitroom');
      if (el) el.textContent = 'Close Lobby';
    }, 6000);
  }

  private disarmClose() {
    this.closeArmed = false;
    this.screen?.querySelector('#exitroom')?.classList.remove('armed');
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
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
    list.innerHTML =
      players
        .map((p) => {
          const isHost = p.id === hostId;
          const me = p.id === myId;
          const fresh = !this.seenPlayers.has(p.id);
          const justReady = p.ready && !this.seenReady.has(p.id);
          const status = isHost
            ? '<span class="status host"><span class="ico">👑</span>Host</span>'
            : p.ready
              ? `<span class="status ready${justReady ? ' enter' : ''}">✓ Ready</span>`
              : '<span class="status waiting">waiting<i>.</i><i>.</i><i>.</i></span>';
          return (
            `<div class="player-card${me ? ' me' : ''}${p.ready && !isHost ? ' is-ready' : ''}${fresh ? ' enter' : ''}">` +
            miniBean(p.cosmetics) +
            `<span class="who"><span class="who-name">${escapeHtml(p.name)}</span>${me ? '<span class="tag">you</span>' : ''}</span>${status}</div>`
          );
        })
        .join('') +
      Array.from({ length: Math.max(0, 4 - players.length) })
        .map(() => '<div class="player-card empty"><span class="mini-bean ghost" aria-hidden="true"></span><span class="who">waiting for a friend…</span></div>')
        .join('');
    this.seenPlayers = new Set(players.map((p) => p.id));
    this.seenReady = new Set(players.filter((p) => p.ready).map((p) => p.id));
    const count = this.screen.querySelector('#crewcount');
    if (count) count.textContent = `${players.length}/4`;

    const amHost = myId === hostId;
    const exitBtn = this.screen.querySelector<HTMLButtonElement>('#exitroom');
    if (exitBtn && amHost !== this.amHost) {
      this.disarmClose(); // host migrated mid-confirm — don't leave the button armed
      exitBtn.textContent = amHost ? 'Close Lobby' : 'Leave Lobby';
      exitBtn.title = amHost ? 'Shut the room down and send everyone home' : 'Go back to the home screen';
    }
    this.amHost = amHost;
    const startBtn = this.screen.querySelector<HTMLButtonElement>('#start');
    const readyBtn = this.screen.querySelector<HTMLButtonElement>('#ready');
    const seedRow = this.screen.querySelector<HTMLElement>('#seedrow');
    const waitMsg = this.screen.querySelector<HTMLElement>('#waitmsg');
    if (!startBtn || !readyBtn || !seedRow || !waitMsg) return;
    seedRow.hidden = !amHost;
    const seedEl = this.screen.querySelector<HTMLInputElement>('#seed')!;
    if (document.activeElement !== seedEl && seedEl.value !== seed) seedEl.value = seed;
    startBtn.hidden = !amHost;
    readyBtn.hidden = amHost;
    const allReady = players.every((p) => p.ready || p.id === hostId);
    const readyCount = players.filter((p) => p.ready && p.id !== hostId).length;
    startBtn.disabled = !allReady;
    waitMsg.classList.toggle('solo', amHost && players.length === 1);
    if (amHost) {
      waitMsg.innerHTML =
        players.length === 1
          ? '🧍 <b>Climbing solo?</b> Solo climbs skip the 2+ player contraptions (catapults, crank lifts and ledge saves). It’s better with friends!'
          : allReady
            ? '🎉 Everyone’s ready. Start when you like!'
            : `Waiting for everyone to ready up… <b>${readyCount}/${players.length - 1}</b>`;
    } else {
      waitMsg.textContent = this.ready ? 'You’re ready! Waiting for the host to start…' : 'The host starts the climb once everyone is ready';
    }
  }

  // ---------- loading ----------
  showLoading(text: string) {
    // the second call ("Waiting for the team…") just swaps the heading
    if (this.screen && this.screenKind === 'loading') {
      const h = this.screen.querySelector('.loading-text');
      if (h) h.textContent = text;
      return;
    }
    const beans = ['#ff7a7a', '#ffd24d', '#69db7c', '#4dabf7'];
    const s = this.setScreen(
      'loading',
      `
      <div class="logo-sm-wrap">${LOGO}</div>
      <div class="loader" aria-hidden="true">
        ${beans.map((c, i) => `<span class="hop" style="--i:${i}"><span class="mini-bean" style="--bean:${c}" data-eyes="${i % 3}"><i class="eye"></i><i class="eye"></i></span></span>`).join('')}
        <div class="loader-floor"></div>
      </div>
      <h2 class="loading-text">${escapeHtml(text)}</h2>
      <div class="tip-card"><span class="tip-label">Tip</span><span class="tip-text" id="tip"></span></div>
    `,
    );
    const tipEl = s.querySelector<HTMLElement>('#tip')!;
    const showTip = () => {
      tipEl.innerHTML = TIPS[this.tipIndex % TIPS.length];
      restartAnim(tipEl, 'in');
      this.tipIndex++;
    };
    showTip();
    this.tipTimer = window.setInterval(showTip, 4500);
  }

  // ---------- results ----------
  showResults(info: FinishInfo, players: PlayerInfo[], amHost: boolean) {
    const fallsOf = (p: PlayerInfo) => Number(info.falls[p.id]) || 0;
    const falls = players.map(fallsOf);
    const minF = Math.min(...falls);
    const maxF = Math.max(...falls);
    const unique = (v: number) => falls.filter((f) => f === v).length === 1;
    const cards = players
      .map((p) => {
        const f = fallsOf(p);
        let award = '';
        if (players.length > 1 && f === minF && unique(minF)) award = '<span class="award">😇 Steadiest</span>';
        else if (players.length > 1 && f === maxF && maxF > 0 && unique(maxF)) award = '<span class="award">🤕 Most dramatic</span>';
        return (
          `<div class="crew-card" style="--c:${cosColor(p.cosmetics?.color)}">${miniBean(p.cosmetics, 'lg')}` +
          `<div class="crew-name">${escapeHtml(p.name)}</div>` +
          `<div class="crew-falls">${f === 0 ? '✨ no falls!' : `💀 ${f} fall${f === 1 ? '' : 's'}`}</div>${award}</div>`
        );
      })
      .join('');
    const rank = info.rank;
    const rankBadge =
      rank !== null && rank > 0
        ? `<div class="rank-badge ${rank <= 3 ? `r${rank}` : ''}">${rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '🏅'} <b>#${rank}</b> on the all-time board</div>`
        : '';
    const highlight = rank !== null ? rank - 1 : -1;
    const confetti = Array.from({ length: 56 }, (_, i) => {
      const c = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
      const x = (Math.random() * 100).toFixed(1);
      const d = (3 + Math.random() * 2.6).toFixed(2);
      const delay = (Math.random() * 3).toFixed(2);
      const r = Math.round(Math.random() * 720 - 360);
      const drift = Math.round(Math.random() * 120 - 60);
      const w = 6 + Math.round(Math.random() * 6);
      return `<i class="${i % 4 === 0 ? 'round' : ''}" style="--x:${x}%;--d:${d}s;--delay:${delay}s;--r:${r}deg;--drift:${drift}px;--w:${w}px;--c:${c}"></i>`;
    }).join('');
    const s = this.setScreen(
      'results',
      `
      <div class="confetti" aria-hidden="true">${confetti}</div>
      <div class="panel panel-results">
        <div class="results-kicker"><span class="ico">🚩</span>Summit reached</div>
        <h1 class="results-title">${players.length > 1 ? 'You made it. <span>All of you!</span>' : 'You made it <span>to the top!</span>'}</h1>
        <div class="big-time">${formatTime(info.durationMs)}</div>
        ${rankBadge}
        <div class="crew-results">${cards}</div>
        <div class="board-head"><span class="ico">🏆</span>Best times</div>
        <div class="board-scroll">${this.leaderboardTable(Array.isArray(info.top) ? info.top : [], highlight)}</div>
        ${amHost ? '<button id="again" class="big">Back to Lobby <span class="btn-emoji">🔄</span></button>' : '<div class="waitmsg">Waiting for the host to head back to the lobby…</div>'}
      </div>
    `,
    );
    s.querySelector('#again')?.addEventListener('click', () => this.cb.onPlayAgain());
    s.querySelector('.board-scroll tr.you')?.scrollIntoView({ block: 'nearest' });
  }
}

/** Re-trigger a one-shot CSS animation bound to `cls`. */
function restartAnim(el: HTMLElement, cls: string) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}
