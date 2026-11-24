// The notes pad: the ✎ button at the top right of every screen. Write what you
// would change, in the UI tab (looks, layout, screens) or the Practicals tab
// (lesson steps, wording, marking), add a screenshot with a red box round what
// you mean, and send it. The local server saves it in notes/ for Claude to read
// and act on (src/server/notes.ts). The hosted lab has no pad: its
// /api/version says notes: false.

import { h } from './dom.js';

const TABS = {
  ui: {
    name: 'UI',
    hint: 'How it looks and works: layout, colours, screens, buttons.',
    placeholder: 'What would you change about how this looks or works?',
  },
  practicals: {
    name: 'Practicals',
    hint: 'The floors themselves: steps, wording, the attack, the marking.',
    placeholder: 'What would you change about this floor?',
  },
};
const TAB_KEY = 'cyberverse.notes.tab';
const DRAFT_KEY = 'cyberverse.notes.draft';
/** Keep a screenshot comfortably under the server's limit. */
const MAX_SHOT_CHARS = 11_000_000;

const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* no storage: the draft just isn't kept */
    }
  },
};

export class NotePad {
  /**
   * @param {{ where: () => Record<string, string>, onSaved?: (text: string) => void }} options
   *   where: where you are right now, saved with the note (screen, floor, room...).
   */
  constructor({ where, onSaved }) {
    this.where = where;
    this.onSaved = onSaved ?? (() => {});
    this.tab = store.get(TAB_KEY) === 'practicals' ? 'practicals' : 'ui';
    this.drafts = readDrafts();
    this.shot = null;
    this.sending = false;
    this.build();
  }

  /** The server can save notes: show the button. */
  enable() {
    this.button.hidden = false;
    document.body.classList.add('has-pad');
  }

  // ------------------------------------------------------------------ the pad

