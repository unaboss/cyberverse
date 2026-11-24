// A small, read-only SQL engine for the lab's query consoles: enough of SELECT
// to find a needle in a hundred thousand log lines. It reads one table at a
// time and supports WHERE (=, <>, <, >, LIKE, IN, BETWEEN, IS NULL, AND, OR,
// NOT), GROUP BY with COUNT, COUNT(DISTINCT), SUM, AVG, MIN and MAX, HAVING,
// ORDER BY, LIMIT and OFFSET, DISTINCT, aliases, arithmetic and a few text
// functions. No joins and no writes: an analyst's console is read-only.
//
// Errors are written for a learner: they say what is wrong and how to fix it.

export type Cell = string | number | null;
export type Row = Record<string, Cell>;

export interface Table {
  name: string;
  columns: string[];
  rows: Row[];
}

export interface QueryResult {
  columns: string[];
  rows: Cell[][];
  /** Rows the query matched before LIMIT. */
  matched: number;
}

export class SqlError extends Error {}

// ------------------------------------------------------------------ tokens

type TokenKind = 'word' | 'num' | 'str' | 'quoted' | 'op' | 'end';

interface Token {
  kind: TokenKind;
  text: string;
  /** Upper-cased word, for keywords. */
  upper: string;
  value?: number | string;
  at: number;
  end: number;
}

const OPS = ['<>', '!=', '<=', '>=', '||', '=', '<', '>', '(', ')', ',', '*', '+', '-', '/', ';', '.', '%'];

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    const at = i;
    if (/[A-Za-z_]/.test(c)) {
      while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i]!)) i++;
      const text = sql.slice(at, i);
      tokens.push({ kind: 'word', text, upper: text.toUpperCase(), at, end: i });
      continue;
    }
    if (/[0-9]/.test(c)) {
      while (i < sql.length && /[0-9.]/.test(sql[i]!)) i++;
      const text = sql.slice(at, i);
      tokens.push({ kind: 'num', text, upper: text, value: Number(text), at, end: i });
      continue;
    }
    if (c === "'" || c === '"') {
      let value = '';
      i++;
      for (;;) {
        if (i >= sql.length) throw new SqlError(`A ${c === "'" ? 'text value' : 'quoted name'} starting with ${c} is never closed. Add the closing ${c}.`);
        if (sql[i] === c && sql[i + 1] === c) {
          value += c;
          i += 2;
          continue;
        }
        if (sql[i] === c) break;
        value += sql[i];
        i++;
      }
      i++;
      tokens.push({ kind: c === "'" ? 'str' : 'quoted', text: sql.slice(at, i), upper: value.toUpperCase(), value, at, end: i });
      continue;
    }
    const op = OPS.find((o) => sql.startsWith(o, i));
    if (!op) throw new SqlError(`The console doesn't understand "${c}" here.`);
    i += op.length;
    tokens.push({ kind: 'op', text: op, upper: op, at, end: i });
  }
  tokens.push({ kind: 'end', text: '', upper: '', at: sql.length, end: sql.length });
  return tokens;
}

// ------------------------------------------------------------------ syntax

export type Expr =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'null' }
  | { k: 'col'; name: string }
  | { k: 'star' }
  | { k: 'fn'; name: string; args: Expr[]; distinct: boolean }
  | { k: 'bin'; op: string; l: Expr; r: Expr }
  | { k: 'not'; e: Expr }
  | { k: 'neg'; e: Expr }
  | { k: 'like'; e: Expr; pattern: Expr; not: boolean }
  | { k: 'in'; e: Expr; list: Expr[]; not: boolean }
  | { k: 'between'; e: Expr; lo: Expr; hi: Expr; not: boolean }
  | { k: 'isnull'; e: Expr; not: boolean };

interface SelectItem {
  expr: Expr;
  name: string;
  /** Written as `AS name`. */
  alias: boolean;
}

export interface Query {
  distinct: boolean;
  star: boolean;
  items: SelectItem[];
  from: string;
  where?: Expr;
  groupBy: Expr[];
  having?: Expr;
  orderBy: { expr: Expr; desc: boolean }[];
  limit?: number;
  offset?: number;
}

