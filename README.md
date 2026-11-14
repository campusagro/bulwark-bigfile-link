# bigfile-link — large attachments as download links for Bulwark

A [Bulwark](https://github.com/bulwarkmail/webmail) webmail plugin. When a user
attaches a file above a size threshold (20 MiB by default), the plugin uploads
it to a [Gokapi](https://github.com/Forceu/Gokapi) file share instead of the
mail server and puts an expiring download link into the message body. Smaller
files stay ordinary attachments.

It is made of two parts:

| | What | Where it runs |
|---|---|---|
| `plugin/` | Bulwark hook plugin (`onBeforeBlobUpload`) | in the browser, inside Bulwark |
| `service/` | Small upload proxy, one Node file, no dependencies | next to Gokapi, behind your reverse proxy |

Bulwark itself stays the stock upstream image.

## How it works

1. The composer calls `onBeforeBlobUpload(fileId)` for each attachment.
2. Files at or below the threshold go through the normal JMAP upload.
3. A larger file is read with `api.upfiles.get()` and POSTed as-is to the
   same-origin path `/api/bigfile-link/upload`, with upload progress shown in
   the composer (`progressFileId`).
4. The reverse proxy sends that one path to `service/`. The service replays the
   caller's `Authorization` header against the JMAP server
   (`GET /.well-known/jmap`), so only a signed-in mailbox can spend the Gokapi
   key. Only then does it stream the body to Gokapi (`POST /api/files/add`).
5. The plugin returns an `ExternalAttachmentResult`: the composer drops the
   attachment and inserts the link block at the cursor.

If the upload fails the user gets the reason and a choice: **Retry**, or
**Send as attachment** (back to the normal upload). A message never goes out
with a silently lost file.

The Gokapi key lives only in the service. The browser never sees it.

## Requirements

- Bulwark **1.21.2** or newer is what this version is tested against. Since
  1.21 every hook needs a declared permission, and `onBeforeBlobUpload` sits
  under `email:blob-write` — plugin versions before 1.6.0 silently stop working
  there.
- A Gokapi instance and an API key with the **Upload** permission only.
- A reverse proxy in front of Bulwark that can route one path elsewhere
  (example for Caddy in `service/Caddyfile.snippet`).

## Install

### 1. The service

```bash
cd service
mkdir -p secrets && printf '%s' 'YOUR_GOKAPI_UPLOAD_KEY' > secrets/gokapi_upload_key
chmod 600 secrets/gokapi_upload_key
# edit docker-compose.yml: JMAP_SERVER_URL, Gokapi endpoint and network
docker compose up -d --build
curl -s http://127.0.0.1:8099/healthz
```

| Variable | Meaning |
|---|---|
| `PORT` | listen port, default 8099 |
| `JMAP_SERVER_URL` | JMAP server the webmail signs in to; callers are verified against it |
| `BIGFILE_LINK_GOKAPI_ENDPOINT` | Gokapi base URL as seen from the container |
| `BIGFILE_LINK_GOKAPI_API_KEY_FILE` | file with the Gokapi API key |
| `BIGFILE_LINK_MAX_BYTES` | upload ceiling in bytes, checked against `Content-Length` and the bytes actually received |

### 2. The route

Add `service/Caddyfile.snippet` to the site block of **every** host the webmail
is served on, before the `reverse_proxy` to Bulwark, and reload. Check:

```bash
curl -s -X POST https://webmail.example.com/api/bigfile-link/upload
# {"error":"Invalid Authorization header"} — the route reaches the service
```

### 3. The plugin

```bash
cd plugin
npm ci
npm test
npm run package   # -> bigfile-link.zip
```

Upload `bigfile-link.zip` in **Bulwark Admin → Plugins**, approve
`email:blob-read`, `email:blob-write` and `http:post`, enable it. A ready ZIP is
attached to each GitHub release.

## Settings (Admin → Plugins → bigfile-link)

| Setting | Default |
|---|---|
| Large attachment threshold | 20 MiB |
| Link expiry | 7 days |
| HTML / plain-text link templates | placeholders `{{name}}`, `{{size}}`, `{{url}}`, `{{expires}}` |

The HTML template goes through Bulwark's composer sanitizer (signature
allowlist): tags outside it are unwrapped, so the default template uses
`<span style="…">`. A test guards that.

## License

MIT, see [LICENSE](LICENSE).
