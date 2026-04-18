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
  const sender = entry.fromName ? `${entry.fromName}` : entry.from;
  console.log(`  - [${entry.type}] From ${sender}: ${entry.summary}`);
}
console.log('');
console.log('处理流程:');
console.log('1. 使用 Agent 工具派遣子代理(subagent)读取消息: 子代理调用 bridge_read 读取完整内容，');
console.log('   然后调用 bridge_draft_reply 为每条需要回复的消息起草回复，将草稿返回给主代理。');
console.log('2. 主代理将草稿展示给人类用户，由用户确认或修改回复内容，以及是否抄送(CC)给其他 peer。');
console.log('3. 用户确认后，主代理调用 bridge_reply 发送最终回复，调用 bridge_mark_read 标记已读。');
console.log('重要: 绝不能跳过人类确认步骤直接发送回复。\n');
