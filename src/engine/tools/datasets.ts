// The data behind the query consoles: logs and tables big enough that you
// need SQL to read them, made up row by row from a fixed seed, so every round
// (and every test) sees the same needle in the same haystack.
//
// Every address is in the lab's internet range and every email address is on
// a reserved .example domain: nothing here points at a real person or host.

import type { Cell, Row, Table } from './sql-engine.ts';

export interface Dataset {
  table: Table;
  /** Named answers the floor checks against, such as the accounts the bot got into. */
  sets: Record<string, string[]>;
}

/** A small seeded random generator (mulberry32): the same seed, the same rows. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function picker(rand: () => number) {
  const int = (min: number, max: number): number => min + Math.floor(rand() * (max - min + 1));
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
  const weighted = <T>(list: readonly (readonly [T, number])[]): T => {
    const total = list.reduce((s, [, w]) => s + w, 0);
    let r = rand() * total;
    for (const [v, w] of list) {
      r -= w;
      if (r < 0) return v;
    }
    return list[list.length - 1]![0];
  };
  return { int, pick, weighted };
}

const FIRST = [
  'thandi', 'sipho', 'lerato', 'thabo', 'naledi', 'bongani', 'zanele', 'kagiso', 'ayanda', 'mpho', 'nomsa', 'tumelo', 'lindiwe', 'themba', 'palesa', 'jabu',
  'refilwe', 'sibusiso', 'nandi', 'andile', 'busi', 'karabo', 'lwazi', 'precious', 'zodwa', 'tshepo', 'dineo', 'vusi', 'amahle', 'neo', 'pieter', 'anika',
  'johan', 'marike', 'riaan', 'megan', 'chantelle', 'kevin', 'shireen', 'yusuf', 'fatima', 'rajesh', 'priya', 'ashwin', 'nadia', 'faizel', 'liezl', 'gert',
  'sarah', 'david', 'michelle', 'jason', 'lauren', 'tamsin', 'brandon', 'kayla', 'ruan', 'elna', 'ismail', 'zaid', 'keegan', 'tasneem',
];
const LAST = [
  'nkosi', 'dlamini', 'ndlovu', 'khumalo', 'mokoena', 'mahlangu', 'zulu', 'mthembu', 'naidoo', 'pillay', 'botha', 'vanwyk', 'pretorius', 'smith', 'jacobs',
  'molefe', 'sithole', 'mabaso', 'shange', 'cassim', 'ebrahim', 'govender', 'moodley', 'mabuza', 'seabi', 'khoza', 'ndaba', 'mazibuko', 'radebe', 'nel',
  'venter', 'coetzee', 'adams', 'williams', 'petersen', 'hendricks', 'baloyi', 'maluleke', 'mathebula', 'tshabalala', 'gumede', 'cele', 'ngcobo', 'majola',
];
const DOMAINS = ['mail.example', 'post.example', 'inbox.example', 'webmail.example', 'telco.example'];

const BROWSERS = [
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1', 22],
  ['Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', 26],
  ['IkhayaApp/6.3 (Android 14)', 18],
  ['IkhayaApp/6.3 (iOS 18.1)', 12],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 12],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0', 5],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0', 3],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15', 2],
] as const;

/** The credential-stuffing bot's one, out-of-date browser string. */
export const STUFFING_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36';

// How busy the shop is, hour by hour, for honest customers.
const HOURLY = [1, 0.6, 0.4, 0.3, 0.4, 0.8, 1.6, 2.6, 3.2, 3.4, 3.6, 3.8, 4.2, 4, 3.6, 3.6, 3.8, 4.4, 5, 5.4, 5.2, 4.4, 3.2, 2];

const clock = (sec: number): string => {
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
};

export const SIGNINS = {
  honest: 52_000,
  customers: 38_000,
  bot: 70_000,
  botAddresses: 180,
  taken: 63,
  /** The attack ran from 02:10 to 05:05. */
  from: 2 * 3600 + 10 * 60,
  to: 5 * 3600 + 5 * 60,
};

/**
 * A day of sign-ins to the online shop, with a credential-stuffing run in
 * the small hours: 70 000 leaked email and password pairs from other sites'
 * breaches, each tried once, from 180 addresses, by one bot with one old
 * browser string. 63 of them worked.
 */
