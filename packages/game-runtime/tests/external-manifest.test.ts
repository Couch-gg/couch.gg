import { describe, it, expect } from 'vitest';
import {
  validateExternalManifestInput,
  RESERVED_GAME_IDS,
  type ExternalManifestInput
} from '../src/external-manifest.js';

// A known-good creator manifest. Individual tests clone and mutate one field so
// each rule is exercised in isolation.
function base(): ExternalManifestInput {
  return {
    id: 'tap-race',
    title: 'Tap Race',
    description: 'First to 30 taps wins. A tiny reflex race for 2-8 couch players.',
    minPlayers: 2,
    maxPlayers: 8,
    controllerLayout: {
      kind: 'generic-buttons',
      controls: [
        { control: 'tap', type: 'button', label: 'Tap!' },
        { control: 'charge', type: 'hold', label: 'Charge' },
        { control: 'power', type: 'slider', label: 'Power', min: 0, max: 100, step: 5 },
        { control: 'weapon', type: 'select', label: 'Weapon', options: ['Rock', 'Paper', 'Scissors'] }
      ]
    },
    aspectRatio: '16:9',
    estimatedDurationMinutes: 5,
    thumbnail: {
      kind: 'css',
      gradient: 'linear-gradient(160deg, #111 0%, #333 100%)',
      icon: 'Zap'
    },
    entryUrl: 'https://games.example.com/tap-race/',
    supportsRemote: true,
    sdkProtocol: 1,
    author: { name: 'A Creator', url: 'https://creator.example.com' }
  };
}

// Convenience: mutate a base clone via callback and validate.
function check(
  mutate: (m: Record<string, any>) => void,
  opts?: { allowHttpLocalhost?: boolean }
) {
  const m: Record<string, any> = base();
  mutate(m);
  return validateExternalManifestInput(m, opts);
}

describe('validateExternalManifestInput — accept path', () => {
  it('accepts a fully-valid manifest and returns a normalized value', () => {
    const res = validateExternalManifestInput(base());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.id).toBe('tap-race');
      expect(res.value.sdkProtocol).toBe(1);
      expect(res.value.controllerLayout.controls).toHaveLength(4);
    }
  });

  it('accepts a minimal manifest without optional fields', () => {
    const res = validateExternalManifestInput({
      id: 'mini',
      title: 'Mini',
      description: 'A minimal valid manifest.',
      minPlayers: 1,
      maxPlayers: 1,
      controllerLayout: {
        kind: 'generic-buttons',
        controls: [{ control: 'go', type: 'button', label: 'Go' }]
      },
      aspectRatio: '4:3',
      estimatedDurationMinutes: 1,
      thumbnail: { kind: 'css', gradient: 'g', icon: 'i' },
      entryUrl: 'https://x.example.com',
      sdkProtocol: 1
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.supportsRemote).toBeUndefined();
      expect(res.value.author).toBeUndefined();
    }
  });

  it('trims whitespace in normalized string fields', () => {
    const res = check((m) => {
      m.id = '  tap-race  ';
      m.title = '  Tap Race  ';
      m.description = '  Race the taps.  ';
      m.entryUrl = '  https://games.example.com/  ';
      m.author = { name: '  A Creator  ', url: '  https://creator.example.com  ' };
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.id).toBe('tap-race');
      expect(res.value.title).toBe('Tap Race');
      expect(res.value.description).toBe('Race the taps.');
      expect(res.value.entryUrl).toBe('https://games.example.com/');
      expect(res.value.author?.name).toBe('A Creator');
      expect(res.value.author?.url).toBe('https://creator.example.com');
    }
  });
});

describe('validateExternalManifestInput — top-level shape', () => {
  it('rejects non-object input', () => {
    for (const bad of [null, undefined, 42, 'x', []]) {
      const res = validateExternalManifestInput(bad as unknown);
      expect(res.ok).toBe(false);
    }
  });
});

describe('id rule', () => {
  it('rejects id shorter than 3 chars', () => {
    const res = check((m) => (m.id = 'ab'));
    expect(res.ok).toBe(false);
  });

  it('rejects id with uppercase / bad chars', () => {
    expect(check((m) => (m.id = 'Tap_Race')).ok).toBe(false);
    expect(check((m) => (m.id = 'tap race')).ok).toBe(false);
    expect(check((m) => (m.id = '-tap')).ok).toBe(false); // must start alnum
  });

  it('rejects id longer than 32 chars', () => {
    const res = check((m) => (m.id = 'a'.repeat(33)));
    expect(res.ok).toBe(false);
  });

  it('rejects every reserved id', () => {
    for (const reserved of RESERVED_GAME_IDS) {
      const res = check((m) => (m.id = reserved));
      expect(res.ok, `expected reserved id "${reserved}" to be rejected`).toBe(false);
    }
  });

  it('accepts a valid 32-char id', () => {
    const res = check((m) => (m.id = 'a' + 'b'.repeat(31)));
    expect(res.ok).toBe(true);
  });
});

