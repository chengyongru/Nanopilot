# Setup Guide

## Nanobot Side

Add a WebSocket channel to your `~/.nanobot/config.json`:

```json
{
  "channels": {
    "websocket": {
      "enabled": true,
      "host": "127.0.0.1",
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

Then start Nanobot:

```bash
nanobot gateway
```

You should see `WebSocket server listening on ws://127.0.0.1:8765/ws` in the logs.

## Extension Side

Open the side panel (click the toolbar icon), then click the gear icon. The settings:

| Field | Default | What it does |
|-------|---------|-------------|
| Host | `127.0.0.1` | Where Nanobot is running |
| Port | `8765` | WebSocket port |
| WS Path | `/ws` | The WebSocket endpoint path |
| Token Issue Path | `/auth/token` | HTTP path to get a short-lived token |
| Token Issue Secret | *(empty)* | Shared secret for token requests |
| Client ID | `browser-extension` | How this extension identifies itself |

Click **Save**. The extension will reconnect automatically.

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

**Ctrl+Shift+K does nothing**

- The shortcut may conflict with another extension. Go to `chrome://extensions/shortcuts` to reassign it
- It's not available on `chrome://` or `edge://` pages

**Quick chat overlay doesn't appear**

- Check the service worker logs: `chrome://extensions` → Nanobot → Inspect views: service worker
- Make sure the page isn't a restricted URL (browser internals, Chrome Web Store, etc.)
