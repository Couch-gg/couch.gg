// Dependency-free validator for creator-supplied external game manifests.
//
// This runs in two places with no shared runtime: the server (before publishing)
// and the browser submit page (live error feedback). It therefore uses NO node
// imports and only the global `URL` — nothing environment-specific. Style mirrors
// the hand-rolled sanitizers in ./index.ts: no zod, no schema library.
//
// It validates the CREATOR-supplied fields only. The server later composes the
// full ExternalGameManifest by stamping origin/status/publishedAt. Types must be
// correct up front — there is NO coercion (a numeric string is a type error, not
// a number). The returned value is normalized: strings are trimmed.

// Slugs a creator may not claim: the built-in games plus reserved route/API
// segments that would collide with platform paths.
export const RESERVED_GAME_IDS: readonly string[] = [
  'trebuchet',
  'tank-duel',
  'quiz-rush',
  'kart-chaos',
  'dev',
  'admin',
  'api',
  'games',
  'sdk',
  'couch',
  'screen',
  'lobby',
  's',
  'c',
  'l',
  'j',
  'new',
  'test'
];

// The creator-supplied shape. The server adds origin/status/publishedAt itself.
export interface ExternalManifestInput {
  id: string;
  title: string;
  description: string;
  minPlayers: number;
  maxPlayers: number;
  controllerLayout: {
    kind: 'generic-buttons';
    controls: Array<{
      control: string;
      type: 'button' | 'hold' | 'slider' | 'select';
      label: string;
      min?: number;
      max?: number;
      step?: number;
      options?: string[];
    }>;
  };
  aspectRatio: '16:9' | '4:3';
  estimatedDurationMinutes: number;
  thumbnail: {
    kind: 'css';
    gradient: string;
    icon: string;
    accent?: string;
  };
  entryUrl: string;
  supportsRemote?: boolean;
  sdkProtocol: 1;
  author?: { name: string; url?: string };
}

export type ValidateExternalManifestResult =
  | { ok: true; value: ExternalManifestInput }
  | { ok: false; errors: string[] };

const ID_RE = /^[a-z0-9][a-z0-9-]{2,31}$/;
const CONTROL_NAME_RE = /^[a-z0-9._-]{1,32}$/;
const CONTROL_TYPES = ['button', 'hold', 'slider', 'select'] as const;
const ASPECT_RATIOS = ['16:9', '4:3'] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

// A private / loopback / link-local IPv4 literal we must never let a creator
// point their entryUrl at (SSRF + local-network probing defense).
function isPrivateIpv4Literal(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    if (n > 255) return false;
    nums.push(n);
  }
  const [a, b] = nums;
  if (a === 10) return true;                       // 10.0.0.0/8
  if (a === 127) return true;                      // 127.0.0.0/8 loopback
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;         // 192.168.0.0/16
  if (a === 169 && b === 254) return true;         // 169.254.0.0/16 link-local
  return false;
}

function isLocalhostHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

// Any bracketed IPv6 literal. Only [::1] is ever acceptable, and only via the
// dev localhost allowance — public IPv6 games must use a hostname, which keeps
// the private-range check (fd00::/8, fe80::/10, ...) from needing an IPv6 parser.
function isIpv6Literal(hostname: string): boolean {
  return hostname.startsWith('[') && hostname.endsWith(']');
}

// Validate a full https URL used for the author link (no localhost allowance).
function validateAuthorUrl(raw: string, errors: string[]): void {
  if (raw.length > 200) {
    errors.push('author.url must be at most 200 characters');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    errors.push('author.url must be a valid URL');
    return;
  }
  if (parsed.protocol !== 'https:') {
    errors.push('author.url must use https');
  }
}

