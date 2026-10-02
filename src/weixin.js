import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import metadata from '../package.json' with { type: 'json' };

export const API_BASE = 'https://ilinkai.weixin.qq.com';
export function trustedBase(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !(url.hostname === 'ilinkai.weixin.qq.com' || url.hostname.endsWith('.ilinkai.weixin.qq.com')) ||
      url.search || url.hash || url.pathname !== '/') throw new Error('微信返回的 API 地址不在 iLink 信任域内。');
  return url.origin;
}
export class ApiError extends Error {
  constructor(code, operation) { super(`微信接口 ${operation} 失败（${code}）。`); this.code = code; }
}
export class WeixinAPI {
  constructor(credentials = {}, fetchImpl = fetch) {
    this.credentials = credentials;
    this.base = trustedBase(credentials.apiBaseUrl || API_BASE);
    this.fetch = fetchImpl;
  }
  async request(endpoint, { payload, query, signal, timeout = 45000 } = {}) {
    const url = new URL(`${this.base}/ilink/bot/${endpoint}`);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
    const headers = { 'iLink-App-ClientVersion': '1' };
    let body;
    if (payload) {
      body = JSON.stringify({ ...payload, base_info: { channel_version: `wedot-${metadata.version}` } });
      Object.assign(headers, {
        'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
        'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'),
        Authorization: `Bearer ${this.credentials.botToken}`,
      });
    }
    const combined = AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]);
    const response = await this.fetch(url, { method: body ? 'POST' : 'GET', headers, body, signal: combined, redirect: 'error' });
    if (!response.ok) throw new ApiError(response.status, endpoint);
    const result = await response.json();
    if (result.ret || result.errcode) throw new ApiError(result.errcode || result.ret, endpoint);
    return result;
  }
  qr() { return this.request('get_bot_qrcode', { query: { bot_type: '3' }, timeout: 15000 }); }
  qrStatus(qrcode, signal) {
    return this.request('get_qrcode_status', { query: { qrcode }, signal, timeout: 35000 });
  }
  updates(cursor, signal, pollMs = 35000) {
    return this.request('getupdates', { payload: { get_updates_buf: cursor }, signal, timeout: Math.min(65000, Math.max(1000, pollMs)) + 10000 });
  }
  async send(message, text, signal) {
    for (const chunk of chunkText(text)) {
      await this.request('sendmessage', { signal, timeout: 15000, payload: { msg: {
        from_user_id: '', to_user_id: message.senderId, client_id: `codex-${randomUUID()}`,
        message_type: 2, message_state: 2, context_token: message.contextToken,
        item_list: [{ type: 1, text_item: { text: chunk } }],
      } } });
      await delay(300, undefined, { signal });
    }
  }
}
export function chunkText(text, maxBytes = 3800) {
  if (!Number.isInteger(maxBytes) || maxBytes < 4) throw new Error('Invalid text chunk size');
  const chunks = []; let part = ''; let bytes = 0;
  for (const char of String(text)) {
    const n = Buffer.byteLength(char);
    if (bytes + n > maxBytes) { chunks.push(part); part = ''; bytes = 0; }
    part += char; bytes += n;
  }
  if (part) chunks.push(part);
  return chunks;
}
export function normalize(raw, credentials) {
  // Only the user who confirmed QR login may operate this assistant.
  if (!credentials.userId || raw.from_user_id !== credentials.userId || raw.message_type !== 1 ||
      (raw.message_state != null && raw.message_state !== 2) || !raw.context_token || !Array.isArray(raw.item_list)) return null;
  const text = raw.item_list.filter(Boolean).map(item =>
    item.type === 1 ? item.text_item?.text : item.type === 3 ? item.voice_item?.text : ''
  ).filter(value => typeof value === 'string' && value).join('\n');
  const unsupported = raw.item_list.some(item => item && (item.type === 2 || item.type === 4 || item.type === 5 || item.type === 3 && !item.voice_item?.text));
  if (!text.trim() && !unsupported) return null;
  const identity = raw.message_id ?? raw.seq;
  if (identity == null) return null;
  const key = JSON.stringify([credentials.accountId, raw.from_user_id, raw.session_id || 'default']);
  return {
    id: createHash('sha256').update(JSON.stringify([key, String(identity)])).digest('hex'),
    senderId: raw.from_user_id, contextToken: raw.context_token,
    text, unsupported,
  };
}
