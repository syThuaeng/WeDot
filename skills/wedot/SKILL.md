---
name: wedot
description: 连接、启动、停止或检查 WeDot（微信助理桥接插件），把扫码本人的消息转交现有 Codex Dot，并同步 Dot 的新增 ChatGPT 文字回复。用户要求微信连接 Dot、扫码绑定微信或检查此桥接时使用；不适用于企业微信或独立 Codex 会话。
---

# WeDot

This local plugin connects ordinary WeChat iLink messages to the user's existing Dot. It provides a CLI and background relay, not a separate assistant or an independent Codex App Server.

Resolve `../../dist/cli.js` relative to this SKILL.md to an absolute path. Run it with Node.js 22.12+ using the current shell's proper path quoting.

## Commands

- `connect-dot --name NAME`: while stopped, match the requested name against the current primary Dot's desktop profile and verify its main thread. Use the Dot chosen by the user, not an ordinary task created by that Dot.
- `doctor`: read-only verification of desktop tools and the bound Dot; does not run a model turn or send a message.
- `login`: start the hidden QR worker. Display only its returned `qrPath` as a local Markdown image and ask the user to scan and confirm. Never read or display the private state file or raw authentication response.
- `status`: show sanitized binding, process, Dot, queue and recent transfer status. During QR login poll no more often than once every 10 seconds.
- `start`: start the hidden relay once Dot selection and owner QR binding are confirmed.
- `stop`: stop only this plugin and its owned helper, never the shared Dot. Verify `running: false` before claiming it stopped.
- `logout`: after stopping, remove local WeChat credentials. This does not revoke authorization on the phone.
- `help` / `version`: inspect available commands or version without connecting.

## Setup

For a new connection, run `connect-dot --name NAME`, `doctor`, `login`, then `status` and `start` after scanning. The user's request to connect authorizes these steps; do not ask repeatedly for permission. If the Dot name is unknown, ask which Dot to connect.

For an existing connection, preserve credentials and history. Run `status`; stop before changing the target. Reuse the confirmed binding rather than asking the owner to scan again. An old independent Codex configuration needs an explicit `connect-dot` selection; it must not silently fall back or create a conversation.

Ask the owner to send a new WeChat message to establish the return context. Verify `lastForwardAt` and `lastReplyAt`; do not claim end-to-end success before actual delivery. A status-only request authorizes only status inspection.

The request to synchronize authorizes forwarding messages from the QR-bound owner to the selected Dot and returning that Dot's new user-facing ChatGPT text to the same owner. It does not authorize sending to other contacts or unrelated tasks.

## Behavior and boundaries

The relay uses Codex's bundled app-tools MCP service. Start it from the actual Codex desktop task environment. Never fabricate caller IDs, pipe paths or auth tokens, use another task's identity, or import WorkBuddy credentials. Keep the desktop app running and the computer awake. After restarting Codex, run `stop` and `start` from a Codex conversation to inherit its current connection.

The Dot keeps its existing identity, memory, model and permissions. The plugin only mirrors completed `user_message.send_message` calls to `chatgpt`; internal analysis, tool logs, final `done`, and other channels are excluded. Desktop-origin and proactive Dot replies are included. Initial connection seeds a baseline instead of forwarding old history.

WeChat input reaches the Dot as a forwarded request, not a native user bubble in its messaging room. Desktop user input bubbles themselves are not copied. Describe this as text forwarding, not an identical transcript or a native official WeChat channel.

Text and voice already transcribed by WeChat are supported. All slash commands are handled locally and never forwarded to the Dot. `/status` reports relay health and queues; `/help` lists capabilities. `/new`, `/clear`, and `/清空` explain that Dot memory is preserved without resetting or stopping anything. Unknown commands, including `/stop`, `/restart`, `/login`, and `/logout`, return local guidance to manage WeDot from Codex. Commands accept case/full-width variants and no arguments. No switching to ordinary Codex chats, images/files, live calls, remote approvals, or automatic startup is implemented.

Command replies and Dot replies share one serialized sender. During temporary desktop tool failures, the bridge retries read-only access, keeps local commands available, and queues ordinary messages. For missing replies, inspect sanitized `workerVersion`, `lastReceiveAt`, `lastCommandAt`, `lastCommandReplyAt`, `lastSendError`, `dotConnection`, and `lastPollAt`. Do not equate a completed or idle Dot turn with a stopped relay, or claim a particular cause without evidence.

If login or desktop access fails, use sanitized status diagnostics. Report the limitation rather than bypassing controls or connecting a different backend. For compatibility with existing logins and process locks, runtime data remains under `~/.codex-wechat-assistant`; use `CODEX_WECHAT_DATA` only for an explicitly chosen separate instance. Usage instructions and limitations are in README.md.
