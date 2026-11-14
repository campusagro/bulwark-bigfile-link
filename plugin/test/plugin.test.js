import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activate,
  escapeHtml,
  formatBytes,
  hooks,
  renderTemplate,
} from '../src/index.js';

test('formatBytes formats MiB values', () => {
  assert.equal(formatBytes(20 * 1024 * 1024), '20 МБ');
});

test('HTML template values are escaped', () => {
  const result = renderTemplate(
    '<a href="{{url}}">{{name}}</a>',
    { name: '<report>.pdf', url: 'https://example.test/a?x="y"', size: '', expires: '' },
    true,
  );
  assert.equal(
    result,
    '<a href="https://example.test/a?x=&quot;y&quot;">&lt;report&gt;.pdf</a>',
  );
});

test('escapeHtml covers all HTML-significant characters', () => {
  assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
});

function fakeApi(overrides = {}) {
  return {
    plugin: { settings: {} },
    http: {
      post: async () => ({
        ok: true,
        status: 200,
        data: { url: 'https://files.example.test/token', expiresAt: '2026-08-02T00:00:00Z' },
      }),
    },
    toast: { info() {}, success() {}, error() {} },
    upfiles: { get: async () => null },
    ui: { confirm: async () => false },
    i18n: {
      t: (key, values = {}) => `${key}:${values.name || ''}`,
      getLocale: () => 'ru',
    },
    log: { info() {} },
    ...overrides,
  };
}

test('small attachment stays on the normal upload path', async () => {
  const file = new File(['small'], 'small.txt', { type: 'text/plain' });
  await activate(fakeApi({ upfiles: { get: async () => file } }));
  assert.equal(await hooks.onBeforeBlobUpload('file-1'), 'file-1');
});

test('large attachment becomes an external link replacement', async () => {
  let uploadRequest;
  const file = new File([new Uint8Array(1024 * 1024 + 1)], '<large>.bin', {
    type: 'application/octet-stream',
  });
  await activate(fakeApi({
    plugin: { settings: { thresholdBytes: 1024 * 1024 } },
    upfiles: { get: async () => file },
    http: {
      post: async (...args) => {
        uploadRequest = args;
        return {
          ok: true,
          status: 200,
          data: { url: 'https://files.example.test/token', expiresAt: '2026-08-02T00:00:00Z' },
        };
      },
    },
  }));
  const result = await hooks.onBeforeBlobUpload('file-2');
  assert.equal(uploadRequest[0], '/api/bigfile-link/upload');
  assert.equal(uploadRequest[1], file);
  assert.deepEqual(uploadRequest[2], {
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Plugin-Bigfile-Name': '%3Clarge%3E.bin',
      'X-Plugin-Bigfile-Expiry-Days': '7',
      // 0 is Gokapi's "unlimited". The mail promises the link lasts until a
      // date and says nothing about a download count, so a counter that could
      // retire it earlier would make that promise false.
      'X-Plugin-Bigfile-Allowed-Downloads': '0',
    },
    // The staged file id from onBeforeBlobUpload, echoed so the host (Bulwark
    // 1.9.0+) counts this transfer's bytes for the attachment chip.
    progressFileId: 'file-2',
  });
  assert.equal(result.externalAttachment, true);
  assert.match(result.html, /https:\/\/files\.example\.test\/token/);
  assert.match(result.html, /&lt;large&gt;\.bin/);
});

test('failed external upload can fall back to the original attachment', async () => {
  const file = new File([new Uint8Array(1024 * 1024 + 1)], 'fallback.bin');
  await activate(fakeApi({
    plugin: { settings: { thresholdBytes: 1024 * 1024 } },
    upfiles: { get: async () => file },
    http: { post: async () => ({ ok: false, status: 503, data: { error: 'offline' } }) },
    ui: { confirm: async () => false },
  }));
  assert.equal(await hooks.onBeforeBlobUpload('file-3'), 'file-3');
});

// The composer runs a handler's html through sanitizePluginBodyHtml, which is
// the signature allowlist from bulwarkmail/webmail#751. A tag outside it (the
// template used to use <small>) is silently unwrapped, so the link block
// degrades without anything failing. Guard the shipped defaults against that.
test('default html template only uses tags the composer keeps', async () => {
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(
    await readFile(new URL('../manifest.json', import.meta.url), 'utf8'),
  );
  const allowed = new Set([
    'p', 'br', 'b', 'strong', 'i', 'em', 'u', 'a', 'span', 'div', 'img',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  ]);
  const template = manifest.settingsSchema.templateHtml.default;
  const used = [...template.matchAll(/<\/?([a-z0-9]+)/gi)].map(m => m[1].toLowerCase());
  assert.ok(used.length > 0, 'template should contain markup');
  for (const tag of used) {
    assert.ok(allowed.has(tag), `<${tag}> is stripped by the composer sanitizer`);
  }
});

test('manifest asks for both blob permissions the plugin needs', async () => {
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(
    await readFile(new URL('../manifest.json', import.meta.url), 'utf8'),
  );
  // upfiles.get sits behind email:blob-read: without it every read of the
  // attached file throws at runtime.
  assert.ok(manifest.permissions.includes('email:blob-read'));
  // Since Bulwark 1.21 hooks need a declared permission, and
  // onBeforeBlobUpload is catalogued under email:blob-write. Without it the
  // hook is silently dropped and big files go out as plain attachments.
  assert.ok(manifest.permissions.includes('email:blob-write'));
});
