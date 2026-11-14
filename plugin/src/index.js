let pluginApi = null;

const DEFAULT_THRESHOLD = 20 * 1024 * 1024;
const DEFAULT_EXPIRY_DAYS = 7;
// Gokapi reads 0 as "unlimited downloads". The link is advertised to the
// recipient as valid until a date and nothing else, so a download counter that
// could kill it earlier would make the mail lie. Expiry alone retires the file.
const UNLIMITED_DOWNLOADS = 0;
// The composer runs this through sanitizePluginBodyHtml (the signature
// allowlist), so only p/br/b/strong/i/em/u/a/span/div/img/table tags survive.
// <small> is not on that list and would be unwrapped - use a styled span.
//
// A plain link, not a button, because the composer's rich-text editor will not
// carry one. Two shapes were tried against it: a table cell with bgcolor came
// out as an empty full-width box (the editor drops bgcolor and normalizes the
// <a> down to its href), and a styled <span> nested inside the <a> lost its
// text entirely, since a link is a mark there and cannot hold that span.
// Styled spans do survive on their own - hence the bold name and grey size -
// but nothing survives *inside* a link, which is exactly where a button needs
// its styling to live. Restyling this is a dead end until the editor keeps
// attributes on links.
const DEFAULT_HTML_TEMPLATE =
  '<div style="margin:16px 0">' +
  '<div style="margin-bottom:6px">К письму приложены файлы:</div>' +
  '<div style="margin-bottom:8px"><span style="font-weight:600">{{name}}</span>' +
  '<span style="color:#5b6b7c"> ({{size}})</span></div>' +
  '<div style="margin-bottom:8px"><a href="{{url}}">Скачать файл</a></div>' +
  '<span style="font-size:12px;color:#5b6b7c">' +
  'Ссылка действует до {{expires}}</span></div>';
const DEFAULT_TEXT_TEMPLATE =
  '\n\nК письму приложены файлы:\n{{name}} ({{size}})\n' +
  'Скачать: {{url}}\nСсылка действует до {{expires}}\n';

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || size >= 10 ? 0 : 1;
  return `${size.toFixed(digits)} ${units[unit]}`;
}

export function renderTemplate(template, values, html = false) {
  const safe = html
    ? {
        name: escapeHtml(values.name),
        size: escapeHtml(values.size),
        url: escapeHtml(values.url),
        expires: escapeHtml(values.expires),
      }
    : values;
  return String(template || '').replace(
    /\{\{(name|size|url|expires)\}\}/g,
    (_, key) => String(safe[key] ?? ''),
  );
}

function numericSetting(settings, name, fallback, min, max) {
  const value = Number(settings?.[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function responseError(response) {
  const data = response?.data;
  if (data && typeof data.error === 'string') return data.error;
  return `HTTP ${response?.status || 0}`;
}

async function upload(file, settings, fileId) {
  const expiryDays = numericSetting(settings, 'expiryDays', DEFAULT_EXPIRY_DAYS, 1, 365);
  // Upstream only lets a binary upload carry Content-Type and X-Plugin-*
  // headers; anything else is refused by applyPluginUploadHeaders.
  //
  // progressFileId (Bulwark 1.9.0) is the staged file id the composer handed
  // to onBeforeBlobUpload; echoing it makes the host count this transfer's
  // bytes, so the attachment chip shows a real percentage instead of the
  // indeterminate bar. Older hosts ignore the unknown option field.
  const response = await pluginApi.http.post('/api/bigfile-link/upload', file, {
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-Plugin-Bigfile-Name': encodeURIComponent(file.name || 'attachment.bin'),
      'X-Plugin-Bigfile-Expiry-Days': String(expiryDays),
      'X-Plugin-Bigfile-Allowed-Downloads': String(UNLIMITED_DOWNLOADS),
    },
    progressFileId: fileId,
  });
  if (!response?.ok || !response?.data?.url) {
    throw new Error(responseError(response));
  }
  return response.data;
}

function buildReplacement(file, result, settings) {
  const expiresDate = result.expiresAt
    ? new Date(result.expiresAt)
    : new Date(Date.now() + numericSetting(settings, 'expiryDays', DEFAULT_EXPIRY_DAYS, 1, 365) * 86400000);
  // Дата всегда по-русски: блок со ссылкой уходит получателю, а не остаётся в
  // интерфейсе отправителя, и локаль приложения к его языку отношения не имеет.
  // (Прежний `i18n.getLocale?.()` вдобавок был мёртвой веткой — в API есть
  // только геттер `locale`, метода getLocale нет.)
  const expires = new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(expiresDate);
  const values = {
    name: file.name,
    size: formatBytes(file.size),
    url: result.url,
    expires,
  };
  return {
    externalAttachment: true,
    html: renderTemplate(settings.templateHtml || DEFAULT_HTML_TEMPLATE, values, true),
    text: renderTemplate(settings.templateText || DEFAULT_TEXT_TEMPLATE, values, false),
  };
}

export const hooks = {
  async onBeforeBlobUpload(fileId) {
    const file = await pluginApi.upfiles.get(fileId);
    if (!file || typeof file.size !== 'number') return fileId;

    const settings = pluginApi?.plugin?.settings || {};
    const threshold = numericSetting(
      settings,
      'thresholdBytes',
      DEFAULT_THRESHOLD,
      1024 * 1024,
      500 * 1024 * 1024,
    );
    if (file.size <= threshold) return fileId;

    for (;;) {
      pluginApi.toast.info(pluginApi.i18n.t('uploading', { name: file.name }));
      try {
        const result = await upload(file, settings, fileId);
        pluginApi.toast.success(pluginApi.i18n.t('uploaded', { name: file.name }));
        return buildReplacement(file, result, settings);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        pluginApi.toast.error(pluginApi.i18n.t('failed', { name: file.name, error: message }));
        const retry = await pluginApi.ui.confirm({
          title: pluginApi.i18n.t('retry_title'),
          message: pluginApi.i18n.t('retry_message', { name: file.name }),
          confirmLabel: pluginApi.i18n.t('retry'),
          cancelLabel: pluginApi.i18n.t('send_as_attachment'),
        });
        if (!retry) return fileId;
      }
    }
  },
};

export async function activate(api) {
  pluginApi = api;
  api.log.info('bigfile-link activated; Gokapi credentials remain server-side');
}
