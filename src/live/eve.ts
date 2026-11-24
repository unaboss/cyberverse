// Live mode, draft: reads Suricata's eve.json (one JSON object per line) and
// turns it into the lab's own shapes, so a live round can show real sensor
// output in the same alert queue and office map as a simulated one.

import type { Severity } from '../world/types.ts';

export interface EveRecord {
  /** Milliseconds since the epoch. */
  at: number;
  type: 'alert' | 'flow' | 'http' | 'dns' | 'tls' | 'ssh' | 'fileinfo' | 'other';
  src?: string;
  dst?: string;
  srcPort?: number;
  dstPort?: number;
  proto?: string;
  alert?: { signature: string; signatureId: number; category: string; severity: Severity; action: string };
  http?: { hostname?: string; url?: string; method?: string; status?: number; userAgent?: string };
  bytes?: { toServer: number; toClient: number };
}

const KNOWN = new Set(['alert', 'flow', 'http', 'dns', 'tls', 'ssh', 'fileinfo']);

/** Suricata severity 1 is the most serious. */
export function eveSeverity(level: unknown, category = ''): Severity {
  if (level === 1) {
    return /exploit|trojan|executable code|administrator privilege/i.test(category) ? 'critical' : 'high';
  }
  if (level === 2) {
    return 'medium';
  }
  return 'low';
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Parse one eve.json line. Returns null for blank, broken or non-object lines. */
export function parseEveLine(line: string): EveRecord | null {
  const trimmed = line.trim();
  if (trimmed === '') {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const e = raw as Record<string, unknown>;
  const at = Date.parse(String(e.timestamp ?? '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  const eventType = String(e.event_type ?? 'other');
  const record: EveRecord = {
    at: Number.isNaN(at) ? 0 : at,
    type: (KNOWN.has(eventType) ? eventType : 'other') as EveRecord['type'],
  };
  const src = text(e.src_ip);
  const dst = text(e.dest_ip);
  const srcPort = num(e.src_port);
  const dstPort = num(e.dest_port);
  const proto = text(e.proto);
  if (src) record.src = src;
  if (dst) record.dst = dst;
  if (srcPort !== undefined) record.srcPort = srcPort;
  if (dstPort !== undefined) record.dstPort = dstPort;
  if (proto) record.proto = proto;

  const alert = e.alert as Record<string, unknown> | undefined;
  if (record.type === 'alert' && alert && typeof alert === 'object') {
    const category = text(alert.category) ?? 'Uncategorised';
    record.alert = {
      signature: text(alert.signature) ?? 'Unnamed signature',
      signatureId: num(alert.signature_id) ?? 0,
      category,
      severity: eveSeverity(alert.severity, category),
      action: text(alert.action) ?? 'allowed',
    };
  }
  const http = e.http as Record<string, unknown> | undefined;
  if (http && typeof http === 'object') {
    record.http = {};
    const hostname = text(http.hostname);
    const url = text(http.url);
    const method = text(http.http_method);
    const status = num(http.status);
    const userAgent = text(http.http_user_agent);
    if (hostname) record.http.hostname = hostname;
    if (url) record.http.url = url;
    if (method) record.http.method = method;
    if (status !== undefined) record.http.status = status;
    if (userAgent) record.http.userAgent = userAgent;
  }
  const flow = e.flow as Record<string, unknown> | undefined;
  if (flow && typeof flow === 'object') {
    record.bytes = { toServer: num(flow.bytes_toserver) ?? 0, toClient: num(flow.bytes_toclient) ?? 0 };
  }
  return record;
}

/** Parse a whole eve.json chunk. Broken lines are skipped and counted. */
export function parseEve(chunk: string): { records: EveRecord[]; skipped: number } {
  const records: EveRecord[] = [];
  let skipped = 0;
  for (const line of chunk.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const record = parseEveLine(line);
    if (record) {
      records.push(record);
    } else {
      skipped++;
    }
  }
  return { records, skipped };
}

/** One alert line for the SOC queue, in the same style as simulated alerts. */
export function eveAlertSummary(record: EveRecord, nameOf: (ip: string) => string = (ip) => ip): string | null {
  if (!record.alert) {
    return null;
  }
  const src = record.src ? nameOf(record.src) : 'an unknown source';
  const dst = record.dst ? nameOf(record.dst) : 'the network';
  const port = record.dstPort !== undefined ? `:${record.dstPort}` : '';
  return `${record.alert.signature}: ${src} -> ${dst}${port}`;
}
