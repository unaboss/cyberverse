// The desk tools: one window per tool a floor gives the learner (a risk
// register, a scanner, a honeypot...). The server sends each tool's view in the
// round snapshot; the tool's module in ui/tools/ draws it and turns clicks into
// tool operations. A window is only redrawn when its view changed, and never
// while you are typing in it.

import { h } from './dom.js';
import { clamp } from './geometry.js';
import * as risk from './tools/risk.js';
import * as scan from './tools/scan.js';
import * as honeypot from './tools/honeypot.js';
import * as power from './tools/power.js';
import * as bench from './tools/bench.js';
import * as tickets from './tools/tickets.js';
import * as wifi from './tools/wifi.js';
import * as sessions from './tools/sessions.js';
import * as traffic from './tools/traffic.js';
import * as compose from './tools/compose.js';
import * as recovery from './tools/recovery.js';
import * as evidence from './tools/evidence.js';
import * as sql from './tools/sql.js';
import * as script from './tools/script.js';
import * as cloud from './tools/cloud.js';
import * as segments from './tools/segments.js';
import * as design from './tools/design.js';
import * as approvals from './tools/approvals.js';
import * as sheet from './tools/sheet.js';
import * as budget from './tools/budget.js';

const RENDERERS = { risk, scan, honeypot, power, bench, tickets, wifi, sessions, traffic, compose, recovery, evidence, sql, script, cloud, segments, design, approvals, sheet, budget };

const M = 12;

export class ToolDesk {
  /**
   * @param {{ desk: import('./windows.js').Desk, stage: HTMLElement, act: (tool: string, op: string, args?: object) => Promise<object|null>, look: (id: string) => void, ctx: object }} options
   */
  constructor({ desk, stage, act, look, ctx }) {
    this.desk = desk;
    this.stage = stage;
    this.act = act;
    this.look = look;
    this.ctx = ctx;
    this.panels = new Map(); // tool id -> { panel, key, pending }
    this.lastLook = new Map();
  }

  /** Show the round's tools and hide the rest. */
  sync(snap) {
    const tools = snap.tools ?? {};
    for (const [id, entry] of this.panels) {
      if (!(id in tools)) entry.panel.hidden = true;
    }
    Object.entries(tools).forEach(([id, view], i) => {
      const renderer = RENDERERS[id];
      if (!renderer) return;
      const entry = this.panels.get(id) ?? this.create(id, view.title, i);
      entry.panel.hidden = false;
      entry.view = view;
      const key = JSON.stringify(view);
      if (key === entry.key) return;
      if (entry.panel.contains(document.activeElement) && document.activeElement.matches('input, textarea, select')) {
        // Typing in it: draw once you leave the field.
        entry.pending = true;
        return;
      }
      entry.key = key;
      this.draw(id, entry);
    });
  }

  draw(id, entry) {
    const renderer = RENDERERS[id];
    const ctx = {
      ...this.ctx,
      h,
      act: (op, args = {}) => this.act(id, op, args),
      // The tool asked to redraw (you ticked or picked something in it): draw now,
      // even with a field focused, and put the focus back where it was.
      redraw: () => {
        const label = entry.body.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') : null;
        entry.pending = false;
        entry.key = JSON.stringify(entry.view);
        this.draw(id, entry);
        if (label) entry.body.querySelector(`[aria-label="${CSS.escape(label)}"]`)?.focus();
      },
    };
    renderer.render(entry.body, entry.view, ctx, entry.local);
    this.desk.setTitle(`tool-${id}`, renderer.title?.(entry.view) ?? entry.view.title);
  }

  create(id, title, index) {
    const body = h('div', { class: `tool-body tool-${id}` });
    const panel = h('div', { class: 'panel tool-panel', 'data-tool': id, hidden: true }, body);
    const entry = { panel, body, key: null, pending: false, view: null, local: {} };
    this.panels.set(id, entry);
    const win = this.desk.add(`tool-${id}`, panel, {
      title,
      defaults: (W, H) => {
        const w = Math.round(clamp(W * 0.36, 340, 560));
        // A tool with a map or a chart in it asks for the full height.
        const hgt = Math.round(RENDERERS[id]?.tall ? clamp(H - 2 * M - index * 40, 320, 860) : clamp(H * 0.6, 280, 600));
        // Folded until a step needs it, so the floor keeps the room.
        return { x: M, y: M + index * 40, w, h: hgt, folded: true };
      },
    });
    win.addEventListener('pointerdown', () => this.touched(id));
    panel.addEventListener('focusout', () => {
      setTimeout(() => {
        if (entry.pending && !panel.contains(document.activeElement)) {
          entry.pending = false;
          entry.key = null;
          this.sync(this.ctx.snap());
        }
      }, 0);
    });
    return entry;
  }

  /** You opened or used a tool: a guided step may be waiting for exactly that. */
  touched(id) {
    const now = Date.now();
    if (now - (this.lastLook.get(id) ?? 0) < 1500) return;
    this.lastLook.set(id, now);
    this.look(id);
  }

  has(id) {
    return this.panels.has(id) && !this.panels.get(id).panel.hidden;
  }

  /** Open one tool's window and fold the others, so a step's tool is never hidden behind another. */
  focus(id) {
    if (!this.has(id)) return null;
    for (const other of this.panels.keys()) {
      if (other !== id && this.has(other)) this.desk.setFolded(`tool-${other}`, true);
    }
    return this.open(id);
  }

  /** Bring a tool's window forward, for Show me. */
  open(id) {
    if (!this.has(id)) return null;
    this.desk.open(`tool-${id}`);
    return this.desk.win(`tool-${id}`);
  }
}
