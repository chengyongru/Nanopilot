# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Nanopilot (branded "Nanobot") is a Chrome Extension (Manifest V3) that provides a side panel and quick chat overlay for conversing with a Nanobot AI backend via WebSocket. TypeScript + Vite, tested with Vitest.

## Commands

```bash
npm run build            # Build src/ → dist/ (3 IIFE bundles via custom Vite script)
npm run dev              # Watch mode build
npm test                 # Run all tests
npm run test:coverage    # Tests with v8 coverage (90% thresholds enforced)
npm run test:watch       # Vitest in watch mode
```

Run a single test file: `npx vitest run src/lib/__tests__/storage.test.ts`

## Architecture

### Build System

`scripts/build.mjs` runs **three separate Vite builds** producing self-contained IIFE bundles — one each for the service worker, side panel, and quick chat. Each bundles its own copy of shared `lib/` code (no runtime sharing). Static assets (manifest.json, icons, HTML, CSS) are copied into `dist/` directly. The `dist/` directory is committed to git so end users can load it without building.

### Extension Entry Points

- **`src/background/service-worker.ts`** — Thin routing layer. Routes toolbar icon clicks to `chrome.sidePanel.open()` and Ctrl+K to quick chat injection/toggle.
- **`src/sidepanel/app.ts`** — Persistent side panel UI: session list, chat rendering, settings form. Runs in extension origin with full `chrome.storage` access. WebSocket lives here (not in the service worker, which MV3 can kill after 30s).
- **`src/quickchat/quickchat.ts`** — Content script injected into host pages. Builds a floating overlay DOM. Every CSS selector prefixed with `#nb-qc-` for style isolation (no Shadow DOM).

### Shared Libraries (`src/lib/`)

- **`types.ts`** — `Settings`, `Message`, `Session`, `ServerFrame` interfaces
- **`storage.ts`** — `chrome.storage.local` read/write for settings
- **`session.ts`** — Session CRUD (create, list, switch, delete, append) persisted in `chrome.storage.local`
- **`ws-client.ts`** — WebSocket client with automatic token issuance (fetches one-time token from `/auth/token`, then connects with `?token=...`)
- **`markdown.ts`** — Markdown rendering pipeline: `marked` (GFM + breaks) + `highlight.js` (syntax highlighting) + `DOMPurify` (XSS sanitization). Exports `renderMarkdown()` and `initCopyButtons()`.

### Data Flow

1. Extension fetches a single-use token: `GET /auth/token` with `Authorization: Bearer <secret>`
2. Opens WebSocket to `ws://host:port/path?token=nbwt_...`
3. Receives streaming deltas (`delta`), final messages (`message`), and stream end signals (`stream_end`)
4. Sessions and settings persist in `chrome.storage.local`

## Key Conventions

- **Target**: Chrome 120+ (ES2022, `chrome` types)
- **TypeScript strict mode** enabled with `noUnusedLocals` and `noUnusedParameters`
- **Tests** live in `__tests__/` directories adjacent to source, using jsdom environment with `fake-indexeddb`
- **Coverage thresholds**: 90% across lines, branches, functions, statements
- **No runtime bundling between entry points** — each IIFE bundle is fully self-contained
- **Quick chat CSS isolation** uses `#nb-qc-` prefixed selectors, not Shadow DOM
- **Markdown rendering**: Assistant messages are rendered via `renderMarkdown()` (marked + highlight.js + DOMPurify). Streaming uses `requestAnimationFrame` to debounce re-renders of accumulated text. User messages remain plain text.
- **Markdown dependencies**: `marked`, `highlight.js`, `dompurify` (bundled into sidepanel and quickchat IIFEs; service worker does not use them)
