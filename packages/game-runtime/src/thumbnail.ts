// Thumbnail rules shared by the manifest validator (server + /dev page) and the
// catalog cards (apps/web). Every TV and phone in a lobby renders the catalog,
// so a thumbnail value must never be able to break a card or load anything:
//   - icons come from a fixed list. Lookup ignores case and hyphens, so 'Zap',
//     'zap', 'Gamepad2' and 'gamepad-2' all work. The catalog maps each name to
//     a lucide component (apps/web/src/components/catalogIcons.ts).
//   - a gradient is ONE linear-/radial-/conic-gradient(...) whose only inner
//     functions are colors: no url(), image-set(), var(), quotes or escapes.
//   - an accent is a hex color, a color name or an rgb()/hsl() color.
// Submit and update reject anything else (validateExternalManifestInput).
// Records stored before these rules are cleaned on read with sanitizeThumbnail,
// so an already-published game still shows up, with the fallback look.
//
// Dependency-free like ./external-manifest.ts: it runs in Node and the browser.

import type { GameThumbnail } from '@couch/types';

// Alphabetical; the guide (COUCH-GAME-GUIDE.md, section 7.5) lists the same names.
export const THUMBNAIL_ICONS = [
  'atom',
  'bike',
  'bird',
  'blocks',
  'bomb',
  'bot',
  'brain',
  'brush',
  'bug',
  'cake',
  'car',
  'castle',
  'cat',
  'coins',
  'compass',
  'crosshair',
  'crown',
  'dice5',
  'dices',
  'dog',
  'drum',
  'fish',
  'flag',
  'flame',
  'gamepad',
  'gamepad2',
  'gem',
  'ghost',
  'globe',
  'guitar',
  'heart',
  'joystick',
  'key',
  'laugh',
  'lightbulb',
  'magnet',
  'map',
  'medal',
  'mic',
  'moon',
  'mountain',
  'music',
  'orbit',
  'palette',
  'partypopper',
  'pencil',
  'pizza',
  'plane',
  'puzzle',
  'rabbit',
  'rocket',
  'shapes',
  'shield',
  'ship',
  'skull',
  'smile',
  'snowflake',
  'sparkles',
  'star',
  'sun',
  'sword',
  'swords',
  'target',
  'timer',
  'trophy',
  'turtle',
  'wandsparkles',
  'zap'
] as const;

export type ThumbnailIcon = (typeof THUMBNAIL_ICONS)[number];

// What a card shows for an icon or gradient that is not allowed.
export const FALLBACK_THUMBNAIL_ICON: ThumbnailIcon = 'gamepad2';
export const FALLBACK_THUMBNAIL_GRADIENT = 'linear-gradient(160deg, #1b2235 0%, #34405f 100%)';

const MAX_GRADIENT_CHARS = 120;
const MAX_ICON_CHARS = 40;
const MAX_ACCENT_CHARS = 40;

const ICON_SET: ReadonlySet<string> = new Set(THUMBNAIL_ICONS);
// The whole value is one gradient function...
const GRADIENT_START_RE = /^(?:repeating-)?(?:linear|radial|conic)-gradient\(/i;
// ...made of these characters only (no quotes, colons, semicolons, backslashes).
const GRADIENT_CHARS_RE = /^[a-z0-9#%.,()\s/+-]+$/i;
// Every name directly followed by '(' is a function call.
const FUNCTION_CALL_RE = /([a-z0-9-]+)\(/gi;
const COLOR_FUNCTIONS: ReadonlySet<string> = new Set([
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch'
]);
const ACCENT_RE = /^(?:#[0-9a-f]{3,8}|[a-z]{3,20}|(?:rgb|rgba|hsl|hsla)\([0-9a-z%.,\s/+-]{1,30}\))$/i;

// The allowed icon a creator-supplied name stands for, or null.
export function thumbnailIconName(raw: unknown): ThumbnailIcon | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ICON_CHARS) return null;
  const key = trimmed.toLowerCase().replace(/-/g, '');
  return ICON_SET.has(key) ? (key as ThumbnailIcon) : null;
}

// Whether a value is a single CSS gradient the catalog may put into
// style.background as is (see the rules at the top of this file).
export function isSafeThumbnailGradient(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_GRADIENT_CHARS) return false;
  if (!GRADIENT_START_RE.test(value) || !GRADIENT_CHARS_RE.test(value)) return false;
  const calls = [...value.matchAll(FUNCTION_CALL_RE)].map((match) => match[1].toLowerCase());
  if (calls.slice(1).some((name) => !COLOR_FUNCTIONS.has(name))) return false;
  // Balanced, and the gradient's own ')' is the last character: nothing (like
  // a second background layer) may follow it.
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '(') depth++;
    else if (value[i] === ')') {
      depth--;
      if (depth < 0) return false;
      if (depth === 0 && i !== value.length - 1) return false;
    }
  }
  return depth === 0;
}

// Whether a value is a plain color for the icon (thumbnail.accent).
export function isSafeThumbnailAccent(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const value = raw.trim();
  return value.length > 0 && value.length <= MAX_ACCENT_CHARS && ACCENT_RE.test(value);
}

// A thumbnail that is safe to render, whatever was stored: allowed values are
// kept (trimmed), anything else is replaced by the fallback (or, for the
// optional accent, dropped). Never throws.
export function sanitizeThumbnail(raw: unknown): GameThumbnail {
  const thumbnail = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const icon = thumbnailIconName(thumbnail.icon) ? (thumbnail.icon as string).trim() : FALLBACK_THUMBNAIL_ICON;
  const gradient = isSafeThumbnailGradient(thumbnail.gradient)
    ? (thumbnail.gradient as string).trim()
    : FALLBACK_THUMBNAIL_GRADIENT;
  const accent = isSafeThumbnailAccent(thumbnail.accent) ? (thumbnail.accent as string).trim() : undefined;
  return { kind: 'css', gradient, icon, ...(accent !== undefined ? { accent } : {}) };
}
