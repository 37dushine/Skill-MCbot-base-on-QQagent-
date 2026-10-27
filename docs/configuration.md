# 配置参考（20 项）

全部在 **QQ Agent →「技能」→ 我的世界分身（MC Bot）→ 设置** 里，改动即时生效（少数几项需要重连，见标注）。设置持久化在宿主的数据目录 `data/config.json` 的 `skills.mc-bot` 下，不需要手改文件。

## 身份与连接

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `username` | string | 空 | 游戏内玩家名，最多 16 字。空 = 用机器人的人设名（`persona.botName`），再空则 `Agent`。会自动剔除空格、`@`、冒号、括号等 CQ/命令字符。**改名需重连**，且等于换了身份（背包、位置、`usercache` 记录都会重置） |
| `host` | string | 空 | 常驻联机服务器地址（不含端口）。空 = 只靠局域网自动加入，或每次临时指定 |
| `port` | number | 25565 | 联机端口。单机局域网的世界端口**不用填**，会自动发现 |
| `version` | string | 空 | 如 `1.20.4`。空 = 自动探测（推荐）。填错会连不上 |
| `autoConnect` | boolean | 关 | 宿主启动时自动连 `host:port` |
| `lanAutoJoin` | boolean | **开** | 监听 `224.0.2.60:4445` 组播，发现「对局域网开放」的世界就自动加入。关掉就只能手动连 |
| `autoRejoin` | boolean | 开 | 掉线自动重连。**只对联机服务器生效**；局域网世界不重连（等主机重新开放） |
| `rejoinDelaySec` | number | 15 | 重连等待，5~600 秒 |

## 自主游玩

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `autoExplore` | boolean | 开 | 自主游玩总开关。关掉后它只在你下指令时动 |
| `exploreIntervalSec` | number | 12 | 每隔多久看一次"闲不闲"，5~600 秒。调大更从容，调小更活泼 |
| `exploreRange` | number | 48 | 单次闲逛最远离开当前位置多少格，16~256。防止越走越远 |
| `exploreDig` | boolean | **关** | 自主游玩时被地形挡住是否挖穿。**在别人的世界/服务器上开着等于拆家**，只影响自主行为；`mc_dig` 工具不受此限 |
| `autoGather` | boolean | **关** | 自主游玩时看到树是否砍一块木头（一次一个，不会剃光林子）。这是唯一会主动改变世界的自主行为 |
| `autoChatter` | boolean | 开 | 偶尔在游戏聊天框自言自语（预设台词）。限频：≥60 秒一次、每小时 ≤3 句、约 1/5 概率真开口 |
| `autoReport` | boolean | **关** | 发现玩家 / 村庄营地 / 被怪逼退时往绑定群报一声。限频：≥2 分钟一次、每小时 ≤6 条 |

## 聊天与通知

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `chatMonitor` | enum | `mentions` | `mentions`：只处理叫它名字的；`all`：全部记录（仍只有叫名字才唤醒）；`off`：完全不监听 |
| `relayToQQ` | boolean | 关 | 把游戏聊天**原样**转发到绑定群（与监听独立）。注意：开启后群里会看到所有人的游戏发言 |
| `qqGroup` | string | 空 | 固定绑定的群号。空 = 自动绑定"第一次让它上线"时它所在的那个群/私聊（推荐） |
| `mcCommands` | boolean | 开 | 游戏内 `!` 命令总开关。关掉就只剩"叫名字"一条路 |
| `notifyEvents` | boolean | 开 | 进游戏 / 掉线 / 死亡时往绑定群发一条短通知 |

## 场景预设

### A. 单人世界（推荐起点）

```jsonc
{
  "lanAutoJoin": true,
  "autoExplore": true,
  "exploreIntervalSec": 12,
  "exploreRange": 48,
  "exploreDig": false,
  "autoGather": false,
  "autoChatter": true,
  "autoReport": false
}
```

它自己逛、偶尔嘀咕一句，不动你的地形，不在群里刷消息。

### B. 和自己朋友的小服

```jsonc
{
  "host": "mc.example.com",
  "port": 25565,
  "autoConnect": true,
  "autoRejoin": true,
  "autoGather": true,          // 允许砍树，但只砍一块
  "autoReport": true,           // 有人在时往群里说一声
  "chatMonitor": "mentions",
  "relayToQQ": false
}
```

### C. 公共服务器 / 别人的世界

```jsonc
{
  "lanAutoJoin": false,
  "exploreDig": false,          // 务必保持关
  "autoGather": false,          // 务必保持关
  "autoReport": false,
  "autoChatter": false,         // 别在人家公共聊天里念台词
  "chatMonitor": "mentions",
  "relayToQQ": false
}
```

只做「跟着人走、听指令干活、被问到才说话」，不做任何主动改变世界的事。

## 调参直觉

- **觉得它太吵**：关 `autoChatter`、关 `autoReport`、`relayToQQ` 保持关。
- **觉得它太木**：`exploreIntervalSec` 调到 8~10，`exploreRange` 调小到 24（在附近转，不容易走丢）。
- **它总是走远**：`exploreRange` 降到 16~24，或直接 `!停` 让它待命。
- **服务器人多、机器卡**：`exploreIntervalSec` 调到 30+，减少寻路频率。
- **只想让它当"听指令的木桩"**：`autoExplore` 关掉。

## 配置文件长什么样

宿主把它存在数据目录的 `data/config.json`：

```jsonc
{
  "skills": {
    "mc-bot": {
      "username": "小明",
      "host": "",
      "port": 25565,
      "lanAutoJoin": true
      // ……
    }
  }
}
```

**不建议手改**：热重载时宿主会重新读取，边改边跑容易和 UI 打架。UI 里改就是即时生效的。
