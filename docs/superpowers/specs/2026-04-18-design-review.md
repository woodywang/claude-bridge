# claude-bridge 设计评审

**日期:** 2026-04-18
**范围:** 产品交互 / 系统架构 / 安全模型 / 可扩展性 / 可靠性
**方法:** 场景推演 + 维度归纳
**代码版本:** `9e1ba92` (develop)

---

## 一、场景推演

### 场景 1: 5 人房间，Alice 广播消息，Bob 回复并 CC Charlie

1. Alice `bridge_send` → 为 4 个 peer 各加密一份 → DO 广播
2. Bob hook 触发 → 子代理读取 → 起草回复 → 人类确认
3. Bob `bridge_reply(cc: ["Charlie"])` → 回复定向发 Alice，CC 发 Charlie

**发现:**

- **P1 (低):** DO `handleRelay` 广播给所有 socket，不检查 `recipients` 字段。定向回复的密文也发给了不相关的 peer，浪费带宽。
- **P2 (中):** CC 是标题前缀 `[CC]` hack，不是协议级概念。如果 Charlie 回复这条 CC，`bridge_reply` 定向发给 `message.from`（Bob），Alice 不会收到。CC 回复链会断裂。
- **P3 (中):** `bridge_send` 只能广播给所有人，没有选择收件人的能力。私聊只能通过 reply 间接实现。

### 场景 2: Bob 断网 3 分钟后重连

1. Bob 断网 → DO 标记 offline → Alice 发 5 条消息写入 messageLog
2. Bob 重连 → sync(lastSeenId) → DO 重放缺失消息

**发现:**

- **P4 (低):** 重连时 sync 先于 register 发送（`websocket.ts` onOpen 中 sync 在 `this.onOpen?.()` 之前）。语义倒置，虽然功能不受影响。
- **P5 (中):** messageLog 上限 1000 条（全局共享）。高频场景下离线 peer 可能丢消息，且客户端无感知——没有 gap 检测。
- **P6 (高):** 进程重启 = 新 keypair = 新 fingerprint。其他 peer 用旧密钥加密的消息无法解密。身份不持久化，重启即丢失。

### 场景 3: 恶意中继攻击

1. 攻击者控制 Worker/DO，尝试读取密文 → 失败 ✅
2. 攻击者替换 Alice 的 publicKey → Bob 用假公钥加密 → 攻击者可解密 → 转发给 Alice

**发现:**

- **P7 (高):** MITM 完全可行且不可检测。没有 fingerprint 验证 UI、密钥固定或安全号码机制。
- **P8 (高):** Room code 6 位（36^6 ≈ 22 亿），无速率限制、无密码、无认证。可暴力枚举加入房间。
- **P9 (中):** members 数组只追加不清理。攻击者可注入大量假 member 污染注册表。

### 场景 4: 两条消息快速到达，子代理处理竞态

1. Alice 快速发 2 条消息 → Bob hook 一次性读到 2 条
2. 子代理处理第 1 条 → 返回草稿 → 人输入确认 → hook 再次触发

**发现:**

- **P10 (高):** hook 每次用户输入都触发，包括"确认发送"的输入。确认操作和新消息提示交织，行为不可预测。
- **P11 (中):** 多条消息的批量处理完全依赖 LLM 行为，没有结构化的待回复队列。
- **P12 (高):** `bridge_read` 立即标记已读。子代理崩溃或主代理未展示草稿时，消息已标记已读但未被人类看到。消息可能"静默丢失"。

### 场景 5: context 同步冲突 + 时钟偏差

1. Alice 和 Bob 同时 `bridge_set_context("api_version", ...)` → 各自广播
2. last-write-wins 按客户端 timestamp 判定。时钟偏差 5 秒即可导致不可预测的结果。

**发现:**

- **P13 (高):** last-write-wins 依赖客户端时钟，跨机器时钟偏差导致最终状态不确定。
- **P14 (低):** context 覆盖是静默的，没有冲突提示。