describe('title & description rules', () => {
  it('rejects empty title', () => {
    expect(check((m) => (m.title = '   ')).ok).toBe(false);
  });
  it('rejects title over 40 chars', () => {
    expect(check((m) => (m.title = 'x'.repeat(41))).ok).toBe(false);
  });
  it('accepts title at exactly 40 chars', () => {
    expect(check((m) => (m.title = 'x'.repeat(40))).ok).toBe(true);
  });
  it('rejects empty description', () => {
    expect(check((m) => (m.description = '')).ok).toBe(false);
  });
  it('rejects description over 200 chars', () => {
    expect(check((m) => (m.description = 'x'.repeat(201))).ok).toBe(false);
  });
  it('accepts description at exactly 200 chars', () => {
    expect(check((m) => (m.description = 'x'.repeat(200))).ok).toBe(true);
  });
});

describe('player-count rules', () => {
  it('rejects minPlayers < 1', () => {
    expect(check((m) => (m.minPlayers = 0)).ok).toBe(false);
  });
  it('rejects maxPlayers > 8', () => {
    expect(check((m) => (m.maxPlayers = 9)).ok).toBe(false);
  });
  it('rejects min > max', () => {
    const res = check((m) => {
      m.minPlayers = 5;
      m.maxPlayers = 3;
    });
    expect(res.ok).toBe(false);
  });
  it('rejects non-integer players (no coercion of numeric strings)', () => {
    expect(check((m) => (m.minPlayers = '2')).ok).toBe(false);
    expect(check((m) => (m.maxPlayers = 4.5)).ok).toBe(false);
  });
  it('accepts min === max at the bounds', () => {
    const res = check((m) => {
      m.minPlayers = 8;
      m.maxPlayers = 8;
    });
    expect(res.ok).toBe(true);
  });
});

describe('controllerLayout rules', () => {
  it('rejects wrong kind', () => {
    expect(check((m) => (m.controllerLayout.kind = 'trebuchet-aim-fire')).ok).toBe(false);
  });

  it('rejects zero controls', () => {
    expect(check((m) => (m.controllerLayout.controls = [])).ok).toBe(false);
  });

  it('rejects more than 12 controls', () => {
    const res = check((m) => {
      m.controllerLayout.controls = Array.from({ length: 13 }, (_, i) => ({
        control: `c${i}`,
        type: 'button',
        label: 'B'
      }));
    });
    expect(res.ok).toBe(false);
  });

  it('accepts exactly 12 controls', () => {
    const res = check((m) => {
      m.controllerLayout.controls = Array.from({ length: 12 }, (_, i) => ({
        control: `c${i}`,
        type: 'button',
        label: 'B'
      }));
    });
    expect(res.ok).toBe(true);
  });

  it('rejects invalid control name', () => {
    expect(check((m) => (m.controllerLayout.controls[0].control = 'Bad Name')).ok).toBe(false);
    expect(check((m) => (m.controllerLayout.controls[0].control = 'a'.repeat(33))).ok).toBe(false);
  });

  it('rejects duplicate control names', () => {
    const res = check((m) => {
      m.controllerLayout.controls = [
        { control: 'tap', type: 'button', label: 'A' },
        { control: 'tap', type: 'button', label: 'B' }
      ];
    });
    expect(res.ok).toBe(false);
  });

  it('rejects invalid control type', () => {
    expect(check((m) => (m.controllerLayout.controls[0].type = 'joystick')).ok).toBe(false);
  });

  it('rejects empty and over-long labels', () => {
    expect(check((m) => (m.controllerLayout.controls[0].label = '')).ok).toBe(false);
    expect(check((m) => (m.controllerLayout.controls[0].label = 'x'.repeat(17))).ok).toBe(false);
  });

  it('accepts a 16-char label', () => {
    expect(check((m) => (m.controllerLayout.controls[0].label = 'x'.repeat(16))).ok).toBe(true);
  });
});

