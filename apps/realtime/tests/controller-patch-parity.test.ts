import { describe, expect, it } from 'vitest';
import { sanitizeControllerPatch } from '../src/lobbies.js';
// The dev simulator and the /dev harness check couch.setController patches with
// the SDK's copy of these rules, so a creator sees a rejection before a live
// couch does. Both copies must accept and reject the same patches.
import { checkControllerPatch } from '../../../packages/game-sdk/src/protocol.js';

const CONTROLS = ['tap', 'charge'];

const PATCHES: Array<[string, unknown]> = [
  ['empty patch', {}],
  ['labels', { labels: { tap: ' SHIELD ', charge: 'BASH' } }],
  ['16-char label', { labels: { tap: 'A'.repeat(16) } }],
  ['17-char label', { labels: { tap: 'A'.repeat(17) } }],
  ['blank label', { labels: { tap: '   ' } }],
  ['label not a string', { labels: { tap: 5 } }],
  ['unknown label control', { labels: { nope: 'X' } }],
  ['inherited control name', { labels: { constructor: 'X' } }],
  ['labels as a list', { labels: ['tap'] }],
  ['disabled', { disabled: ['tap', 'tap'] }],
  ['re-enable all', { disabled: [] }],
  ['disabled unknown', { disabled: ['nope'] }],
  ['disabled not a list', { disabled: 'tap' }],
  ['disabled non-string', { disabled: [1] }],
  ['cooldown', { cooldowns: { tap: 2999.5 } }],
  ['cooldown at the cap', { cooldowns: { tap: 60_000 } }],
  ['cooldown over the cap', { cooldowns: { tap: 60_001 } }],
  ['negative cooldown', { cooldowns: { tap: -1 } }],
  ['cooldown as a string', { cooldowns: { tap: '100' } }],
  ['cooldown NaN', { cooldowns: { tap: Number.NaN } }],
  ['vibrate number', { vibrate: 80 }],
  ['vibrate pattern', { vibrate: [40, 20, 40] }],
  ['vibrate empty', { vibrate: [] }],
  ['vibrate 11 steps', { vibrate: new Array(11).fill(10) }],
  ['vibrate step over 1 s', { vibrate: [1001] }],
  ['vibrate as a string', { vibrate: '80' }],
  ['not an object', 'tap'],
  ['null', null],
  ['an array', []]
];

describe('SDK checkControllerPatch matches the server', () => {
  it.each(PATCHES)('%s', (_name, patch) => {
    let server: { ok: true; patch: unknown } | { ok: false };
    try {
      server = { ok: true, patch: sanitizeControllerPatch(patch, new Set(CONTROLS)) };
    } catch {
      server = { ok: false };
    }
    const sdk = checkControllerPatch(patch, CONTROLS);
    expect(sdk.ok).toBe(server.ok);
    if (sdk.ok && server.ok) expect(JSON.parse(JSON.stringify(sdk.patch))).toEqual(JSON.parse(JSON.stringify(server.patch)));
  });
});
