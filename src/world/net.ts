// Small IPv4 helpers. The lab only uses IPv4 inside its own private range.

export function ipToInt(ip: string): number {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    throw new Error(`Not an IPv4 address: ${ip}`);
  }
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      throw new Error(`Not an IPv4 address: ${ip}`);
    }
    value = value * 256 + octet;
  }
  return value;
}

export function intToIp(value: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join('.');
}

export interface Cidr {
  base: number;
  size: number;
}

export function parseCidr(cidr: string): Cidr {
  const [ip, bitsText] = cidr.split('/');
  const bits = Number(bitsText);
  if (ip === undefined || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    throw new Error(`Not a CIDR range: ${cidr}`);
  }
  const size = 2 ** (32 - bits);
  const base = Math.floor(ipToInt(ip) / size) * size;
  return { base, size };
}

export function inCidr(ip: string, cidr: string): boolean {
  const range = parseCidr(cidr);
  const value = ipToInt(ip);
  return value >= range.base && value < range.base + range.size;
}

export function cidrInside(inner: string, outer: string): boolean {
  const a = parseCidr(inner);
  const b = parseCidr(outer);
  return a.base >= b.base && a.base + a.size <= b.base + b.size;
}

/** Every usable host address in a range (skips network and broadcast). */
export function hostsIn(cidr: string): string[] {
  const range = parseCidr(cidr);
  const out: string[] = [];
  for (let i = 1; i < range.size - 1; i++) {
    out.push(intToIp(range.base + i));
  }
  return out;
}
