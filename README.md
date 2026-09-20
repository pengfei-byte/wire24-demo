# WIRE 24

A 24-hour rolling newscast. The anchor is **Elena Voss**, a PopVid Realtime character. Viewers do not type. Once the picture is up, she reads politics, business, finance, and entertainment on her own.

PopVid sessions last about five minutes. When the hour ends, the next edition starts automatically.

## News sources

The server pulls public RSS — headlines and summaries only, no full articles:

| Desk | Sources |
| --- | --- |
| Politics | BBC World / Politics, NPR, The Guardian World |
| Business | BBC Business, NPR Business, The Guardian Business |
| Finance | MarketWatch, NPR, Guardian Economics |
| Entertainment | BBC Entertainment, NPR Arts, Guardian Culture |

Google News RSS is a backup aggregator.

## Anchor likeness

`public/anchor.jpg` is a 576×768 (3:4) still. The lobby uses that photo. PopVid uses the same file as `seed_image_url`, so the live face is generated from it.

PopVid fetches the image from the public internet. `localhost` will not work. On a deployed HTTPS host, `/anchor.jpg` is picked up automatically. For local realtime looks, set `PUBLIC_BASE_URL` to a public origin that serves that file (a Cloudflare tunnel is enough).

## Run locally

```bash
cp .env.example .env   # add POPVID_API_KEY
npm install
npm test
npm run dev
```

Open `http://127.0.0.1:5173`. Click **Watch live** once (browsers block unmuted autoplay). After that the hour runs itself.

- The API key stays on the server.
- Without a key, the teleprompter still reads the wires.

## Deploy

Express serves the built frontend and keeps the key. Do not use a static host.

Same path as NITE: push the repo, then Render Blueprint from `render.yaml` (free Web Service). Health check is `/api/health`. After it is live, PopVid fetches `/anchor.jpg` from that HTTPS origin automatically.

Needed env (set `POPVID_API_KEY` in the Render dashboard only, never in Git):

- `POPVID_API_KEY`
- `POPVID_BASE_URL=https://popvid.ai/api/public/v1`
- `NODE_ENV=production`
- optional `PUBLIC_BASE_URL` if the public origin is not the request host
