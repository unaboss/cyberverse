// The spreadsheet: build the monthly security report the way an analyst
// does in a spreadsheet or BI tool. Import from a database, a CSV file and a
// report; relate the incidents to the store list so each incident has a
// region; pivot by the date's month level, by region, by average time to
// respond; chart it; and publish a dashboard of the tiles the executives
// can act on. Every pivot is computed from the imported rows.

import { Tool, type ToolArgs, type ToolCheck, type ToolModule, type ToolOutcome, type ToolParts } from './tool.ts';
import { MONTH_NAMES, MONTHS, reportTables, type Cell, type SheetTable } from './report-data.ts';
import type { ResolvedOrg } from '../../world/resolve.ts';

export interface SheetSourceDef {
  id: string;
  name: string;
  kind: 'database' | 'csv' | 'file' | 'report';
  about: string;
  /** The table it fills. None for a source the report shouldn't touch. */
  table?: string;
  /** A CSV's real separator. */
  delimiter?: string;
  /** Said when someone imports a source the report shouldn't touch. */
  reply?: string;
}

export interface SheetFindingDef {
  id: string;
  rows: string;
  columns?: string;
  value: string;
  /** Rows and columns may be swapped. */
  either?: boolean;
}

export interface SheetTileDef {
  id: string;
  name: string;
  /** What it shows: computed from the data, or a fixed figure. */
  kind: 'trend' | 'regions' | 'respond' | 'phishing' | 'vulns' | 'figure';
  figure?: string;
  good?: boolean;
  reply?: string;
}

export interface SheetConfig {
  file: string;
  sources: SheetSourceDef[];
  relationship: { from: string; to: string };
  findings: SheetFindingDef[];
  /** The response-time target, in minutes. */
  target: number;
  tiles: SheetTileDef[];
}

interface Pivot {
  rows: string;
  columns: string;
  value: string;
  rowLabels: string[];
  colLabels: string[];
  cells: (number | null)[][];
  rowTotals: number[];
  colTotals: number[];
  grand: number;
}

const FIELDS: Record<string, { label: string; relation?: boolean }> = {
  month: { label: 'Opened → Month' },
  opened: { label: 'Opened (date and time)' },
  category: { label: 'Category' },
  severity: { label: 'Severity' },
  status: { label: 'Status' },
  store: { label: 'Store number' },
  region: { label: 'Store → Region', relation: true },
};
const VALUES: Record<string, string> = { count: 'Count of incidents', 'avg-minutes': 'Average of minutes to respond', 'sum-minutes': 'Sum of minutes to respond' };
const BLANK = '(blank)';

const round = (x: number): number => Math.round(x * 10) / 10;

class Sheet extends Tool<SheetConfig> {
  readonly id = 'sheet';
  private readonly data = reportTables();
  private readonly imported = new Map<string, number>();
  /** A CSV brought in with the wrong separator: one column of text. */
  private readonly garbled = new Set<string>();
  private related: string | null = null;
  private pivot: Pivot | null = null;
  private chart = 'table';
  private published: { at: number; tiles: string[] } | null = null;

  constructor(config: SheetConfig, parts: ToolParts) {
    super(config, parts);
  }

  act(op: string, args: ToolArgs): ToolOutcome {
    if (op === 'import') return this.importSource(this.text(args, 'source'), this.text(args, 'delimiter'));
    if (op === 'relate') return this.relate(this.text(args, 'from'), this.text(args, 'to'));
    if (op === 'pivot') return this.makePivot(this.text(args, 'rows'), this.text(args, 'columns'), this.text(args, 'value'));
    if (op === 'chart') return this.setChart(this.text(args, 'type'));
    if (op === 'publish') return this.publish(args);
    return { ok: false, message: 'The spreadsheet cannot do that.' };
  }

  private importSource(id: string, delimiter: string): ToolOutcome {
    const source = this.config.sources.find((s) => s.id === id);
    if (!source) return { ok: false, message: 'Choose something to import.' };
    if (!source.table) return { ok: true, message: `Looked at importing ${source.name}`, target: source.id, correct: false, reply: source.reply ?? 'The report doesn\'t need that.' };
    if (this.imported.has(id) && !this.garbled.has(id)) return { ok: false, message: `${source.name} is imported already.` };
    const table = this.data[source.table]!;
    if (source.kind === 'csv' && delimiter && delimiter !== source.delimiter) {
      this.garbled.add(id);
      this.imported.set(id, this.parts.clock.now);
      return {
        ok: true,
        message: `Imported ${source.name} with "${delimiter}" as the separator`,
        target: source.id,
        correct: false,
        reply: `Everything landed in one column: "${table.columns.join(source.delimiter)}". This file is separated by "${source.delimiter}", which many South African exports use because the comma is the decimal sign. Import it again with the right separator.`,
      };
    }
    this.garbled.delete(id);
    this.imported.set(id, this.parts.clock.now);
    this.emit({ kind: 'tool.update', summary: `Imported ${table.rows.length} rows from ${source.name}`, data: { tool: this.id } });
    return { ok: true, message: `Imported ${table.rows.length} rows from ${source.name} into ${table.name}`, target: source.id, correct: true, reply: `${table.rows.length} rows in ${table.name}: ${table.columns.join(', ')}.` };
  }

