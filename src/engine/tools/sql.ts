// The query console: a read-only SQL prompt over a log or a table too big to
// read by eye (a day of sign-ins, a week of API requests). The learner types
// real SELECT queries; a guided step waits for a query whose answer shows
// what the step is after (the total, the busiest browser string, the
// accounts that were broken into), however the learner wrote it.
//
// It can also act on its last result: force a password reset for exactly the
// accounts the result lists, no more and no fewer.

import { Tool, type ToolArgs, type ToolCheck, type ToolModule, type ToolOutcome } from './tool.ts';
import type { ResolvedOrg } from '../../world/resolve.ts';
import { DATASETS, columnValues, type Dataset } from './datasets.ts';
import { SqlError, query, type Cell, type Table } from './sql-engine.ts';

export interface SqlTableDef {
  /** Which made-up data set fills it. */
  dataset: string;
  /** What it holds, one line. */
  about: string;
}

export interface FindingDef {
  id: string;
  /**
   * What a result must show, all of it:
   * - value: a single row with this value in it;
   * - top: the first row has this value in it;
   * - rows: exactly this many rows;
   * - column: a column of this name (an alias or the expression as typed, any case);
   * - set: a column whose values are exactly the data set's named set, in any order;
   * - each: a column whose distinct values are exactly the data set's named set (repeats allowed);
   * - topIn: the first row has a value from the data set's named set;
   * - topHas: the first row has a value with this text in it;
   * - uses: the query's text has this in it (any case), such as DISTINCT;
   * - min: at least this many rows.
   */
  check: { value?: number | string; top?: number | string; rows?: number; column?: string; set?: string; each?: string; topIn?: string; topHas?: string; uses?: string; min?: number };
}

export interface SqlActionDef {
  /** The column of the last result it acts on. */
  column: string;
  /** The set it must match exactly. */
  set: string;
  /** The button. */
  label: string;
  /** What the rows are, plural: "customers". */
  noun: string;
  /** Said when it's exactly right. */
  done: string;
}

export interface SqlConfig {
  /** Where the data lives, for the window: "SIEM". */
  source: string;
  tables: Record<string, SqlTableDef>;
  /** The query the editor starts with. */
  start?: string;
  findings: FindingDef[];
  action?: SqlActionDef;
  seed?: number;
}

/** Rows a result shows in the window. */
const SHOWN = 100;

interface Ran {
  sql: string;
  at: number;
  error?: string;
  columns?: string[];
  rows?: Cell[][];
  matched?: number;
  ms?: number;
}

class QueryConsole extends Tool<SqlConfig> {
  readonly id = 'sql';
  private data: Map<string, Dataset> | null = null;
  private readonly history: Ran[] = [];
  private last: Ran | null = null;
  private readonly found = new Set<string>();
  private acted: { at: number; count: number } | null = null;

  private get tables(): Map<string, Dataset> {
    if (!this.data) {
      this.data = new Map(
        Object.entries(this.config.tables).map(([name, def], i) => {
          const ds = DATASETS[def.dataset]!.make((this.config.seed ?? 4207) + i * 101);
          return [name, { ...ds, table: { ...ds.table, name } }];
        }),
      );
    }
    return this.data;
  }

  override start(): void {
    void this.tables;
  }

  act(op: string, args: ToolArgs): ToolOutcome {
    if (op === 'query') return this.query(this.text(args, 'sql'));
    if (op === 'act' && this.config.action) return this.action(this.config.action);
    return { ok: false, message: 'The query console cannot do that.' };
  }

  private query(sql: string): ToolOutcome {
    if (sql === '') return { ok: false, message: 'Type a query first.' };
    const at = this.parts.clock.now;
    const tables: Table[] = [...this.tables.values()].map((d) => d.table);
    const started = performance.now();
    let ran: Ran;
    try {
      const result = query(sql, tables);
      ran = { sql, at, columns: result.columns, rows: result.rows, matched: result.matched, ms: Math.max(1, Math.round(performance.now() - started)) };
    } catch (err) {
      if (!(err instanceof SqlError)) throw err;
      ran = { sql, at, error: err.message };
    }
    this.last = ran;
    this.history.unshift({ sql, at, ...(ran.error ? { error: ran.error } : {}) });
    if (this.history.length > 12) this.history.pop();
    const short = sql.replace(/\s+/g, ' ').slice(0, 70);
    if (ran.error) return { ok: true, message: `Query failed: ${short}`, target: 'error' };
    const matches = this.config.findings.filter((f) => this.satisfies(f, ran));
    const fresh = matches.filter((f) => !this.found.has(f.id));
    for (const f of matches) this.found.add(f.id);
    // One query can answer two steps at once: the first counts now, the rest right after.
    for (const extra of fresh.slice(1)) this.finishedOp('query', { message: `Query: ${short}`, target: extra.id, correct: true });
    const hit = fresh[0] ?? matches[0];
    return { ok: true, message: `Query: ${short}`, target: hit?.id ?? 'query', ...(hit ? { correct: true } : {}) };
  }

