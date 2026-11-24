// The script editor: a half-finished script that checks every store's device
// in a loop, shown in bash, Python and PowerShell side by side. The learner
// finishes it a block at a time (the loop, what happens when a device doesn't
// answer, how to read the answer), tests it on one store, then runs it on all
// of them. The run is simulated store by store, so each mistake shows up the
// way it would for real: a loop that ends too soon or never, a script that
// dies at the first dead store, one that skips it without a word, or one that
// reads the answer backwards.

import { Tool, type ToolArgs, type ToolCheck, type ToolModule, type ToolOutcome } from './tool.ts';
import type { ResolvedOrg } from '../../world/resolve.ts';

export type Lang = 'bash' | 'python' | 'powershell';
export const LANGS: readonly Lang[] = ['bash', 'python', 'powershell'];

/** Text that can differ by language. */
type PerLang = string | Partial<Record<Lang, string>>;

export interface ScriptOptionDef {
  id: string;
  /** The block's code in each language. */
  code: Record<Lang, string>;
  /** For a block that opens (a loop): the line that closes it. */
  end?: Partial<Record<Lang, string>>;
  correct?: boolean;
  /**
   * What it does when it runs. Errors: handled, crash or skip. Verdict:
   * right, any or inverted. A loop that isn't right prints `output` instead.
   */
  effect?: string;
  /** What the run prints when this block is the first one wrong. */
  output?: PerLang;
  reply: PerLang;
}

export interface ScriptSlotDef {
  id: string;
  label: string;
  /** What the block does: loop, errors or verdict. */
  role: 'loop' | 'errors' | 'verdict';
  options: ScriptOptionDef[];
}

export interface ScriptConfig {
  /** Where the script runs, and how it's edited. */
  host: string;
  editor: string;
  list: { file: string; about: string };
  stores: { from: number; to: number; ip: string; default: number[]; dead: number[] };
  languages: Record<Lang, { file: string; run: string; template: string; crash: string }>;
  slots: ScriptSlotDef[];
  /** Blocks already filled in when the floor starts: slot -> option. */
  draft?: Record<string, string>;
  fix: { label: string; done: string };
}

interface RunResult {
  lang: Lang;
  scope: 'one' | 'all';
  command: string;
  lines: string[];
  summary: string;
  at: number;
}

const pick = (text: PerLang | undefined, lang: Lang): string => (text === undefined ? '' : typeof text === 'string' ? text : (text[lang] ?? Object.values(text)[0] ?? ''));

class ScriptEditor extends Tool<ScriptConfig> {
  readonly id = 'script';
  private last: RunResult | null = null;
  private found: number[] | null = null;
  private fixed: number | null = null;
  private clean = false;

  private stores(): { n: number; ip: string }[] {
    const { from, to, ip } = this.config.stores;
    return Array.from({ length: to - from + 1 }, (_, i) => ({ n: from + i, ip: `${ip}${from + i}` }));
  }

  act(op: string, args: ToolArgs): ToolOutcome {
    if (op === 'run') return this.run(args);
    if (op === 'fix') return this.fix();
    return { ok: false, message: 'The script editor cannot do that.' };
  }

  private run(args: ToolArgs): ToolOutcome {
    const lang = this.text(args, 'lang') as Lang;
    if (!LANGS.includes(lang)) return { ok: false, message: 'Choose bash, Python or PowerShell.' };
    const scope = this.text(args, 'scope') === 'one' ? 'one' : 'all';
    const raw = Array.isArray(args.choices) ? args.choices.filter((c): c is string => typeof c === 'string') : [];
    const choices = Object.fromEntries(raw.map((c) => c.split(':') as [string, string]));
    const picked = this.config.slots.map((slot) => ({ slot, option: slot.options.find((o) => o.id === choices[slot.id]) }));
    const empty = picked.find((p) => !p.option);
    if (empty) return { ok: false, message: `Fill in "${empty.slot.label}" first.` };
    const block = (role: ScriptSlotDef['role']): ScriptOptionDef => picked.find((p) => p.slot.role === role)!.option!;
    const lc = this.config.languages[lang];
    const command = scope === 'one' ? `head -n 1 ${this.config.list.file} > one.txt && ${lc.run.replace(this.config.list.file, 'one.txt')}` : lc.run;
    const stores = scope === 'one' ? this.stores().slice(0, 1) : this.stores();
    const lines: string[] = [];
    let summary = '';
    let wrong: ScriptOptionDef | null = null;
    const loop = block('loop');
    const errors = block('errors');
    const verdict = block('verdict');
    const dead = new Set(this.config.stores.dead);
    const open = new Set(this.fixed === null ? this.config.stores.default : []);
    const flagged: number[] = [];
    const silent: number[] = [];
    if (!loop.correct) {
      wrong = loop;
      lines.push(...pick(loop.output, lang).split('\n'));
      summary = 'The loop never went through the list.';
    } else {
      for (const store of stores) {
        if (dead.has(store.n)) {
          if (errors.effect === 'crash') {
            lines.push(...lc.crash.replaceAll('<ip>', store.ip).split('\n'));
            summary = `Stopped at store ${store.n}: ${stores.length - stores.indexOf(store)} stores never checked.`;
            wrong ??= errors;
            break;
          }
          if (errors.effect === 'skip') {
            silent.push(store.n);
            wrong ??= errors;
            continue;
          }
        }
        const code = dead.has(store.n) ? null : open.has(store.n) ? 200 : 401;
        let result: string;
        if (verdict.effect === 'any') result = 'DEFAULT PASSWORD';
        else if (verdict.effect === 'inverted') result = code === 401 ? 'DEFAULT PASSWORD' : 'refused';
        else result = code === 200 ? 'DEFAULT PASSWORD' : code === 401 ? 'refused' : 'no answer';
        if (result === 'DEFAULT PASSWORD') flagged.push(store.n);
        const truth = code === 200 ? 'DEFAULT PASSWORD' : code === 401 ? 'refused' : 'no answer';
        if (result !== truth) wrong ??= verdict;
        lines.push(`${String(store.n).padEnd(4)} ${store.ip.padEnd(13)} ${result}`);
      }
      if (!summary) {
        const checked = stores.length - silent.length;
        const unanswered = stores.filter((s) => dead.has(s.n) && !silent.includes(s.n)).length;
        summary = `${checked} checked · ${flagged.length} on the factory password${unanswered ? ` · ${unanswered} no answer` : ''} · results.csv written`;
      }
    }
    this.last = { lang, scope, command, lines, summary, at: this.parts.clock.now };
    const message = scope === 'one' ? `Tested ${lc.file} on one store` : `Ran ${lc.file} on ${stores.length} stores`;
    if (wrong) return { ok: true, message, target: scope, correct: false, reply: pick(wrong.reply, lang) };
    if (scope === 'one') return { ok: true, message, target: 'one', correct: true, reply: `Store ${stores[0]!.n} refused the factory password, and the script says so. Now the whole list.` };
    if (this.fixed !== null) {
      this.clean = true;
      return { ok: true, message, target: 'clean', correct: true, reply: `No recorder takes the factory password any more. ${this.config.stores.dead.length} still don't answer: that's for store support, not a tick.` };
    }
    this.found = flagged;
    this.emit({ kind: 'tool.update', summary: `${flagged.length} recorders on the factory password`, data: { tool: this.id } });
    return {
      ok: true,
      message,
      target: 'all',
      correct: true,
      reply: `${flagged.length} recorders still take admin/admin: stores ${flagged.join(', ')}. Stores ${this.config.stores.dead.join(' and ')} didn't answer, and the script said so and carried on.`,
    };
  }

