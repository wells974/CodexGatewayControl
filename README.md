# Codex Gateway Control

A local, single-process OpenAI-compatible gateway for Codex. It stores multiple upstream endpoints in SQLite and forwards every `/v1/*` request to the selected upstream.

The Gateway never changes the Codex request model name. If Codex requests `gpt-4.1`, `o3`, or any other model, the same request body is forwarded unchanged to the active upstream. Switching only changes the destination for later requests; active streams stay on their original connection.

## Run

Requirements: Node.js 22.13+ only. Docker, Postgres, LiteLLM, and a separate database service are not required.

```bash
cp .env.example .env
npm install
npm run build
npm start
```

Open http://127.0.0.1:4000. Add each OpenAI-compatible upstream URL and API key, test it, then choose **Use**. Data is stored locally in `.data/gateway.sqlite` with owner-only file permissions. API keys are never returned by the management API or exposed to the embedded browser page.

Configure Codex once to use:

```text
Base URL: http://127.0.0.1:4000/v1
API key: GATEWAY_ACCESS_TOKEN from .env
Model: any model name supported by your selected upstream
```

The Gateway sends the upstream's stored API key onward. It does not expose it to Codex or the browser.

## API

Management endpoints are local-only. Writes require a local `HttpOnly` request-token cookie created when opening the management UI.

- `GET /health`
- `GET /api/status`
- `GET /api/upstreams`
- `POST /api/upstreams`
- `PATCH /api/upstreams/:id`
- `DELETE /api/upstreams/:id`
- `POST /api/upstreams/:id/test`
- `POST /api/upstreams/:id/activate`

All `/v1/*` paths are authenticated with the optional `GATEWAY_ACCESS_TOKEN` and transparently streamed to the active upstream. The Gateway does not buffer SSE output and does not rewrite `model`, tools, messages, or request paths.

## Codex sidebar embedding

The optional launcher opens a separate Gateway-enabled Codex Desktop window while retaining your original window:

```bash
npm run codex
```

It starts the local Gateway when needed, launches ChatGPT/Codex with a loopback CDP port, injects the **Gateway** sidebar entry, and keeps watching renderer replacements and reloads. It does not start Docker because this project no longer uses Docker.

To attach to an instance that was already started with CDP:

```bash
npm run codex:attach -- --port 9222
```

Attach mode fails if the selected port is not a live Codex CDP endpoint. CDP is an unauthenticated loopback debugging interface; use it only when trusted local code is running. This project does not yet package a signed macOS companion app, Keychain integration, or Notarization.

## Limits

This first version implements manual upstream selection. It does not implement automatic fallback, retries, cooldown, multi-tenancy, billing, audit trails, autoscaling, or a generic LiteLLM Admin UI.