describe('slider control rules', () => {
  it('rejects slider missing numeric min/max', () => {
    const res = check((m) => {
      m.controllerLayout.controls = [{ control: 'p', type: 'slider', label: 'P' }];
    });
    expect(res.ok).toBe(false);
  });

  it('rejects slider with min >= max', () => {
    const res = check((m) => {
      m.controllerLayout.controls = [
        { control: 'p', type: 'slider', label: 'P', min: 10, max: 10 }
      ];
    });
    expect(res.ok).toBe(false);
  });

  it('rejects slider with non-positive step', () => {
    const res = check((m) => {
      m.controllerLayout.controls = [
        { control: 'p', type: 'slider', label: 'P', min: 0, max: 10, step: 0 }
      ];
    });
    expect(res.ok).toBe(false);
  });

  it('accepts a slider without a step (step optional)', () => {
    const res = check((m) => {
      m.controllerLayout.controls = [
        { control: 'p', type: 'slider', label: 'P', min: 0, max: 10 }
      ];
    });
    expect(res.ok).toBe(true);
  });
});

describe('select control rules', () => {
  it('rejects select with fewer than 2 options', () => {
    const res = check((m) => {
      m.controllerLayout.controls = [
        { control: 's', type: 'select', label: 'S', options: ['only'] }
      ];
    });
    expect(res.ok).toBe(false);
  });

  it('rejects select with more than 8 options', () => {
    const res = check((m) => {
      m.controllerLayout.controls = [
        {
          control: 's',
          type: 'select',
          label: 'S',
          options: ['1', '2', '3', '4', '5', '6', '7', '8', '9']
        }
      ];
    });
    expect(res.ok).toBe(false);
  });

  it('rejects select with a non-string or over-long option', () => {
    expect(
      check((m) => {
        m.controllerLayout.controls = [
          { control: 's', type: 'select', label: 'S', options: ['ok', 42] }
        ];
      }).ok
    ).toBe(false);
    expect(
      check((m) => {
        m.controllerLayout.controls = [
          { control: 's', type: 'select', label: 'S', options: ['ok', 'x'.repeat(17)] }
        ];
      }).ok
    ).toBe(false);
  });

  it('rejects select with a missing options array', () => {
    const res = check((m) => {
      m.controllerLayout.controls = [{ control: 's', type: 'select', label: 'S' }];
    });
    expect(res.ok).toBe(false);
  });

  it('accepts a valid 2-option select', () => {
    const res = check((m) => {
      m.controllerLayout.controls = [
        { control: 's', type: 'select', label: 'S', options: ['yes', 'no'] }
      ];
    });
    expect(res.ok).toBe(true);
  });
});

describe('aspectRatio & duration rules', () => {
  it('rejects invalid aspectRatio', () => {
    expect(check((m) => (m.aspectRatio = '21:9')).ok).toBe(false);
  });
  it('accepts 4:3', () => {
    expect(check((m) => (m.aspectRatio = '4:3')).ok).toBe(true);
  });
  it('rejects non-integer or out-of-range duration', () => {
    expect(check((m) => (m.estimatedDurationMinutes = 0)).ok).toBe(false);
    expect(check((m) => (m.estimatedDurationMinutes = 61)).ok).toBe(false);
    expect(check((m) => (m.estimatedDurationMinutes = 5.5)).ok).toBe(false);
  });
  it('accepts duration at bounds', () => {
    expect(check((m) => (m.estimatedDurationMinutes = 1)).ok).toBe(true);
    expect(check((m) => (m.estimatedDurationMinutes = 60)).ok).toBe(true);
  });
});

describe('thumbnail rules', () => {
  it('rejects wrong kind', () => {
    expect(check((m) => (m.thumbnail.kind = 'image')).ok).toBe(false);
  });
  it('rejects empty / over-long gradient', () => {
    expect(check((m) => (m.thumbnail.gradient = '')).ok).toBe(false);
    expect(check((m) => (m.thumbnail.gradient = 'x'.repeat(121))).ok).toBe(false);
  });
  it('rejects empty / over-long icon', () => {
    expect(check((m) => (m.thumbnail.icon = '')).ok).toBe(false);
    expect(check((m) => (m.thumbnail.icon = 'x'.repeat(41))).ok).toBe(false);
  });
});