  private satisfies(f: FindingDef, ran: Ran): boolean {
    const columns = ran.columns ?? [];
    const rows = ran.rows ?? [];
    const { value, top, rows: count, column, set, each, min, topIn, topHas, uses } = f.check;
    const same = (cell: Cell, want: number | string): boolean => (typeof want === 'number' ? Number(cell) === want : String(cell).toLowerCase() === want.toLowerCase());
    if (count !== undefined && rows.length !== count) return false;
    if (min !== undefined && rows.length < min) return false;
    if (value !== undefined && !(rows.length === 1 && rows[0]!.some((c) => same(c, value)))) return false;
    if (top !== undefined && !(rows.length > 0 && rows[0]!.some((c) => same(c, top)))) return false;
    if (uses !== undefined && !ran.sql.toLowerCase().includes(uses.toLowerCase())) return false;
    if (topHas !== undefined && !(rows.length > 0 && rows[0]!.some((c) => String(c).toLowerCase().includes(topHas.toLowerCase())))) return false;
    if (topIn !== undefined) {
      const inSet = this.set(topIn);
      if (!(rows.length > 0 && rows[0]!.some((c) => inSet.has(String(c))))) return false;
    }
    if (column !== undefined && !columns.some((c) => c.toLowerCase().replace(/\s+/g, '') === column.toLowerCase().replace(/\s+/g, ''))) return false;
    if (set !== undefined) {
      const want = this.set(set);
      const has = columns.some((c) => {
        const values = columnValues(columns, rows, c);
        return values !== null && values.length === want.size && new Set(values).size === want.size && values.every((v) => want.has(v));
      });
      if (!has) return false;
    }
    if (each !== undefined) {
      const want = this.set(each);
      const has = columns.some((c) => {
        const values = new Set(columnValues(columns, rows, c) ?? []);
        return values.size === want.size && [...values].every((v) => want.has(v));
      });
      if (!has) return false;
    }
    return true;
  }

  private set(name: string): Set<string> {
    for (const d of this.tables.values()) if (d.sets[name]) return new Set(d.sets[name]);
    return new Set();
  }

  private action(def: SqlActionDef): ToolOutcome {
    if (this.acted) return { ok: false, message: `Done already, at ${this.parts.clock.clockText(this.acted.at)}.` };
    const ran = this.last;
    const values = ran?.columns && ran.rows ? columnValues(ran.columns, ran.rows, def.column) : null;
    if (!ran || ran.error || !values) return { ok: false, message: `Run a query whose result has a ${def.column} column first.` };
    const unique = [...new Set(values)];
    const want = this.set(def.set);
    const right = unique.filter((v) => want.has(v)).length;
    const n = (x: number): string => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    const message = `${def.label}: ${n(unique.length)} ${def.noun}`;
    if (right === want.size && unique.length === want.size) {
      this.acted = { at: this.parts.clock.now, count: unique.length };
      this.emit({ kind: 'tool.update', summary: `${def.label}: ${unique.length} ${def.noun}`, data: { tool: this.id } });
      return { ok: true, message, target: def.set, correct: true, reply: def.done };
    }
    const reply =
      right === want.size
        ? `That's ${n(unique.length)} ${def.noun}, and only ${n(want.size)} of them were broken into. The other ${n(unique.length - right)} did nothing wrong. Narrow the query to the ones that got in.`
        : right > 0
          ? `That's ${n(unique.length)}, but ${n(want.size)} ${def.noun} were broken into, and ${n(want.size - right)} are missing from your result.${unique.length > right ? ` ${n(unique.length - right)} in it weren't broken into at all.` : ''}`
          : `None of those ${def.noun} were broken into. Find the ones the bot signed in as.`;
    return { ok: true, message, target: def.set, correct: false, reply };
  }

  view(): unknown {
    const clock = this.parts.clock;
    const last = this.last;
    return {
      source: this.config.source,
      start: this.config.start ?? '',
      tables: [...this.tables].map(([name, d]) => ({ name, about: this.config.tables[name]!.about, columns: d.table.columns, rows: d.table.rows.length })),
      last: last
        ? {
            sql: last.sql,
            at: clock.clockText(last.at),
            error: last.error ?? null,
            columns: last.columns ?? [],
            rows: (last.rows ?? []).slice(0, SHOWN),
            count: last.rows?.length ?? 0,
            matched: last.matched ?? 0,
            ms: last.ms ?? 0,
          }
        : null,
      history: this.history.map((h) => ({ sql: h.sql, at: clock.clockText(h.at), failed: !!h.error })),
      action: this.config.action ? { label: this.config.action.label, column: this.config.action.column, done: this.acted ? { at: clock.clockText(this.acted.at), count: this.acted.count } : null } : null,
    };
  }
}

function validate(config: SqlConfig, check: ToolCheck): void {
  const { add } = check;
  if (typeof config?.source !== 'string' || !config.tables || Object.keys(config.tables).length === 0) {
    add('sql: needs a source and tables');
    return;
  }
  const sets = new Set<string>();
  for (const [name, def] of Object.entries(config.tables)) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) add(`sql table ${name}: use lower-case letters, digits and _`);
    if (!DATASETS[def.dataset]) add(`sql table ${name}: no data set ${def.dataset}`);
    else DATASETS[def.dataset]!.sets.forEach((s) => sets.add(s));
    if (!def.about) add(`sql table ${name}: needs an about line`);
  }
  for (const f of config.findings ?? []) {
    if (!f.check || Object.keys(f.check).length === 0) add(`sql finding ${f.id}: needs a check`);
    for (const name of [f.check?.set, f.check?.each, f.check?.topIn]) if (name && !sets.has(name)) add(`sql finding ${f.id}: no set ${name}`);
  }
  if (config.action && !sets.has(config.action.set)) add(`sql action: no set ${config.action.set}`);
}

function ops(config: SqlConfig, _org: ResolvedOrg): Record<string, Set<string> | null> {
  return { query: new Set((config.findings ?? []).map((f) => f.id)), ...(config.action ? { act: new Set([config.action.set]) } : {}) };
}

export const sqlTool: ToolModule<SqlConfig> = {
  create: (config, parts) => new QueryConsole(config, parts),
  validate,
  ops,
};
