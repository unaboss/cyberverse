// Floating windows over the office floor. Every panel on the round screen can be
// dragged by its title bar, resized from its bottom-right corner and folded away
// to just its bar. Where each one sits is remembered in this browser, and "Reset
// layout" puts them all back. A window you have not moved keeps its default
// place, worked out again whenever the screen changes size. On a phone the
// windows stack under the floor instead: there they only fold.

import { clamp } from './geometry.js';

const KEY = 'cyberverse.layout.v1';
const MIN_W = 240;
const MIN_H = 120;
const BAR_H = 34;
const STEP = 24;
const SNAP = 14; // how close an edge must come before it clicks into place
const GAP = 10; // the gap a snapped window keeps from the stage edge and its neighbours
const PHONE = '(max-width: 760px)';

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function make(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

const num = (v) => typeof v === 'number' && Number.isFinite(v);

export class Desk {
  /**
   * @param {HTMLElement} stage the element the windows float over
   * @param {{ onChange?: () => void }} [options] onChange runs after the windows settle
   */
  constructor(stage, { onChange } = {}) {
    this.stage = stage;
    this.wins = new Map();
    this.z = 20;
    this.saved = load();
    this.onChange = onChange ?? null;
    this.busy = false;
    this.frame = 0;
    this.relayoutFrame = 0;
    this.phone = window.matchMedia(PHONE);
    this.phone.addEventListener('change', () => this.placeAll());
    this.sizes = new ResizeObserver(() => this.relayout());
    this.sizes.observe(stage);
  }

  get onPhone() {
    return this.phone.matches;
  }

  /**
   * Turn a panel into a window.
   * @param {string} id
   * @param {HTMLElement} panel shown and hidden by the app as before; the window follows it
   * @param {{ title: string, bar?: HTMLElement, fills?: boolean, defaults: (W: number, H: number) => { x: number, y: number, w: number, h: number | null, maxH?: number, folded?: boolean } }} options
   *   `bar` reuses a header the panel already has; `h: null` lets the window grow with its
   *   content, up to `maxH`. A window that `fills` is placed after the others, so its
   *   defaults can fit around where they ended up.
   */
  add(id, panel, { title, bar, fills = false, defaults }) {
    const win = make('section', 'pane');
    win.dataset.pane = id;
    win.setAttribute('aria-label', title);
    const head = bar ?? make('header', 'pane-bar-own');
    head.classList.add('pane-bar');
    head.tabIndex = 0;
    head.title = 'Click to fold or open. Drag to move. With the bar selected, arrow keys move it, Shift and arrow keys resize it, and Enter folds it.';
    const name = bar ? null : make('span', 'pane-title', title);
    if (name) head.append(make('span', 'pane-grip'), name);
    const fold = make('button', 'pane-fold icon', '▾');
    fold.type = 'button';
    fold.setAttribute('aria-label', `Fold ${title} away`);
    const tools = make('span', 'pane-tools');
    tools.append(fold);
    const close = head.querySelector('[data-pane-close]');
    if (close) tools.append(close);
    head.append(tools);
    const body = make('div', 'pane-body');
    const size = make('div', 'pane-size');
    size.title = 'Drag to resize';
    size.setAttribute('aria-hidden', 'true');
    const left = make('div', 'pane-edge l');
    const bottom = make('div', 'pane-edge b');
    left.title = 'Drag to make wider';
    bottom.title = 'Drag to make taller';
    for (const edge of [left, bottom]) edge.setAttribute('aria-hidden', 'true');
    if (bar) bar.remove();
    win.append(head, body, left, bottom, size);
    body.append(panel);
    this.stage.append(win);

    const entry = { id, win, head, body, panel, fold, name, defaults, title, fills };
    this.wins.set(id, entry);
    fold.addEventListener('click', () => this.setFolded(id, !this.state(id).folded));
    win.addEventListener('pointerdown', () => this.front(id), true);
    win.addEventListener('focusin', () => this.front(id));
    this.dragging(entry);
    this.sizing(entry, size);
    this.edges(entry, left, bottom);
    this.keys(entry);
    this.sizes.observe(win);

    const sync = () => {
      win.hidden = panel.hidden;
      if (!panel.hidden) this.front(id);
      this.placeAll();
    };
    new MutationObserver(sync).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    win.hidden = panel.hidden;
    return win;
  }

  // ------------------------------------------------------------ state

  /** This window's position, size and fold: what you set, else its default. */
  state(id) {
    const entry = this.wins.get(id);
    const { width, height } = this.stage.getBoundingClientRect();
    const base = entry.defaults(width, height);
    const saved = this.saved[id] ?? {};
    const own = Object.fromEntries(Object.entries(saved).filter(([k, v]) => (k === 'folded' ? typeof v === 'boolean' : num(v))));
    return { folded: false, ...base, ...own };
  }

  /** One thing you set on a window (x, y, w, h or folded), if you set it. Safe inside defaults. */
  savedValue(id, key) {
    const v = this.saved[id]?.[key];
    return (key === 'folded' ? typeof v === 'boolean' : num(v)) ? v : undefined;
  }

  /** Whether you have moved this window, so it no longer sits in its default place. */
  moved(id) {
    const saved = this.saved[id];
    return !!saved && (num(saved.x) || num(saved.y));
  }

  save(id, patch) {
    this.saved[id] = { ...(this.saved[id] ?? {}), ...patch };
    this.store();
  }

  store() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.saved));
    } catch {
      /* a private window: the layout just won't stick */
    }
  }

  reset() {
    this.saved = {};
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* nothing to forget */
    }
    this.placeAll();
  }

  // ------------------------------------------------------------ placing

  placeAll() {
    const entries = [...this.wins.values()];
    for (const e of entries.filter((x) => !x.fills)) this.place(e.id);
    for (const e of entries.filter((x) => x.fills)) this.place(e.id);
  }

  /** Place everything again on the next frame, once the browser has done its sums. */
  relayout() {
    if (this.relayoutFrame) return;
    this.relayoutFrame = requestAnimationFrame(() => {
      this.relayoutFrame = 0;
      if (!this.busy) this.placeAll();
    });
  }

  place(id) {
    const entry = this.wins.get(id);
    if (!entry) return;
    const { win, fold, title } = entry;
    const s = this.state(id);
    win.classList.toggle('folded', s.folded);
    fold.textContent = s.folded ? '▸' : '▾';
    fold.title = s.folded ? 'Open' : 'Fold away';
    fold.setAttribute('aria-label', s.folded ? `Open ${title}` : `Fold ${title} away`);
    fold.setAttribute('aria-expanded', String(!s.folded));
    if (this.onPhone) {
      for (const prop of ['left', 'top', 'width', 'height', 'maxHeight']) win.style[prop] = '';
      this.changed();
      return;
    }
    const { width: W, height: H } = this.stage.getBoundingClientRect();
    if (W === 0 || H === 0) return;
    const w = clamp(s.w, Math.min(MIN_W, W), W);
    const x = clamp(s.x, 0, Math.max(0, W - w));
    // An open window of known height slides up to fit; its saved place stays put, so
    // folding it again puts it back.
    const tall = !s.folded && num(s.h) ? Math.min(Math.max(s.h, MIN_H), H) : BAR_H;
    const y = clamp(s.y, 0, Math.max(0, H - tall));
    win.style.left = `${Math.round(x)}px`;
    win.style.top = `${Math.round(y)}px`;
    win.style.width = `${Math.round(w)}px`;
    if (s.folded) {
      win.style.height = '';
      win.style.maxHeight = '';
    } else if (!num(s.h)) {
      win.style.height = '';
      win.style.maxHeight = `${Math.round(Math.min(H - y, num(s.maxH) ? s.maxH : Infinity))}px`;
    } else {
      win.style.height = `${Math.round(clamp(s.h, MIN_H, Math.max(MIN_H, H - y)))}px`;
      win.style.maxHeight = '';
    }
    this.changed();
  }

  /** Tell the app the windows have settled, once per frame and never mid-drag. */
  changed() {
    if (this.busy || !this.onChange || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.onChange?.();
    });
  }

  front(id) {
    const entry = this.wins.get(id);
    if (!entry || Number(entry.win.style.zIndex) === this.z) return;
    if (this.z > 600) {
      // Renumber from the bottom so the stack never climbs over the popups and dialogs.
      const order = [...this.wins.values()].sort((a, b) => Number(a.win.style.zIndex || 0) - Number(b.win.style.zIndex || 0));
      this.z = 20;
      for (const e of order) e.win.style.zIndex = String(++this.z);
    }
    entry.win.style.zIndex = String(++this.z);
  }

  /** Unfold a window, bring it to the front, and on a phone scroll to it. */
  open(id) {
    const entry = this.wins.get(id);
    if (!entry) return;
    if (this.state(id).folded) this.setFolded(id, false);
    this.front(id);
    if (this.onPhone && !entry.panel.hidden) {
      // After the window has followed its panel into view.
      requestAnimationFrame(() => entry.win.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
  }

  folded(id) {
    return this.wins.has(id) && this.state(id).folded;
  }

  setFolded(id, folded) {
    this.save(id, { folded });
    this.place(id);
  }

  setTitle(id, text) {
    const entry = this.wins.get(id);
    if (entry?.name && entry.name.textContent !== text) entry.name.textContent = text;
  }

  win(id) {
    return this.wins.get(id)?.win ?? null;
  }

  /** Flash a window's bar, for news that lands while it is folded. */
  ping(id) {
    const entry = this.wins.get(id);
    if (!entry) return;
    entry.head.classList.remove('ping');
    void entry.head.offsetWidth;
    entry.head.classList.add('ping');
  }

  /** Where a visible window is, relative to the stage. */
  rect(id) {
    const entry = this.wins.get(id);
    if (!entry || entry.win.hidden) return null;
    return this.relative(entry.win.getBoundingClientRect());
  }

  relative(r) {
    const s = this.stage.getBoundingClientRect();
    return { left: r.left - s.left, top: r.top - s.top, right: r.right - s.left, bottom: r.bottom - s.top, width: r.width, height: r.height };
  }

  /** The visible windows, optionally leaving one out, or the folded ones. */
  visibleRects({ except = null, open = false } = {}) {
    return [...this.wins.keys()]
      .filter((id) => id !== except && !(open && this.folded(id)))
      .map((id) => this.rect(id))
      .filter(Boolean);
  }

  // ------------------------------------------------------------ input

  /** Follow the pointer from a pointerdown until it lets go. */
  track(handle, event, onMove, onUp) {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    this.busy = true;
    const move = (e) => onMove(e);
    const up = (e) => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      this.busy = false;
      onUp(e.type === 'pointerup');
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }

  dragging({ id, win, head }) {
    head.addEventListener('pointerdown', (event) => {
      if (this.onPhone || event.button !== 0 || event.target.closest('button, a, input, select, textarea')) return;
      const start = { px: event.clientX, py: event.clientY, x: win.offsetLeft, y: win.offsetTop };
      let went = false;
      win.classList.add('moving');
      this.track(
        head,
        event,
        (e) => {
          // A click with a shaky hand is not a move: the window keeps its default place.
          if (!went && Math.abs(e.clientX - start.px) + Math.abs(e.clientY - start.py) < 4) return;
          went = true;
          const at = this.snap(id, start.x + e.clientX - start.px, start.y + e.clientY - start.py, win.offsetWidth, win.offsetHeight);
          this.saved[id] = { ...(this.saved[id] ?? {}), x: at.x, y: at.y };
          this.place(id);
          this.guides(at.gx, at.gy);
        },
        (released) => {
          win.classList.remove('moving');
          this.guides(null, null);
          if (went) this.save(id, { x: win.offsetLeft, y: win.offsetTop });
          // A click on the bar that did not drag folds or opens the window, like a drop-down.
          else if (released) this.save(id, { folded: !this.state(id).folded });
          this.placeAll();
        },
      );
    });
    // On a phone the bar does not drag, so a tap on it just folds or opens.
    head.addEventListener('click', (event) => {
      if (!this.onPhone || event.target.closest('button, a, input, select, textarea')) return;
      this.setFolded(id, !this.state(id).folded);
    });
  }

  sizing({ id, win }, handle) {
    handle.addEventListener('pointerdown', (event) => {
      if (this.onPhone || event.button !== 0) return;
      const start = { px: event.clientX, py: event.clientY, x: win.offsetLeft, y: win.offsetTop, w: win.offsetWidth, h: win.offsetHeight };
      let went = false;
      win.classList.add('moving');
      this.track(
        handle,
        event,
        (e) => {
          if (!went && Math.abs(e.clientX - start.px) + Math.abs(e.clientY - start.py) < 4) return;
          went = true;
          // A window you resize stays where it is, so its corner follows the pointer.
          this.saved[id] = { ...(this.saved[id] ?? {}), x: start.x, y: start.y, w: Math.max(MIN_W, start.w + e.clientX - start.px), h: Math.max(MIN_H, start.h + e.clientY - start.py) };
          this.place(id);
        },
        () => {
          win.classList.remove('moving');
          if (went) this.save(id, { x: win.offsetLeft, y: win.offsetTop, w: win.offsetWidth, h: win.offsetHeight });
          this.placeAll();
        },
      );
    });
  }

  /** The left edge makes a window wider (its right side stays put); the bottom edge, taller. */
  edges({ id, win }, left, bottom) {
    const grab = (handle, apply) =>
      handle.addEventListener('pointerdown', (event) => {
        if (this.onPhone || event.button !== 0) return;
        const start = { px: event.clientX, py: event.clientY, x: win.offsetLeft, y: win.offsetTop, w: win.offsetWidth, h: win.offsetHeight };
        let went = false;
        win.classList.add('moving');
        this.track(
          handle,
          event,
          (e) => {
            if (!went && Math.abs(e.clientX - start.px) + Math.abs(e.clientY - start.py) < 4) return;
            went = true;
            this.saved[id] = { ...(this.saved[id] ?? {}), x: start.x, y: start.y, w: start.w, h: start.h, ...apply(start, e) };
            this.place(id);
          },
          () => {
            win.classList.remove('moving');
            if (went) this.save(id, { x: win.offsetLeft, y: win.offsetTop, w: win.offsetWidth, h: win.offsetHeight });
            this.placeAll();
          },
        );
      });
    grab(left, (start, e) => {
      const w = Math.max(MIN_W, Math.min(start.w - (e.clientX - start.px), start.x + start.w));
      return { x: start.x + start.w - w, w };
    });
    grab(bottom, (start, e) => ({ h: Math.max(MIN_H, start.h + e.clientY - start.py) }));
  }

  /**
   * Pull a window being dragged to the nearest stage edge or neighbour's edge, when
   * one is close. Returns where it lands and the lines to draw where it snapped.
   */
  snap(id, x, y, w, h) {
    const { width: W, height: H } = this.stage.getBoundingClientRect();
    // Pushed past the stage's edge, a window lands against it.
    x = clamp(x, 0, Math.max(0, W - w));
    y = clamp(y, 0, Math.max(0, H - h));
    const xs = [
      { at: GAP, line: GAP },
      { at: W - w - GAP, line: W - GAP },
    ];
    const ys = [
      { at: GAP, line: GAP },
      { at: H - h - GAP, line: H - GAP },
    ];
    for (const r of this.visibleRects({ except: id })) {
      xs.push({ at: r.left, line: r.left }, { at: r.right - w, line: r.right }, { at: r.right + GAP, line: r.right + GAP / 2 }, { at: r.left - w - GAP, line: r.left - GAP / 2 });
      ys.push({ at: r.top, line: r.top }, { at: r.bottom - h, line: r.bottom }, { at: r.bottom + GAP, line: r.bottom + GAP / 2 }, { at: r.top - h - GAP, line: r.top - GAP / 2 });
    }
    const nearest = (v, list) => list.reduce((best, c) => (Math.abs(c.at - v) <= SNAP && (!best || Math.abs(c.at - v) < Math.abs(best.at - v)) ? c : best), null);
    const sx = nearest(x, xs);
    const sy = nearest(y, ys);
    return { x: sx ? sx.at : x, y: sy ? sy.at : y, gx: sx ? sx.line : null, gy: sy ? sy.line : null };
  }

  /** Show (or hide, with nulls) the thin lines that mark where a window snapped. */
  guides(gx, gy) {
    if (!this.lines) {
      this.lines = { v: make('div', 'snap-guide v'), h: make('div', 'snap-guide h') };
      this.stage.append(this.lines.v, this.lines.h);
    }
    this.lines.v.hidden = gx === null;
    this.lines.h.hidden = gy === null;
    if (gx !== null) this.lines.v.style.left = `${Math.round(gx)}px`;
    if (gy !== null) this.lines.h.style.top = `${Math.round(gy)}px`;
  }

  keys({ id, win, head }) {
    head.addEventListener('keydown', (event) => {
      if (event.target !== head) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.setFolded(id, !this.state(id).folded);
        return;
      }
      const delta = { ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0], ArrowUp: [0, -STEP], ArrowDown: [0, STEP] }[event.key];
      if (!delta || this.onPhone) return;
      event.preventDefault();
      if (event.shiftKey) {
        this.save(id, { w: Math.max(MIN_W, win.offsetWidth + delta[0]), h: Math.max(MIN_H, win.offsetHeight + delta[1]) });
      } else {
        this.save(id, { x: win.offsetLeft + delta[0], y: win.offsetTop + delta[1] });
      }
      this.placeAll();
    });
  }
}
