import { createHash, createHmac, randomBytes } from 'node:crypto';

// Who is calling, for counting reports / probe results once per client and for
// their rate limits. The id is an HMAC of the address under a server secret,
// so a stored id can't be turned back into an IP by hashing every candidate
// address (all of IPv4 takes minutes) without that secret. IPv6 counts per
// /64, the block one connection usually gets, so hopping addresses in it
// doesn't make a caller look like several.
export function clientId(ip: string, key: Buffer): string {
  return createHmac('sha256', key).update(ipBlock(ip)).digest('hex').slice(0, 32);
}

// The key for clientId. CLIENT_ID_SECRET when set. Else one derived from the
// secrets the deployment already has, so every instance of it gets the same
// key: REDIS_URL (it carries the store's password) and ADMIN_KEY. Ids are then
// as hard to reverse as those are to guess, and changing either one starts
// every client over (each may report once more). With neither there is no
// shared store and nothing outlives this process, so a random key does.
export function clientIdKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  if (env.CLIENT_ID_SECRET) return createHash('sha256').update(`couch-client-id:${env.CLIENT_ID_SECRET}`).digest();
  if (!env.REDIS_URL && !env.ADMIN_KEY) return randomBytes(32);
  return createHash('sha256')
    .update(`couch-client-id:${env.REDIS_URL ?? ''}\n${env.ADMIN_KEY ?? ''}`)
    .digest();
}

function ipBlock(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const groups = ip.includes('::')
    ? [...headParts, ...Array(Math.max(0, 8 - headParts.length - tailParts.length)).fill('0'), ...tailParts]
    : headParts;
  return `${groups
    .slice(0, 4)
    .map((group) => (Number.parseInt(group, 16) || 0).toString(16))
    .join(':')}::/64`;
}
