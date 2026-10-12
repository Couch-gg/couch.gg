import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { clientId, clientIdKey } from '../src/client-id.js';

// The ids reports and probe results are counted by are stored on game records,
// so they must not give the IP back: an HMAC under a server secret that every
// instance of a deployment shares.

const key = clientIdKey({ CLIENT_ID_SECRET: 'test-secret' });

describe('clientId', () => {
  it('is one id per IPv4 address and per IPv6 /64', () => {
    expect(clientId('192.0.2.1', key)).toBe(clientId('192.0.2.1', key));
    expect(clientId('::ffff:192.0.2.1', key)).toBe(clientId('192.0.2.1', key));
    expect(clientId('192.0.2.2', key)).not.toBe(clientId('192.0.2.1', key));
    expect(clientId('2001:db8:1:2::10', key)).toBe(clientId('2001:db8:1:2:aaaa::20', key));
    expect(clientId('2001:db8:1:3::10', key)).not.toBe(clientId('2001:db8:1:2::10', key));
  });

  it('cannot be recomputed from the IP without the key', () => {
    const ip = '203.0.113.5';
    const unsalted = createHash('sha256').update(`couch-client:${ip}`).digest('hex').slice(0, 32);
    const plain = createHash('sha256').update(ip).digest('hex').slice(0, 32);
    expect([unsalted, plain]).not.toContain(clientId(ip, key));
    expect(clientId(ip, clientIdKey({ CLIENT_ID_SECRET: 'another-secret' }))).not.toBe(clientId(ip, key));
  });
});

describe('clientIdKey', () => {
  it('uses CLIENT_ID_SECRET when set, whatever else the deployment has', () => {
    expect(clientIdKey({ CLIENT_ID_SECRET: 'test-secret', REDIS_URL: 'redis://a', ADMIN_KEY: 'x' })).toEqual(key);
  });

  it('else derives the same key on every instance from REDIS_URL and ADMIN_KEY', () => {
    const env = { REDIS_URL: 'redis://default:pw@store.example:6379', ADMIN_KEY: 'admin' };
    expect(clientIdKey(env)).toEqual(clientIdKey({ ...env }));
    expect(clientIdKey(env)).not.toEqual(clientIdKey({ ...env, REDIS_URL: 'redis://default:other@store.example:6379' }));
    expect(clientIdKey(env)).not.toEqual(clientIdKey({ ...env, ADMIN_KEY: 'other' }));
    expect(clientIdKey({ REDIS_URL: env.REDIS_URL })).toEqual(clientIdKey({ REDIS_URL: env.REDIS_URL }));
  });

  it('is random per process without any secret to derive it from', () => {
    expect(clientIdKey({})).not.toEqual(clientIdKey({}));
    expect(clientIdKey({})).toHaveLength(32);
  });
});