  private has(table: string): boolean {
    return this.config.sources.some((s) => s.table === table && this.imported.has(s.id) && !this.garbled.has(s.id));
  }

  private relate(from: string, to: string): ToolOutcome {
    const [ft, fc] = from.split('.');
    const [tt] = to.split('.');
    if (!ft || !fc || !tt || !this.has(ft) || !this.has(tt)) return { ok: false, message: 'Import both tables first.' };
    const message = `Related ${from} to ${to}`;
    if (from === this.config.relationship.from && to === this.config.relationship.to) {
      this.related = `${from}>${to}`;
      this.emit({ kind: 'tool.update', summary: `Relationship: ${from} → ${to}, many to one`, data: { tool: this.id } });
      return { ok: true, message, target: tt, correct: true, reply: 'Many incidents to one store. Every incident with a store number now has its store\'s name and region.' };
    }
    const reply =
      to === 'stores.name'
        ? 'stores.name holds "Store 47, Mthatha"; the incidents hold just 47. Join number to number.'
        : fc !== 'store'
          ? `${from} isn't a store. A relationship joins the same thing in two tables: here, the store number.`
          : 'The region is in the store list. Join the incidents\' store number to the store list\'s store number.';
    return { ok: true, message, target: tt, correct: false, reply };
  }

  private field(row: Record<string, Cell>, field: string, stores: Map<Cell, Record<string, Cell>>): string {
    if (field === 'month') return MONTH_NAMES[String(row.opened).slice(0, 7)] ?? BLANK;
    if (field === 'region') {
      const s = row.store === '' ? undefined : stores.get(row.store!);
      return s ? String(s.region) : BLANK;
    }
    const v = row[field];
    return v === '' || v === undefined ? BLANK : String(v);
  }

  private makePivot(rows: string, columns: string, value: string): ToolOutcome {
    if (!this.has('incidents')) return { ok: false, message: 'Import the SIEM incidents first.' };
    if (!FIELDS[rows] || (columns && !FIELDS[columns]) || !VALUES[value]) return { ok: false, message: 'Choose rows and a value.' };
    if (rows === columns) return { ok: false, message: 'Rows and columns need different fields.' };
    const short = `${FIELDS[rows]!.label}${columns ? ` by ${FIELDS[columns]!.label}` : ''}, ${VALUES[value]!.toLowerCase()}`;
    if ((FIELDS[rows]!.relation || (columns && FIELDS[columns]!.relation)) && !this.related) {
      return { ok: true, message: `Tried a pivot: ${short}`, target: 'pivot', correct: false, reply: 'Region isn\'t in the incidents table: it\'s in the store list. Relate the incidents to the stores first, on the Model tab.' };
    }
    const table = this.data.incidents!;
    const stores = new Map(this.data.stores!.rows.map((s) => [s.store!, s]));
    const order = (labels: Set<string>, field: string): string[] => {
      const list = [...labels];
      if (field === 'month') return MONTHS.map((m) => MONTH_NAMES[m]!).filter((m) => labels.has(m));
      if (field === 'store') return list.sort((a, b) => (a === BLANK ? 1 : b === BLANK ? -1 : Number(a) - Number(b)));
      return list.sort((a, b) => (a === BLANK ? 1 : b === BLANK ? -1 : a.localeCompare(b)));
    };
    const rowSet = new Set<string>();
    const colSet = new Set<string>();
    for (const r of table.rows) {
      rowSet.add(this.field(r, rows, stores));
      if (columns) colSet.add(this.field(r, columns, stores));
    }
    const rowLabels = order(rowSet, rows);
    const colLabels = columns ? order(colSet, columns) : [];
    const agg = (subset: Record<string, Cell>[]): number => {
      if (value === 'count') return subset.length;
      const sum = subset.reduce((a, r) => a + Number(r.minutes_to_respond), 0);
      return value === 'sum-minutes' ? sum : subset.length ? round(sum / subset.length) : 0;
    };
    const groups = new Map<string, Record<string, Cell>[]>();
    for (const r of table.rows) {
      const k = `${this.field(r, rows, stores)}|${columns ? this.field(r, columns, stores) : ''}`;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
    }
    const byRow = (label: string) => table.rows.filter((r) => this.field(r, rows, stores) === label);
    const byCol = (label: string) => table.rows.filter((r) => this.field(r, columns, stores) === label);
    const cells = rowLabels.map((rl) => (columns ? colLabels.map((cl) => (groups.has(`${rl}|${cl}`) ? agg(groups.get(`${rl}|${cl}`)!) : null)) : []));
    this.pivot = { rows, columns, value, rowLabels, colLabels, cells, rowTotals: rowLabels.map((rl) => agg(byRow(rl))), colTotals: colLabels.map((cl) => agg(byCol(cl))), grand: agg(table.rows) };
    this.chart = 'table';
    const message = `Pivot: ${short}`;
    if (rows === 'opened' || columns === 'opened') {
      return { ok: true, message, target: 'pivot', correct: false, reply: `That's one row per date and time: ${rowLabels.length} rows nobody can read. Dates have levels; use the Month level of Opened.` };
    }
    if (value === 'sum-minutes') {
      return { ok: true, message, target: 'pivot', correct: false, reply: 'A sum of minutes grows with the number of incidents, so it says nothing about how fast we are. The target is per incident: use the average.' };
    }
    const hit = this.config.findings.find((f) => value === f.value && ((rows === f.rows && (columns || '') === (f.columns ?? '')) || (f.either && rows === f.columns && columns === f.rows)));
    return { ok: true, message, target: hit?.id ?? 'pivot', ...(hit ? { correct: true } : {}) };
  }

