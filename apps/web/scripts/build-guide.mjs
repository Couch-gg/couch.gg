// Renders the canonical creator guide (packages/game-sdk/COUCH-GAME-GUIDE.md)
// to a standalone, styled HTML page at apps/web/public/guide.html so humans get
// a readable in-app guide (the raw .md stays for coding agents at
// /COUCH-GAME-GUIDE.md). The .md is the single source of truth — this file is a
// build artifact (gitignored), regenerated on every dev/build next to copy-sdk.
//
// `marked` is a ROOT devDependency, imported ONLY from this build script — it is
// never bundled into the apps/web/src runtime. GFM is enabled because the guide
// uses tables. The guide is FIRST-PARTY TRUSTED CONTENT authored in-repo, so we
// intentionally do NOT run an HTML sanitizer over the rendered output.
//
// Paths are resolved relative to THIS script's location, not the cwd, so it works
// regardless of where pnpm invokes it from (mirrors copy-sdk.mjs).

import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const scriptDir = dirname(fileURLToPath(import.meta.url));
// scripts/ -> apps/web -> apps -> <repo root>
const repoRoot = resolve(scriptDir, '..', '..', '..');

const guideSource = resolve(repoRoot, 'packages', 'game-sdk', 'COUCH-GAME-GUIDE.md');
const publicDir = resolve(scriptDir, '..', 'public');
const guideDest = resolve(publicDir, 'guide.html');

// Retro palette hard-coded to match apps/web/src/styles.css :root (that file is
// owned by another builder; these hexes mirror its vars so the guide feels
// native without importing the app CSS).
const PALETTE = {
  bg: '#101211',
  bg2: '#151918',
  surface: '#1b211f',
  surface2: '#24251e',
  line: 'rgba(248, 237, 207, 0.14)',
  text: '#f8edcf',
  muted: '#aeb9a3',
  accent: '#f1cf6a',
  red: '#e8554d',
  green: '#5dc961',
  cyan: '#62d5d5'
};

