# WhatsApp API

Express service wrapping [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js).
Sends text and media messages to individuals and groups, with a persistent
on-disk queue so requests made while WhatsApp is disconnected are delivered once
the client reconnects.

## Requirements

- Node.js 20 LTS
- Chromium system libraries (puppeteer runs headless Chrome)
- pm2 for process management

## Setup

```bash
npm install
cp .env.example .env   # then fill in the values
```

Start under pm2 using the bundled ecosystem file:

```bash
pm2 start ecosystem.config.js
pm2 save
```

On first run the process prints a QR code to the pm2 log. Scan it from
WhatsApp on your phone (Linked devices) to authenticate:

```bash
pm2 logs wpapi
```

The session is stored in `.wwebjs_auth/` and survives restarts, so the QR is
only needed once per device link.

## Environment

| Variable | Purpose |
| --- | --- |
| `PORT` | Port the server listens on (default `3000`) |
| `API` | Shared secret; every request must pass `?api=<value>` |
| `INSIGHTS_URL` | Optional backend that answers inbound messages |
| `INSIGHTS_API_KEY` | Auth key for that backend |

## Endpoints

All endpoints require `?api=<API>`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/msg?mobile=<10-digit>&message=<text>` | Send text to a person |
| POST | `/message-text` | Same, as POST |
| GET | `/groups` | List groups with their chat ids |
| GET | `/group-msg?group=<id or name>&message=<text>` | Send text to a group |
| POST | `/message-group` | Same, as POST |
| POST | `/message` | Send media (file URL) |
| GET | `/health` | Liveness and client state |

Mobile numbers are prefixed with country code `91` server-side. Address groups
by chat id where possible — ids survive a group rename, names do not.

## Operational notes

- pm2 restarts the process nightly at 04:00 (`cron_restart`) and if RSS passes
  600 MB, since long-lived Chromium sessions leak memory.
- The process deliberately exits on a stuck or disconnected client so pm2 can
  restart it clean.
- `queue.json` holds pending messages and is written atomically; it is runtime
  state and is not committed.

## Patched dependency

`whatsapp-web.js` 1.34.7 cannot send media: every media send fails with
`Data passed to getter must include an id property`. The upstream fix
([wwebjs/whatsapp-web.js#201923](https://github.com/wwebjs/whatsapp-web.js/pull/201923))
is unreleased, so it is applied here as `patches/whatsapp-web.js+1.34.7.patch`
via `patch-package` on `postinstall`. The version is pinned exactly so the
patch cannot drift. When a release ships the fix, bump the version and delete
the patch file.
