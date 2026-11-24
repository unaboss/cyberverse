// The notes pad (ui/notepad.js): notes you write while playing, saved as
// Markdown on this computer so Claude can read them and make the change.
//
//   POST /api/notes {tab: 'ui' | 'practicals', text, where?, shot?}
//
// Local server only: the hosted lab has no notes pad. Each note is appended to
// notes/ui-notes.md or notes/practicals-notes.md in the project folder, which
// git ignores, and its screenshot (if any) is written to notes/shots/ as a PNG.
//
// An entry looks like this, the same shape as CyberLab v6's notes:
//
//   ### 2026-11-24 13:52:10 - <who wrote it>
//   ## Screen: Round
//   - Floor: 3, Close the door (defend-03-close-the-door)
//
//   The firewall button is hard to find.
//
//   ![screenshot](shots/2026-11-24_13-52-10-ui-3fa9c2.png)
//
//   ---

import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { HttpError } from './api.ts';

/** A note can carry a screenshot, so it may be much larger than other API calls. */
export const NOTE_MAX_BODY = 12 * 1024 * 1024;
const MAX_TEXT = 20_000;
const MAX_SHOT = 9 * 1024 * 1024;
const MAX_FIELD = 200;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export const NOTE_FILES = { ui: 'ui-notes.md', practicals: 'practicals-notes.md' } as const;
export type NoteTab = keyof typeof NOTE_FILES;

/** What the page says about where you were, in the order it is written down. */
const WHERE: [key: string, label: string][] = [
  ['tower', 'Tower'],
  ['floor', 'Floor'],
  ['step', 'Guide step'],
  ['room', 'Room open'],
  ['machine', 'Machine open'],
  ['window', 'Last window used'],
  ['clock', 'Game clock'],
  ['size', 'Browser size'],
];

export interface SavedNote {
  /** The notes file, relative to the project folder. */
  file: string;
  /** The screenshot, relative to the project folder, if there was one. */
  shot: string | null;
  at: string;
}

export interface NotesOptions {
  /** Who wrote the notes. Defaults to the user signed in to this computer. */
  author?: string;
  now?: () => Date;
}

export class NotesBook {
  readonly dir: string;
  private readonly author: string;
  private readonly now: () => Date;
  /** Notes are written one at a time, so two quick submits never interleave. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string, opts: NotesOptions = {}) {
    this.dir = dir;
    this.author = clean(opts.author ?? whoami()) || 'learner';
    this.now = opts.now ?? (() => new Date());
  }

  add(body: Record<string, unknown>): Promise<SavedNote> {
    const note = parseNote(body);
    const next = this.queue.then(() => this.write(note));
    this.queue = next.catch(() => {});
    return next;
  }

  private async write(note: Note): Promise<SavedNote> {
    const at = this.now();
    const stamp = `${day(at)} ${time(at, ':')}`;
    await mkdir(this.dir, { recursive: true });
    let shot: string | null = null;
    if (note.shot) {
      shot = `shots/${day(at)}_${time(at, '-')}-${note.tab}-${randomBytes(3).toString('hex')}.png`;
      await mkdir(join(this.dir, 'shots'), { recursive: true });
      await writeFile(join(this.dir, shot), note.shot, { flag: 'wx' });
    }
    const lines = [`### ${stamp} - ${this.author}`, `## Screen: ${note.where.screen ?? 'Unknown'}`];
    for (const [key, label] of WHERE) {
      const value = note.where[key];
      if (value) lines.push(`- ${label}: ${value}`);
    }
    lines.push('');
    if (note.text) lines.push(escapeText(note.text), '');
    if (shot) lines.push(`![screenshot](${shot})`, '');
    lines.push('---', '', '');
    const file = NOTE_FILES[note.tab];
    await appendFile(join(this.dir, file), lines.join('\n'), 'utf8');
    return { file: `notes/${file}`, shot: shot ? `notes/${shot}` : null, at: stamp };
  }
}

interface Note {
  tab: NoteTab;
  text: string;
  where: Record<string, string>;
  shot: Buffer | null;
}

export function parseNote(body: Record<string, unknown>): Note {
  const tab = body.tab;
  if (tab !== 'ui' && tab !== 'practicals') {
    throw new HttpError(400, 'Say which notes this is for: "ui" or "practicals".');
  }
  const text = typeof body.text === 'string' ? body.text.replace(/\r\n?/g, '\n').trim() : '';
  if (text.length > MAX_TEXT) {
    throw new HttpError(413, `A note can be up to ${MAX_TEXT} characters.`);
  }
  const shot = body.shot === undefined || body.shot === null ? null : decodePng(body.shot);
  if (!text && !shot) {
    throw new HttpError(400, 'Write something, or add a screenshot.');
  }
  const where: Record<string, string> = {};
  if (typeof body.where === 'object' && body.where !== null && !Array.isArray(body.where)) {
    for (const [key, value] of Object.entries(body.where as Record<string, unknown>)) {
      const known = key === 'screen' || WHERE.some(([k]) => k === key);
      const cleaned = typeof value === 'string' || typeof value === 'number' ? clean(String(value)) : '';
      if (known && cleaned) where[key] = cleaned;
    }
  }
  return { tab, text, where, shot };
}

function decodePng(value: unknown): Buffer {
  const prefix = 'data:image/png;base64,';
  if (typeof value !== 'string' || !value.startsWith(prefix)) {
    throw new HttpError(400, 'A screenshot must be a PNG.');
  }
  const data = value.slice(prefix.length);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new HttpError(400, 'A screenshot must be a PNG.');
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > MAX_SHOT) {
    throw new HttpError(413, 'That screenshot is too large.');
  }
  if (bytes.length < PNG_MAGIC.length || PNG_MAGIC.some((b, i) => bytes[i] !== b)) {
    throw new HttpError(400, 'A screenshot must be a PNG.');
  }
  return bytes;
}

/** One line of plain text: no line breaks or control characters, and not too long. */
function clean(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD);
}

/** Keep the note inside its entry: a line can't start a new heading or end the entry. */
function escapeText(text: string): string {
  return text
    .split('\n')
    .map((line) => (/^\s*(#|-{3,}\s*$)/.test(line) ? `\\${line.trimStart()}` : line))
    .join('\n');
}

function whoami(): string {
  try {
    return userInfo().username;
  } catch {
    return 'learner';
  }
}

const pad = (n: number): string => String(n).padStart(2, '0');
const day = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const time = (d: Date, sep: string): string => [d.getHours(), d.getMinutes(), d.getSeconds()].map(pad).join(sep);
