# 架构

## 一句话

一个 **mineflayer 客户端**（分身）+ 三条**确定性链路**（LAN 发现、`!命令`、自主游玩）+ 一条**受控的模型链路**（QQ / 游戏聊天 → 宿主会话 → `mc_*` 工具）。

## 分层

| 层 | 文件 | 职责 | 是否依赖模型 |
|---|---|---|---|
| 清单层 | `skill.json` | 设置项、schema、提示词段、能力声明 | — |
| 桥接层 | `host.js` | 定位宿主、`getConfig()`、`OneBotClient` 类 | — |
| 连接层 | `index.js` §连接 | 连接/重连/超时/退场、LAN 发现 | 否 |
| 行为层 | `index.js` §自主游玩 | 候选行为、权重抽签、执行、见闻 | 否 |
| 聊天层 | `index.js` §聊天处理 | `!命令`、名字识别、注入 QQ、镜像 | 否（注入后由宿主决定） |
| 工具层 | `index.js` `registerTools` | 8 个 `mc_*` 工具 | **是**（模型决定调用） |
| 展示层 | `providers['status.mc-bot']` | 状态面板快照 | 否 |

## 连接生命周期

```
startLan()  ──bind 4445──▶ 收到组播包 ──▶ connect({host:'127.0.0.1', port, source:'lan'})
                                              │
设置 autoConnect ──▶ connect({host, port, source:'auto'})   │
群里让我上线   ──▶ connect({source:'manual'})               │
                                              ▼
                        createBot({host, port, username, auth:'offline', version?})
                                              │
                     ┌────────────────────────┼────────────────────────┐
                     ▼                        ▼                        ▼
                  spawn                    error                  end/kicked
                     │                        │                        │
             清超时 / 通知 / 开始自主游玩   记错误 + 通知      判断是否重连（仅 server）
```

要点：

- **30 秒连接超时**：只算"发出 `login` 到 `spawn`"，进游戏就清掉，不误杀慢服务器。
- **局域网不重连**：主机关了世界，重连也没意义，等下一次组播。
- **`source` 决定重连策略**：`lan` 不重连，`server` / `manual` 按 `autoRejoin` + `rejoinDelaySec` 重试。
- **退场清理**：`disconnect()` 会停自主游玩、清定时器、断开连接、发通知。

## 自主游玩引擎

每 `exploreIntervalSec`（默认 12 秒）tick 一次，**先判断"闲不闲"**：

```
有 bot？ 有 pathfinder？ autoExplore 开？ wanderOn 开？
正在跟随？ 正在赶路（pathfinder.goal）？ 刚做完动作（busyUntil）？
        ↓ 全部通过
behaviorCandidates(bot, settings) → 按处境生成 {id, w, arg} 列表
        ↓
pickBehavior() → 按权重随机取一个
        ↓
runBehavior() → 设置寻路目标 / 转头 / 起跳 / 记录见闻
        ↓
写 lastBehavior（状态面板显示）+ stats.explores++
```

**遇怪短路**：`behaviorCandidates` 第一件事就是查 24 格内有没有敌对生物，有就只返回 `{id:'flee', w:200}` —— 不是"权重很高"，是"只剩这一项"，从结构上保证不会被随机性坑死。

行为与权重见 [`token-economy.md`](token-economy.md#自主游玩的行为池)。

## 聊天桥（最绕的一段）

宿主只给了 `registerTool / config / log / fetch` 这些白名单能力，**没有**"往会话里塞一条消息"的公开 API。而"游戏里叫它名字，它在群里回"必须走宿主的入库→档位→唤醒管线，自己拼存档文件会和宿主的锁、去重、聚批打架。

做法：**伪造一条 OneBot 消息事件，从正门送进去。**

```
onMcChat(username, text)
   ├─ ! 命令 ─────────────▶ handleMcCommand() → bot.chat() 回复（零 token）
   ├─ 监听档位 off ───────▶ 丢弃
   ├─ mentions 且没叫名字 ─▶ 丢弃
   ├─ relayToQQ ──────────▶ sendQQ()（原样转发，零 token）
   └─ injectChat()
         ├─ boundChatKey()：设置里的固定群 > 首次指挥时自动绑定的会话
         ├─ qqAllowed()：照抄宿主 allow / deny / allowAllWhenEmpty 口径
         ├─ 没有 onebot 实例 → 进 pending 队列（上限 30），捕获后补投
         └─ onebot.onEvent(buildMcEvent(...))
                └─ sender.nickname = "MC·Steve"，user_id = 合成号，message_id = 负数
```

拿到 `onebot` 实例有三条路（任一成功即可）：

1. **包原型壳**：`setup()` 时给 `OneBotClient.prototype` 的 12 个方法各包一层"记录 `this` 后原样 `apply`"。宿主启动顺序是 `loadPlugins()` → `onebot.connect()`，所以冷启动一定能等到；热重载场景等下一条消息任意 API 调用。
2. **`before-context` 钩子**：钩子 `ctx` 里有 `store` / `onebot` / `sender` / `emit`。
3. **工具执行时的 `ctx`**：orchestrator 构建的工具上下文里同样有这些。

`recordSelfMc()` 用第 1/2 条拿到的 `store.appendSelf()`，让"它在游戏里说过什么"留痕——否则下一轮它不认自己说过的话。

## 热重载

宿主的 `?t=` 缓存破坏会让模块被重新求值，所以**有状态的东西一律不能放模块作用域**：

```js
const G = (globalThis.__MCBOT_STATE = globalThis.__MCBOT_STATE || { ... });
```

- `G.cfg` / `G.log` / `G.warn` 是**共享访问器**，新实例 `setup()` 时刷新成新闭包；旧闭包不会被调用。
- `deactivate({reason:'reload'})` 直接 `return`，不拆连接、不清定时器。
- `activate()` 认领状态：`G.bot` 还在就重启自主游玩定时器，不重新连接。

## 状态上报

`providers['status.mc-bot']` 是**同步、零 IO** 的：只读 `G.lastStatus`（每 30 秒由 `updateStatus()` 刷新一次，工具调用时也会刷新）。

离线时显示「离线 · 守着局域网广播」+ 累计次数；在线时显示「名字 @ 端点 / 坐标 / 当前动作 + 血量 / 累计探索、采集、聊天条数」。

## 安全边界

| 面 | 处理 |
|---|---|
| QQ 白名单 | `qqAllowed()` 完全照抄宿主口径，不放宽；白名单为空且 `allowAllWhenEmpty=false` 时**不注入** |
| 伪造事件 | 合成 QQ 号 `9900000000+`（32 位空间之外）；`message_id` 从 `-1e9` 递减 |
| 破坏性行为 | 攻击路径不存在；`mc_dig` / `mc_place` 只在模型明确调用时执行；自主挖方块、砍树各有独立开关且默认关 |
| 文件系统 | 技能**不写任何文件**（状态全在内存），避免 `fs.watch` 自激 |
| 凭据 | 不需要任何账号密码；离线身份，不碰正版 token |