  private setChart(type: string): ToolOutcome {
    if (!['table', 'bar', 'line', 'pie'].includes(type)) return { ok: false, message: 'Choose a chart.' };
    if (!this.pivot) return { ok: false, message: 'Make a pivot first.' };
    this.chart = type;
    const overTime = this.pivot.rows === 'month' && !this.pivot.columns;
    const message = `Charted the pivot as a ${type === 'table' ? 'table' : `${type} chart`}`;
    if (!overTime) return { ok: true, message, target: type };
    if (type === 'line') return { ok: true, message, target: 'line', correct: true, reply: 'A line, left to right through the months: down from August to October, and up in November.' };
    if (type === 'pie') return { ok: true, message, target: 'pie', correct: false, reply: 'A pie shows the parts of one whole. Months aren\'t parts of anything; they\'re a trend. Use a line.' };
    if (type === 'bar') return { ok: true, message, target: 'bar', correct: false, reply: 'Bars are for comparing separate things side by side. For one number moving over time, a line reads at a glance.' };
    return { ok: true, message, target: type };
  }

  private publish(args: ToolArgs): ToolOutcome {
    const chosen = Array.isArray(args.tiles) ? [...new Set(args.tiles.filter((t): t is string => typeof t === 'string'))] : [];
    const tiles = this.config.tiles.filter((t) => chosen.includes(t.id));
    const message = `Checked a dashboard of ${tiles.length} tiles`;
    const bad = tiles.find((t) => !t.good);
    if (bad) return { ok: true, message, target: 'dashboard', correct: false, reply: `"${bad.name}": ${bad.reply ?? 'nobody can act on that.'}` };
    const missing = this.config.tiles.find((t) => t.good && !chosen.includes(t.id));
    if (missing) return { ok: true, message, target: 'dashboard', correct: false, reply: `The executives also need "${missing.name}". ${missing.reply ?? ''}`.trim() };
    this.published = { at: this.parts.clock.now, tiles: tiles.map((t) => t.id) };
    this.emit({ kind: 'tool.update', summary: `Published the November security dashboard: ${tiles.length} tiles`, data: { tool: this.id } });
    return { ok: true, message: `Published the November security dashboard to the executives`, target: 'dashboard', correct: true, reply: 'Five tiles, each one a question the executives can act on, each against a target or a trend.' };
  }

