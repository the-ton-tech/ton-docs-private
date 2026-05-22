# TON Docs AI backend

A small streaming chat backend for the AI assistant on the TON blockchain
documentation site. The docs site is a static export and has no server
runtime, so this service runs separately and handles chat requests.

## What it does

- Exposes `POST /api/chat`, which the docs site calls via the Vercel AI SDK
  `useChat` hook. It runs the AI SDK, forwards the conversation to
  [OpenRouter](https://openrouter.ai), and streams the answer back in the AI
  SDK v6 **UI Message Stream** format.
- Grounds answers in the real documentation: it builds an in-memory search
  index from `https://docs.ton.org/llms-full.txt` and exposes it to the model
  as a `search` tool. The model is instructed to search before answering and
  to cite the doc pages it used.
- Protects the OpenRouter free-tier quota with a per-IP rate limit, a per-IP
  daily cap, and a global daily request cap.

### Architecture

```
browser (docs site)  ->  nginx (TLS, docs-ton.space)  ->  this service (127.0.0.1:8787)  ->  OpenRouter
```

The service binds to localhost only; nginx terminates TLS and proxies `/api/`.

## Prerequisites

- Node.js 18 or newer.
- An OpenRouter API key — create one at <https://openrouter.ai/keys>.
- For deployment: a Linux VPS with nginx and certbot.

## Install

```bash
cd ai-backend
npm ci          # or: npm install
npm run build   # compiles src/ -> dist/
```

## Configure

Copy the example env file and fill in your key:

```bash
cp .env.example .env
# edit .env and set OPENROUTER_KEY
```

`.env` is gitignored. Never commit a real key.

## Run

Development (auto-reload):

```bash
npm run dev
```

Production:

```bash
npm run build
npm start        # runs node dist/server.js
```

## Deploy (systemd + nginx)

1. Build and copy the project to the server, e.g. `/opt/ton-docs-ai`
   (must contain `dist/`, `node_modules/`, and `.env`).

2. Create a dedicated system user:

   ```bash
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin ton-docs-ai
   sudo chown -R ton-docs-ai:ton-docs-ai /opt/ton-docs-ai
   ```

3. Install the systemd unit:

   ```bash
   sudo cp deploy/ton-docs-ai.service /etc/systemd/system/ton-docs-ai.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now ton-docs-ai
   sudo systemctl status ton-docs-ai
   ```

4. Install the nginx server block and obtain a TLS certificate:

   ```bash
   sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/docs-ton.space
   sudo ln -s /etc/nginx/sites-available/docs-ton.space /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   sudo certbot --nginx -d docs-ton.space
   ```

## Test

Health check:

```bash
curl https://docs-ton.space/api/health
# {"ok":true,"indexedPages":123,"dailyUsed":0,"dailyCap":45}
```

Streaming chat request (the UI Message Stream is a sequence of SSE-style
`data:` lines):

```bash
curl -N https://docs-ton.space/api/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "messages": [
      { "role": "user", "parts": [{ "type": "text", "text": "What is a smart contract on TON?" }] }
    ]
  }'
```

Against a local dev server, replace the URL with
`http://127.0.0.1:8787/api/chat`.

## Environment variables

| Variable                     | Required | Default                                   | Description                                                            |
| ----------------------------- | -------- | ----------------------------------------- | ---------------------------------------------------------------------- |
| `OPENROUTER_KEY`              | yes      | —                                         | OpenRouter API key. The service refuses to start without it.           |
| `OPENROUTER_MODEL`            | no       | `nvidia/nemotron-3-super-120b-a12b:free`  | Model slug passed to OpenRouter.                                       |
| `PORT`                        | no       | `8787`                                    | Port the service listens on (localhost only).                          |
| `ALLOWED_ORIGINS`             | no       | _(empty)_                                 | Extra CORS origins, comma-separated. `docs.ton.org` + topteam Vercel previews are always allowed. |
| `DOCS_LLMS_URL`               | no       | `https://docs.ton.org/llms-full.txt`      | Source of the documentation index.                                     |
| `DAILY_REQUEST_CAP`           | no       | `45`                                      | Max requests forwarded to OpenRouter per UTC day.                       |
| `PER_IP_DAILY_CAP`            | no       | `10`                                      | Max requests per client IP per UTC day.                                 |
| `DOCS_INDEX_REFRESH_MINUTES`  | no       | `360`                                     | How often to rebuild the docs search index.                            |

## Endpoints

- `POST /api/chat` — body `{ messages: UIMessage[] }`. Streams a UI Message
  Stream response. Rate-limited: 1 req/sec per IP, a per-IP daily cap, and a
  global daily cap; the request body is size-capped.
- `GET /api/health` — returns `{ ok, indexedPages, dailyUsed, dailyCap }`.
