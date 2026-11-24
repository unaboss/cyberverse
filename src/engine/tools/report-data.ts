// The data behind the monthly security report: four months of the SOC's
// incidents (from the SIEM database), the store list (a spreadsheet file),
// the phishing simulation results (a CSV export, separated by semicolons),
// and the vulnerability scanner's report. Made once from a fixed seed, so
// every pivot gives the same numbers in every round and every test.
//
// In it: incidents fall from August to October, then jump in November when
// the Eastern Cape's camera recorders were taken over; the SOC's time to
// respond falls under its 60-minute target in October; incidents at head
// office have no store number.

import { seeded, picker } from './datasets.ts';

export type Cell = string | number;
export interface SheetTable {
  name: string;
  columns: string[];
  rows: Record<string, Cell>[];
}

export const MONTHS = ['2026-08', '2026-09', '2026-10', '2026-11'] as const;
export const MONTH_NAMES: Record<string, string> = { '2026-08': 'Aug 2026', '2026-09': 'Sep 2026', '2026-10': 'Oct 2026', '2026-11': 'Nov 2026' };

const REGIONS: [string, number, number, string[]][] = [
  ['Gauteng', 1, 35, ['Soweto', 'Tembisa', 'Midrand', 'Pretoria Central', 'Benoni', 'Krugersdorp', 'Vereeniging', 'Mamelodi', 'Randburg', 'Germiston', 'Alexandra', 'Springs']],
  ['Eastern Cape', 36, 50, ['Mthatha', 'Gqeberha', 'East London', 'Komani', 'Mdantsane', 'Butterworth', 'Makhanda', 'Uitenhage']],
  ['KwaZulu-Natal', 51, 72, ['Durban Central', 'Pietermaritzburg', 'Umlazi', 'Richards Bay', 'Newcastle', 'Pinetown', 'Ladysmith', 'Phoenix', 'Empangeni']],
  ['Western Cape', 73, 92, ['Khayelitsha', 'Bellville', 'Mitchells Plain', 'Paarl', 'George', 'Worcester', 'Cape Town CBD', 'Stellenbosch']],
  ['Limpopo and Mpumalanga', 93, 108, ['Polokwane', 'Mbombela', 'Thohoyandou', 'Witbank', 'Tzaneen', 'Secunda', 'Giyani']],
  ['Free State and North West', 109, 120, ['Bloemfontein', 'Mahikeng', 'Rustenburg', 'Welkom', 'Klerksdorp', 'Botshabelo']],
];

/** Incidents per month, before November's camera recorders, and the average minutes to respond. */
const PLAN: Record<string, { count: number; respond: number }> = {
  '2026-08': { count: 96, respond: 74 },
  '2026-09': { count: 88, respond: 66 },
  '2026-10': { count: 81, respond: 57 },
  '2026-11': { count: 79, respond: 42 },
};
/** November's extra incidents: taken-over camera recorders, all in the Eastern Cape. */
export const RECORDERS = 26;

let cache: Record<string, SheetTable> | null = null;