  /** What a tile shows, from the data. */
  private tile(t: SheetTileDef): unknown {
    const inc = this.data.incidents!.rows;
    const monthOf = (r: Record<string, Cell>) => String(r.opened).slice(0, 7);
    if (t.kind === 'trend') return { series: MONTHS.map((m) => ({ label: MONTH_NAMES[m], value: inc.filter((r) => monthOf(r) === m).length })) };
    if (t.kind === 'respond') {
      return {
        target: this.config.target,
        series: MONTHS.map((m) => {
          const rs = inc.filter((r) => monthOf(r) === m);
          return { label: MONTH_NAMES[m], value: round(rs.reduce((a, r) => a + Number(r.minutes_to_respond), 0) / rs.length) };
        }),
      };
    }
    if (t.kind === 'regions') {
      const stores = new Map(this.data.stores!.rows.map((s) => [s.store!, s]));
      const counts = new Map<string, number>();
      for (const r of inc.filter((x) => monthOf(x) === '2026-11')) {
        const region = this.field(r, 'region', stores);
        counts.set(region === BLANK ? 'Head office' : region, (counts.get(region === BLANK ? 'Head office' : region) ?? 0) + 1);
      }
      return { bars: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value })) };
    }
    if (t.kind === 'phishing') {
      return { series: MONTHS.map((m) => { const r = this.data.phishing!.rows.find((x) => x.month === m && x.group === 'Stores')!; return { label: MONTH_NAMES[m], value: Math.round((Number(r.clicked) / Number(r.sent)) * 100) }; }) };
    }
    if (t.kind === 'vulns') return { figure: String(this.data.vulns!.rows.filter((v) => v.severity === 'critical' && Number(v.days_open) > 30).length), note: 'target 0' };
    return { figure: t.figure ?? '' };
  }

  view(): unknown {
    const clock = this.parts.clock;
    const tables = this.config.sources
      .filter((s) => s.table && this.imported.has(s.id))
      .map((s) => {
        const t: SheetTable = this.data[s.table!]!;
        if (this.garbled.has(s.id)) {
          const header = t.columns.join(s.delimiter);
          return { name: t.name, source: s.name, garbled: true, columns: [header], count: t.rows.length, preview: t.rows.slice(0, 4).map((r) => [t.columns.map((c) => r[c]).join(s.delimiter)]) };
        }
        return { name: t.name, source: s.name, garbled: false, columns: t.columns, count: t.rows.length, preview: t.rows.slice(0, 4).map((r) => t.columns.map((c) => r[c] ?? '')) };
      });
    const csvHeads = Object.fromEntries(this.config.sources.filter((s) => s.kind === 'csv' && s.table).map((s) => [s.id, this.data[s.table!]!.columns.join(s.delimiter)]));
    return {
      file: this.config.file,
      sources: this.config.sources.map((s) => ({ id: s.id, name: s.name, kind: s.kind, about: s.about, imported: this.imported.has(s.id) && !this.garbled.has(s.id) ? clock.clockText(this.imported.get(s.id)) : null, head: csvHeads[s.id] ?? null })),
      tables,
      related: this.related ? this.related.replace('>', ' → ') : null,
      fields: Object.entries(FIELDS).map(([id, f]) => ({ id, label: f.label, relation: Boolean(f.relation) })),
      values: Object.entries(VALUES).map(([id, label]) => ({ id, label })),
      pivot: this.pivot ? { ...this.pivot, rowsLabel: FIELDS[this.pivot.rows]!.label, columnsLabel: this.pivot.columns ? FIELDS[this.pivot.columns]!.label : null, valueLabel: VALUES[this.pivot.value] } : null,
      chart: this.chart,
      target: this.config.target,
      tiles: this.config.tiles.map((t) => ({ id: t.id, name: t.name, kind: t.kind, show: this.tile(t) })),
      published: this.published ? { at: clock.clockText(this.published.at), tiles: this.published.tiles } : null,
    };
  }
}

function validate(config: SheetConfig, check: ToolCheck): void {
  const { add } = check;
  const tables = reportTables();
  for (const s of config?.sources ?? []) {
    if (s.table && !tables[s.table]) add(`sheet source ${s.id}: no table ${s.table}`);
    if (!s.table && !s.reply) add(`sheet source ${s.id}: a source with no table needs a reply`);
    if (s.kind === 'csv' && s.table && !s.delimiter) add(`sheet source ${s.id}: a CSV needs its delimiter`);
  }
  for (const f of config?.findings ?? []) {
    if (!FIELDS[f.rows] || (f.columns && !FIELDS[f.columns]) || !VALUES[f.value]) add(`sheet finding ${f.id}: unknown field or value`);
  }
  for (const t of config?.tiles ?? []) if (!t.good && !t.reply) add(`sheet tile ${t.id}: needs a reply saying why not`);
  if (!config?.relationship?.from || !config.relationship.to) add('sheet: needs the relationship');
}

function ops(config: SheetConfig, _org: ResolvedOrg): Record<string, Set<string> | null> {
  const tables = new Set((config.sources ?? []).flatMap((s) => (s.table ? [s.table] : [])));
  return {
    import: new Set((config.sources ?? []).map((s) => s.id)),
    relate: tables,
    pivot: new Set(['pivot', ...(config.findings ?? []).map((f) => f.id)]),
    chart: new Set(['table', 'bar', 'line', 'pie']),
    publish: new Set(['dashboard']),
  };
}

export const sheetTool: ToolModule<SheetConfig> = {
  create: (config, parts) => new Sheet(config, parts),
  validate,
  ops,
};