  build() {
    this.button = h('button', { id: 'pad-open', class: 'pad-open', type: 'button', hidden: true, title: 'Write a note for Claude (N)', 'aria-label': 'Write a note for Claude', 'aria-expanded': 'false', onclick: () => this.toggle() }, '✎');

    this.tabButtons = Object.entries(TABS).map(([id, t]) =>
      h('button', { type: 'button', role: 'tab', dataset: { tab: id }, onclick: () => this.selectTab(id) }, t.name),
    );
    this.hint = h('p', { class: 'pad-hint' });
    this.text = h('textarea', { rows: 6, 'aria-label': 'Your note', oninput: () => this.saveDraft() });
    this.text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void this.send();
      }
    });
    this.whereList = h('ul', { class: 'pad-where' });
    this.thumb = h('img', { class: 'pad-thumb', alt: 'Your screenshot, with your boxes' });
    this.shotBox = h('div', { class: 'pad-shot', hidden: true },
      this.thumb,
      h('div', { class: 'pad-shot-actions' },
        h('button', { type: 'button', class: 'ghost small', onclick: () => void this.capture() }, 'Take it again'),
        h('button', { type: 'button', class: 'ghost small', onclick: () => this.setShot(null) }, 'Remove'),
      ),
    );
    this.shotButton = h('button', { type: 'button', class: 'ghost', onclick: () => void this.capture() }, 'Add a screenshot');
    this.sendButton = h('button', { type: 'button', class: 'primary', onclick: () => void this.send() }, 'Send note');
    this.status = h('p', { class: 'pad-status', role: 'status', 'aria-live': 'polite' });

    this.panel = h('section', { id: 'pad', class: 'pad', role: 'dialog', 'aria-label': 'Notes for Claude', hidden: true },
      h('header', { class: 'pad-head' },
        h('h2', {}, 'Notes for Claude'),
        h('button', { type: 'button', class: 'icon', 'aria-label': 'Close the notes pad', onclick: () => this.close() }, '✕'),
      ),
      h('div', { class: 'tabs pad-tabs', role: 'tablist' }, this.tabButtons),
      this.hint,
      this.text,
      this.shotBox,
      h('details', { class: 'pad-details' }, h('summary', {}, 'Saved with your note'), this.whereList),
      h('div', { class: 'pad-actions' }, this.shotButton, this.sendButton),
      this.status,
    );
    this.panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.close();
      }
    });

    this.marker = new Marker({
      onUse: (dataUrl) => {
        this.setShot(dataUrl);
        this.show();
      },
      onRetake: () => void this.capture(),
      onCancel: () => this.show(),
    });

    document.body.append(this.button, this.panel, this.marker.root);
    document.addEventListener('keydown', (e) => {
      if (this.button.hidden || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.toLowerCase() !== 'n' || isTyping(e.target)) return;
      e.preventDefault();
      this.open();
    });
    this.selectTab(this.tab);
  }

  toggle() {
    if (this.panel.hidden) this.open();
    else this.close();
  }

  open() {
    this.show();
    this.say('');
    this.text.focus();
  }

  /** Show the pad as it was, with "where" read again. */
  show() {
    this.renderWhere();
    this.panel.hidden = false;
    this.button.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
  }

  close() {
    this.panel.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    this.button.focus();
  }

  selectTab(id) {
    this.saveDraft();
    this.tab = id;
    store.set(TAB_KEY, id);
    for (const b of this.tabButtons) b.setAttribute('aria-selected', String(b.dataset.tab === id));
    this.hint.textContent = TABS[id].hint;
    this.text.placeholder = TABS[id].placeholder;
    this.text.value = this.drafts[id] ?? '';
  }

  saveDraft() {
    if (!this.text) return;
    this.drafts[this.tab] = this.text.value;
    store.set(DRAFT_KEY, JSON.stringify(this.drafts));
  }

  renderWhere() {
    const where = this.currentWhere();
    this.whereList.replaceChildren(
      ...Object.entries(where).map(([k, v]) => h('li', {}, h('span', {}, LABELS[k] ?? k), v)),
      h('li', {}, h('span', {}, 'Screenshot'), this.shot ? 'Yes' : 'None'),
    );
  }

  currentWhere() {
    try {
      return this.where() ?? {};
    } catch {
      return {};
    }
  }

  setShot(dataUrl) {
    this.shot = dataUrl;
    this.shotBox.hidden = !dataUrl;
    this.shotButton.hidden = Boolean(dataUrl);
    if (dataUrl) this.thumb.src = dataUrl;
    else this.thumb.removeAttribute('src');
    this.renderWhere();
  }

  say(text, bad = false) {
    this.status.textContent = text;
    this.status.classList.toggle('bad', bad);
  }

  async send() {
    if (this.sending) return;
    const text = this.text.value.trim();
    if (!text && !this.shot) {
      this.say('Write something first, or add a screenshot.', true);
      this.text.focus();
      return;
    }
    this.sending = true;
    this.sendButton.disabled = true;
    this.say('Sending…');
    try {
      const body = { tab: this.tab, text, where: this.currentWhere(), ...(this.shot ? { shot: this.shot } : {}) };
      const res = await fetch('/api/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `The note wasn't saved (${res.status}).`);
      this.text.value = '';
      this.drafts[this.tab] = '';
      store.set(DRAFT_KEY, JSON.stringify(this.drafts));
      this.setShot(null);
      this.say(`Saved at ${data.at.slice(11)} in ${data.file}. Claude reads it from there.`);
      this.onSaved(`Note saved for Claude (${TABS[this.tab].name}).`);
    } catch (err) {
      this.say(err.message, true);
    } finally {
      this.sending = false;
      this.sendButton.disabled = false;
    }
  }

  // --------------------------------------------------------------- screenshot

  /** Ask the browser for a picture of this tab, then let you draw boxes on it. */
  async capture() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      this.show();
      this.say('This browser can’t take a screenshot of the page. Chrome and Edge can.', true);
      return;
    }
    // Hide the pad (and the box screen) so they aren't in the picture.
    this.panel.hidden = true;
    this.button.hidden = true;
    this.marker.hide();
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser', frameRate: 5 },
        audio: false,
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
        surfaceSwitching: 'exclude',
      });
    } catch (err) {
      this.show();
      this.say(err?.name === 'NotAllowedError' ? 'No screenshot taken.' : `Couldn’t take a screenshot (${err?.message ?? err}).`, !(err?.name === 'NotAllowedError'));
      return;
    }
    try {
      this.marker.open(await grabFrame(stream));
    } catch (err) {
      this.show();
      this.say(`Couldn’t take a screenshot (${err?.message ?? err}).`, true);
    } finally {
      for (const track of stream.getTracks()) track.stop();
    }
  }
}

const LABELS = {
  screen: 'Screen',
  tower: 'Tower',
  floor: 'Floor',
  step: 'Guide step',
  room: 'Room open',
  machine: 'Machine open',
  window: 'Last window used',
  clock: 'Game clock',
  size: 'Browser size',
};

function readDrafts() {
  try {
    const value = JSON.parse(store.get(DRAFT_KEY) ?? '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function isTyping(target) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

/** One still frame from a screen-share stream, as a canvas. */
async function grabFrame(stream) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();
  if (!video.videoWidth) {
    await new Promise((done) => {
      const timer = setTimeout(done, 2000);
      video.addEventListener('loadeddata', () => {
        clearTimeout(timer);
        done();
      }, { once: true });
    });
  }
  // Give the page a moment to repaint without the pad and the browser's prompt.
  await new Promise((done) => setTimeout(done, 400));
  if (!video.videoWidth) throw new Error('the browser sent no picture');
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  video.srcObject = null;
  return canvas;
}

// ------------------------------------------------------------------ the boxes

/** The full-screen view where you draw red boxes on the screenshot. */
class Marker {
  constructor({ onUse, onRetake, onCancel }) {
    this.onUse = onUse;
    this.onCancel = onCancel;
    this.image = null;
    this.boxes = [];
    this.drawing = null;
    this.canvas = h('canvas', { class: 'pad-canvas', 'aria-label': 'Your screenshot. Drag to draw a red box.' });
    this.undo = h('button', { type: 'button', class: 'ghost', disabled: true, onclick: () => this.removeLast() }, 'Undo box');
    this.root = h('div', { id: 'pad-mark', class: 'pad-mark', hidden: true, role: 'dialog', 'aria-label': 'Draw a box round what you mean' },
      h('div', { class: 'pad-mark-bar' },
        h('span', { class: 'pad-mark-hint' }, 'Drag to draw a red box round what you mean. You can draw more than one.'),
        this.undo,
        h('button', { type: 'button', class: 'ghost', onclick: () => onRetake() }, 'Take it again'),
        h('button', { type: 'button', class: 'ghost', onclick: () => this.cancel() }, 'Cancel'),
        h('button', { type: 'button', class: 'primary', onclick: () => this.use() }, 'Use this screenshot'),
      ),
      h('div', { class: 'pad-mark-stage' }, this.canvas),
    );
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.cancel();
      } else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.removeLast();
      }
    });
    this.canvas.addEventListener('pointerdown', (e) => this.start(e));
    this.canvas.addEventListener('pointermove', (e) => this.move(e));
    this.canvas.addEventListener('pointerup', (e) => this.end(e));
    this.canvas.addEventListener('pointercancel', () => {
      this.drawing = null;
      this.paint();
    });
  }

  open(image) {
    this.image = image;
    this.boxes = [];
    this.drawing = null;
    this.canvas.width = image.width;
    this.canvas.height = image.height;
    this.paint();
    this.root.hidden = false;
    this.root.querySelector('.primary').focus();
  }

  hide() {
    this.root.hidden = true;
  }

  cancel() {
    this.hide();
    this.onCancel();
  }

  use() {
    this.drawing = null;
    this.paint();
    let url = this.canvas.toDataURL('image/png');
    // A very large screen: send a smaller copy so the note stays under the limit.
    for (let scale = 0.75; url.length > MAX_SHOT_CHARS && scale > 0.2; scale -= 0.15) {
      const small = document.createElement('canvas');
      small.width = Math.round(this.canvas.width * scale);
      small.height = Math.round(this.canvas.height * scale);
      small.getContext('2d').drawImage(this.canvas, 0, 0, small.width, small.height);
      url = small.toDataURL('image/png');
    }
    this.hide();
    this.onUse(url);
  }

  point(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * this.canvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * this.canvas.height;
    return { x: Math.max(0, Math.min(this.canvas.width, x)), y: Math.max(0, Math.min(this.canvas.height, y)) };
  }

  start(e) {
    if (e.button !== 0) return;
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.point(e);
    this.drawing = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  }

  move(e) {
    if (!this.drawing) return;
    const p = this.point(e);
    this.drawing.x1 = p.x;
    this.drawing.y1 = p.y;
    this.paint();
  }

  end(e) {
    if (!this.drawing) return;
    this.move(e);
    const box = this.drawing;
    this.drawing = null;
    const min = this.canvas.width / 200;
    if (Math.abs(box.x1 - box.x0) > min && Math.abs(box.y1 - box.y0) > min) this.boxes.push(box);
    this.undo.disabled = this.boxes.length === 0;
    this.paint();
  }

  removeLast() {
    this.boxes.pop();
    this.undo.disabled = this.boxes.length === 0;
    this.paint();
  }

  paint() {
    const g = this.canvas.getContext('2d');
    g.drawImage(this.image, 0, 0);
    const width = Math.max(3, Math.round(this.canvas.width / 360));
    g.lineWidth = width;
    g.strokeStyle = '#ff2d2d';
    g.shadowColor = 'rgb(0 0 0 / 0.6)';
    g.shadowBlur = width * 2;
    for (const b of this.drawing ? [...this.boxes, this.drawing] : this.boxes) {
      g.strokeRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
    }
    g.shadowBlur = 0;
  }
}
