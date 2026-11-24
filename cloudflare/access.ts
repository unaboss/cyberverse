// Checks the Cloudflare Access login on every API call.
//
// Cloudflare Access sits in front of the lab's domain and asks each learner to
// sign in (an emailed one-time code, or the organisation's own login). It then
// adds a signed token to every request, in the Cf-Access-Jwt-Assertion header.
// The Worker checks that token itself as well, so the lab stays shut if Access
// is ever switched off or a request reaches the Worker some other way.

export interface AccessSettings {
  /** The Zero Trust team domain, like `yourteam.cloudflareaccess.com`. */
  ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's audience tag (AUD), from its settings page. */
  ACCESS_AUD?: string;
}

interface Jwk extends JsonWebKey {
  kid?: string;
}

interface Claims {
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iss?: string;
  email?: string;
}

const KEYS_TTL_MS = 60 * 60_000;
let cached: { team: string; at: number; keys: Map<string, CryptoKey> } | null = null;

function b64urlBytes(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let n = 0; n < raw.length; n++) out[n] = raw.charCodeAt(n);
  return out;
}

function b64urlJson<T>(text: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlBytes(text))) as T;
}

/** The team's signing keys, fetched once an hour. */
async function signingKeys(team: string, fetcher: typeof fetch, now: number): Promise<Map<string, CryptoKey>> {
  if (cached && cached.team === team && now - cached.at < KEYS_TTL_MS) {
    return cached.keys;
  }
  const res = await fetcher(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) {
    throw new Error(`Cloudflare Access keys could not be fetched (${res.status}).`);
  }
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (!jwk.kid || jwk.kty !== 'RSA') continue;
    keys.set(jwk.kid, await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
  }
  cached = { team, at: now, keys };
  return keys;
}

/**
 * Null when the request carries a valid Access login for this lab, otherwise
 * the reason it doesn't (for the log, not for the learner).
 */
export async function accessProblem(request: Request, settings: AccessSettings, fetcher: typeof fetch = fetch, now = Date.now()): Promise<string | null> {
  const team = settings.ACCESS_TEAM_DOMAIN?.trim();
  const aud = settings.ACCESS_AUD?.trim();
  if (!team || !aud) {
    return 'Cloudflare Access is not set up: ACCESS_TEAM_DOMAIN and ACCESS_AUD are empty.';
  }
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) {
    return 'No Cloudflare Access login on the request.';
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return 'The Access token is malformed.';
  }
  const [head, payload, signature] = parts as [string, string, string];
  let header: { alg?: string; kid?: string };
  let claims: Claims;
  try {
    header = b64urlJson(head);
    claims = b64urlJson(payload);
  } catch {
    return 'The Access token is malformed.';
  }
  if (header.alg !== 'RS256' || !header.kid) {
    return 'The Access token is not signed the way Access signs.';
  }
  const keys = await signingKeys(team, fetcher, now);
  const key = keys.get(header.kid);
  if (!key) {
    return 'The Access token was signed by a key this team does not have.';
  }
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(signature), new TextEncoder().encode(`${head}.${payload}`));
  if (!valid) {
    return 'The Access token signature is wrong.';
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(aud)) {
    return 'The Access token is for another application.';
  }
  if (claims.iss !== `https://${team}`) {
    return 'The Access token comes from another team.';
  }
  const seconds = now / 1000;
  if (typeof claims.exp !== 'number' || claims.exp < seconds) {
    return 'The Access login has expired.';
  }
  if (typeof claims.nbf === 'number' && claims.nbf > seconds + 60) {
    return 'The Access login is not valid yet.';
  }
  return null;
}

/** Forget the cached keys (tests). */
export function forgetAccessKeys(): void {
  cached = null;
}
