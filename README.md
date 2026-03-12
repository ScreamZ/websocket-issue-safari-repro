# WebSocket Refresh Repro

A minimal Bun + browser WebSocket reproduction app intended to isolate refresh issues on Mobile Safari with websocket code involved.

## Run modes

The repro now supports two explicit topologies:

- `same-port`: app UI and websocket server both run on `3100`
- `split-port`: app UI runs on `3100` and websocket server runs on `3001`

Use:

```bash
bun run dev:same-port
```

or:

```bash
bun run dev:split-port
```

The default `bun run dev` keeps the split-port setup.

## 
So far here are my observations

When using a bun server or i think any ws server based on ūSocket (haven't try any other)

Whenever the port is bind on a different port than the port the app is currently running (or maybe its wss).

On safari Mobile (ONLY) when first joining the page or when the socket is disconnected due to tab back to OS. The socket is having hard time (random) to connect. (If you refresh the page also)

For the port i haven't been able to confirm it yet. But i have good clues about it.

No issue on safari web (same host) or chrome (mobile and desktop)

I might have found a workaround using partysocket. For some reason calling "Reconnect" method on partysocket fixes the issue.
