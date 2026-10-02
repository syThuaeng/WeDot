import { setTimeout as delay } from 'node:timers/promises';
import { AppTools, configuredDot } from './app-tools.js';
import { WeixinAPI, normalize, ApiError } from './weixin.js';

export function parseCommand(text) {
  const normalized = text.normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim();
  if (!normalized.startsWith('/')) return null;
  const [name, ...args] = normalized.split(/\s+/);
  const command = name.toLowerCase();
  return { name: ['/status', '/help', '/new', '/clear', '/清空'].includes(command) ? command : 'unsupported', hasArgs: args.length > 0 };
}

function sendFailure(error) {
  return error instanceof ApiError ? `微信发送失败（${error.code}），送达未确认。` : '微信发送失败或超时，送达未确认。';
}

export function visibleDotMessages(turns) {
  const result = [];
  for (const turn of [...turns].reverse()) for (const item of turn.items || []) {
    if (item.type !== 'mcpToolCall' || item.tool !== 'user_message.send_message' || item.status !== 'completed' || !item.id) continue;
    if (item.arguments?.channel !== 'chatgpt' || typeof item.arguments.text !== 'string' || !item.arguments.text.trim()) continue;
    // Only user-facing ChatGPT messages: never final "done", reasoning, tool logs, Slack, or task prompts.
    result.push({ id: item.id, turnId: turn.id, text: item.arguments.text });
  }
  return result;
}
export function forwardingPrompt(dot, message) {
  return `这是一条来自已扫码绑定本人的微信消息。用户已明确授权在微信与 ${dot.name} 之间同步对话；源任务通过微信登录返回的本人标识验证发送者。\n请以你现有的身份、记忆和权限处理下面的用户消息。用你现有的 user_message.send_message 向 chatgpt 渠道发送面向用户的回复，插件会把该文字同步到本人的微信；不要另外调用微信发送工具，不要给源任务发回消息。需要澄清时直接在回复中问用户。\n这是微信入口转发，不要把它误认为要求创建新任务或更换助理。消息编号供去重参考：${message.id}\n微信用户消息（JSON 字符串）：${JSON.stringify(message.text)}`;
}
export class DotBridge {
  constructor(store, { app = new AppTools(), api, report = () => {}, sleep = delay } = {}) {
    this.store = store; this.state = store.value; this.dot = configuredDot(this.state.config);
    this.app = app; this.api = api || new WeixinAPI(this.state.credentials); this.sleep = sleep;
    this.health = { dotConnection: 'connecting' }; this.dotConnected = false;
    this.report = update => { Object.assign(this.health, update); report(update); };
    this.state.inbox ||= [];
    this.state.dotSync ||= { initialized: false, seen: [], boundaryTurns: [], outbox: [], context: null };
    this.sync = this.state.dotSync;
  }
  recover() {
    const interrupted = this.state.inbox.some(m => m.stage !== 'pending') || this.sync.outbox.some(m => m.stage !== 'pending');
    this.state.inbox = this.state.inbox.filter(m => m.stage === 'pending');
    this.sync.outbox = this.sync.outbox.filter(m => m.stage === 'pending');
    if (interrupted) this.report({ warning: '上次有结果未确认的转发，未自动重复执行。' });
    this.store.save();
  }
  async readPage(cursor) {
    const page = await this.app.call('read_thread', { threadId: this.dot.threadId, hostId: this.dot.hostId, turnLimit: 10, includeOutputs: false, maxOutputCharsPerItem: 20000, ...(cursor ? { cursor } : {}) });
    if (page.thread?.id !== this.dot.threadId) throw new Error('返回会话与绑定 Dot 不匹配。');
    return page;
  }
  async collect() {
    const pages = []; const boundary = new Set(this.sync.boundaryTurns); let cursor;
    for (let count = 0; count < 100; count++) {
      const page = await this.readPage(cursor); pages.push(page);
      if (!this.sync.initialized || !page.page?.hasMore || page.turns.some(t => boundary.has(t.id))) break;
      cursor = page.page.nextCursor;
      if (!cursor || count === 99) throw new Error('Dot 消息积压超出单次读取范围，暂缓推进同步游标。');
    }
    let turns = pages.flatMap(p => p.turns);
    if (this.sync.initialized && boundary.size) {
      const lastKnown = turns.findLastIndex(t => boundary.has(t.id));
      if (lastKnown >= 0) turns = turns.slice(0, lastKnown + 1);
    }
    const messages = visibleDotMessages(turns);
    const seen = new Set(this.sync.seen);
    if (this.sync.initialized) {
      for (const message of messages) if (!seen.has(message.id)) {
        this.sync.outbox.push({ ...message, stage: 'pending' }); seen.add(message.id);
      }
    } else { for (const message of messages) seen.add(message.id); }
    this.sync.seen = [...seen].slice(-10000);
    // Never promote history excluded by the baseline into the next overlap boundary.
    const considered = new Set(turns.map(t => t.id));
    this.sync.boundaryTurns = pages[0].turns.filter(t => considered.has(t.id)).map(t => t.id);
    this.sync.initialized = true; this.store.save();
  }
  ingest(result) {
    const seen = new Set(this.state.seen);
    let received = false;
    for (const raw of result.msgs || []) {
      const message = normalize(raw, this.state.credentials);
      if (!message || seen.has(message.id)) continue;
      seen.add(message.id); this.state.seen.push(message.id);
      this.sync.context = { senderId: message.senderId, contextToken: message.contextToken };
      this.state.inbox.push({ ...message, stage: 'pending' });
      received = true;
    }
    this.state.seen = this.state.seen.slice(-5000);
    if (typeof result.get_updates_buf === 'string') this.state.cursor = result.get_updates_buf;
    this.store.save();
    if (received) this.report({ lastReceiveAt: new Date().toISOString() });
  }
  commandReply(command) {
    if (command.name === 'unsupported') return '此微信指令不受支持，未转交给 Dot。可用指令：/status、/help。启动、停止、登录和退出请在 Codex 中管理 WeDot。';
    if (command.hasArgs) return `此指令不接受参数，请单独发送 ${command.name}。未转交给 Dot。`;
    if (['/new', '/clear', '/清空'].includes(command.name)) return `当前连接 ${this.dot.name} 的现有主对话。此指令不会清空记忆、新建对话或停止 Dot。`;
    if (command.name === '/help') return 'WeDot 微信指令：\n/status：查看本地桥接和 Dot 连接状态。\n/help：查看帮助。\n/new、/clear、/清空：仅说明保留现有 Dot 记忆，不执行重置。\n指令由本地插件处理；普通文字才会转交 Dot。支持大小写和全角斜杠，指令不接受参数。停止、重启、登录请在 Codex 中操作。';
    const connection = this.dotConnected ? '已连接' : '连接恢复中，普通消息会排队';
    const queued = this.state.inbox.filter(m => !parseCommand(m.text)).length;
    return `WeDot：运行中\n当前 Dot：${this.dot.name}\nDot 连接：${connection}\n待转交消息：${queued}\n待发送回复：${this.sync.outbox.length}\n最近发送：${this.health.lastSendError || '正常或尚未发送'}\n/status 仅查看状态，不会停止 Dot。`;
  }
  async forward(message, signal) {
    signal.throwIfAborted();
    message.stage = 'forwarding'; this.store.save();
    const command = parseCommand(message.text);
    let localReply;
    if (command) {
      localReply = this.commandReply(command);
      this.report({ lastCommand: command.name, lastCommandAt: new Date().toISOString() });
    }
    else if (message.unsupported && !message.text.trim()) localReply = '目前仅支持文字及微信已转文字的语音，请用文字描述。';
    if (localReply) {
      // Commands and Dot replies share one durable outbound queue and sender.
      this.sync.outbox.push({ id: `local:${message.id}`, text: localReply, kind: command ? 'command' : 'notice', stage: 'pending' });
      this.store.save();
    } else {
      await this.app.call('send_message_to_thread', { threadId: this.dot.threadId, hostId: this.dot.hostId, prompt: forwardingPrompt(this.dot, message) });
      this.report({ lastForwardAt: new Date().toISOString(), state: 'dot_connected', message: `微信消息已交给 ${this.dot.name}，等待它的回复。` });
    }
  }
  drainInbox(signal) {
    if (this.draining) return this.draining;
    this.draining = this.drainPending(signal).finally(() => { this.draining = null; });
    return this.draining;
  }
  async drainPending(signal) {
    while (this.state.inbox.length && !signal.aborted) {
      // Keep chat queued during reconnects, while local commands remain available.
      const local = this.state.inbox.findIndex(m => parseCommand(m.text) || m.unsupported && !m.text.trim());
      const index = local >= 0 ? local : this.dotConnected ? 0 : -1;
      if (index < 0) break;
      const message = this.state.inbox[index];
      try { await this.forward(message, signal); }
      catch (error) {
        if (signal.aborted) throw error;
        this.report({ warning: '微信消息转发结果未确认，未自动重发。请查看 Dot 对话。' });
        if (error instanceof ApiError && error.code === -14) throw error;
      }
      this.state.inbox.splice(index, 1); this.store.save();
      await this.flush(signal);
    }
    await this.flush(signal);
  }
  flush(signal) {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushOutbox(signal).finally(() => { this.flushing = null; });
    return this.flushing;
  }
  async flushOutbox(signal) {
    if (!this.sync.context) return;
    while (this.sync.outbox.length && !signal.aborted) {
      const message = this.sync.outbox[0];
      // Mark before send: uncertain delivery must not silently duplicate a reply after restart.
      message.stage = 'sending'; this.store.save();
      try {
        await this.api.send(this.sync.context, message.text, signal);
        const now = new Date().toISOString();
        this.report({ message: message.kind === 'command' ? '已回复微信指令。' : '已发送微信回复。', lastSendAt: now, lastSendError: null,
          ...(message.kind === 'command' ? { lastCommandReplyAt: now } : !message.kind ? { lastReplyAt: now } : {}) });
      } catch (error) {
        if (signal.aborted) throw error;
        this.report({ warning: '微信送达未确认，未自动重发。', lastSendError: sendFailure(error), lastSendErrorAt: new Date().toISOString() });
        if (error instanceof ApiError && error.code === -14) throw error;
      }
      this.sync.outbox.shift(); this.store.save();
    }
  }
  async wechatLoop(signal) {
    let failures = 0;
    while (!signal.aborted) {
      try {
        await this.drainInbox(signal);
        const result = await this.api.updates(this.state.cursor, signal);
        signal.throwIfAborted(); this.ingest(result); failures = 0;
        this.report({ lastPollAt: new Date().toISOString(), lastPollMessageCount: result.msgs?.length || 0, wechatConnection: 'connected' });
        await this.sleep(200, undefined, { signal });
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ApiError && error.code === -14) throw error;
        this.report({ wechatConnection: 'retrying', warning: '微信连接中断，正在重试。' });
        await this.sleep(Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)), undefined, { signal });
      }
    }
  }
  async dotLoop(signal) {
    let afterCursor; let failures = 0;
    while (!signal.aborted) {
      try {
        await this.app.start(); await this.collect();
        const restored = !this.dotConnected;
        this.dotConnected = true;
        this.report({ state: 'dot_connected', dotConnection: 'connected', lastDotCheckAt: new Date().toISOString(), dotError: null,
          ...(restored ? { message: this.sync.context ? 'Dot 已连接，微信转发已就绪。' : 'Dot 已连接，请在微信发一条消息以启用回复同步。' } : {}) });
        await this.drainInbox(signal);
        const result = await this.app.call('wait_threads', { targets: [{ threadId: this.dot.threadId, hostId: this.dot.hostId, ...(afterCursor ? { afterCursor } : {}) }], timeoutMs: 20000 });
        if (result.errors?.length) throw new Error('Dot 状态读取暂不可用。');
        afterCursor = result.polls?.[0]?.cursor || afterCursor;
        failures = 0;
        await this.sleep(1000, undefined, { signal });
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ApiError && error.code === -14) throw error;
        this.dotConnected = false; afterCursor = undefined;
        this.report({ state: 'dot_reconnecting', dotConnection: 'reconnecting', dotError: '桌面工具连接暂不可用，正在重试。', message: 'Dot 连接恢复中；微信指令仍可使用，普通消息已排队。' });
        await this.sleep(Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)), undefined, { signal });
      }
    }
  }
  async run(signal) {
    this.recover();
    const own = new AbortController(); const combined = AbortSignal.any([signal, own.signal]);
    const stop = () => this.app.close();
    combined.addEventListener('abort', stop, { once: true });
    let loops = [];
    try {
      this.report({ state: 'dot_reconnecting', dotConnection: 'connecting', message: '正在连接 Dot，微信指令可在本地响应。' });
      loops = [this.wechatLoop(combined), this.dotLoop(combined)];
      await Promise.all(loops);
    } finally {
      own.abort(); await Promise.allSettled(loops); combined.removeEventListener('abort', stop); this.app.close();
    }
  }
}