const AGGREGATES = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);
const SCALARS = new Set(['LOWER', 'UPPER', 'LENGTH', 'SUBSTR', 'ROUND', 'ABS', 'COALESCE']);
const WRITES = new Set(['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'GRANT', 'REPLACE', 'MERGE']);
const RESERVED = new Set(['FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'BY', 'AND', 'OR', 'NOT', 'AS', 'ON', 'JOIN', 'UNION', 'ASC', 'DESC']);

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  private readonly sql: string;

  constructor(sql: string) {
    this.sql = sql;
    this.tokens = tokenize(sql);
  }

  private get t(): Token {
    return this.tokens[this.pos]!;
  }

  /** A method, not the getter, so the type checker doesn't carry an earlier check over. */
  private atEnd(): boolean {
    return this.tokens[this.pos]!.kind === 'end';
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private isWord(...words: string[]): boolean {
    return this.t.kind === 'word' && words.includes(this.t.upper);
  }

  private isOp(op: string): boolean {
    return this.t.kind === 'op' && this.t.text === op;
  }

  private eatWord(word: string): boolean {
    if (!this.isWord(word)) return false;
    this.pos++;
    return true;
  }

  private eatOp(op: string): boolean {
    if (!this.isOp(op)) return false;
    this.pos++;
    return true;
  }

  private near(): string {
    return this.t.kind === 'end' ? 'at the end' : `near "${this.t.text}"`;
  }

  private expectOp(op: string, why: string): void {
    if (!this.eatOp(op)) throw new SqlError(`Expected "${op}" ${this.near()}: ${why}`);
  }

  parse(): Query {
    if (this.t.kind === 'end') throw new SqlError('Type a query first, for example: SELECT * FROM signins LIMIT 10');
    if (this.isWord(...WRITES)) throw new SqlError(`${this.t.upper} changes data. This console is read-only: SELECT only. Evidence you can change isn't evidence.`);
    if (!this.eatWord('SELECT')) throw new SqlError(`A query starts with SELECT. Found "${this.t.text}".`);
    const distinct = this.eatWord('DISTINCT');
    const items: SelectItem[] = [];
    let star = false;
    if (this.eatOp('*')) {
      star = true;
    } else {
      do {
        items.push(this.item());
      } while (this.eatOp(','));
    }
    if (!this.eatWord('FROM')) {
      throw new SqlError(this.atEnd() ? 'Say which table to read: add FROM and the table name.' : `Expected FROM ${this.near()}. Check for a missing comma between columns.`);
    }
    const table = this.next();
    if (table.kind !== 'word' && table.kind !== 'quoted') throw new SqlError('Name the table after FROM.');
    const from = table.kind === 'quoted' ? String(table.value) : table.text;
    if (this.isOp(',') || this.isWord('JOIN')) throw new SqlError('This console reads one table at a time. No joins.');
    const query: Query = { distinct, star, items, from, groupBy: [], orderBy: [] };
    if (this.eatWord('WHERE')) query.where = this.expr();
    if (this.eatWord('GROUP')) {
      if (!this.eatWord('BY')) throw new SqlError('GROUP needs BY: GROUP BY column.');
      do {
        query.groupBy.push(this.expr());
      } while (this.eatOp(','));
    }
    if (this.eatWord('HAVING')) query.having = this.expr();
    if (this.eatWord('ORDER')) {
      if (!this.eatWord('BY')) throw new SqlError('ORDER needs BY: ORDER BY column.');
      do {
        const expr = this.expr();
        const desc = this.eatWord('DESC');
        if (!desc) this.eatWord('ASC');
        query.orderBy.push({ expr, desc });
      } while (this.eatOp(','));
    }
    if (this.eatWord('LIMIT')) query.limit = this.count('LIMIT');
    if (this.eatWord('OFFSET')) query.offset = this.count('OFFSET');
    this.eatOp(';');
    if (!this.atEnd()) {
      if (this.isWord('WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT')) throw new SqlError(`${this.t.upper} is in the wrong place. The order is SELECT, FROM, WHERE, GROUP BY, HAVING, ORDER BY, LIMIT.`);
      throw new SqlError(`Unexpected "${this.t.text}". Is a comma, AND or quote missing?`);
    }
    return query;
  }

  private count(word: string): number {
    const n = this.next();
    if (n.kind !== 'num' || !Number.isInteger(n.value) || (n.value as number) < 0) throw new SqlError(`${word} takes a whole number.`);
    return n.value as number;
  }

  private item(): SelectItem {
    const start = this.t.at;
    const expr = this.expr();
    const text = this.sql.slice(start, this.tokens[this.pos - 1]!.end).trim();
    if (this.eatWord('AS')) {
      const name = this.next();
      if (name.kind !== 'word' && name.kind !== 'quoted') throw new SqlError('Give a name after AS.');
      return { expr, name: name.kind === 'quoted' ? String(name.value) : name.text, alias: true };
    }
    if ((this.t.kind === 'word' && !RESERVED.has(this.t.upper)) || this.t.kind === 'quoted') {
      const name = this.next();
      return { expr, name: name.kind === 'quoted' ? String(name.value) : name.text, alias: true };
    }
    return { expr, name: expr.k === 'col' ? expr.name : text, alias: false };
  }

  expr(): Expr {
    let l = this.and();
    while (this.eatWord('OR')) l = { k: 'bin', op: 'OR', l, r: this.and() };
    return l;
  }

  private and(): Expr {
    let l = this.notExpr();
    while (this.eatWord('AND')) l = { k: 'bin', op: 'AND', l, r: this.notExpr() };
    return l;
  }

  private notExpr(): Expr {
    if (this.eatWord('NOT')) return { k: 'not', e: this.notExpr() };
    return this.compare();
  }

  private compare(): Expr {
    const e = this.add();
    if (this.t.kind === 'op' && ['=', '!=', '<>', '<', '>', '<=', '>='].includes(this.t.text)) {
      const op = this.next().text;
      return { k: 'bin', op: op === '!=' ? '<>' : op, l: e, r: this.add() };
    }
    const not = this.eatWord('NOT');
    if (this.eatWord('LIKE') || this.eatWord('ILIKE')) return { k: 'like', e, pattern: this.add(), not };
    if (this.eatWord('IN')) {
      this.expectOp('(', 'IN takes a list in brackets, like IN (\'ok\', \'fail\').');
      const list: Expr[] = [];
      do {
        list.push(this.add());
      } while (this.eatOp(','));
      this.expectOp(')', 'close the IN list with a bracket.');
      return { k: 'in', e, list, not };
    }
    if (this.eatWord('BETWEEN')) {
      const lo = this.add();
      if (!this.eatWord('AND')) throw new SqlError('BETWEEN needs AND: BETWEEN 2 AND 4.');
      return { k: 'between', e, lo, hi: this.add(), not };
    }
    if (not) throw new SqlError(`NOT here must come before LIKE, IN or BETWEEN ${this.near()}.`);
    if (this.eatWord('IS')) {
      const isNot = this.eatWord('NOT');
      if (!this.eatWord('NULL')) throw new SqlError('IS is followed by NULL or NOT NULL.');
      return { k: 'isnull', e, not: isNot };
    }
    return e;
  }

  private add(): Expr {
    let l = this.mul();
    while (this.isOp('+') || this.isOp('-') || this.isOp('||')) {
      const op = this.next().text;
      l = { k: 'bin', op, l, r: this.mul() };
    }
    return l;
  }

  private mul(): Expr {
    let l = this.unary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = this.next().text;
      l = { k: 'bin', op, l, r: this.unary() };
    }
    return l;
  }

  private unary(): Expr {
    if (this.eatOp('-')) return { k: 'neg', e: this.unary() };
    return this.primary();
  }

  private primary(): Expr {
    const t = this.next();
    if (t.kind === 'num') return { k: 'num', v: t.value as number };
    if (t.kind === 'str') return { k: 'str', v: String(t.value) };
    if (t.kind === 'quoted') {
      if (this.isOp('.')) throw new SqlError('Write column names on their own, without the table in front.');
      return { k: 'col', name: String(t.value) };
    }
    if (t.kind === 'op' && t.text === '(') {
      if (this.isWord('SELECT')) throw new SqlError('This console has no sub-queries. Run the inner query first, then use its answer.');
      const e = this.expr();
      this.expectOp(')', 'a bracket is never closed.');
      return e;
    }
    if (t.kind === 'op' && t.text === '*') throw new SqlError('* on its own means every column, and goes straight after SELECT. Inside COUNT, write COUNT(*).');
    if (t.kind === 'word') {
      if (t.upper === 'NULL') return { k: 'null' };
      if (t.upper === 'TRUE') return { k: 'num', v: 1 };
      if (t.upper === 'FALSE') return { k: 'num', v: 0 };
      if (this.eatOp('(')) {
        const name = t.upper;
        if (!AGGREGATES.has(name) && !SCALARS.has(name)) throw new SqlError(`There's no function called ${t.text} here. Try COUNT, SUM, AVG, MIN, MAX, LOWER, UPPER, LENGTH, SUBSTR or ROUND.`);
        const distinct = this.eatWord('DISTINCT');
        const args: Expr[] = [];
        if (this.eatOp('*')) {
          if (name !== 'COUNT') throw new SqlError(`Only COUNT takes *. ${name} needs a column.`);
          args.push({ k: 'star' });
        } else if (!this.isOp(')')) {
          do {
            args.push(this.expr());
          } while (this.eatOp(','));
        }
        this.expectOp(')', `close ${name}( with a bracket.`);
        if (AGGREGATES.has(name) && args.length !== 1) throw new SqlError(`${name} takes one column, like ${name}(${name === 'COUNT' ? '*' : 'bytes'}).`);
        return { k: 'fn', name, args, distinct };
      }
      if (this.isOp('.')) throw new SqlError('Write column names on their own, without the table in front.');
      if (RESERVED.has(t.upper) || t.upper === 'SELECT') throw new SqlError(`${t.upper} is in the wrong place. Is a column name or a value missing before it?`);
      return { k: 'col', name: t.text };
    }
    if (t.kind === 'end') throw new SqlError('The query stops too early. Is something missing at the end?');
    throw new SqlError(`Unexpected "${t.text}".`);
  }
}

export function parse(sql: string): Query {
  if (sql.length > 4000) throw new SqlError('That query is too long for this console.');
  return new Parser(sql).parse();
}

// --------------------------------------------------------------- running

interface Ctx {
  row: Row | undefined;
  group?: Row[];
}

function hasAggregate(e: Expr): boolean {
  switch (e.k) {
    case 'fn':
      return AGGREGATES.has(e.name) || e.args.some(hasAggregate);
    case 'bin':
      return hasAggregate(e.l) || hasAggregate(e.r);
    case 'not':
    case 'neg':
    case 'isnull':
      return hasAggregate(e.e);
    case 'like':
      return hasAggregate(e.e) || hasAggregate(e.pattern);
    case 'in':
      return hasAggregate(e.e) || e.list.some(hasAggregate);
    case 'between':
      return hasAggregate(e.e) || hasAggregate(e.lo) || hasAggregate(e.hi);
    default:
      return false;
  }
}

/** Columns used outside any aggregate. */
function bareColumns(e: Expr, out: string[] = []): string[] {
  switch (e.k) {
    case 'col':
      out.push(e.name.toLowerCase());
      break;
    case 'fn':
      if (!AGGREGATES.has(e.name)) e.args.forEach((a) => bareColumns(a, out));
      break;
    case 'bin':
      bareColumns(e.l, out);
      bareColumns(e.r, out);
      break;
    case 'not':
    case 'neg':
    case 'isnull':
      bareColumns(e.e, out);
      break;
    case 'like':
      bareColumns(e.e, out);
      bareColumns(e.pattern, out);
      break;
    case 'in':
      bareColumns(e.e, out);
      e.list.forEach((a) => bareColumns(a, out));
      break;
    case 'between':
      bareColumns(e.e, out);
      bareColumns(e.lo, out);
      bareColumns(e.hi, out);
      break;
  }
  return out;
}

/** How many letters to change to turn one name into the other (Levenshtein). */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row.push(Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)));
    prev = row;
  }
  return prev[b.length]!;
}