---

## 二、关键设计缺陷：客户端时间戳

当前系统在多处依赖客户端 `Date.now()` 时间戳：

- **BridgeMessage.timestamp** — 消息创建时间，用于 inbox 排序
- **context last-write-wins** — `handleDecryptedMessage` 中用 `message.timestamp >= existingEntry.timestamp` 判定覆盖
- **task/inbox 时间显示** — 所有 UI 层用 timestamp 计算相对时间

问题：跨机器时钟无法保证一致。即使用 NTP，偏差 1-5 秒很常见。

### 建议：服务端单调序列号

DO `handleRelay` 已经在生成 `seqId`（当前是随机 hex），改为 **单调递增计数器**：

```
seqId: 1, 2, 3, 4, ...  (per-room, DO storage 持久化)
```

**改动点:**
1. DO `handleRelay`：用 `await this.ctx.storage.get<number>('seqCounter')` + 1 替代 `generateId()`
2. 客户端收到的每条 relay 消息外层携带 `seqId: number`
3. 客户端解密后，将 seqId 附加到内存中的 InboxMessage / LocalTask / context entry 上（seqId 是外层信封字段，BridgeMessage 本身不含 seqId）
4. **消息排序**：客户端用 `seqId` 排序 inbox，不用 timestamp
5. **context last-write-wins**：用 `seqId` 比较，不用 timestamp
6. **gap 检测**：客户端追踪 lastSeenSeqId，收到的 seqId 不连续 = 有消息丢失，可告警
7. **去重**：相同 seqId 的消息直接丢弃
8. **timestamp 保留**：BridgeMessage.timestamp 仍由客户端设置，但仅用于 UI 显示（"5 分钟前"），不用于任何逻辑判定

**优势:**
- 一个改动同时解决 P5（gap 检测）、P13（时钟偏差）、P17（去重）
- DO 是单点，计数器天然全局有序，无需分布式时钟
- 向后兼容：旧客户端收到 number 类型 seqId 仍可工作

---

## 三、维度评审总结

### 产品交互 — 6/10

| 优势 | |
|------|--|
| draft-confirm 回复流程确保人类守门 | |
| alias 系统提供可读身份 | |
| inbox 模型（标题/正文/已读/线程）直觉清晰 | |

| ID | 问题 | 严重度 | 建议 |
|----|------|--------|------|
| P3 | `bridge_send` 只能广播，不能私聊 | 中 | 增加可选 `to` 参数 |
| P10 | hook 在确认回复时也触发，流程交织 | 高 | hook 增加去重/节流逻辑 |
| P11 | 多消息批量处理依赖 LLM 行为 | 中 | 结构化待回复队列或逐条处理模式 |
| P12 | `bridge_read` 已读副作用在崩溃时导致静默丢失 | 高 | 拆分为 read (只读) + mark_read (确认后) |
| P15 | CC 是标题前缀 hack，回复链断裂 | 中 | 协议层增加 `cc` 字段 |

### 系统架构 — 7/10

| 优势 | |
|------|--|
| DO 中继天然全球分布、低延迟 | |
| pairwise 加密 + 协议版本号留有升级空间 | |
| sync/replay 保证断连补齐 | |

| ID | 问题 | 严重度 | 建议 |
|----|------|--------|------|
| P1 | DO 广播不按 recipients 过滤 | 低 | 解析 recipients，只发给目标 socket |
| P4 | 重连时 sync 在 register 前发送 | 低 | 调换顺序：先 register 后 sync |
| P5 | messageLog 1000 上限，溢出无告警 | 中 | 改用单调 seqId + gap 检测 |
| P6 | 进程重启 = 身份丢失 | 高 | keypair 持久化到磁盘 |
| P13 | 消息排序/context 冲突解决依赖客户端时钟 | 高 | 改用 DO 单调 seqId |
| P16 | writeToInbox read-modify-write 非原子 | 中 | 改为 append-only（每行一条 JSON） |