function signins(seed: number): Dataset {
  const rand = seeded(seed);
  const { int, pick, weighted } = picker(rand);
  const used = new Set<string>();
  const email = (style: number): string => {
    for (;;) {
      const f = pick(FIRST);
      const l = pick(LAST);
      const n = int(1, 999);
      const local = style === 0 ? `${f}.${l}${n}` : style === 1 ? `${f}${l}${n % 100}` : `${f[0]}${l}${n}`;
      const address = `${local}@${pick(DOMAINS)}`;
      if (!used.has(address)) {
        used.add(address);
        return address;
      }
    }
  };
  const customers = Array.from({ length: SIGNINS.customers }, () => email(0));
  // Mobile networks put thousands of customers behind one address (carrier NAT).
  const homeIps = Array.from({ length: 69 }, (_, i) => `10.88.0.${i + 2}`);
  const proxyCountries = [['ZA', 35], ['US', 15], ['BR', 10], ['VN', 8], ['IN', 8], ['NL', 6], ['DE', 6], ['ID', 6], ['RU', 6]] as const;
  const proxies = Array.from({ length: SIGNINS.botAddresses }, (_, i) => ({ ip: `10.88.0.${i + 71}`, country: weighted(proxyCountries) }));
  const homeProxies = proxies.filter((p) => p.country === 'ZA');
  const rows: (Row & { t: number })[] = [];
  const hourWeights = HOURLY.map((w, h) => [h, w] as const);
  for (let i = 0; i < SIGNINS.honest; i++) {
    const t = weighted(hourWeights) * 3600 + int(0, 3599);
    const roaming = rand() < 0.03;
    const viaHome = !roaming && rand() < 0.1;
    const fail = rand() < 0.04;
    rows.push({
      t,
      time: clock(t),
      hour: Math.floor(t / 3600),
      username: pick(customers),
      ip: viaHome && homeProxies.length > 0 ? pick(homeProxies).ip : pick(homeIps),
      country: roaming ? pick(['BW', 'NA', 'GB', 'US', 'AE', 'MZ']) : 'ZA',
      user_agent: weighted(BROWSERS),
      result: fail ? 'fail' : 'ok',
      reason: fail ? weighted([['wrong password', 9], ['locked', 1]] as const) : '',
    });
  }
  // The leaked list: a quarter of it are our customers, and 63 of those reused their password.
  const known = new Set<string>();
  while (known.size < SIGNINS.bot / 4) known.add(pick(customers));
  const knownList = [...known];
  const taken = new Set<string>();
  while (taken.size < SIGNINS.taken) taken.add(pick(knownList));
  const strangers = Array.from({ length: SIGNINS.bot - known.size }, () => email(int(1, 2)));
  const list = [...knownList, ...strangers];
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [list[i], list[j]] = [list[j]!, list[i]!];
  }
  const span = SIGNINS.to - SIGNINS.from;
  list.forEach((username, i) => {
    const t = SIGNINS.from + Math.floor((i / list.length) * span);
    const proxy = proxies[i % proxies.length]!;
    const ok = taken.has(username);
    rows.push({
      t,
      time: clock(t),
      hour: Math.floor(t / 3600),
      username,
      ip: proxy.ip,
      country: proxy.country,
      user_agent: STUFFING_AGENT,
      result: ok ? 'ok' : 'fail',
      reason: ok ? '' : known.has(username) ? 'wrong password' : 'no such account',
    });
  });
  rows.sort((a, b) => a.t - b.t);
  const columns = ['time', 'hour', 'username', 'ip', 'country', 'user_agent', 'result', 'reason'];
  return {
    table: { name: 'signins', columns, rows: rows.map(({ t: _t, ...row }) => row) },
    sets: { taken: [...taken].sort(), 'bot-ips': proxies.map((p) => p.ip) },
  };
}

export const API = {
  key: 'k_9d41e7',
  account: 'deals4u@post.example',
  ip: '10.88.0.201',
  first: 1_431_788,
  last: 1_480_000,
  /** The scraper ran from 00:12 to about 06:13. */
  from: 12 * 60,
  rate: 2.2,
};

/**
 * Today's requests to the app's API, midnight to 10:20, with a scraper in
 * them: one customer account, signed up the night before, that asked for
 * every order number from 1 431 788 to 1 480 000, one at a time. The API
 * checked it was signed in, never that the orders were its own.
 */