describe('entryUrl rules', () => {
  it('rejects a non-URL string', () => {
    expect(check((m) => (m.entryUrl = 'not a url')).ok).toBe(false);
  });

  it('rejects http on a non-localhost host', () => {
    expect(check((m) => (m.entryUrl = 'http://games.example.com/')).ok).toBe(false);
  });

  it('rejects a URL over 512 chars', () => {
    const long = 'https://games.example.com/' + 'a'.repeat(520);
    expect(check((m) => (m.entryUrl = long)).ok).toBe(false);
  });

  it('rejects URLs with credentials', () => {
    expect(check((m) => (m.entryUrl = 'https://user:pass@games.example.com/')).ok).toBe(false);
  });

  it('rejects URLs with a hash fragment', () => {
    expect(check((m) => (m.entryUrl = 'https://games.example.com/#play')).ok).toBe(false);
  });

  it('rejects private / loopback IP literals', () => {
    for (const host of [
      'https://10.0.0.5/',
      'https://172.16.4.4/',
      'https://172.31.255.1/',
      'https://192.168.1.10/',
      'https://169.254.1.1/',
      'https://127.0.0.1/'
    ]) {
      expect(check((m) => (m.entryUrl = host)).ok, `expected ${host} rejected`).toBe(false);
    }
  });

  it('accepts a non-private IP literal over https', () => {
    expect(check((m) => (m.entryUrl = 'https://172.15.0.1/')).ok).toBe(true);
    expect(check((m) => (m.entryUrl = 'https://8.8.8.8/')).ok).toBe(true);
  });

  it('rejects http://localhost when the dev allowance is OFF', () => {
    expect(check((m) => (m.entryUrl = 'http://localhost:5173/')).ok).toBe(false);
  });

  it('accepts http://localhost when the dev allowance is ON', () => {
    const res = check(
      (m) => (m.entryUrl = 'http://localhost:5173/'),
      { allowHttpLocalhost: true }
    );
    expect(res.ok).toBe(true);
  });

  it('accepts http://127.0.0.1 when the dev allowance is ON', () => {
    const res = check(
      (m) => (m.entryUrl = 'http://127.0.0.1:8080/'),
      { allowHttpLocalhost: true }
    );
    expect(res.ok).toBe(true);
  });

  it('still rejects a private LAN IP even with the dev allowance ON', () => {
    const res = check(
      (m) => (m.entryUrl = 'http://192.168.1.50/'),
      { allowHttpLocalhost: true }
    );
    expect(res.ok).toBe(false);
  });

  it('rejects IPv6 literals (loopback and private ranges) without the dev allowance', () => {
    for (const host of ['https://[::1]/', 'https://[fd00::1]/', 'https://[fe80::1]/', 'https://[2606:4700::1]/']) {
      expect(check((m) => (m.entryUrl = host)).ok, `expected ${host} rejected`).toBe(false);
    }
  });

  it('accepts http://[::1] only via the dev allowance', () => {
    const res = check(
      (m) => (m.entryUrl = 'http://[::1]:5173/'),
      { allowHttpLocalhost: true }
    );
    expect(res.ok).toBe(true);
    expect(check((m) => (m.entryUrl = 'http://[fd00::1]/'), { allowHttpLocalhost: true }).ok).toBe(false);
  });
});

describe('sdkProtocol / supportsRemote / author rules', () => {
  it('rejects sdkProtocol other than 1', () => {
    expect(check((m) => (m.sdkProtocol = 2)).ok).toBe(false);
    expect(check((m) => (m.sdkProtocol = '1')).ok).toBe(false);
  });

  it('rejects non-boolean supportsRemote', () => {
    expect(check((m) => (m.supportsRemote = 'yes')).ok).toBe(false);
  });

  it('rejects author.name over 40 chars', () => {
    expect(check((m) => (m.author = { name: 'x'.repeat(41) })).ok).toBe(false);
  });

  it('rejects non-https author.url', () => {
    expect(check((m) => (m.author = { name: 'A', url: 'http://a.example.com' })).ok).toBe(false);
  });

  it('rejects author.url over 200 chars', () => {
    const url = 'https://a.example.com/' + 'a'.repeat(200);
    expect(check((m) => (m.author = { name: 'A', url })).ok).toBe(false);
  });

  it('accepts author with name only', () => {
    const res = check((m) => (m.author = { name: 'A Creator' }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.author?.url).toBeUndefined();
  });
});

describe('multi-error collection', () => {
  it('collects every error rather than stopping at the first', () => {
    const res = validateExternalManifestInput({
      id: 'BAD ID',
      title: '',
      description: '',
      minPlayers: 0,
      maxPlayers: 99,
      controllerLayout: { kind: 'nope', controls: [] },
      aspectRatio: 'weird',
      estimatedDurationMinutes: 999,
      thumbnail: { kind: 'image', gradient: '', icon: '' },
      entryUrl: 'http://user:pass@10.0.0.1/#x',
      sdkProtocol: 7
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      // Many independent failures should be reported together.
      expect(res.errors.length).toBeGreaterThanOrEqual(8);
    }
  });
});
