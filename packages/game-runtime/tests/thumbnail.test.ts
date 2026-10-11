import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FALLBACK_THUMBNAIL_GRADIENT,
  FALLBACK_THUMBNAIL_ICON,
  THUMBNAIL_ICONS,
  isSafeThumbnailGradient,
  sanitizeThumbnail,
  thumbnailIconName
} from '../src/thumbnail.js';
import { GAME_MANIFESTS } from '../src/index.js';

describe('thumbnailIconName', () => {
  it('maps any case and hyphenation to the catalog name', () => {
    expect(thumbnailIconName('Zap')).toBe('zap');
    expect(thumbnailIconName('gamepad-2')).toBe('gamepad2');
    expect(thumbnailIconName('  PartyPopper ')).toBe('partypopper');
  });

  it('returns null for anything outside the list', () => {
    for (const raw of ['Icon', 'icons', 'createLucideIcon', 'constructor', '', 42, null, undefined]) {
      expect(thumbnailIconName(raw)).toBeNull();
    }
  });

  it('knows every icon the built-in games use', () => {
    for (const game of GAME_MANIFESTS) expect(thumbnailIconName(game.thumbnail.icon), game.id).not.toBeNull();
  });
});

describe('isSafeThumbnailGradient', () => {
  it('accepts every built-in gradient and the fallback', () => {
    for (const game of GAME_MANIFESTS) expect(isSafeThumbnailGradient(game.thumbnail.gradient), game.id).toBe(true);
    expect(isSafeThumbnailGradient(FALLBACK_THUMBNAIL_GRADIENT)).toBe(true);
  });

  it('rejects unbalanced parentheses', () => {
    expect(isSafeThumbnailGradient('linear-gradient(red, blue')).toBe(false);
    expect(isSafeThumbnailGradient('linear-gradient(red, blue))')).toBe(false);
  });
});

describe('sanitizeThumbnail', () => {
  it('keeps allowed values as they are', () => {
    const thumbnail = { kind: 'css', gradient: 'linear-gradient(#000,#111)', icon: 'Zap', accent: '#fff' };
    expect(sanitizeThumbnail(thumbnail)).toEqual(thumbnail);
  });

  it('replaces values a stored record may still carry with the fallback look', () => {
    expect(
      sanitizeThumbnail({
        kind: 'css',
        gradient: 'url(https://tracker.example/p.gif?x=1) center/cover',
        icon: 'createLucideIcon',
        accent: 'url(#x)'
      })
    ).toEqual({ kind: 'css', gradient: FALLBACK_THUMBNAIL_GRADIENT, icon: FALLBACK_THUMBNAIL_ICON });
  });

  it('never throws on a missing or malformed thumbnail', () => {
    for (const raw of [undefined, null, 'zap', 7, { icon: 3, gradient: {} }]) {
      expect(sanitizeThumbnail(raw)).toEqual({
        kind: 'css',
        gradient: FALLBACK_THUMBNAIL_GRADIENT,
        icon: FALLBACK_THUMBNAIL_ICON
      });
    }
  });
});

describe('creator guide', () => {
  it('lists exactly the allowed icon names', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const guide = readFileSync(resolve(here, '../../game-sdk/COUCH-GAME-GUIDE.md'), 'utf-8');
    const section = guide.slice(guide.indexOf('### 7.5'));
    const block = section.slice(section.indexOf('```') + 3, section.indexOf('```', section.indexOf('```') + 3));
    const listed = block
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    expect(listed).toEqual([...THUMBNAIL_ICONS]);
  });
});
