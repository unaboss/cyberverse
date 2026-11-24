// Alert sounds, made with WebAudio so there are no audio files to ship.
// Louder and more urgent as the severity climbs.

let ctx = null;
let muted = false;

export function unlockSound() {
  if (!ctx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    ctx = new Ctor();
  }
  if (ctx.state === 'suspended') void ctx.resume();
}

export function setMuted(value) {
  muted = value;
}

export function isMuted() {
  return muted;
}

function tone(freq, start, length, type = 'sine', gain = 0.08) {
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  amp.gain.setValueAtTime(0.0001, start);
  amp.gain.exponentialRampToValueAtTime(gain, start + 0.015);
  amp.gain.exponentialRampToValueAtTime(0.0001, start + length);
  osc.connect(amp).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + length + 0.02);
}

let lastAt = 0;

export function alertSound(severity) {
  if (muted || !ctx) return;
  const now = ctx.currentTime;
  // Never stack sounds into a wall of noise.
  if (now - lastAt < 0.6 && severity !== 'critical') return;
  lastAt = now;
  switch (severity) {
    case 'low':
      tone(660, now, 0.12, 'sine', 0.04);
      break;
    case 'medium':
      tone(740, now, 0.12, 'triangle', 0.06);
      tone(740, now + 0.18, 0.12, 'triangle', 0.06);
      break;
    case 'high':
      tone(660, now, 0.14, 'square', 0.05);
      tone(880, now + 0.16, 0.14, 'square', 0.05);
      tone(1100, now + 0.32, 0.2, 'square', 0.05);
      break;
    case 'critical':
      for (let i = 0; i < 6; i++) {
        tone(i % 2 ? 620 : 980, now + i * 0.2, 0.18, 'sawtooth', 0.05);
      }
      break;
    default:
      break;
  }
}

/** A soft click when a terminal command finishes. */
export function doneSound() {
  if (muted || !ctx) return;
  tone(1200, ctx.currentTime, 0.05, 'sine', 0.025);
}

/** A bright two-note chime when a guided step is done. */
export function stepSound() {
  if (muted || !ctx) return;
  const now = ctx.currentTime;
  tone(880, now, 0.12, 'sine', 0.05);
  tone(1320, now + 0.1, 0.22, 'sine', 0.05);
}

/** A short rising run when a floor is complete. */
export function floorSound() {
  if (muted || !ctx) return;
  const now = ctx.currentTime;
  [660, 880, 990, 1320].forEach((f, i) => tone(f, now + i * 0.11, 0.2, 'triangle', 0.05));
}