function likeRegex(pattern: string): RegExp {
  const body = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${body}$`, 'is');
}

const likeCache = new Map<string, RegExp>();

function truthy(v: Cell): boolean {
  return v !== null && v !== 0 && v !== '';
}

function compare(a: Cell, b: Cell): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function num(v: Cell, what: string): number | null {
  if (v === null) return null;
  if (typeof v === 'number') return v;
  const n = Number(v);
  if (v.trim() === '' || !Number.isFinite(n)) throw new SqlError(`${what} needs numbers, and "${v}" is text.`);
  return n;
}

class Runner {
  private readonly columns: Map<string, string>;
  private readonly table: Table;
  private readonly aliases: Map<string, Expr>;

  constructor(table: Table, aliases: Map<string, Expr>) {
    this.table = table;
    this.columns = new Map(table.columns.map((c) => [c.toLowerCase(), c]));
    this.aliases = aliases;
  }

  column(name: string): string {
    const found = this.columns.get(name.toLowerCase());
    if (found) return found;
    const close = this.table.columns.find((c) => distance(c.toLowerCase(), name.toLowerCase()) <= Math.max(1, Math.floor(name.length / 3)));
    throw new SqlError(`There's no column "${name}" in ${this.table.name}.${close ? ` Did you mean ${close}?` : ''} Its columns are ${this.table.columns.join(', ')}. Text values go in single quotes: 'like this'.`);
  }

  check(e: Expr): void {
    switch (e.k) {
      case 'col':
        if (!this.aliases.has(e.name.toLowerCase())) this.column(e.name);
        return;
      case 'fn':
        e.args.forEach((a) => this.check(a));
        return;
      case 'bin':
        this.check(e.l);
        this.check(e.r);
        return;
      case 'not':
      case 'neg':
      case 'isnull':
        this.check(e.e);
        return;
      case 'like':
        this.check(e.e);
        this.check(e.pattern);
        return;
      case 'in':
        this.check(e.e);
        e.list.forEach((a) => this.check(a));
        return;
      case 'between':
        this.check(e.e);
        this.check(e.lo);
        this.check(e.hi);
        return;
      default:
        return;
    }
  }

  eval(e: Expr, ctx: Ctx): Cell {
    switch (e.k) {
      case 'num':
        return e.v;
      case 'str':
        return e.v;
      case 'null':
        return null;
      case 'star':
        return 1;
      case 'col': {
        const alias = this.aliases.get(e.name.toLowerCase());
        if (alias && !this.columns.has(e.name.toLowerCase())) return this.eval(alias, ctx);
        return ctx.row?.[this.column(e.name)] ?? null;
      }
      case 'fn':
        return AGGREGATES.has(e.name) ? this.aggregate(e, ctx) : this.scalar(e, ctx);
      case 'not':
        return truthy(this.eval(e.e, ctx)) ? 0 : 1;
      case 'neg': {
        const v = num(this.eval(e.e, ctx), 'A minus sign');
        return v === null ? null : -v;
      }
      case 'isnull': {
        const isNull = this.eval(e.e, ctx) === null;
        return isNull !== e.not ? 1 : 0;
      }
      case 'like': {
        const v = this.eval(e.e, ctx);
        const p = this.eval(e.pattern, ctx);
        if (v === null || p === null) return 0;
        const key = String(p);
        let re = likeCache.get(key);
        if (!re) {
          re = likeRegex(key);
          if (likeCache.size > 200) likeCache.clear();
          likeCache.set(key, re);
        }
        return re.test(String(v)) !== e.not ? 1 : 0;
      }
      case 'in': {
        const v = this.eval(e.e, ctx);
        const found = e.list.some((x) => compare(v, this.eval(x, ctx)) === 0 && v !== null);
        return found !== e.not ? 1 : 0;
      }
      case 'between': {
        const v = this.eval(e.e, ctx);
        const inside = v !== null && compare(v, this.eval(e.lo, ctx)) >= 0 && compare(v, this.eval(e.hi, ctx)) <= 0;
        return inside !== e.not ? 1 : 0;
      }
      case 'bin':
        return this.binary(e.op, e.l, e.r, ctx);
    }
  }

  private binary(op: string, le: Expr, re: Expr, ctx: Ctx): Cell {
    if (op === 'AND') return truthy(this.eval(le, ctx)) && truthy(this.eval(re, ctx)) ? 1 : 0;
    if (op === 'OR') return truthy(this.eval(le, ctx)) || truthy(this.eval(re, ctx)) ? 1 : 0;
    const l = this.eval(le, ctx);
    const r = this.eval(re, ctx);
    if (op === '||') return l === null || r === null ? null : `${l}${r}`;
    if (['=', '<>', '<', '>', '<=', '>='].includes(op)) {
      if (l === null || r === null) return 0;
      // A number column compared with a number written as text, or the other way round.
      const numeric = (v: Cell): boolean => String(v).trim() !== '' && Number.isFinite(Number(v));
      const c = typeof l === typeof r ? compare(l, r) : numeric(l) && numeric(r) ? Number(l) - Number(r) : compare(String(l), String(r));
      return { '=': c === 0, '<>': c !== 0, '<': c < 0, '>': c > 0, '<=': c <= 0, '>=': c >= 0 }[op] ? 1 : 0;
    }
    const a = num(l, `"${op}"`);
    const b = num(r, `"${op}"`);
    if (a === null || b === null) return null;
    switch (op) {
      case '+':
        return a + b;
      case '-':
        return a - b;
      case '*':
        return a * b;
      case '/':
        return b === 0 ? null : a / b;
      case '%':
        return b === 0 ? null : a % b;
      default:
        throw new SqlError(`Unknown operator ${op}.`);
    }
  }

  private aggregate(e: Extract<Expr, { k: 'fn' }>, ctx: Ctx): Cell {
    const rows = ctx.group;
    if (!rows) throw new SqlError(`${e.name} adds up many rows, so it can't go in WHERE. Use HAVING after GROUP BY instead.`);
    const arg = e.args[0]!;
    if (e.name === 'COUNT' && arg.k === 'star') return rows.length;
    let values: Cell[] = rows.map((row) => this.eval(arg, { row })).filter((v) => v !== null);
    if (e.distinct) values = [...new Set(values)];
    switch (e.name) {
      case 'COUNT':
        return values.length;
      case 'SUM':
        return values.length === 0 ? null : values.reduce<number>((s, v) => s + (num(v, 'SUM') ?? 0), 0);
      case 'AVG':
        return values.length === 0 ? null : values.reduce<number>((s, v) => s + (num(v, 'AVG') ?? 0), 0) / values.length;
      case 'MIN':
        return values.length === 0 ? null : values.reduce((m, v) => (compare(v, m) < 0 ? v : m));
      case 'MAX':
        return values.length === 0 ? null : values.reduce((m, v) => (compare(v, m) > 0 ? v : m));
      default:
        return null;
    }
  }

  private scalar(e: Extract<Expr, { k: 'fn' }>, ctx: Ctx): Cell {
    const args = e.args.map((a) => this.eval(a, ctx));
    const [a, b, c] = args;
    switch (e.name) {
      case 'LOWER':
        return a === null || a === undefined ? null : String(a).toLowerCase();
      case 'UPPER':
        return a === null || a === undefined ? null : String(a).toUpperCase();
      case 'LENGTH':
        return a === null || a === undefined ? null : String(a).length;
      case 'SUBSTR': {
        if (a === null || a === undefined) return null;
        const start = Math.max(1, num(b ?? 1, 'SUBSTR') ?? 1);
        const len = c === undefined ? undefined : (num(c, 'SUBSTR') ?? 0);
        return String(a).substr(start - 1, len);
      }
      case 'ROUND': {
        const v = num(a ?? null, 'ROUND');
        if (v === null) return null;
        const places = num(b ?? 0, 'ROUND') ?? 0;
        return Math.round(v * 10 ** places) / 10 ** places;
      }
      case 'ABS': {
        const v = num(a ?? null, 'ABS');
        return v === null ? null : Math.abs(v);
      }
      case 'COALESCE':
        return args.find((v) => v !== null && v !== undefined) ?? null;
      default:
        return null;
    }
  }
}