export function validateExternalManifestInput(
  input: unknown,
  opts?: { allowHttpLocalhost?: boolean }
): ValidateExternalManifestResult {
  const errors: string[] = [];
  const allowHttpLocalhost = opts?.allowHttpLocalhost === true;

  if (!isPlainObject(input)) {
    return { ok: false, errors: ['manifest must be an object'] };
  }

  // --- id ---
  let id = '';
  if (typeof input.id !== 'string') {
    errors.push('id must be a string');
  } else {
    id = input.id.trim();
    if (!ID_RE.test(id)) {
      errors.push('id must match /^[a-z0-9][a-z0-9-]{2,31}$/');
    } else if (RESERVED_GAME_IDS.includes(id)) {
      errors.push(`id "${id}" is reserved`);
    }
  }

  // --- title ---
  let title = '';
  if (typeof input.title !== 'string') {
    errors.push('title must be a string');
  } else {
    title = input.title.trim();
    if (title.length === 0) {
      errors.push('title must not be empty');
    } else if (title.length > 40) {
      errors.push('title must be at most 40 characters');
    }
  }

  // --- description ---
  let description = '';
  if (typeof input.description !== 'string') {
    errors.push('description must be a string');
  } else {
    description = input.description.trim();
    if (description.length === 0) {
      errors.push('description must not be empty');
    } else if (description.length > 200) {
      errors.push('description must be at most 200 characters');
    }
  }

  // --- minPlayers / maxPlayers ---
  const minPlayers = input.minPlayers;
  const maxPlayers = input.maxPlayers;
  let minOk = false;
  let maxOk = false;
  if (!isInteger(minPlayers)) {
    errors.push('minPlayers must be an integer');
  } else if (minPlayers < 1) {
    errors.push('minPlayers must be at least 1');
  } else {
    minOk = true;
  }
  if (!isInteger(maxPlayers)) {
    errors.push('maxPlayers must be an integer');
  } else if (maxPlayers > 8) {
    errors.push('maxPlayers must be at most 8');
  } else {
    maxOk = true;
  }
  if (minOk && maxOk && (minPlayers as number) > (maxPlayers as number)) {
    errors.push('minPlayers must be <= maxPlayers');
  }

  // --- controllerLayout ---
  const layout = input.controllerLayout;
  if (!isPlainObject(layout)) {
    errors.push('controllerLayout must be an object');
  } else {
    if (layout.kind !== 'generic-buttons') {
      errors.push("controllerLayout.kind must be 'generic-buttons'");
    }
    const controls = layout.controls;
    if (!Array.isArray(controls)) {
      errors.push('controllerLayout.controls must be an array');
    } else {
      if (controls.length < 1 || controls.length > 12) {
        errors.push('controllerLayout.controls must contain between 1 and 12 controls');
      }
      const seenNames = new Set<string>();
      controls.forEach((ctrl, i) => {
        if (!isPlainObject(ctrl)) {
          errors.push(`controllerLayout.controls[${i}] must be an object`);
          return;
        }
        // name
        if (typeof ctrl.control !== 'string') {
          errors.push(`controllerLayout.controls[${i}].control must be a string`);
        } else {
          const name = ctrl.control;
          if (!CONTROL_NAME_RE.test(name)) {
            errors.push(`controllerLayout.controls[${i}].control must match /^[a-z0-9._-]{1,32}$/`);
          } else if (seenNames.has(name)) {
            errors.push(`controllerLayout.controls[${i}].control "${name}" is duplicated`);
          } else {
            seenNames.add(name);
          }
        }
        // type
        const type = ctrl.type;
        const typeOk = typeof type === 'string' && (CONTROL_TYPES as readonly string[]).includes(type);
        if (!typeOk) {
          errors.push(`controllerLayout.controls[${i}].type must be one of button|hold|slider|select`);
        }
        // label
        if (typeof ctrl.label !== 'string') {
          errors.push(`controllerLayout.controls[${i}].label must be a string`);
        } else {
          const label = ctrl.label.trim();
          if (label.length === 0) {
            errors.push(`controllerLayout.controls[${i}].label must not be empty`);
          } else if (label.length > 16) {
            errors.push(`controllerLayout.controls[${i}].label must be at most 16 characters`);
          }
        }
        // slider constraints
        if (type === 'slider') {
          const min = ctrl.min;
          const max = ctrl.max;
          const step = ctrl.step;
          if (typeof min !== 'number' || Number.isNaN(min)) {
            errors.push(`controllerLayout.controls[${i}].min must be a number for a slider`);
          }
          if (typeof max !== 'number' || Number.isNaN(max)) {
            errors.push(`controllerLayout.controls[${i}].max must be a number for a slider`);
          }
          if (typeof min === 'number' && typeof max === 'number' && !(min < max)) {
            errors.push(`controllerLayout.controls[${i}].min must be less than max`);
          }
          if (step !== undefined) {
            if (typeof step !== 'number' || !(step > 0)) {
              errors.push(`controllerLayout.controls[${i}].step must be greater than 0 when present`);
            }
          }
        }
        // select constraints
        if (type === 'select') {
          const options = ctrl.options;
          if (!Array.isArray(options)) {
            errors.push(`controllerLayout.controls[${i}].options must be an array for a select`);
          } else {
            if (options.length < 2 || options.length > 8) {
              errors.push(`controllerLayout.controls[${i}].options must contain between 2 and 8 entries`);
            }
            options.forEach((opt, j) => {
              if (typeof opt !== 'string') {
                errors.push(`controllerLayout.controls[${i}].options[${j}] must be a string`);
              } else if (opt.length === 0 || opt.length > 16) {
                errors.push(`controllerLayout.controls[${i}].options[${j}] must be 1-16 characters`);
              }
            });
          }
        }
      });
    }
  }

  // --- aspectRatio ---
  if (typeof input.aspectRatio !== 'string' || !(ASPECT_RATIOS as readonly string[]).includes(input.aspectRatio)) {
    errors.push("aspectRatio must be '16:9' or '4:3'");
  }

  // --- estimatedDurationMinutes ---
  const duration = input.estimatedDurationMinutes;
  if (!isInteger(duration)) {
    errors.push('estimatedDurationMinutes must be an integer');
  } else if (duration < 1 || duration > 60) {
    errors.push('estimatedDurationMinutes must be between 1 and 60');
  }

  // --- thumbnail ---
  const thumbnail = input.thumbnail;
  if (!isPlainObject(thumbnail)) {
    errors.push('thumbnail must be an object');
  } else {
    if (thumbnail.kind !== 'css') {
      errors.push("thumbnail.kind must be 'css'");
    }
    if (typeof thumbnail.gradient !== 'string') {
      errors.push('thumbnail.gradient must be a string');
    } else if (thumbnail.gradient.length === 0 || thumbnail.gradient.length > 120) {
      errors.push('thumbnail.gradient must be 1-120 characters');
    }
    if (typeof thumbnail.icon !== 'string') {
      errors.push('thumbnail.icon must be a string');
    } else if (thumbnail.icon.length === 0 || thumbnail.icon.length > 40) {
      errors.push('thumbnail.icon must be 1-40 characters');
    }
  }

  // --- entryUrl ---
  let entryUrl = '';
  if (typeof input.entryUrl !== 'string') {
    errors.push('entryUrl must be a string');
  } else {
    entryUrl = input.entryUrl.trim();
    if (entryUrl.length === 0) {
      errors.push('entryUrl must not be empty');
    } else if (entryUrl.length > 512) {
      errors.push('entryUrl must be at most 512 characters');
    } else {
      let parsed: URL | null = null;
      try {
        parsed = new URL(entryUrl);
      } catch {
        errors.push('entryUrl must be a valid URL');
      }
      if (parsed) {
        const hostname = parsed.hostname;
        const isLocalhost = isLocalhostHostname(hostname);
        if (parsed.protocol === 'https:') {
          // fine
        } else if (parsed.protocol === 'http:' && allowHttpLocalhost && isLocalhost) {
          // allowed dev exception
        } else {
          errors.push('entryUrl must use https (http allowed only on localhost in dev)');
        }
        if (parsed.username !== '' || parsed.password !== '') {
          errors.push('entryUrl must not contain a username or password');
        }
        if (parsed.hash !== '') {
          errors.push('entryUrl must not contain a hash fragment');
        }
        // Block private/loopback/link-local IP literals. localhost is a name, not
        // an IP literal, and 127.0.0.1 is only tolerated via the dev exception.
        if (isPrivateIpv4Literal(hostname) && !(allowHttpLocalhost && isLocalhost)) {
          errors.push('entryUrl must not point at a private or loopback IP address');
        }
        // IPv6 literals: [::1] rides the dev exception; everything else is
        // rejected outright (public IPv6 must use a hostname).
        if (isIpv6Literal(hostname) && !(allowHttpLocalhost && isLocalhost)) {
          errors.push('entryUrl must not use an IPv6 address literal');
        }
      }
    }
  }

  // --- sdkProtocol ---
  if (input.sdkProtocol !== 1) {
    errors.push('sdkProtocol must be 1');
  }

  // --- supportsRemote (optional) ---
  let supportsRemote: boolean | undefined;
  if (input.supportsRemote !== undefined) {
    if (typeof input.supportsRemote !== 'boolean') {
      errors.push('supportsRemote must be a boolean when present');
    } else {
      supportsRemote = input.supportsRemote;
    }
  }

  // --- author (optional) ---
  let author: { name: string; url?: string } | undefined;
  if (input.author !== undefined) {
    if (!isPlainObject(input.author)) {
      errors.push('author must be an object when present');
    } else {
      const authorName = input.author.name;
      let authorNameOk = false;
      let normalizedName = '';
      if (typeof authorName !== 'string') {
        errors.push('author.name must be a string');
      } else {
        normalizedName = authorName.trim();
        if (normalizedName.length === 0) {
          errors.push('author.name must not be empty');
        } else if (normalizedName.length > 40) {
          errors.push('author.name must be at most 40 characters');
        } else {
          authorNameOk = true;
        }
      }
      let normalizedUrl: string | undefined;
      if (input.author.url !== undefined) {
        if (typeof input.author.url !== 'string') {
          errors.push('author.url must be a string when present');
        } else {
          normalizedUrl = input.author.url.trim();
          validateAuthorUrl(normalizedUrl, errors);
        }
      }
      if (authorNameOk) {
        author = normalizedUrl !== undefined
          ? { name: normalizedName, url: normalizedUrl }
          : { name: normalizedName };
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // All validated — build the normalized value. By this point every field above
  // passed its type check, so the assertions here are sound.
  const normalizedLayout = layout as ExternalManifestInput['controllerLayout'];
  const normalizedThumb = thumbnail as Record<string, unknown>;

  const value: ExternalManifestInput = {
    id,
    title,
    description,
    minPlayers: minPlayers as number,
    maxPlayers: maxPlayers as number,
    controllerLayout: {
      kind: 'generic-buttons',
      controls: normalizedLayout.controls.map((ctrl) => {
        const out: ExternalManifestInput['controllerLayout']['controls'][number] = {
          control: ctrl.control,
          type: ctrl.type,
          label: ctrl.label.trim()
        };
        if (ctrl.min !== undefined) out.min = ctrl.min;
        if (ctrl.max !== undefined) out.max = ctrl.max;
        if (ctrl.step !== undefined) out.step = ctrl.step;
        if (ctrl.options !== undefined) out.options = ctrl.options.slice();
        return out;
      })
    },
    aspectRatio: input.aspectRatio as '16:9' | '4:3',
    estimatedDurationMinutes: duration as number,
    thumbnail: {
      kind: 'css',
      gradient: (normalizedThumb.gradient as string).trim(),
      icon: (normalizedThumb.icon as string).trim(),
      ...(typeof normalizedThumb.accent === 'string' ? { accent: normalizedThumb.accent } : {})
    },
    entryUrl,
    sdkProtocol: 1
  };
  if (supportsRemote !== undefined) value.supportsRemote = supportsRemote;
  if (author !== undefined) value.author = author;

  return { ok: true, value };
}
