// A short tour of the round screen: a spotlight moves from part to part with a
// line or two about each. It runs once, on the first floor of a tower, and the
// "?" on the map plays it again any time.

import { h } from './dom.js';

const KEY = 'cyberverse.tour.v1';

export const tourSeen = () => {
  try {
    return localStorage.getItem(KEY) === 'done';
  } catch {
    return false;
  }
};

const markSeen = () => {
  try {
    localStorage.setItem(KEY, 'done');
  } catch {
    /* a private window: it shows again next time */
  }
};

/**
 * @typedef {{ target: () => Element | null, title: string, text: string, side?: 'left' | 'right' | 'top' | 'bottom' | 'inside' }} Stop
 */

export class Tour {
  constructor() {
    this.stops = [];
    this.at = 0;
    this.root = null;
    this.onEnd = null;
    this.follow = () => this.place();
    this.keys = (event) => this.key(event);
  }

  get running() {
    return this.root !== null;
  }

  /** @param {Stop[]} stops */
  start(stops, { onEnd } = {}) {
    this.end(false);
    this.stops = stops.filter((s) => visible(s.target()));
    if (this.stops.length === 0) return;
    this.onEnd = onEnd ?? null;
    this.at = 0;
    this.hole = h('div', { class: 'tour-hole' });
    this.card = h('div', { class: 'tour-card', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'tour-title' });
    this.root = h('div', { class: 'tour' }, this.hole, this.card);
    document.body.append(this.root);
    window.addEventListener('resize', this.follow);
    document.addEventListener('keydown', this.keys, true);
    this.show();
  }

  show() {
    const stop = this.stops[this.at];
    const last = this.at === this.stops.length - 1;
    const back = h('button', { class: 'ghost', type: 'button', disabled: this.at === 0 }, 'Back');
    const next = h('button', { class: 'primary', type: 'button' }, last ? "Let's go" : 'Next');
    const skip = h('button', { class: 'tour-skip', type: 'button' }, 'Skip the tour');
    back.addEventListener('click', () => this.go(-1));
    next.addEventListener('click', () => this.go(1));
    skip.addEventListener('click', () => this.end(true));
    const dots = h('div', { class: 'tour-dots', 'aria-hidden': 'true' }, ...this.stops.map((_, n) => h('i', { class: n === this.at ? 'on' : n < this.at ? 'done' : '' })));
    this.card.replaceChildren(
      h('div', { class: 'tour-step' }, `${this.at + 1} of ${this.stops.length}`),
      h('h3', { id: 'tour-title' }, stop.title),
      h('p', {}, stop.text),
      h('div', { class: 'tour-foot' }, dots, h('div', { class: 'tour-buttons' }, skip, back, next)),
    );
    this.card.classList.remove('moved');
    void this.card.offsetWidth;
    this.card.classList.add('moved');
    this.place();
    next.focus({ preventScroll: true });
  }

  go(delta) {
    const to = this.at + delta;
    if (to < 0) return;
    if (to >= this.stops.length) {
      this.end(true);
      return;
    }
    this.at = to;
    this.show();
  }

  key(event) {
    if (!this.running) return;
    if (event.key === 'Escape') this.end(true);
    else if (event.key === 'ArrowRight') this.go(1);
    else if (event.key === 'ArrowLeft') this.go(-1);
    else return;
    event.preventDefault();
    event.stopPropagation();
  }

  /** Put the spotlight on this stop's target and the card beside it. */
  place() {
    if (!this.running) return;
    const stop = this.stops[this.at];
    const el = stop.target();
    if (!visible(el)) {
      this.go(1);
      return;
    }
    const pad = 6;
    const r = el.getBoundingClientRect();
    const box = { left: r.left - pad, top: r.top - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
    Object.assign(this.hole.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });

    const W = window.innerWidth;
    const H = window.innerHeight;
    const cw = Math.min(340, W - 32);
    this.card.style.width = `${cw}px`;
    const ch = this.card.offsetHeight || 180;
    const gap = 14;
    const side = stop.side ?? bestSide(box, cw, ch, W, H);
    let x;
    let y;
    if (side === 'inside') {
      x = box.left + 24;
      y = box.top + 24;
    } else if (side === 'left') {
      x = box.left - cw - gap;
      y = box.top + 12;
    } else if (side === 'right') {
      x = box.left + box.width + gap;
      y = box.top + 12;
    } else if (side === 'bottom') {
      x = box.left + box.width - cw;
      y = box.top + box.height + gap;
    } else {
      x = box.left;
      y = box.top - ch - gap;
    }
    x = Math.max(16, Math.min(x, W - cw - 16));
    y = Math.max(16, Math.min(y, H - ch - 16));
    Object.assign(this.card.style, { left: `${x}px`, top: `${y}px` });
  }

  end(seen) {
    if (!this.root) return;
    window.removeEventListener('resize', this.follow);
    document.removeEventListener('keydown', this.keys, true);
    this.root.remove();
    this.root = null;
    if (seen) markSeen();
    const done = this.onEnd;
    this.onEnd = null;
    done?.();
  }
}

function visible(el) {
  if (!el || !el.isConnected) return false;
  if (el.closest('[hidden]')) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** The side of the target with the most room for the card. */
function bestSide(box, cw, ch, W, H) {
  const room = {
    left: box.left,
    right: W - (box.left + box.width),
    bottom: H - (box.top + box.height),
    top: box.top,
  };
  if (room.left >= cw + 30) return 'left';
  if (room.right >= cw + 30) return 'right';
  if (room.bottom >= ch + 30) return 'bottom';
  if (room.top >= ch + 30) return 'top';
  return 'inside';
}