### 安全模型 — 5/10

| 优势 | |
|------|--|
| X25519 + XSalsa20-Poly1305 成熟方案 | |
| pairwise 加密隔离 peer 间通信 | |
| DO 真正零知识 | |

| ID | 问题 | 严重度 | 建议 |
|----|------|--------|------|
| P7 | MITM 可行且不可检测 | 高 | 显示 fingerprint 供带外验证 |
| P8 | room 无认证，可暴力枚举 | 高 | room 创建时生成 join secret |
| P9 | members 数组无清理 | 中 | 离线超时后清理，或设上限 |
| P17 | 无消息去重，可重放密文 | 中 | 客户端按 BridgeMessage.id 去重 |
| P18 | alias 无唯一性约束，CC 可能发错人 | 中 | DO register 时检查同名冲突 |

### 可扩展性 — 6/10

| 优势 | |
|------|--|
| 多方架构已就位 | |
| protocolVersion 支持未来升级 | |
| 工具注册模式清晰 | |

| ID | 问题 | 严重度 | 建议 |
|----|------|--------|------|
| P19 | 新消息类型需改 3 处 | 低 | 可接受，暂不需要 handler 注册机制 |
| P20 | 256KB 限制阻断文件传输 | 中 | 走 presigned URL，消息里传链接 |
| P21 | 无频道/话题分组 | 低 | 未来可在 BridgeMessage 加 channel 字段 |

### 可靠性 — 6/10

| 优势 | |
|------|--|
| 自动重连 + 指数退避 | |
| sync/replay 断连补齐 | |
| counts.json 变更检测避免无效写盘 | |

| ID | 问题 | 严重度 | 建议 |
|----|------|--------|------|
| P5 | messageLog 溢出静默丢消息 | 中 | 单调 seqId + gap 告警 |
| P6 | 进程重启身份丢失 | 高 | keypair 持久化 |
| P16 | inbox 文件并发写损坏 | 中 | append-only 格式 |
| P22 | state.inbox/tasks 无上限 | 低 | 加 TTL 淘汰（24h 已读消息） |

---

## 四、总评

| 维度 | 评分 | 一句话 |
|------|------|--------|
| 产品交互 | 6/10 | draft-confirm 方向正确，已读副作用和 hook 竞态是主要风险 |
| 系统架构 | 7/10 | DO 中继骨架扎实，身份持久化和服务端排序是最大缺口 |
| 安全模型 | 5/10 | 加密方案没问题，MITM 无防护 + room 无认证 = 不适用敏感场景 |
| 可扩展性 | 6/10 | 2-5 人够用，10+ 人需要频道分组 |
| 可靠性 | 6/10 | 重连补齐合理，身份丢失和消息溢出是定时炸弹 |

---

## 五、改进优先级

### P0 — 立即修复（影响正确性）

1. **服务端单调 seqId** — DO 生成递增计数器替代随机 hex，客户端用 seqId 排序/去重/gap 检测/context 冲突解决。一个改动解决 P5 + P13 + P17。
2. **keypair 持久化** — 写入 `~/.claude-bridge/identity.json`，进程重启复用身份。解决 P6。
3. **拆分 bridge_read 已读副作用** — read 只返回内容，新增 mark_read 由主代理在人类确认后调用。解决 P12。

### P1 — 短期改进（提升安全和体验）

4. **Room join secret** — 创建 room 时生成 token，加入需提供。解决 P8。
5. **Alias 唯一性** — DO register 时检查同名冲突，拒绝重复。解决 P18。
6. **bridge_send 支持定向发送** — 增加可选 `to` 参数。解决 P3。
7. **CC 协议化** — ChatPayload 增加 `cc?: string[]` 字段，替代标题前缀 hack。解决 P2/P15。

### P2 — 中期优化

8. DO 按 recipients 过滤广播 (P1)
9. inbox append-only 写入 (P16)
10. state Map TTL 淘汰 (P22)
11. Fingerprint 验证 UI (P7)
