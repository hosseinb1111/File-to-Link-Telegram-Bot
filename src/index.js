import { S3mini } from 's3mini';

// ==========================================
// Constants
// ==========================================
const TG_API = (token, method) => `https://api.telegram.org/bot${token}/${method}`;
const MAX_PART_BYTES = 20 * 1024 * 1024;   // Telegram getFile limit per file
const MAX_TOTAL_BYTES = 100 * 1024 * 1024; // total size of one Telegram multi-part upload
const SESSION_MAX_AGE = 6 * 3600;          // abandoned Telegram uploads are cleaned after 6 hours
const PAGE_SIZE = 8;
const HINT = `🤔 I didn't understand that. Try sending a file to get a link, or type /start.`;
const OWNER_COMMANDS = ['/admin', '/begin', '/done', '/cancel'];

const WEB_CHUNK_BYTES = 16 * 1024 * 1024; // size of each piece the browser sends
const MAX_WEB_PARTS = 128;                // 128 x 16 MB = 2 GB

// ==========================================
// Shared helpers
// ==========================================
function makeS3(env) {
  const endpoint = env.B2_ENDPOINT.replace(/\/$/, '') + '/' + env.B2_BUCKET_NAME;
  return new S3mini({
    accessKeyId: env.B2_KEY_ID,
    secretAccessKey: env.B2_APPLICATION_KEY,
    endpoint: endpoint,
    region: env.B2_REGION || 'us-east-005',
  });
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function isOwner(userId, env) {
  return !!env.OWNER_USER_ID && String(userId) === String(env.OWNER_USER_ID);
}

function defaultTtl(env) {
  return parseInt(env.TTL_SECONDS, 10) || 600;
}

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

function keysOf(row) {
  return row.parts ? JSON.parse(row.parts) : [row.r2_key];
}

// ==========================================
// Telegram helpers
// ==========================================
function tg(env, method, body) {
  return fetch(TG_API(env.TELEGRAM_BOT_TOKEN, method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function sendMessage(chatId, text, env, replyMarkup) {
  const body = { chat_id: chatId, text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  return tg(env, 'sendMessage', body);
}

async function editMessage(chatId, messageId, text, env, replyMarkup) {
  const body = { chat_id: chatId, message_id: messageId, text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  return tg(env, 'editMessageText', body);
}

async function downloadFromTelegram(fileId, env) {
  const fileResp = await tg(env, 'getFile', { file_id: fileId });
  const fileData = await fileResp.json();
  if (!fileData.ok) throw new Error('Could not read file from Telegram.');
  const res = await fetch(
    `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${fileData.result.file_path}`
  );
  if (!res.ok) throw new Error('Failed to download file from Telegram.');
  return res.arrayBuffer();
}

// ==========================================
// Storage and link helpers
// ==========================================
async function storePart(buffer, mimeType, env) {
  const key = `uploads/${crypto.randomUUID()}`;
  await makeS3(env).putObject(key, buffer, mimeType || 'application/octet-stream');
  return key;
}

async function deleteKeys(keys, env) {
  const s3 = makeS3(env);
  for (const key of keys) {
    try {
      await s3.deleteObject(key);
    } catch (err) {
      console.error('B2 delete failed', key, err);
    }
  }
}

async function createLink(chatId, fileName, keys, ttl, env) {
  const token = randomToken();
  await env.DB.prepare(
    `INSERT INTO links (token, r2_key, file_name, chat_id, expires_at, parts)
     VALUES (?, ?, ?, ?, unixepoch() + ?, ?)`
  ).bind(
    token,
    keys[0],
    fileName,
    chatId,
    ttl,
    keys.length > 1 ? JSON.stringify(keys) : null
  ).run();
  return token;
}

async function sendLinkMessage(chatId, token, ttl, env) {
  const link = `${env.BASE_URL}/d/${token}`;
  await sendMessage(chatId, `✅ Link (valid ${Math.floor(ttl / 60)} min):\n${link}`, env, {
    inline_keyboard: [[{ text: '❌ Expire Link Now', callback_data: `expire_${token}` }]],
  });
}

async function expireLink(token, env) {
  const row = await env.DB.prepare(`SELECT r2_key, parts FROM links WHERE token = ?`)
    .bind(token).first();
  if (!row) return false;
  await deleteKeys(keysOf(row), env);
  await env.DB.prepare(`DELETE FROM links WHERE token = ?`).bind(token).run();
  return true;
}

async function discardSession(chatId, env) {
  const { results } = await env.DB.prepare(`SELECT r2_key FROM upload_parts WHERE chat_id = ?`)
    .bind(chatId).all();
  await deleteKeys((results || []).map(r => r.r2_key), env);
  await env.DB.prepare(`DELETE FROM upload_parts WHERE chat_id = ?`).bind(chatId).run();
  await env.DB.prepare(`DELETE FROM upload_sessions WHERE chat_id = ?`).bind(chatId).run();
}

// ==========================================
// Telegram uploads (files up to 20 MB, or /begin ... /done for up to 100 MB)
// ==========================================
async function singleUpload(msg, doc, env) {
  const chatId = msg.chat.id;
  if (doc.file_size && doc.file_size > MAX_PART_BYTES) {
    return sendMessage(
      chatId,
      `❌ This file is over 20 MB. Upload it at ${env.BASE_URL}/upload instead.`,
      env
    );
  }
  const buffer = await downloadFromTelegram(doc.file_id, env);
  const key = await storePart(buffer, doc.mime_type, env);
  const ttl = defaultTtl(env);
  const token = await createLink(chatId, doc.file_name || 'file', [key], ttl, env);
  await sendLinkMessage(chatId, token, ttl, env);
}

async function beginSession(msg, env) {
  const chatId = msg.chat.id;
  const args = (msg.text || '').trim().split(/\s+/).slice(1);

  let minutes = null;
  if (args.length > 1 && /^\d+$/.test(args[args.length - 1])) {
    minutes = parseInt(args.pop(), 10);
  }
  const fileName = args.join(' ').slice(0, 200);
  if (!fileName) {
    return sendMessage(chatId, 'Usage: /begin <file name> [minutes]\nExample: /begin movie.mkv 60', env);
  }

  await discardSession(chatId, env);
  const ttl = minutes ? Math.max(1, minutes) * 60 : defaultTtl(env);
  await env.DB.prepare(
    `INSERT INTO upload_sessions (chat_id, file_name, ttl, created_at) VALUES (?, ?, ?, ?)`
  ).bind(chatId, fileName, ttl, Math.floor(Date.now() / 1000)).run();

  return sendMessage(
    chatId,
    `📦 Started "${fileName}" (up to 100 MB total).\n\n` +
    `Send the parts as files (not photos or videos), one at a time, in order. ` +
    `Each part must be 20 MB or smaller.\n\n` +
    `/done – build the link\n/cancel – discard the upload`,
    env
  );
}

async function addPart(msg, doc, env) {
  const chatId = msg.chat.id;
  if (doc.file_size && doc.file_size > MAX_PART_BYTES) {
    return sendMessage(chatId, '❌ This part is over 20 MB. Split the file into smaller parts and send again.', env);
  }

  const { total } = await env.DB.prepare(
    `SELECT COALESCE(SUM(size), 0) AS total FROM upload_parts WHERE chat_id = ?`
  ).bind(chatId).first();

  if (total + (doc.file_size || 0) > MAX_TOTAL_BYTES) {
    return sendMessage(
      chatId,
      `❌ That would go over 100 MB total (${mb(total)} MB so far). Send /done to finish or /cancel.`,
      env
    );
  }

  const buffer = await downloadFromTelegram(doc.file_id, env);
  const key = await storePart(buffer, doc.mime_type, env);

  // message_id increases in the order the parts were sent, so it keeps them in order.
  await env.DB.prepare(
    `INSERT INTO upload_parts (chat_id, seq, r2_key, size) VALUES (?, ?, ?, ?)`
  ).bind(chatId, msg.message_id, key, buffer.byteLength).run();

  const stats = await env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS total FROM upload_parts WHERE chat_id = ?`
  ).bind(chatId).first();

  return sendMessage(
    chatId,
    `✅ Part ${stats.n} received (${mb(buffer.byteLength)} MB). Total ${mb(stats.total)} / 100 MB.\n` +
    `Send the next part, or /done.`,
    env
  );
}

async function finishSession(chatId, env) {
  const session = await env.DB.prepare(`SELECT file_name, ttl FROM upload_sessions WHERE chat_id = ?`)
    .bind(chatId).first();
  if (!session) {
    return sendMessage(chatId, 'No upload in progress. Start one with /begin <file name>.', env);
  }

  const { results } = await env.DB.prepare(
    `SELECT r2_key FROM upload_parts WHERE chat_id = ? ORDER BY seq`
  ).bind(chatId).all();
  if (!results || results.length === 0) {
    return sendMessage(chatId, 'No parts received yet. Send the file parts first, then /done.', env);
  }

  const keys = results.map(r => r.r2_key);
  const token = await createLink(chatId, session.file_name, keys, session.ttl, env);
  await env.DB.prepare(`DELETE FROM upload_parts WHERE chat_id = ?`).bind(chatId).run();
  await env.DB.prepare(`DELETE FROM upload_sessions WHERE chat_id = ?`).bind(chatId).run();
  await sendLinkMessage(chatId, token, session.ttl, env);
}

// ==========================================
// Admin panel (inside the bot)
// ==========================================
async function renderAdmin(env, page) {
  const now = Math.floor(Date.now() / 1000);
  const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM links WHERE expires_at > ?`)
    .bind(now).first();
  const total = count?.n || 0;
  if (!total) return { text: '📂 No active links.', markup: null };

  const pages = Math.ceil(total / PAGE_SIZE);
  const p = Math.min(Math.max(0, page), pages - 1);

  const { results } = await env.DB.prepare(
    `SELECT token, file_name, expires_at FROM links
     WHERE expires_at > ? ORDER BY expires_at ASC LIMIT ? OFFSET ?`
  ).bind(now, PAGE_SIZE, p * PAGE_SIZE).all();

  let text = `🛠 Active links: ${total} (page ${p + 1}/${pages})\n`;
  const rows = [];
  results.forEach((r, i) => {
    const n = p * PAGE_SIZE + i + 1;
    const mins = Math.max(0, Math.round((r.expires_at - now) / 60));
    const name = r.file_name.length > 40 ? r.file_name.slice(0, 37) + '...' : r.file_name;
    text += `\n${n}. ${name} · ${mins} min left\n${env.BASE_URL}/d/${r.token}\n`;
    rows.push([{ text: `❌ Expire #${n}`, callback_data: `aexp:${p}:${r.token}` }]);
  });

  const nav = [];
  if (p > 0) nav.push({ text: '⬅️ Prev', callback_data: `apage:${p - 1}` });
  if (p < pages - 1) nav.push({ text: 'Next ➡️', callback_data: `apage:${p + 1}` });
  if (nav.length) rows.push(nav);

  return { text, markup: { inline_keyboard: rows } };
}

async function showAdmin(chatId, messageId, page, env) {
  const { text, markup } = await renderAdmin(env, page);
  if (messageId) return editMessage(chatId, messageId, text, env, markup);
  return sendMessage(chatId, text, env, markup);
}

async function handleCallback(cb, env) {
  // Stop the loading spinner on the button.
  tg(env, 'answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});

  if (!isOwner(cb.from?.id, env)) return;

  const chatId = cb.message.chat.id;
  const messageId = cb.message.message_id;
  const data = cb.data || '';

  if (data.startsWith('expire_')) {
    const token = data.slice('expire_'.length);
    const ok = await expireLink(token, env);
    return editMessage(
      chatId,
      messageId,
      ok ? '❌ This link has been expired and the file deleted.' : 'ℹ️ This link was already expired.',
      env
    );
  }

  if (data.startsWith('aexp:')) {
    const [, page, token] = data.split(':');
    await expireLink(token, env);
    return showAdmin(chatId, messageId, Number(page), env);
  }

  if (data.startsWith('apage:')) {
    return showAdmin(chatId, messageId, Number(data.slice('apage:'.length)), env);
  }
}

// ==========================================
// Web uploader (/upload, up to 2 GB, split and joined automatically)
// ==========================================
function unauthorized() {
  return new Response('Login required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="uploader"' },
  });
}

function authorized(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const h = request.headers.get('Authorization') || '';
  if (!h.startsWith('Basic ')) return false;
  let decoded;
  try { decoded = atob(h.slice(6)); } catch { return false; }
  const password = decoded.slice(decoded.indexOf(':') + 1);
  return password === env.ADMIN_PASSWORD;
}

function isUploadId(id) {
  return /^[A-Za-z0-9-]{16,64}$/.test(id || '');
}

function partKey(id, n) {
  return `uploads/${id}/${String(n).padStart(4, '0')}`;
}

function uploaderPage() {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Uploader</title>
<style>
body{font-family:system-ui,sans-serif;background:#f5f5f7;color:#1d1d1f;margin:0;padding:40px 16px}
.card{max-width:640px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-size:22px;margin:0 0 12px}
button{padding:10px 16px;border:0;border-radius:8px;background:#1d1d1f;color:#fff;font-size:15px;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
input{font-size:15px}
#status{margin-top:14px;color:#555;white-space:pre-wrap}
#link{word-break:break-all;margin-top:12px}
.bar{height:8px;background:#eee;border-radius:4px;overflow:hidden;margin-top:12px;display:none}
.bar>div{height:100%;width:0;background:#1d1d1f;transition:width .2s}
</style></head>
<body><div class="card">
<h1>Upload a file (up to 2 GB)</h1>
<p>The file is split into pieces in your browser and joined back when someone downloads it. Keep this tab open until it finishes.</p>
<input type="file" id="file"><br><br>
<label>Valid for <input type="number" id="minutes" value="60" min="1" max="10080" style="width:90px"> minutes</label><br><br>
<button id="go">Upload and get link</button>
<div class="bar" id="bar"><div id="fill"></div></div>
<div id="status"></div>
<div id="link"></div>
</div>
<script>
const CHUNK = ${WEB_CHUNK_BYTES};
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sendPart(id, n, blob) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch('/upload/chunk?id=' + id + '&n=' + n, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: blob
      });
      if (res.ok) return;
    } catch (e) {}
    if (attempt < 4) await sleep(1000 * attempt);
  }
  throw new Error('part ' + (n + 1) + ' failed after 4 tries');
}

$('go').onclick = async () => {
  const file = $('file').files[0];
  if (!file) { $('status').textContent = 'Choose a file first.'; return; }
  if (file.size === 0) { $('status').textContent = 'That file is empty.'; return; }
  if (file.size > 2 * 1024 * 1024 * 1024) { $('status').textContent = 'Files over 2 GB are not supported.'; return; }

  const minutes = Math.min(10080, Math.max(1, parseInt($('minutes').value, 10) || 60));
  const id = crypto.randomUUID();
  const count = Math.ceil(file.size / CHUNK);

  $('go').disabled = true;
  $('link').textContent = '';
  $('bar').style.display = 'block';
  try {
    for (let n = 0; n < count; n++) {
      $('status').textContent = 'Uploading part ' + (n + 1) + ' of ' + count + '… keep this tab open.';
      $('fill').style.width = ((n / count) * 100) + '%';
      await sendPart(id, n, file.slice(n * CHUNK, (n + 1) * CHUNK));
    }
    $('status').textContent = 'Building link…';
    const res = await fetch('/upload/finish?id=' + id + '&count=' + count +
      '&ttl=' + (minutes * 60) + '&name=' + encodeURIComponent(file.name), { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'finish failed (' + res.status + ')');
    $('fill').style.width = '100%';
    $('status').textContent = 'Done.';
    const a = document.createElement('a');
    a.href = data.link;
    a.textContent = data.link;
    $('link').appendChild(a);
  } catch (e) {
    $('status').textContent = 'Upload failed: ' + e.message;
  } finally {
    $('go').disabled = false;
  }
};
</script>
</body></html>`;
}

async function handleChunk(request, url, env) {
  const id = url.searchParams.get('id');
  const n = parseInt(url.searchParams.get('n'), 10);
  if (!isUploadId(id) || !(n >= 0 && n < MAX_WEB_PARTS)) {
    return Response.json({ error: 'bad part' }, { status: 400 });
  }
  if (Number(request.headers.get('Content-Length') || 0) > WEB_CHUNK_BYTES) {
    return Response.json({ error: 'part too large' }, { status: 413 });
  }
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength === 0 || buffer.byteLength > WEB_CHUNK_BYTES) {
    return Response.json({ error: 'bad part size' }, { status: 400 });
  }
  await makeS3(env).putObject(partKey(id, n), buffer, 'application/octet-stream');
  return Response.json({ ok: true });
}

async function handleFinish(url, env) {
  const id = url.searchParams.get('id');
  const count = parseInt(url.searchParams.get('count'), 10);
  const ttl = Math.min(10080 * 60, Math.max(60, parseInt(url.searchParams.get('ttl'), 10) || 3600));
  const name = (url.searchParams.get('name') || 'file').slice(0, 200);
  if (!isUploadId(id) || !(count >= 1 && count <= MAX_WEB_PARTS)) {
    return Response.json({ error: 'bad upload' }, { status: 400 });
  }
  const keys = Array.from({ length: count }, (_, i) => partKey(id, i));
  const token = await createLink(0, name, keys, ttl, env);
  return Response.json({ ok: true, link: `${env.BASE_URL}/d/${token}` });
}

// ==========================================
// Update routing (Telegram)
// ==========================================
async function handleUpdate(update, env) {
  if (update.callback_query) return handleCallback(update.callback_query, env);

  const msg = update.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const owner = isOwner(msg.from?.id, env);
  const doc = msg.document || msg.video || msg.audio || msg.voice;

  if (doc) {
    if (!owner) return;
    const open = await env.DB.prepare(`SELECT chat_id FROM upload_sessions WHERE chat_id = ?`)
      .bind(chatId).first();
    return open ? addPart(msg, doc, env) : singleUpload(msg, doc, env);
  }

  const text = (msg.text || '').trim();
  const cmd = text.split(/\s+/)[0].split('@')[0].toLowerCase();

  if (cmd === '/start') {
    return sendMessage(
      chatId,
      `👋 Welcome to your File-to-Link bot!\n\nSend me a file (up to 20 MB) and I will give you a download link.\n\nFor bigger files, use the uploader at ${env.BASE_URL}/upload`,
      env
    );
  }

  if (owner && OWNER_COMMANDS.includes(cmd)) {
    if (cmd === '/admin') return showAdmin(chatId, null, 0, env);
    if (cmd === '/begin') return beginSession(msg, env);
    if (cmd === '/done') return finishSession(chatId, env);
    if (cmd === '/cancel') {
      await discardSession(chatId, env);
      return sendMessage(chatId, 'Upload cancelled and any received parts were deleted.', env);
    }
  }

  return sendMessage(chatId, HINT, env);
}

// ==========================================
// Downloads (reassembles multi-part files on the fly)
// ==========================================
// Streams the parts one after another, so the browser receives one complete file.
function concatParts(s3, keys) {
  let index = 0;
  let reader = null;
  return new ReadableStream({
    async pull(controller) {
      while (true) {
        if (!reader) {
          if (index >= keys.length) {
            controller.close();
            return;
          }
          const obj = await s3.getObjectResponse(keys[index++]);
          if (!obj) {
            controller.error(new Error('Missing part'));
            return;
          }
          reader = obj.body.getReader();
        }
        const { done, value } = await reader.read();
        if (done) {
          reader = null;
          continue;
        }
        controller.enqueue(value);
        return;
      }
    },
    cancel() {
      if (reader) reader.cancel();
    },
  });
}

async function handleDownload(token, env) {
  const row = await env.DB.prepare(
    `SELECT r2_key, file_name, expires_at, parts FROM links WHERE token = ?`
  ).bind(token).first();

  if (!row) return new Response('Link not found or expired.', { status: 404 });
  if (Math.floor(Date.now() / 1000) > row.expires_at) {
    return new Response('Link expired.', { status: 410 });
  }

  const keys = keysOf(row);
  const s3 = makeS3(env);
  const headers = new Headers();
  headers.set('Content-Disposition', `attachment; filename="${encodeURIComponent(row.file_name)}"`);

  if (keys.length === 1) {
    const obj = await s3.getObjectResponse(keys[0]);
    if (!obj) return new Response('File missing.', { status: 404 });
    headers.set('Content-Type', obj.headers.get('content-type') || 'application/octet-stream');
    return new Response(obj.body, { headers });
  }

  // Check that every part exists before the response starts.
  for (const key of keys) {
    if (!(await s3.objectExists(key))) return new Response('File missing.', { status: 404 });
  }
  headers.set('Content-Type', 'application/octet-stream');
  return new Response(concatParts(s3, keys), { headers });
}

// ==========================================
// Entry point
// ==========================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/') {
      return new Response('Bot is running!', { status: 200 });
    }

    if (url.pathname.startsWith('/d/')) {
      return handleDownload(url.pathname.slice(3), env);
    }

    if (url.pathname === '/upload' || url.pathname.startsWith('/upload/')) {
      if (!authorized(request, env)) return unauthorized();
      try {
        if (url.pathname === '/upload' && request.method === 'GET') {
          return new Response(uploaderPage(), {
            headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
          });
        }
        if (url.pathname === '/upload/chunk' && request.method === 'POST') {
          return await handleChunk(request, url, env);
        }
        if (url.pathname === '/upload/finish' && request.method === 'POST') {
          return await handleFinish(url, env);
        }
      } catch (err) {
        console.error(err);
        return Response.json({ error: 'server error' }, { status: 500 });
      }
      return new Response('not found', { status: 404 });
    }

    if (url.pathname === '/webhook' && request.method === 'POST') {
      const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
      if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }

      let update;
      try {
        update = await request.json();
      } catch {
        return new Response('bad request', { status: 400 });
      }

      try {
        await handleUpdate(update, env);
      } catch (err) {
        console.error(err);
        const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
        if (chatId) await sendMessage(chatId, `❌ Bot Error:\n${err.message}`, env);
      }
      return new Response('ok');
    }

    return new Response('not found', { status: 404 });
  },

  async scheduled(_event, env, ctx) {
    const now = Math.floor(Date.now() / 1000);

    ctx.waitUntil((async () => {
      const { results: expired } = await env.DB.prepare(
        `SELECT r2_key, parts FROM links WHERE expires_at < ?`
      ).bind(now).all();
      for (const row of expired || []) {
        await deleteKeys(keysOf(row), env);
      }
      await env.DB.prepare(`DELETE FROM links WHERE expires_at < ?`).bind(now).run();

      const { results: stale } = await env.DB.prepare(
        `SELECT chat_id FROM upload_sessions WHERE created_at < ?`
      ).bind(now - SESSION_MAX_AGE).all();
      for (const s of stale || []) {
        await discardSession(s.chat_id, env);
      }
    })());
  },
};