function pageTemplate(bodyHtml) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="${PALETTE.bg}" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap" rel="stylesheet" />
    <title>couch.gg — Creator Guide</title>
    <style>
      :root {
        --bg: ${PALETTE.bg};
        --bg-2: ${PALETTE.bg2};
        --surface: ${PALETTE.surface};
        --surface-2: ${PALETTE.surface2};
        --line: ${PALETTE.line};
        --text: ${PALETTE.text};
        --muted: ${PALETTE.muted};
        --accent: ${PALETTE.accent};
        --red: ${PALETTE.red};
        --green: ${PALETTE.green};
        --cyan: ${PALETTE.cyan};
      }
      * { box-sizing: border-box; }
      html { scroll-behavior: smooth; }
      body {
        margin: 0;
        color: var(--text);
        background:
          radial-gradient(circle at 18% 12%, rgba(232, 85, 77, 0.14), transparent 30%),
          radial-gradient(circle at 82% 4%, rgba(98, 213, 213, 0.08), transparent 26%),
          linear-gradient(145deg, #101211 0%, #171b18 48%, #111614 100%);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 16px;
        line-height: 1.7;
        -webkit-font-smoothing: antialiased;
      }
      /* Fixed top bar */
      .guide-bar {
        position: sticky;
        top: 0;
        z-index: 10;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px 18px;
        padding: 12px clamp(16px, 4vw, 40px);
        background: rgba(16, 18, 17, 0.9);
        backdrop-filter: blur(8px);
        border-bottom: 1px solid var(--line);
      }
      .guide-bar .brand {
        font-family: "Press Start 2P", monospace;
        font-size: 13px;
        color: var(--accent);
        text-decoration: none;
        letter-spacing: 0.02em;
        text-shadow: 0 0 14px rgba(241, 207, 106, 0.4);
      }
      .guide-bar .spacer { flex: 1 1 auto; }
      .guide-bar a.bar-link {
        color: var(--muted);
        text-decoration: none;
        font-size: 14px;
        padding: 6px 12px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: rgba(248, 237, 207, 0.05);
        transition: color 160ms ease, border-color 160ms ease;
      }
      .guide-bar a.bar-link:hover {
        color: var(--text);
        border-color: rgba(241, 207, 106, 0.5);
      }
      .guide-main {
        max-width: 860px;
        margin: 0 auto;
        padding: clamp(28px, 5vw, 56px) clamp(18px, 4vw, 40px) 120px;
      }
      h1, h2 {
        font-family: "Press Start 2P", monospace;
        line-height: 1.4;
        color: var(--text);
        text-shadow: 0 0 16px rgba(241, 207, 106, 0.28);
      }
      h1 {
        font-size: clamp(20px, 4vw, 30px);
        margin: 0 0 28px;
        letter-spacing: 0.01em;
      }
      h2 {
        font-size: clamp(15px, 2.4vw, 20px);
        margin: 52px 0 18px;
        padding-top: 18px;
        border-top: 1px solid var(--line);
        color: var(--accent);
      }
      h3, h4 {
        font-weight: 800;
        color: var(--text);
        margin: 30px 0 12px;
        line-height: 1.3;
      }
      h3 { font-size: 19px; }
      h4 { font-size: 16px; }
      p { margin: 0 0 18px; }
      a { color: var(--cyan); }
      a:hover { color: var(--accent); }
      strong { color: var(--text); font-weight: 800; }
      ul, ol { margin: 0 0 18px; padding-left: 26px; }
      li { margin: 6px 0; }
      hr {
        border: 0;
        border-top: 1px solid var(--line);
        margin: 40px 0;
      }
      blockquote {
        margin: 0 0 18px;
        padding: 4px 18px;
        border-left: 3px solid var(--accent);
        background: rgba(241, 207, 106, 0.06);
        color: var(--muted);
      }
      /* Inline code + code blocks */
      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.9em;
      }
      :not(pre) > code {
        padding: 2px 6px;
        border-radius: 5px;
        background: rgba(248, 237, 207, 0.08);
        border: 1px solid var(--line);
        color: var(--accent);
      }
      pre {
        margin: 0 0 22px;
        padding: 16px 18px;
        border-radius: 10px;
        background: #0c0e0d;
        border: 1px solid var(--line);
        box-shadow: inset 0 2px 10px rgba(0, 0, 0, 0.4);
        overflow-x: auto;
        line-height: 1.55;
      }
      pre code {
        background: none;
        border: 0;
        padding: 0;
        color: var(--text);
      }
      /* Tables (GFM) */
      .table-wrap { overflow-x: auto; margin: 0 0 22px; }
      table {
        border-collapse: collapse;
        width: 100%;
        min-width: 460px;
        font-size: 14px;
      }
      th, td {
        border: 1px solid var(--line);
        padding: 9px 12px;
        text-align: left;
        vertical-align: top;
      }
      thead th {
        background: var(--surface-2);
        color: var(--accent);
        font-weight: 800;
      }
      tbody tr:nth-child(even) { background: rgba(248, 237, 207, 0.035); }
      @media (prefers-reduced-motion: reduce) {
        html { scroll-behavior: auto; }
        .guide-bar a.bar-link { transition: none; }
      }
    </style>
  </head>
  <body>
    <nav class="guide-bar" aria-label="Guide navigation">
      <a class="brand" href="/">couch.gg</a>
      <span class="spacer"></span>
      <a class="bar-link" href="/dev">Publish a game</a>
      <a class="bar-link" href="/COUCH-GAME-GUIDE.md">Raw .md for your AI</a>
    </nav>
    <main class="guide-main">
${bodyHtml}
    </main>
  </body>
</html>
`;
}

async function main() {
  try {
    await access(guideSource);
  } catch {
    console.error(
      `[build-guide] Creator guide not found:\n  ${guideSource}\n` +
        `Expected packages/game-sdk/COUCH-GAME-GUIDE.md to exist.`
    );
    process.exit(1);
  }

  const md = await readFile(guideSource, 'utf-8');
  marked.setOptions({ gfm: true, breaks: false });
  let bodyHtml = marked.parse(md);

  // Wrap every rendered <table> so wide tables scroll horizontally inside their
  // own container instead of pushing the page body sideways.
  bodyHtml = bodyHtml.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>');

  const html = pageTemplate(bodyHtml);

  await mkdir(publicDir, { recursive: true });
  await writeFile(guideDest, html, 'utf-8');
  console.log(`[build-guide] Rendered creator guide -> ${guideDest}`);
}

main().catch((err) => {
  console.error('[build-guide] Unexpected failure:', err);
  process.exit(1);
});
