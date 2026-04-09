# Architecture

## File Structure

```
nanobot-extension/
├── manifest.json              # MV3 manifest — permissions, commands, side panel config
├── src/                       # TypeScript source
│   ├── background/
│   │   └── service-worker.ts  # Routes icon clicks and Ctrl+K to the right handler
│   ├── lib/
│   │   ├── types.ts           # Shared TypeScript interfaces
│   │   ├── storage.ts         # Read/write settings from chrome.storage.local
│   │   ├── session.ts         # Session CRUD — create, list, switch, delete, append
│   │   └── ws-client.ts       # WebSocket client with automatic token issuance
│   ├── sidepanel/
│   │   ├── index.html         # Side panel markup
│   │   ├── style.css          # Dark theme, all tokens as CSS custom properties
│   │   └── app.ts             # Session list UI, chat rendering, settings form
│   └── quickchat/
│       ├── quickchat.ts       # Content script — builds the overlay DOM on injection
│       └── style.css          # Overlay styles, every selector prefixed with #nb-qc-
├── dist/                      # Built output (committed for end users)
│   ├── manifest.json
│   ├── background/service-worker.js
│   ├── sidepanel/app.js, index.html, style.css
│   ├── quickchat/quickchat.js, style.css
│   └── icons/
├── scripts/
│   └── build.mjs              # Custom build script (3 separate Vite builds for IIFE)
├── package.json
├── tsconfig.json
├── vite.config.ts
├── vitest.config.ts
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## How the Pieces Fit Together

### Background Service Worker

Thin routing layer. Two jobs:

- **Toolbar icon click** → calls `chrome.sidePanel.open()` to show the side panel
- **Ctrl+K command** → tries to toggle an existing quick chat overlay; if none exists, injects the CSS and scripts into the active tab

### Side Panel

Runs in the extension's own origin (`chrome-extension://...`). Has full access to `chrome.storage` and `chrome.runtime` APIs.

On open, it loads sessions from storage, renders the session list, and auto-connects to Nanobot. When the panel closes, the page is destroyed along with the WebSocket — sessions survive because they're in `chrome.storage.local`.

### Quick Chat

A content script injected into the host page's isolated world. It can access `chrome.storage` but shares the DOM with the page (without access to the page's JS).

On first Ctrl+K: the service worker injects `quickchat/quickchat.js` (a self-contained IIFE bundle that includes all shared lib code) into the tab, plus the overlay CSS. The script creates a backdrop and a floating container, then auto-connects to Nanobot.

On subsequent Ctrl+K presses: the service worker sends a toggle message to the already-injected script, which shows or hides the overlay.

### Shared Libraries

`lib/` files are loaded by both the side panel (via `<script>` tags) and quick chat (via `chrome.scripting.executeScript`). They share the same `NanobotWsClient`, `SessionManager`, and settings helpers — no code duplication.

## Data Flow

```
┌─────────────┐     fetch      ┌──────────────────┐
│  Extension   │ ──────────────▶│  Nanobot Server  │
│  (side panel │  GET /auth/    │                  │
│   or quick   │  token         │  Returns nbwt_   │
│   chat)      │◀────────────── │  single-use token│
│              │                │                  │
│              │  WebSocket     │                  │
│              │ ──────────────▶│  ws://host:port  │
│              │  ?token=nbwt_  │  /ws?token=...   │
│              │                │                  │
│              │◀─ delta ───────│  {"event":"delta",│
│              │◀─ stream_end ──│   "text":"..."}  │
│              │◀─ message ─────│                  │
└─────────────┘                └──────────────────┘
        │
        ▼
┌──────────────────┐
│ chrome.storage   │  Sessions, settings —
│ .local           │  survives page closes,
│                  │  extension restarts, etc.
└──────────────────┘
```

## Streaming Performance

Bot responses use `<pre>` elements with `textContent` updates during streaming. This avoids HTML parsing on every delta — the browser just appends text to a text node, which is the fastest path for incremental rendering.

When a stream ends, the `streaming` CSS class is removed (the blue accent border goes away). The raw text stays in `<pre>` for now — markdown rendering is a planned enhancement.

## Style Isolation

The quick chat overlay needs to coexist with arbitrary web pages. Every CSS selector is prefixed with `#nb-qc-` (e.g. `#nb-qc-container`, `#nb-qc-messages .nb-body`). This avoids style leaks in both directions without the overhead of Shadow DOM.

## Design Decisions

**TypeScript with Vite build.** Source code lives in `src/` as TypeScript. A custom build script (`scripts/build.mjs`) runs three separate Vite builds to produce self-contained IIFE bundles in `dist/`. Each entry point (service-worker, sidepanel, quickchat) bundles its own copy of shared lib code. The `dist/` directory is committed to git so end users can load it directly without any build step.

**No Shadow DOM for quick chat.** Shadow DOM would give perfect isolation but adds complexity (event forwarding, slot management, style inheritance). Prefixed selectors are simpler and sufficient for our use case.

**WebSocket lives in the page context, not the service worker.** MV3 service workers can be terminated after 30 seconds of inactivity, killing any active WebSocket. By keeping the connection in the side panel or content script, it stays alive as long as the user is actively chatting. The trade-off is that closing the panel drops the connection — acceptable since sessions are persisted and reconnection is automatic.