function api(seed: number): Dataset {
  const rand = seeded(seed);
  const { int, pick, weighted } = picker(rand);
  const hex = (): string => Array.from({ length: 6 }, () => '0123456789abcdef'[int(0, 15)]).join('');
  const used = new Set<string>([API.account]);
  const customers = Array.from({ length: 12_000 }, () => {
    let account = '';
    do account = `${pick(FIRST)}.${pick(LAST)}${int(1, 999)}@${pick(DOMAINS)}`;
    while (used.has(account));
    used.add(account);
    return { account, key: `k_${hex()}`, ip: `10.88.0.${int(2, 70)}`, orders: Array.from({ length: int(1, 3) }, () => int(1_000_000, API.last)) };
  });
  const rows: (Row & { t: number })[] = [];
  const now = 10 * 3600 + 20 * 60;
  const hours = HOURLY.slice(0, 11).map((w, h) => [h, w] as const);
  for (let i = 0; i < 60_000; i++) {
    const c = pick(customers);
    let t = weighted(hours) * 3600 + int(0, 3599);
    if (t >= now) t = int(0, now - 1);
    const kind = weighted([['me', 30], ['order', 15], ['product', 30], ['stores', 10], ['points', 15]] as const);
    const order = kind === 'order' ? pick(c.orders) : null;
    const path = { me: '/api/orders/me', order: `/api/orders/${order}`, product: `/api/products/${int(10_000, 99_999)}`, stores: '/api/stores/nearby', points: '/api/loyalty/balance' }[kind];
    const status = kind === 'product' && rand() < 0.04 ? 404 : rand() < 0.1 ? 304 : 200;
    rows.push({ t, time: clock(t), hour: Math.floor(t / 3600), api_key: c.key, account: c.account, ip: c.ip, method: 'GET', path, order_id: order, status, bytes: status === 200 ? int(400, 6000) : 0 });
  }
  for (let id = API.first; id <= API.last; id++) {
    const t = API.from + Math.floor((id - API.first) / API.rate);
    rows.push({ t, time: clock(t), hour: Math.floor(t / 3600), api_key: API.key, account: API.account, ip: API.ip, method: 'GET', path: `/api/orders/${id}`, order_id: id, status: 200, bytes: int(1500, 2200) });
  }
  rows.sort((a, b) => a.t - b.t);
  const columns = ['time', 'hour', 'api_key', 'account', 'ip', 'method', 'path', 'order_id', 'status', 'bytes'];
  return { table: { name: 'api_requests', columns, rows: rows.map(({ t: _t, ...row }) => row) }, sets: { 'scraper-key': [API.key] } };
}

export const ERP = {
  insider: 'yusuf.c',
  /** The account the insider's three changes pointed at. */
  mule: 'Ubuntu Mutual 6201 9344 71',
  frauds: [
    { supplier: 'Kgosi Cleaning Supplies', change: '2026-08-19 21:12', run: '2026-08-21', amount: 182_400, back: '2026-08-24 07:41' },
    { supplier: 'Lindani Signs', change: '2026-09-23 21:30', run: '2026-09-25', amount: 94_750, back: '2026-09-28 07:52' },
    { supplier: 'Mvelo Packaging', change: '2026-11-16 21:47', run: null, amount: 2_412_000, back: null },
  ],
  /** The VPN concentrator: a session from home shows up as this address. */
  vpn: '10.88.32.5',
};

const SUPPLIER_A = ['Mvelo', 'Kgosi', 'Lindani', 'Karoo', 'Bayside', 'Umoya', 'Sizwe', 'Highveld', 'Coastal', 'Thaba', 'Indlovu', 'Mopani', 'Protea', 'Amandla', 'Dube', 'Zenzele', 'Fynbos', 'Baobab', 'Molweni', 'Lowveld', 'Drakensberg', 'Ilanga'];
const SUPPLIER_B = ['Packaging', 'Cleaning Supplies', 'Signs', 'Fresh Produce', 'Bakeries', 'Logistics', 'Dairy', 'Printing', 'Security Services', 'Refrigeration', 'Plastics', 'Meat Wholesalers', 'Beverages', 'Electrical', 'Shopfitting', 'Uniforms'];
const BANKS = ['Sizwe Bank', 'Highveld Bank', 'Coastal Bank', 'Protea Bank', 'Ubuntu Mutual'];

