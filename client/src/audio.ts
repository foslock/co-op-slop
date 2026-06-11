// Tiny WebAudio synth: zero assets, just oscillators and noise.
let ctx: AudioContext | null = null;
let master: GainNode | null = null;

function ensure(): AudioContext | null {
  if (!ctx) {
    try {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = 0.35;
      master.connect(ctx.destination);
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

export function unlockAudio() {
  ensure();
}

function tone(freq: number, dur: number, type: OscillatorType = 'sine', vol = 1, slide = 0) {
  const c = ensure();
  if (!c || !master) return;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, c.currentTime);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), c.currentTime + dur);
  g.gain.setValueAtTime(vol * 0.5, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
  osc.connect(g).connect(master);
  osc.start();
  osc.stop(c.currentTime + dur + 0.02);
}

function thud(vol = 1) {
  const c = ensure();
  if (!c || !master) return;
  const len = 0.12;
  const buf = c.createBuffer(1, c.sampleRate * len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const src = c.createBufferSource();
  src.buffer = buf;
  const g = c.createGain();
  g.gain.value = vol * 0.4;
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 380;
  src.connect(lp).connect(g).connect(master);
  src.start();
}

export const sfx = {
  jump: () => tone(420, 0.14, 'square', 0.35, 240),
  land: (hard = false) => thud(hard ? 1 : 0.45),
  pickup: () => { tone(700, 0.1, 'sine', 0.5); setTimeout(() => tone(1050, 0.14, 'sine', 0.5), 70); },
  give: () => tone(560, 0.12, 'triangle', 0.5, 160),
  checkpoint: () => { tone(523, 0.14, 'sine', 0.55); setTimeout(() => tone(659, 0.14, 'sine', 0.55), 110); setTimeout(() => tone(784, 0.22, 'sine', 0.55), 220); },
  button: () => tone(300, 0.09, 'square', 0.4, -80),
  knock: () => tone(260, 0.4, 'sawtooth', 0.4, -180),
  fell: () => tone(360, 0.5, 'sine', 0.45, -300),
  ping: () => { tone(880, 0.12, 'sine', 0.5); setTimeout(() => tone(880, 0.12, 'sine', 0.4), 160); },
  grapple: () => tone(200, 0.25, 'sawtooth', 0.45, 500),
  finish: () => {
    [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => tone(f, 0.3, 'triangle', 0.6), i * 140));
  },
  countdown: (final = false) => tone(final ? 880 : 440, final ? 0.4 : 0.15, 'sine', 0.6),
};