const exprKey = (e: Expr): string => JSON.stringify(e, (k, v) => (k === 'name' && typeof v === 'string' ? v.toLowerCase() : v));

/** Run a parsed query against a table. */
export function run(query: Query, tables: Table[]): QueryResult {
  const table = tables.find((t) => t.name.toLowerCase() === query.from.toLowerCase());
  if (!table) throw new SqlError(`There's no table "${query.from}". The tables are ${tables.map((t) => t.name).join(', ')}.`);
  const items: SelectItem[] = query.star ? table.columns.map((c) => ({ expr: { k: 'col', name: c }, name: c, alias: false })) : query.items;
  const aliases = new Map<string, Expr>();
  for (const item of items) {
    if (item.alias && !table.columns.some((c) => c.toLowerCase() === item.name.toLowerCase())) aliases.set(item.name.toLowerCase(), item.expr);
  }
  const runner = new Runner(table, aliases);
  const columnsOnly = new Runner(table, new Map());
  for (const item of items) columnsOnly.check(item.expr);
  if (query.where) {
    columnsOnly.check(query.where);
    if (hasAggregate(query.where)) throw new SqlError('COUNT, SUM and the others add up many rows, so they can\'t go in WHERE. Use HAVING after GROUP BY instead.');
  }
  // GROUP BY 2 means the second column of the SELECT; GROUP BY name can mean an alias.
  const groupBy = query.groupBy.map((g) => {
    if (g.k === 'num') {
      const item = items[g.v - 1];
      if (!item) throw new SqlError(`GROUP BY ${g.v}: there are only ${items.length} columns in the SELECT.`);
      return item.expr;
    }
    if (g.k === 'col' && aliases.has(g.name.toLowerCase())) return aliases.get(g.name.toLowerCase())!;
    runner.check(g);
    return g;
  });
  for (const g of groupBy) {
    if (hasAggregate(g)) throw new SqlError('You can\'t GROUP BY a COUNT or SUM. Group by a column, and count in the SELECT.');
  }
  if (query.having) runner.check(query.having);
  for (const o of query.orderBy) if (o.expr.k !== 'num') runner.check(o.expr);

  const matched = query.where ? table.rows.filter((row) => truthy(runner.eval(query.where!, { row }))) : table.rows;
  const grouped = groupBy.length > 0 || items.some((i) => hasAggregate(i.expr)) || (query.having !== undefined);

  let contexts: Ctx[];
  if (grouped) {
    const keys = new Set(groupBy.map(exprKey));
    const groupCols = new Set(groupBy.filter((g) => g.k === 'col').map((g) => (g as { name: string }).name.toLowerCase()));
    for (const item of items) {
      if (keys.has(exprKey(item.expr))) continue;
      const bare = bareColumns(item.expr).filter((c) => !aliases.has(c) || table.columns.some((t) => t.toLowerCase() === c));
      const loose = bare.find((c) => !groupCols.has(c));
      if (loose) {
        throw new SqlError(
          groupBy.length === 0
            ? `"${loose}" is one value per row, but COUNT and the others add rows up. Add GROUP BY ${loose}, or take ${loose} out.`
            : `"${loose}" must be in the GROUP BY, or inside COUNT, SUM, MIN, MAX or AVG.`,
        );
      }
    }
    const groups = new Map<string, Row[]>();
    if (groupBy.length === 0) {
      groups.set('', matched);
    } else {
      for (const row of matched) {
        const key = JSON.stringify(groupBy.map((g) => runner.eval(g, { row })));
        const list = groups.get(key);
        if (list) list.push(row);
        else groups.set(key, [row]);
      }
    }
    contexts = [...groups.values()].map((group) => ({ row: group[0], group }));
    if (query.having) contexts = contexts.filter((ctx) => truthy(runner.eval(query.having!, ctx)));
  } else {
    if (query.having) throw new SqlError('HAVING filters groups. Use WHERE to filter rows.');
    contexts = matched.map((row) => ({ row }));
  }

  let out = contexts.map((ctx) => ({ ctx, cells: items.map((item) => runner.eval(item.expr, ctx)) }));
  if (query.distinct) {
    const seen = new Set<string>();
    out = out.filter((r) => {
      const key = JSON.stringify(r.cells);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  if (query.orderBy.length > 0) {
    const keyed = out.map((r) => ({
      r,
      keys: query.orderBy.map((o) => {
        if (o.expr.k === 'num') {
          const index = o.expr.v - 1;
          if (index < 0 || index >= items.length) throw new SqlError(`ORDER BY ${o.expr.v}: there are only ${items.length} columns in the SELECT.`);
          return r.cells[index]!;
        }
        if (o.expr.k === 'col') {
          const index = items.findIndex((i) => i.name.toLowerCase() === (o.expr as { name: string }).name.toLowerCase());
          if (index >= 0) return r.cells[index]!;
        }
        if (!grouped && hasAggregate(o.expr)) throw new SqlError('ORDER BY COUNT(*) needs a GROUP BY.');
        return runner.eval(o.expr, r.ctx);
      }),
    }));
    keyed.sort((a, b) => {
      for (let i = 0; i < query.orderBy.length; i++) {
        const c = compare(a.keys[i]!, b.keys[i]!);
        if (c !== 0) return query.orderBy[i]!.desc ? -c : c;
      }
      return 0;
    });
    out = keyed.map((k) => k.r);
  }
  const total = out.length;
  const start = query.offset ?? 0;
  const sliced = out.slice(start, query.limit === undefined ? undefined : start + query.limit);
  return {
    columns: items.map((i) => i.name),
    rows: sliced.map((r) => r.cells.map((c) => (typeof c === 'number' && !Number.isInteger(c) ? Math.round(c * 1000) / 1000 : c))),
    matched: total,
  };
}

export function query(sql: string, tables: Table[]): QueryResult {
  return run(parse(sql), tables);
}
