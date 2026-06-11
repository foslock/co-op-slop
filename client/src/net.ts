import type { C2S, S2C } from 'shared';

type Handler<T extends S2C['t']> = (msg: Extract<S2C, { t: T }>) => void;

export class Net {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, ((msg: S2C) => void)[]>();
  onClose: (() => void) | null = null;
  private timeOffset = 0; // serverTime - performance.now(), EMA-smoothed
  private hasOffset = false;

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('Could not connect to server'));
      ws.onclose = () => this.onClose?.();
      ws.onmessage = (ev) => {
        let msg: S2C;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if ('time' in msg && typeof msg.time === 'number') this.syncTime(msg.time);
        if ('now' in msg && typeof (msg as { now?: number }).now === 'number') this.syncTime((msg as { now: number }).now);
        for (const h of this.handlers.get(msg.t) ?? []) h(msg);
      };
      this.ws = ws;
    });
  }

  private syncTime(serverTime: number) {
    const sample = serverTime - performance.now();
    if (!this.hasOffset) {
      this.timeOffset = sample;
      this.hasOffset = true;
    } else {
      this.timeOffset += (sample - this.timeOffset) * 0.1;
    }
  }

  serverNow(): number {
    return performance.now() + this.timeOffset;
  }

  send(msg: C2S) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  on<T extends S2C['t']>(type: T, handler: Handler<T>): () => void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler as (msg: S2C) => void);
    this.handlers.set(type, list);
    return () => {
      const arr = this.handlers.get(type);
      if (arr) arr.splice(arr.indexOf(handler as (msg: S2C) => void), 1);
    };
  }

  disconnect() {
    this.onClose = null;
    this.ws?.close();
    this.ws = null;
  }
}
