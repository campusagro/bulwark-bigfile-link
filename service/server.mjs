// Standalone upload proxy for the bigfile-link Bulwark plugin.
//
// Why it is not a Bulwark route: the plugin has to POST to a same-origin
// /api/* path, but baking a route into the Bulwark image means maintaining a
// fork of it. The reverse proxy in front of the webmail routes that one path
// here instead, so Bulwark stays on the stock upstream image and keeps getting
// updates.
//
// It holds the Gokapi API key, so every request must prove it comes from a
// logged-in mailbox: the caller's Authorization header is replayed against the
// JMAP server, and only a valid session gets to spend the key.
//
// The request body is streamed into the multipart envelope rather than
// buffered: holding a several-hundred-megabyte attachment in memory on a
// small host that also runs the mail server would be the wrong trade.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT || 8099);
const UPLOAD_PATH = '/api/bigfile-link/upload';
const JMAP_VERIFY_TIMEOUT_MS = 10_000;
const GOKAPI_TIMEOUT_MS = 300_000;
const MAX_REDIRECTS = 3;

const MAX_BYTES = Number(process.env.BIGFILE_LINK_MAX_BYTES || 524_288_000);
const GOKAPI_ENDPOINT = process.env.BIGFILE_LINK_GOKAPI_ENDPOINT || 'http://127.0.0.1:53842';
const API_KEY_FILE = process.env.BIGFILE_LINK_GOKAPI_API_KEY_FILE || '';
const JMAP_SERVER_URL = process.env.JMAP_SERVER_URL || '';

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function log(level, message, extra = {}) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level, message, ...extra })}\n`);
}

// ─── Request helpers ─────────────────────────────────────────

function intHeader(req, name, fallback, min, max) {
  const value = Number(req.headers[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function decodeFilename(value) {
  if (!value) return 'attachment.bin';
  try {
    return decodeURIComponent(value).replace(/[\r\n/\\"]/g, '_').slice(0, 200);
  } catch {
    return 'attachment.bin';
  }
}

async function getApiKey() {
  if (!API_KEY_FILE) throw new HttpError('BIGFILE_LINK_GOKAPI_API_KEY_FILE is not configured', 500);
  const key = (await readFile(API_KEY_FILE, 'utf8')).trim();
  if (!key) throw new HttpError('Gokapi API key file is empty', 500);
  return key;
}

// ─── JMAP session verification ───────────────────────────────
// Mirrors Bulwark's verifyJmapAuth: replay the caller's credentials against
// the mail server and require a well-formed session document back.

function normalizeJmapServerUrl(serverUrl) {
  let url;
  try {
    url = new URL(serverUrl);
  } catch {
    throw new HttpError('Invalid server URL', 500);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError('Unsupported server URL protocol', 500);
  }
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

function validateAuthHeader(authHeader) {
  if (!/^(?:Basic|Bearer)\s+\S+$/i.test(authHeader)) {
    throw new HttpError('Invalid Authorization header', 400);
  }
}

async function verifyJmapAuth(serverUrl, authHeader) {
  const base = normalizeJmapServerUrl(serverUrl);
  validateAuthHeader(authHeader);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JMAP_VERIFY_TIMEOUT_MS);

  try {
    let currentUrl = `${base}/.well-known/jmap`;
    let response;

    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      response = await fetch(currentUrl, {
        method: 'GET',
        headers: { Authorization: authHeader },
        signal: controller.signal,
        redirect: 'manual',
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new HttpError('Failed to verify JMAP session', 502);
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      break;
    }

    if (!response) throw new HttpError('Failed to verify JMAP session', 502);
    if (response.status >= 300 && response.status < 400) {
      throw new HttpError('Too many redirects verifying JMAP session', 502);
    }
    if (!response.ok) {
      const denied = response.status === 401 || response.status === 403;
      throw new HttpError(denied ? 'Authentication failed' : 'Failed to verify JMAP session', denied ? 401 : 502);
    }

    const session = await response.json().catch(() => null);
    if (!session || typeof session.apiUrl !== 'string' || typeof session.accounts !== 'object' || session.accounts === null) {
      throw new HttpError('Invalid JMAP session response', 502);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error?.name === 'AbortError') throw new HttpError('JMAP session verification timed out', 504);
    throw new HttpError('Failed to verify JMAP session', 502);
  } finally {
    clearTimeout(timer);
  }
}

// ─── Gokapi upload ───────────────────────────────────────────

/**
 * Builds the multipart body as an async iterable so the attachment is piped
 * from the client straight to Gokapi. Enforces the size ceiling as bytes go
 * past, since Content-Length is only a claim.
 */
async function* multipartBody(req, boundary, fields, file) {
  const enc = new TextEncoder();
  for (const [name, value] of Object.entries(fields)) {
    yield enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    );
  }
  yield enc.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
      `Content-Type: ${file.contentType}\r\n\r\n`,
  );

  let seen = 0;
  for await (const chunk of req) {
    seen += chunk.length;
    if (seen > MAX_BYTES) {
      throw new HttpError('Oversized upload', 413);
    }
    yield chunk;
  }
  if (seen === 0) throw new HttpError('Empty upload', 400);

  yield enc.encode(`\r\n--${boundary}--\r\n`);
}

async function uploadToGokapi(req, file, options) {
  const endpoint = new URL('/api/files/add', GOKAPI_ENDPOINT);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new HttpError('Invalid Gokapi endpoint', 500);
  }

  const boundary = `----bigfilelink${randomUUID().replace(/-/g, '')}`;
  const body = multipartBody(req, boundary, {
    expiryDays: String(options.expiryDays),
    allowedDownloads: String(options.allowedDownloads),
    password: '',
  }, file);

  const upstream = await fetch(endpoint, {
    method: 'POST',
    headers: {
      apikey: await getApiKey(),
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
    duplex: 'half',
    signal: AbortSignal.timeout(GOKAPI_TIMEOUT_MS),
  });

  const payload = await upstream.json().catch(() => null);
  if (!upstream.ok || !payload) {
    throw new HttpError(`Gokapi upload failed (HTTP ${upstream.status})`, upstream.status >= 500 ? 502 : 502);
  }

  // Gokapi (v2.2.4) answers `{ Result, FileInfo: { UrlDownload, ExpireAt } }`.
  // Older builds put those at the top level, so accept both.
  const fileInfo = payload.FileInfo ?? payload.fileInfo;
  const source = fileInfo && typeof fileInfo === 'object' ? fileInfo : payload;

  const url = String(source.UrlDownload || source.urlDownload || '');
  if (!url) throw new HttpError('Gokapi returned no download URL', 502);

  // ExpireAt is Unix *seconds*; the plugin passes this to `new Date()`, which
  // reads milliseconds and would date every link to 1970.
  const raw = source.ExpireAt ?? source.expireAt ?? null;
  const expiresAt =
    typeof raw === 'number' && Number.isFinite(raw) && raw > 0
      ? new Date(raw * 1000).toISOString()
      : typeof raw === 'string' && raw
        ? raw
        : null;

  return { url, expiresAt };
}

// ─── HTTP surface ────────────────────────────────────────────

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function handleUpload(req, res) {
  if (!JMAP_SERVER_URL) throw new HttpError('JMAP server is not configured', 500);

  // Spending the private Gokapi key requires a live mailbox session.
  await verifyJmapAuth(JMAP_SERVER_URL, req.headers.authorization || '');

  const claimed = Number(req.headers['content-length'] || 0);
  if (claimed > MAX_BYTES) throw new HttpError('Oversized upload', 413);

  const file = {
    filename: decodeFilename(req.headers['x-plugin-bigfile-name']),
    contentType: req.headers['content-type'] || 'application/octet-stream',
  };
  // allowedDownloads 0 is Gokapi's "unlimited" (it stores UnlimitedDownloads=1
  // and stops counting), which is the default here: the link the recipient gets
  // is only promised to last until its expiry date, so a download counter
  // running out first would make that promise false. The lower bound stays 0 so
  // a caller can still ask for unlimited explicitly.
  const options = {
    expiryDays: intHeader(req, 'x-plugin-bigfile-expiry-days', 7, 1, 365),
    allowedDownloads: intHeader(req, 'x-plugin-bigfile-allowed-downloads', 0, 0, 1000),
  };

  const started = Date.now();
  const result = await uploadToGokapi(req, file, options);
  log('info', 'upload complete', {
    filename: file.filename,
    bytes: claimed || null,
    ms: Date.now() - started,
  });
  sendJson(res, 200, result);
}

const server = createServer((req, res) => {
  const path = (req.url || '').split('?')[0];

  if (req.method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method !== 'POST' || path !== UPLOAD_PATH) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  handleUpload(req, res).catch((error) => {
    const status = error instanceof HttpError ? error.status : 502;
    const message = error instanceof HttpError ? error.message : 'Upload proxy failed';
    // The client is deliberately told nothing beyond "failed", so an unexpected
    // throw leaves no trace of what actually broke unless the real error is
    // recorded here. Stays server-side; never goes back over the wire.
    log('error', 'upload failed', error instanceof HttpError
      ? { status, detail: message }
      : {
          status,
          detail: message,
          cause: error?.message,
          code: error?.code,
          inner: error?.cause?.message,
          at: error?.stack?.split('\n').slice(1, 4).join(' | '),
        });
    // The socket may already be half-consumed; only answer if we still can.
    if (!res.headersSent) sendJson(res, status, { error: message });
    else res.destroy();
    // Drain whatever the client is still sending so it sees the status
    // rather than a connection reset.
    req.resume();
  });
});

// Large uploads over a slow link must not be cut by the default 2 min idle.
server.requestTimeout = 0;
server.headersTimeout = 60_000;

server.listen(PORT, () => {
  log('info', 'bigfile-link upload proxy listening', {
    port: PORT,
    gokapi: GOKAPI_ENDPOINT,
    jmap: JMAP_SERVER_URL || '(unset)',
    maxBytes: MAX_BYTES,
  });
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    log('info', 'shutting down', { signal });
    server.close(() => process.exit(0));
  });
}
