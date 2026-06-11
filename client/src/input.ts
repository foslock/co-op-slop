// Keyboard + mouse-look state, polled by the game loop.
// Prefers the Pointer Lock API; falls back to drag-to-look where pointer lock
// is unavailable (sandboxed iframes, embedded preview panels, some webviews).
export class Input {
  keys = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  zoomHeld = false; // right mouse button
  locked = false;
  dragMode = false; // pointer lock unavailable → hold LMB and drag to look
  onLockFallback: (() => void) | null = null;
  private dragging = false;
  private pressed = new Set<string>(); // edge-triggered keys consumed once
  private el: HTMLElement;
  private detach: (() => void)[] = [];

  constructor(el: HTMLElement) {
    this.el = el;
    const kd = (e: KeyboardEvent) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressed.add(e.code);
      if (['Space', 'KeyE', 'KeyF', 'KeyQ', 'KeyG', 'KeyZ', 'KeyB'].includes(e.code)) e.preventDefault();
    };
    const ku = (e: KeyboardEvent) => this.keys.delete(e.code);
    const mm = (e: MouseEvent) => {
      if (!this.locked && !(this.dragMode && this.dragging)) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    };
    const md = (e: MouseEvent) => {
      if (e.button === 0 && e.target === this.el) this.dragging = true;
      if (e.button === 2) this.zoomHeld = true;
    };
    const mu = (e: MouseEvent) => {
      if (e.button === 0) this.dragging = false;
      if (e.button === 2) this.zoomHeld = false;
    };
    const ctx = (e: Event) => e.preventDefault();
    const plc = () => {
      this.locked = document.pointerLockElement === this.el;
      if (!this.locked) {
        this.keys.clear();
        this.zoomHeld = false;
      }
    };
    const ple = () => this.enableDragFallback();
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    window.addEventListener('mousemove', mm);
    window.addEventListener('mousedown', md);
    window.addEventListener('mouseup', mu);
    window.addEventListener('contextmenu', ctx);
    document.addEventListener('pointerlockchange', plc);
    document.addEventListener('pointerlockerror', ple);
    this.detach.push(
      () => window.removeEventListener('keydown', kd),
      () => window.removeEventListener('keyup', ku),
      () => window.removeEventListener('mousemove', mm),
      () => window.removeEventListener('mousedown', md),
      () => window.removeEventListener('mouseup', mu),
      () => window.removeEventListener('contextmenu', ctx),
      () => document.removeEventListener('pointerlockchange', plc),
      () => document.removeEventListener('pointerlockerror', ple),
    );
  }

  /** Pointer lock, or mouse-drag fallback, is available for looking around. */
  get lookActive(): boolean {
    return this.locked || this.dragMode;
  }

  requestLock() {
    if (this.dragMode) return;
    try {
      // Older browsers return undefined; modern ones return a promise that
      // rejects when a permissions policy blocks pointer lock.
      const ret = this.el.requestPointerLock() as unknown as Promise<void> | undefined;
      if (ret && typeof ret.catch === 'function') ret.catch(() => this.enableDragFallback());
    } catch {
      this.enableDragFallback();
    }
  }

  private enableDragFallback() {
    if (this.dragMode) return;
    this.dragMode = true;
    this.onLockFallback?.();
  }

  /** True only on the first poll after the key went down. */
  consumePress(code: string): boolean {
    if (this.pressed.has(code)) {
      this.pressed.delete(code);
      return true;
    }
    return false;
  }

  /** Drain accumulated mouse movement. */
  consumeMouse(): { dx: number; dy: number } {
    const r = { dx: this.mouseDX, dy: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return r;
  }

  endFrame() {
    this.pressed.clear();
  }

  dispose() {
    for (const d of this.detach) d();
    if (document.pointerLockElement === this.el) document.exitPointerLock();
  }
}
