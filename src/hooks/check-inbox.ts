#!/usr/bin/env node
// Reads ~/.claude-bridge/inbox.json
// If non-empty, outputs message summaries to stdout (injected into Claude's prompt)
// Then clears the inbox (atomically via rename)

import { readAndClearInbox } from '../mcp/inbox.js';

const entries = readAndClearInbox();
if (entries.length === 0) process.exit(0);

// Output to stdout (this gets injected into Claude Code's prompt)
console.log(`\n[claude-bridge] 收到 ${entries.length} 条消息:`);
for (const entry of entries) {
  console.log(`  - [${entry.type}] ${entry.summary}`);
}
console.log('请优先处理以上 bridge 消息。\n');