  private fix(): ToolOutcome {
    if (!this.found) return { ok: false, message: 'Run the check on every store first.' };
    if (this.fixed !== null) return { ok: false, message: 'Done already.' };
    this.fixed = this.parts.clock.now;
    this.emit({ kind: 'tool.update', summary: this.config.fix.label, data: { tool: this.id } });
    return { ok: true, message: `${this.config.fix.label}: stores ${this.found.join(', ')}`, target: 'recorders', correct: true, reply: this.config.fix.done };
  }

  private bit(slot: ScriptSlotDef, option: ScriptOptionDef): unknown {
    return { id: option.id, code: option.code, end: option.end ?? null, slot: slot.id };
  }

  view(): unknown {
    const clock = this.parts.clock;
    return {
      host: this.config.host,
      editor: this.config.editor,
      list: { ...this.config.list, count: this.config.stores.to - this.config.stores.from + 1 },
      languages: LANGS.map((id) => ({ id, file: this.config.languages[id].file, run: this.config.languages[id].run, template: this.config.languages[id].template })),
      slots: this.config.slots.map((s) => ({ id: s.id, label: s.label, options: s.options.map((o) => this.bit(s, o)) })),
      draft: this.config.draft ?? {},
      last: this.last ? { ...this.last, at: clock.clockText(this.last.at) } : null,
      found: this.found,
      fixed: this.fixed !== null ? clock.clockText(this.fixed) : null,
      fix: this.config.fix.label,
      clean: this.clean,
    };
  }
}

function validate(config: ScriptConfig, check: ToolCheck): void {
  const { add } = check;
  if (!config?.languages || LANGS.some((l) => !config.languages[l]?.template || !config.languages[l]?.run)) {
    add('script: needs bash, python and powershell, each with a template and a run line');
    return;
  }
  for (const role of ['loop', 'errors', 'verdict'] as const) {
    const slots = (config.slots ?? []).filter((s) => s.role === role);
    if (slots.length !== 1) add(`script: needs exactly one ${role} block`);
  }
  for (const slot of config.slots ?? []) {
    if (slot.options.filter((o) => o.correct).length !== 1) add(`script block ${slot.id}: needs exactly one correct option`);
    for (const l of LANGS) {
      if (!config.languages[l].template.includes(`{{${slot.id}}}`)) add(`script ${l} template: no {{${slot.id}}}`);
      for (const o of slot.options) if (typeof o.code?.[l] !== 'string') add(`script block ${slot.id} option ${o.id}: no ${l} code`);
    }
    for (const o of slot.options) {
      if (slot.role === 'loop' && !o.correct && !o.output) add(`script loop option ${o.id}: needs the output it prints`);
      if (slot.role === 'errors' && !['handled', 'crash', 'skip'].includes(o.effect ?? '')) add(`script errors option ${o.id}: effect handled, crash or skip`);
      if (slot.role === 'verdict' && !['right', 'any', 'inverted'].includes(o.effect ?? '')) add(`script verdict option ${o.id}: effect right, any or inverted`);
    }
  }
  const { from, to, default: open, dead } = config.stores ?? ({} as ScriptConfig['stores']);
  if (!(to > from) || [...(open ?? []), ...(dead ?? [])].some((n) => n < from || n > to)) add('script: stores need a range that holds the default and dead ones');
  if ((dead ?? []).includes(from) || (open ?? []).includes(from)) add('script: the first store is the test store, so it must answer and refuse');
}

function ops(_config: ScriptConfig, _org: ResolvedOrg): Record<string, Set<string> | null> {
  return { run: new Set(['one', 'all', 'clean']), fix: new Set(['recorders']) };
}

export const scriptTool: ToolModule<ScriptConfig> = {
  create: (config, parts) => new ScriptEditor(config, parts),
  validate,
  ops,
};