interface ErpSupplier {
  name: string;
  /** Where its money went, from each date on ("YYYY-MM-DD HH:MM"). */
  accounts: { from: string; account: string }[];
}

interface ErpBooks {
  suppliers: ErpSupplier[];
  audit: (Row & { t: string })[];
  payments: (Row & { t: string })[];
}

const day = (d: Date): string => d.toISOString().slice(0, 10);
const at = (d: string, minutes: number): string => `${d} ${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

let books: ErpBooks | null = null;

/**
 * Sixteen weeks of Ikhaya's finance system, 3 August to Friday 20 November
 * 2026: purchase orders, invoices, supplier changes and the Friday payment
 * runs, made once from a fixed seed so the audit trail and the payments agree.
 * In them, the procurement manager changed three suppliers' bank details to
 * one account at night, approved each change himself, let a payment run pay
 * it, and changed two of them back on the Monday. The third is due today.
 */
function erpBooks(): ErpBooks {
  if (books) return books;
  const rand = seeded(5150);
  const { int, pick, weighted } = picker(rand);
  const acct = (): string => `${pick(BANKS.slice(0, 4))} ${int(1000, 9999)} ${int(1000, 9999)} ${int(10, 99)}`;
  const names = new Set<string>(ERP.frauds.map((f) => f.supplier));
  while (names.size < 90) names.add(`${pick(SUPPLIER_A)} ${pick(SUPPLIER_B)}`);
  const suppliers: ErpSupplier[] = [...names].map((name) => ({ name, accounts: [{ from: '2020-01-01 00:00', account: name === 'Mvelo Packaging' ? 'Sizwe Bank 4071 2283 91' : acct() }] }));
  const byName = new Map(suppliers.map((s) => [s.name, s]));
  const fraudNames = new Set(ERP.frauds.map((f) => f.supplier));
  const ordinary = suppliers.filter((s) => !fraudNames.has(s.name));
  const accountAt = (s: ErpSupplier, when: string): string => [...s.accounts].reverse().find((a) => a.from <= when)!.account;

  const ips: Record<string, string> = { 'yusuf.c': '10.88.31.50', 'precious.m': '10.88.31.51', 'thembi.n': '10.88.31.52', 'kevin.p': '10.88.31.53', 'lerato.k': '10.88.31.54', 'anton.p': '10.88.31.56' };
  const buyers = [['thembi.n', 4], ['kevin.p', 4], ['yusuf.c', 3]] as const;
  const clerks = [['precious.m', 5], ['lerato.k', 4]] as const;
  const audit: (Row & { t: string })[] = [];
  const row = (t: string, user: string, action: string, supplier: string, field = '', old_value = '', new_value = '', approved_by = '', ip = ips[user] ?? ''): void => {
    audit.push({ t, time: t, user, ip, action, supplier, field, old_value, new_value, approved_by });
  };

  const days: string[] = [];
  for (let d = new Date(Date.UTC(2026, 7, 3)); d <= new Date(Date.UTC(2026, 10, 20)); d = new Date(d.getTime() + 86_400_000)) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) days.push(day(d));
  }
  // Ordinary bank changes: a supplier's letter, captured by a buyer, approved by the CFO.
  const legit = new Map<string, number>();
  while (legit.size < 14) legit.set(pick(days.slice(0, -2)), 0);
  const payments: (Row & { t: string })[] = [];
  let invoice = 40_210;
  for (const d of days) {
    const friday = new Date(`${d}T00:00:00Z`).getUTCDay() === 5;
    for (let i = int(25, 40); i > 0; i--) {
      const s = pick(suppliers);
      row(at(d, int(7 * 60 + 30, 16 * 60 + 30)), weighted(buyers), 'po.create', s.name, 'po', '', `PO-${int(300_000, 399_999)}`);
    }
    for (let i = int(40, 60); i > 0; i--) {
      const s = pick(suppliers);
      row(at(d, int(7 * 60 + 30, 16 * 60 + 30)), weighted(clerks), 'invoice.capture', s.name, 'invoice', '', `INV-${invoice++}`);
    }
    if (rand() < 0.6) {
      const s = pick(suppliers);
      row(at(d, int(8 * 60, 16 * 60)), weighted(buyers), 'supplier.contact_change', s.name, pick(['phone', 'email', 'contact_person']), 'old', 'new');
    }
    if (rand() < 0.15) row(at(d, int(8 * 60, 16 * 60)), weighted(buyers), 'supplier.create', `${pick(SUPPLIER_A)} ${pick(SUPPLIER_B)} (Pty) Ltd`);
    if (legit.has(d)) {
      const s = pick(ordinary);
      const t = at(d, int(8 * 60, 15 * 60));
      const next = acct();
      row(t, weighted(buyers), 'supplier.bank_change', s.name, 'bank_account', accountAt(s, t), next, 'anton.p');
      s.accounts.push({ from: t, account: next });
    }
    for (const f of ERP.frauds) {
      if (f.change.startsWith(d)) {
        const s = byName.get(f.supplier)!;
        row(f.change, ERP.insider, 'supplier.bank_change', s.name, 'bank_account', accountAt(s, f.change), ERP.mule, ERP.insider, ERP.vpn);
        s.accounts.push({ from: f.change, account: ERP.mule });
      }
      if (f.back?.startsWith(d)) {
        const s = byName.get(f.supplier)!;
        const original = s.accounts[s.accounts.length - 2]!.account;
        row(f.back, ERP.insider, 'supplier.bank_change', s.name, 'bank_account', ERP.mule, original, ERP.insider);
        s.accounts.push({ from: f.back, account: original });
      }
    }
    if (friday && d !== '2026-11-20') {
      const paid = new Set<string>();
      for (const f of ERP.frauds) if (f.run === d) paid.add(f.supplier);
      while (paid.size < int(55, 65)) paid.add(pick(ordinary).name);
      let total = 0;
      for (const name of paid) {
        const fraud = ERP.frauds.find((f) => f.supplier === name && f.run === d);
        const amount = fraud ? fraud.amount : Math.round(weighted([[int(8, 60), 6], [int(60, 300), 3], [int(300, 900), 1]] as const) * 1000 + int(0, 99) * 10);
        const t = at(d, 15 * 60 + 30);
        payments.push({ t, run_date: d, supplier: name, invoice: `INV-${int(40_210, invoice)}`, amount, paid_to: accountAt(byName.get(name)!, t), released_by: 'anton.p' });
        total += amount;
      }
      row(at(d, 10 * 60 + int(0, 30)), 'precious.m', 'payment.prepare', '', 'run_total', '', String(total));
      row(at(d, 15 * 60 + 30), 'anton.p', 'payment.release', '', 'run_total', '', String(total));
    }
  }
  audit.sort((a, b) => a.t.localeCompare(b.t));
  payments.sort((a, b) => a.t.localeCompare(b.t) || String(a.supplier).localeCompare(String(b.supplier)));
  books = { suppliers, audit, payments };
  return books;
}

function erpAudit(_seed: number): Dataset {
  const { audit } = erpBooks();
  const columns = ['time', 'user', 'ip', 'action', 'supplier', 'field', 'old_value', 'new_value', 'approved_by'];
  return { table: { name: 'erp_audit', columns, rows: audit.map(({ t: _t, ...r }) => r) }, sets: { insider: [ERP.insider], 'self-suppliers': ERP.frauds.map((f) => f.supplier) } };
}

function erpPayments(_seed: number): Dataset {
  const { payments } = erpBooks();
  const columns = ['run_date', 'supplier', 'invoice', 'amount', 'paid_to', 'released_by'];
  return { table: { name: 'payments', columns, rows: payments.map(({ t: _t, ...r }) => r) }, sets: { mule: [ERP.mule] } };
}

/** Each data set, and the names of the answers it knows. */
export const DATASETS: Record<string, { make: (seed: number) => Dataset; sets: string[] }> = {
  signins: { make: signins, sets: ['taken', 'bot-ips'] },
  api: { make: api, sets: ['scraper-key'] },
  erp: { make: erpAudit, sets: ['insider', 'self-suppliers'] },
  payments: { make: erpPayments, sets: ['mule'] },
};

/** Values in a result column, as text, for comparing with a dataset's set. */
export function columnValues(columns: string[], rows: Cell[][], column: string): string[] | null {
  const index = columns.findIndex((c) => c.toLowerCase() === column.toLowerCase());
  if (index < 0) return null;
  return rows.map((r) => String(r[index]));
}