export function reportTables(): Record<string, SheetTable> {
  if (cache) return cache;
  const rand = seeded(6061);
  const { int, pick, weighted } = picker(rand);

  const stores: Record<string, Cell>[] = [];
  for (const [region, from, to, towns] of REGIONS) {
    for (let n = from; n <= to; n++) {
      const town = n === 47 ? 'Mthatha' : towns[(n - from) % towns.length]!;
      stores.push({ store: n, name: `Store ${n}, ${town}`, region });
    }
  }

  const incidents: Record<string, Cell>[] = [];
  let seq = 3100;
  const categories = [['phishing', 35], ['account', 20], ['malware', 12], ['network', 10], ['device', 8], ['physical', 8], ['fraud', 5]] as const;
  const severities = [['low', 40], ['medium', 38], ['high', 18], ['critical', 4]] as const;
  const add = (month: string, store: Cell, category: string, severity: string, minutes: number): void => {
    const dayOfMonth = int(1, month === '2026-11' ? 27 : 28);
    const opened = `${month}-${String(dayOfMonth).padStart(2, '0')} ${String(int(0, 23)).padStart(2, '0')}:${String(int(0, 59)).padStart(2, '0')}`;
    incidents.push({ id: `INC-${seq++}`, opened, store, category, severity, minutes_to_respond: Math.max(4, minutes), status: month === '2026-11' && rand() < 0.15 ? 'open' : 'closed' });
  };
  for (const month of MONTHS) {
    const { count, respond } = PLAN[month]!;
    // Spread the minutes around the month's average, then nudge the last one so the average is exact.
    const minutes = Array.from({ length: count }, () => respond + int(-25, 25));
    const drift = respond * count - minutes.reduce((a, b) => a + b, 0);
    minutes[minutes.length - 1]! += drift;
    for (let i = 0; i < count; i++) {
      const headOffice = rand() < 0.16;
      const store: Cell = headOffice ? '' : int(1, 120);
      add(month, store, weighted(categories), weighted(severities), minutes[i]!);
    }
    if (month === '2026-11') {
      const recorders: number[] = Array.from({ length: RECORDERS }, () => 0);
      for (let i = 0; i < RECORDERS; i++) recorders[i] = respond + int(-20, 20);
      const drift2 = respond * RECORDERS - recorders.reduce((a, b) => a + b, 0);
      recorders[RECORDERS - 1]! += drift2;
      for (let i = 0; i < RECORDERS; i++) add(month, i === 0 ? 47 : int(36, 50), 'device', i === 0 ? 'critical' : pick(['high', 'high', 'medium']), recorders[i]!);
    }
  }
  incidents.sort((a, b) => String(a.opened).localeCompare(String(b.opened)));

  const groups: [string, number, number[], number[]][] = [
    ['Stores', 1840, [47, 45, 46, 29], [2, 2, 2, 19]],
    ['Distribution centre', 310, [33, 30, 31, 27], [3, 4, 4, 9]],
    ['Customer care', 140, [26, 23, 24, 19], [5, 6, 6, 12]],
    ['Head office', 620, [21, 19, 18, 15], [18, 20, 21, 27]],
    ['Technology', 85, [6, 5, 5, 4], [58, 60, 61, 66]],
  ];
  const phishing: Record<string, Cell>[] = [];
  for (const [i, month] of MONTHS.entries()) {
    for (const [group, sent, clicked, reported] of groups) {
      phishing.push({ month, group, sent, clicked: Math.round((sent * clicked[i]!) / 100), reported: Math.round((sent * reported[i]!) / 100) });
    }
  }

  const hosts = ['erp', 'hr', 'bi', 'dc01', 'vpn', 'files', 'backup', 'jump', 'mail', 'shop', 'api', 'media', 'orders-db', 'pos', 'wms', 'crm', 'siem'];
  const vulns: Record<string, Cell>[] = [];
  for (let i = 0; i < 64; i++) {
    const severity = weighted([['low', 30], ['medium', 40], ['high', 22], ['critical', 8]] as const);
    const days = severity === 'critical' ? int(2, 20) : int(1, 120);
    vulns.push({ host: pick(hosts), finding: `${severity === 'critical' ? 'CVE-2026-' : 'CVE-2025-'}${int(1000, 49999)}`, severity, days_open: days });
  }
  // The three critical ones that have waited too long.
  vulns.push({ host: 'pos', finding: 'CVE-2026-31877', severity: 'critical', days_open: 41 });
  vulns.push({ host: 'vpn', finding: 'CVE-2026-20513', severity: 'critical', days_open: 38 });
  vulns.push({ host: 'wms', finding: 'CVE-2026-27740', severity: 'critical', days_open: 33 });

  cache = {
    incidents: { name: 'incidents', columns: ['id', 'opened', 'store', 'category', 'severity', 'minutes_to_respond', 'status'], rows: incidents },
    stores: { name: 'stores', columns: ['store', 'name', 'region'], rows: stores },
    phishing: { name: 'phishing', columns: ['month', 'group', 'sent', 'clicked', 'reported'], rows: phishing },
    vulns: { name: 'vulns', columns: ['host', 'finding', 'severity', 'days_open'], rows: vulns },
  };
  return cache;
}
