# Nanobot Browser Extension

<p align="center">
  <img src="icons/icon128.png" width="56" alt="Nanobot">
</p>

<p align="center">
  Chat with Nanobot without leaving your browser.
</p>

Open a side panel for persistent multi-session conversations, or hit <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>K</kbd> for a quick question on any page.

**No build tools. No frameworks. Just an extension.**

---

## Install

```bash
git clone https://github.com/HKUDS/nanobot-extension.git
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the repo folder.

Pin it to your toolbar via the puzzle icon.

## Quick Start

1. Make sure Nanobot is running with WebSocket enabled (see [Setup Guide](docs/setup.md))
2. Click the extension icon → open Settings (gear icon)
3. Fill in your host, port, and token issue secret → Save
4. Start chatting

## What's Inside

- **Side Panel** — persistent chat with session management
- **Ctrl+Shift+K Quick Chat** — Cursor-style overlay, ask and dismiss
- **Streaming** — real-time token output, no waiting
- **Token auth** — auto-issues short-lived tokens, secret stays local
- **Multi-session** — conversations persist across restarts

## Docs

| Doc | What's in it |
|-----|-------------|
| [Setup Guide](docs/setup.md) | Nanobot config, extension settings, TLS |
| [Architecture](docs/architecture.md) | File structure, data flow, design decisions |

## Compatibility

Chrome 116+ and Edge 116+. Firefox and Safari are on the roadmap.

## License

MIT
