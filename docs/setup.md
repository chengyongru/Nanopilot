# Setup Guide

## Prerequisites

- **Chrome 120+** or **Edge 120+**
- A running Nanobot instance with a **public IP or domain** (the extension runs in your browser, so `127.0.0.1` only works if Nanobot is on the same machine)
- If your Nanobot is behind NAT, use a tunneling service (Cloudflare Tunnel, ngrok, etc.) or a reverse proxy (nginx, Caddy)

---

## Setup in 3 Steps

### Step 1: Install Nanopilot

1. Download the zip from the [latest release](https://github.com/chengyongru/Nanopilot/releases)
2. Open `chrome://extensions` → enable **Developer mode** (top-right)
3. Click **Load unpacked** → select the extracted folder
4. Pin it to your toolbar via the puzzle icon

### Step 2: Ask Nanobot to Configure Itself

Send this message to your Nanobot (via your existing channel, e.g. Feishu, terminal, etc.):

```
Please configure a WebSocket channel for me. Here's what I need:

1. Enable the WebSocket channel in my config.json with `host` set to `0.0.0.0` so it accepts external connections.
2. Use issued-token authentication (not a static token). Generate a strong `tokenIssueSecret` for me.
3. Enable streaming.
4. After configuring, restart the gateway.
5. Then give me the following values in a clear copy-paste format so I can fill them into Nanopilot's extension settings:
   - Host: (my public IP or domain)
   - Port: (the WebSocket port)
   - WS Path: (the WebSocket path)
   - Token Issue Path: (the token issue path)
   - Token Issue Secret: (the generated secret)

Reference: https://github.com/HKUDS/nanobot/blob/main/docs/WEBSOCKET.md
```

Your Nanobot will handle the entire configuration and output the exact values you need.

### Step 3: Paste & Connect

1. Click the Nanopilot icon in your toolbar → open **Settings** (gear icon)
2. Paste the 5 values from your Nanobot's response into the corresponding fields
3. Click **Save** — you're connected!

---

## Manual Configuration (Optional)

If you prefer to configure Nanobot manually, add a WebSocket channel to your `~/.nanobot/config.json`:

```json
{
  "channels": {
    "websocket": {
      "enabled": true,
      "host": "0.0.0.0",
      "port": 8765,
      "path": "/ws",
      "tokenIssuePath": "/auth/token",
      "tokenIssueSecret": "your-secret-here",
      "tokenTtlS": 300,
      "websocketRequiresToken": true,
      "allowFrom": ["*"],
      "streaming": true
    }
  }
}
```

Then restart Nanobot:

```bash
nanobot gateway
```

You should see `WebSocket server listening on ws://0.0.0.0:8765/ws` in the logs.

### Extension Settings Reference

| Field | Default | What it does |
|-------|---------|-------------|
| Host | `127.0.0.1` | Where Nanobot is running (use your public IP or domain) |
| Port | `8765` | WebSocket port |
| WS Path | `/ws` | The WebSocket endpoint path |
| Token Issue Path | `/auth/token` | HTTP path to get a short-lived token |
| Token Issue Secret | *(empty)* | Shared secret for token requests |
| Client ID | `browser-extension` | How this extension identifies itself |

---

## How Auth Works

The extension never stores or exposes your static secret. Here's the flow:

1. Extension sends `GET /auth/token` with `Authorization: Bearer <your-secret>`
2. Server returns a one-time token: `{"token": "nbwt_...", "expires_in": 300}`
3. Extension opens a WebSocket connection carrying that token as a query parameter
4. The token is consumed on handshake — single use, expires in 5 minutes

If connection drops, the extension simply requests a new token and reconnects. No stale credentials, no manual refresh.

## TLS (Optional)

If your Nanobot instance sits behind HTTPS, set `sslCertfile` and `sslKeyfile` in the Nanobot config, then change the extension's host to `https://` — it just works. No extra configuration needed on the extension side.

## Troubleshooting

**"Connection failed" in the side panel**

- Right-click the side panel → Inspect → check the Console for errors
- Verify Nanobot is running and the WebSocket channel is enabled
- Double-check the host, port, and secret in Settings
- If the token issue returns 401, the secret doesn't match
- Make sure your Nanobot is accessible from your browser (check firewall, public IP, NAT)

**Ctrl+Shift+K does nothing**

- The shortcut may conflict with another extension. Go to `chrome://extensions/shortcuts` to reassign it
- It's not available on `chrome://` or `edge://` pages

**Quick chat overlay doesn't appear**

- Check the service worker logs: `chrome://extensions` → Nanobot → Inspect views: service worker
- Make sure the page isn't a restricted URL (browser internals, Chrome Web Store, etc.)
