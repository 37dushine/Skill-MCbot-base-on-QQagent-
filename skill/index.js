// 我的世界分身（mc-bot）—— LLM 型技能 / skills/mc-bot
//
// ── 一、为什么是技能（skills/），不是插件 ─────────────────────────────────
// 按三问判断法（src/skills/manifest.js 的 DIR_KIND 语义）：
//   ① 触发时机能用 if 描述吗？——核心指挥链不能：「去 Steve 家门口把那块
//     石头挖了」「陪我去下界」这类话必须**理解人话**才知道该不该动、动哪里。
//     只有游戏内 !命令、局域网发现、自动重连这类外围是确定性的。
//   ② 漏触发一次的代价？——大：玩家在游戏里叫它名字没回应，功能等于没做。
//   ③ 参数从哪来？——从人话里抠（坐标、玩家名、方块、走还是停）。
// 三问里两问半指向 LLM → 落 skills/（registerTool，模型决定何时用）。
// 确定性外围（!命令、LAN 监听、重连、闲逛）作为技能内部实现，不单独拆件。
//
// ── 二、架构：一个分身，两个入口，三条链路 ─────────────────────────────
//   分身本体 = mineflayer（一个真正的 Minecraft 客户端协议实现，独立玩家实体，
//   与主机互不干扰：主机该怎么玩怎么玩，分身只是"多了一个玩家"）。
//
//   入口 A：QQ 群自然语言 →（app 原生会话）→ 模型 → mc_* 工具 → 游戏动作。
//   入口 B：游戏聊天框 →
//     · !命令（!来/!跟随/!停/!状态）→ 确定性执行 + 游戏内回复，**零 token**；
//     · 叫它名字 → 注入绑定群的存档（走 OneBot 事件正门）→ 档位判定 →
//       命中才唤醒模型（和普通 QQ 消息完全同一套闸门，不额外烧 token）；
//     · 其它聊天 → 默认不理（mentions 模式），零 token。
//
//   连接来源：
//     · LAN 自动加入：PCL 启动的单机世界「对局域网开放」会向
//       224.0.2.60:4445 组播广播（就是多人菜单里"局域网世界"那个机制），
//       这里直接监听同一个广播 → 拿到端口 → 加入 127.0.0.1:port。
//       这就是「通过 PCL 接入」的实做路径：PCL 负责启动主机的游戏，
//       分身以第二个玩家身份进同一个世界，主机关世界它自动退场。
//     · 联机服务器：设置里填 host/port（或当次让机器人临时填）。
//
// ── 三、省 token 的全部手段（本技能的设计主线）──────────────────────────
//   1. 闲逛/探索：确定性随机走，**零 token**（autoExplore）；
//   2. 游戏内 !命令：确定性，**零 token**；
//   3. 游戏聊天不叫名字 → 不注入或注入但不唤醒（mentions/all 两档），
//      唤醒判定复用 app 的响应档位（1~4 档滑条），与 QQ 消息同一口径；
//   4. 上下线/死亡通知：确定性直发绑定群，**零 token**；
//   5. 工具描述全部控制在两三句话内；mc_observe 一次返回全部态势，
//      引导模型不要连环查询；
//   6. 移动类工具异步化（下达即返回，不挂起整个会话等寻路走完）。
//
// ── 四、和核心的接线方式（重要：为什么这么拿实例）───────────────────────
//   createSkillApi 只给了 registerTool / config / fetch 这些白名单能力，
//   没有"把消息塞进存档"或"唤醒会话"的入口。本机已装扩展的既有先例：
//   · plugins/typo-sim —— 包 OneBotClient.prototype.sendText 拿发送通道；
//   · plugins/question-relay —— 从 before-context 钩子的 ctx.store 抓存档。
//   这里同样合法地"包一层"：把 OneBotClient.prototype 的方法各包一个
//   **只记录 this、原样转发**的壳（零行为改动），拿到 onebot 实例后，
//   用 onebot.onEvent(伪造的 OneBot 消息事件) 把游戏聊天送进 app 的
//   真正入库管线（白名单→存档→档位判定→唤醒），而不是自己拼存档文件。
//   事件体走 handleOneBotEvent 的正规入口，档位/屏蔽/聚批全部自动生效。
//   另外两条兜底捕获路径：before-context 钩子抓 store、工具执行时抓
//   ctx.onebot/store/sender（orchestrator 构建的 ctx 里都有）。
//   注意时序：app 启动是先 loadPlugins 再 onebot.connect()（app.js
//   start() 的顺序），所以原型壳在冷启动时一定能等到 connect 被调用；
//   热重载场景则等下一次任意 API 调用——期间游戏聊天先排队，捕获后补投。
//
// ── 五、热重载（照抄 typo-sim 的教训）───────────────────────────────────
//   分身连接、监听器、定时器、统计全部挂在 globalThis.__MCBOT_STATE 上：
//   热重载开新模块实例时直接认领旧状态（bot 连接不断），deactivate 收到
//   reason==='reload' 时只让位不拆台；事件处理器只通过 G.cfg()/G.log 这类
//   共享访问器读配置，新实例 setup() 会把它们刷新成新闭包。
//
// ── 六、边界（本技能不做的事）────────────────────────────────────────────
//   · 不攻击任何玩家/生物（没有杀戮工具），不主动进传送门/下界；
//   · 自动探索默认**不挖方块**（exploreDig 默认关，防止在别人的世界里拆家）；
//   · 离线身份（offline）：开启正版验证的联机服务器进不去，属正常限制；
//   · 不写任何文件（状态全在内存 + 设置走 config.json），避免 fs.watch
//     自激回路（must-draw 注释里记的那个坑）；
//   · 伪造的 OneBot 事件用 9.9e9+ 的合成 QQ 号（32 位 QQ 号空间之外，
//     绝不撞真人）和负数 message_id（避开真实消息 id）。
//
// ── 七、文档里的坑，逐条避开 ─────────────────────────────────────────────
//   · settings 每个键都在 configSchema 里有声明；enum 用 values；
//   · 配置执行时现读（S()），不在 setup 时快照；
//   · 工具参数先校验、失败返回 {content, isError:true} 不抛错；
//   · 工具 id 只用 [a-zA-Z0-9_-]，长度满足 OpenAI 64 上限；
//   · createRequire 用 import.meta.url 的**目录**解析（loader 的 ?t= 查询串
//     不能进 createRequire，否则 CJS 依赖解析会坏）；
//   · 有 providers（status 上报）也有 registerTool —— skill 目录的语义
//     是"模型决定何时执行"，providers 只是顺带，不触发 lint 告警。

import dgram from 'node:dgram';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
// 宿主桥接：位置解析 / getConfig / OneBotClient 都在 host.js 里做成"尽力而为"，
// 找不到宿主时退化为空实现（MC 侧照常可用，QQ 桥停用），见该文件顶部说明。
import { getConfig, getOneBotClientClass, HOST_INFO } from './host.js';

// ── CJS 依赖（mineflayer 全家是 CommonJS）────────────────────────────────
// 懒加载 + 缓存：缺依赖时整个技能仍可加载，UI 的 available() 给出明确原因，
// 而不是 import 阶段直接炸掉（那样连"为什么不可用"都看不见）。
const requireCjs = createRequire(fileURLToPath(new URL('.', import.meta.url)));
let _lib;
function loadLib() {
  if (_lib !== undefined) return _lib;
  try {
    const mf = requireCjs('mineflayer');
    const pf = requireCjs('mineflayer-pathfinder');
    const { Vec3 } = requireCjs('vec3');
    _lib = { mf, pf, Vec3 };
  } catch (error) {
    _lib = null;
    G.lastDepsError = String(error?.message ?? error);
  }
  return _lib;
}

// ── 共享状态（热重载安全的唯一事实源）────────────────────────────────────
const G = (globalThis.__MCBOT_STATE = globalThis.__MCBOT_STATE || {
  // 核心实例捕获（见文件头 §四）
  core: { onebot: null, store: null, sender: null, emit: null },
  protoPatched: false,
  // 游戏连接
  bot: null,
  connecting: null,             // { host, port, source }
  endpoint: null,               // 最近一次成功连接的 { host, port, source }
  connectTimeout: null,
  rejoinTimer: null,
  statusTimer: null,
  exploreTimer: null,
  spawnedOnce: false,           // 本连接是否已通知过「进游戏了」
  // 局域网发现
  lanSocket: null,
  lastLanPort: 0,
  lastLanJoinAt: 0,
  lanCooldownUntil: 0,
  // QQ 桥
  boundChatKey: '',             // group:123 / private:456（绑定群）
  pending: [],                  // onebot 未捕获时排队的游戏聊天
  lastNotifyAt: 0,
  notifyHour: { key: '', count: 0 },
  relayBuf: [],
  relayTimer: null,
  // 行为（自主玩耍引擎）
  followName: null,
  wanderOn: true,
  lastBehavior: '待命',
  busyUntil: 0,                 // 这个时刻前不安排新行为（避免动作过密）
  sightings: [],                // 近期见闻（环形，确定性生成，喂给 mc_observe）
  lastChatterAt: 0,
  chatterHour: { key: '', count: 0 },
  lastReportAt: 0,
  reportHour: { key: '', count: 0 },
  // 展示与统计
  lastStatus: { connected: false },
  lastError: '',
  lastDepsError: '',
  stats: { joins: 0, deaths: 0, chats: 0, injected: 0, commands: 0, explores: 0, relayed: 0, gathered: 0, fled: 0 },
  // 实例刷新点（setup 时更新）
  cfg: () => ({}),
  log: () => {},
  warn: () => {}
});

// ── 配置（执行时现读；默认值与 skill.json 的 settings 一致）──────────────
const clamp = (v, lo, hi, dft) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dft;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};

function S() {
  const c = G.cfg() || {};
  const port = (() => {
    const n = Number(c.port);
    return Number.isFinite(n) && n > 0 && n < 65536 ? Math.round(n) : 25565;
  })();
  const monitor = ['off', 'mentions', 'all'].includes(c.chatMonitor) ? c.chatMonitor : 'mentions';
  return {
    username: String(c.username ?? '').trim(),
    host: String(c.host ?? '').trim(),
    port,
    version: String(c.version ?? '').trim(),
    autoConnect: c.autoConnect === true,
    lanAutoJoin: c.lanAutoJoin !== false,
    autoRejoin: c.autoRejoin !== false,
    rejoinDelaySec: clamp(c.rejoinDelaySec, 5, 600, 15),
    autoExplore: c.autoExplore !== false,
    exploreIntervalSec: clamp(c.exploreIntervalSec, 5, 600, 12),
    exploreRange: clamp(c.exploreRange, 16, 256, 48),
    exploreDig: c.exploreDig === true,
    autoGather: c.autoGather === true,
    autoChatter: c.autoChatter !== false,
    autoReport: c.autoReport === true,
    chatMonitor: monitor,
    relayToQQ: c.relayToQQ === true,
    qqGroup: String(c.qqGroup ?? '').trim(),
    mcCommands: c.mcCommands !== false,
    notifyEvents: c.notifyEvents !== false
  };
}

/** 分身的游戏内名字：设置 > 人设名 > Agent；清掉空格与 CQ 类字符，限 16。 */
function resolvedName() {
  const s = S();
  let n = s.username || String(getConfig()?.persona?.botName || '').trim() || 'Agent';
  n = String(n).replace(/[\s@:\[\]{}()<>#$%,;"'`\\/\r\n\t]/g, '').trim();
  if (!n) n = 'Agent';
  return [...n].slice(0, 16).join('');
}

// ── 工具返回的统一形状（照核心 tools.js 的 ok/err 约定）──────────────────
const ok = (t) => ({ content: typeof t === 'string' ? t : JSON.stringify(t) });
const err = (t) => ({ content: `错误：${t}`, isError: true });

// ── QQ 侧：白名单口径（与 app.js allowed() 同构，绝不绕开）───────────────
function qqAllowed(kind, id) {
  const cfg = getConfig() || {};
  const s = String(id);
  const denyList = cfg.deny?.[kind] ?? cfg.deny?.[`${kind}s`] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow?.[kind] ?? cfg.allow?.[`${kind}s`] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg.allowAllWhenEmpty === true;
}

/** 绑定群是否可用（设置里的固定绑定优先，否则用捕获时自动绑定的）。 */
function boundChatKey() {
  const fixed = S().qqGroup;
  if (/^\d+$/.test(fixed)) return `group:${fixed}`;
  const k = String(G.boundChatKey || '');
  return /^(group|private):\d+$/.test(k) ? k : '';
}

// ── 核心实例捕获（三层兜底，见文件头 §四）────────────────────────────────
function patchOnebot() {
  if (G.protoPatched) return;
  const proto = getOneBotClientClass()?.prototype;
  if (!proto) return;
  const names = ['call', 'connect', 'reconnect', 'close', 'sendText', 'sendSegments',
    'sendSticker', 'sendImage', 'sendPoke', 'getMsg', 'getGroupInfo', 'getGroupMemberInfo'];
  for (const name of names) {
    const orig = proto[name];
    if (typeof orig !== 'function') continue;
    try {
      proto[name] = function (...args) {
        if (!G.core.onebot) {
          G.core.onebot = this;
          setTimeout(flushPending, 200);
        }
        return orig.apply(this, args);
      };
    } catch { /* 某个方法包不上就跳过，不影响其余 */ }
  }
  G.protoPatched = true;
}

function captureCore(ctx) {
  if (!ctx) return;
  const hadOnebot = Boolean(G.core.onebot);
  if (!G.core.onebot && ctx.onebot) G.core.onebot = ctx.onebot;
  if (!G.core.store && ctx.store) G.core.store = ctx.store;
  if (!G.core.sender && ctx.sender) G.core.sender = ctx.sender;
  if (!G.core.emit && typeof ctx.emit === 'function') G.core.emit = ctx.emit;
  // 自动绑定：设置没固定群时，第一次在某个群/私聊里指挥它，桥就架到那里
  if (!G.boundChatKey && /^(group|private):\d+$/.test(String(ctx.chatKey || ''))) {
    G.boundChatKey = String(ctx.chatKey);
    G.log(`MC 聊天桥已绑定到 ${G.boundChatKey}`);
  }
  if (!hadOnebot && G.core.onebot) flushPending();
}

// ── 游戏聊天 → QQ（走 OneBot 事件正门）────────────────────────────────────
// 合成 QQ 号：9.9e9 起（32 位无符号上限 4294967295 之外），绝不与真人重号。
function synthQqId(mcName) {
  let h = 7;
  const s = String(mcName || 'player');
  for (let i = 0; i < s.length; i++) h = ((h * 31) + s.charCodeAt(i)) >>> 0;
  return 9900000000 + (h % 99999999);
}

let midSeq = -1000000000; // 伪造消息 id 用独立负数区间，避开真实消息 id

function buildMcEvent(chatKey, mcName, text) {
  const [kind, id] = String(chatKey).split(':');
  const uid = synthQqId(mcName);
  const label = `MC·${String(mcName).slice(0, 24)}`;
  return {
    post_type: 'message',
    message_type: kind,
    sub_type: kind === 'group' ? 'normal' : 'friend',
    group_id: kind === 'group' ? Number(id) : undefined,
    user_id: uid,
    sender: { user_id: uid, nickname: label, card: label },
    message: [{ type: 'text', data: { text: String(text).slice(0, 500) } }],
    raw_message: String(text).slice(0, 500),
    message_id: midSeq--,
    time: Math.floor(Date.now() / 1000)
  };
}

/** 注入一条游戏聊天。atMe=true 时补一个 @前缀，让档位判定按「被艾特」唤醒。 */
function injectChat(mcName, text, { atPrefix = false } = {}) {
  const target = boundChatKey();
  if (!target) return false;
  const [kind, id] = target.split(':');
  if (!qqAllowed(kind, id)) return false;
  const onebot = G.core.onebot;
  if (!onebot) {
    G.pending.push({ mcName, text, atPrefix });
    if (G.pending.length > 30) G.pending.shift();
    return false;
  }
  let finalText = String(text);
  if (atPrefix) {
    const bot = G.bot;
    const persona = getConfig()?.persona || {};
    const atName = String(persona.botName || bot?.username || '').trim();
    if (atName) finalText = `@${atName} ${finalText}`;
  }
  try {
    onebot.onEvent(buildMcEvent(target, mcName, finalText));
    G.stats.injected += 1;
    return true;
  } catch (error) {
    G.warn(`注入游戏聊天失败：${error?.message ?? error}`);
    return false;
  }
}

function flushPending() {
  if (!G.core.onebot || !G.pending.length) return;
  const list = G.pending.splice(0, 10);
  let i = 0;
  const step = () => {
    if (i >= list.length) return;
    const p = list[i++];
    injectChat(p.mcName, p.text, p);
    setTimeout(step, 600);
  };
  setTimeout(step, 100);
}

// ── 确定性 QQ 直发（通知/镜像，零 token）───────────────────────────────────
// 与 /api/chats/:id/test-send 路由同款三件套：白名单校验 → onebot.sendText →
// store.appendSelf（机器人自己说过什么，存档里要留痕，否则下一轮它不认账）。
function hourKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}`;
}

/**
 * 直接发一条到绑定群（确定性，零 token）。
 * 小时配额是硬闸门（防刷屏把群炸了）；2 秒节流只给「事件通知」用——
 * 聊天镜像若也走节流，玩家连续说话会被静默吞掉，所以镜像传 throttle:false。
 */
async function sendQQ(text, { throttle = true } = {}) {
  try {
    const target = boundChatKey();
    if (!target) return false;
    const [kind, id] = target.split(':');
    if (!qqAllowed(kind, id)) return false;
    if (!G.core.onebot) return false;
    const now = Date.now();
    if (throttle && now - G.lastNotifyAt < 2000) return false;
    if (G.notifyHour.key !== hourKey()) G.notifyHour = { key: hourKey(), count: 0 };
    if (G.notifyHour.count >= 20) return false;
    G.lastNotifyAt = now;
    G.notifyHour.count += 1;
    const res = await G.core.onebot.sendText(kind, id, String(text).slice(0, 300));
    try { G.core.store?.appendSelf?.(target, { text: String(text).slice(0, 300), ts: Date.now(), mid: res?.message_id ?? null }); } catch { /* 留痕失败不影响发送 */ }
    try { G.core.emit?.('chat-update', target); } catch { /* ignore */ }
    return true;
  } catch (error) {
    G.warn(`MC 通知发送失败：${error?.message ?? error}`);
    return false;
  }
}

/** 事件通知（带 2 秒节流，防同一事件连环发）。 */
function notifyQQ(text) {
  return sendQQ(text);
}

/**
 * 游戏聊天镜像（relayToQQ 开启时）：聚合 1.5 秒内的行，一条消息发出去。
 * mcName 传空 = 只排下一轮定时器（缓冲积压时用），不往里塞空行。
 */
function relayLine(mcName, text) {
  if (mcName) G.relayBuf.push(`MC·${mcName}：${String(text).slice(0, 200)}`);
  if (G.relayBuf.length > 40) G.relayBuf.splice(0, G.relayBuf.length - 40); // 刷屏保护
  if (G.relayTimer) return;
  G.relayTimer = setTimeout(async () => {
    G.relayTimer = null;
    const lines = G.relayBuf.splice(0, 5);
    if (!lines.length) return;
    const sent = await sendQQ(lines.join('\n'), { throttle: false });
    if (sent) G.stats.relayed += lines.length;
    if (G.relayBuf.length) relayLine('', ''); // 还攒着就再排一轮
  }, 1500);
  G.relayTimer.unref?.();
}

// ── 局域网世界发现（=「PCL 单机世界接入」）────────────────────────────────
// MC 客户端开放局域网时向 224.0.2.60:4445 组播 [MOTD]…[/MOTD][AD]端口[/AD]，
// 与多人游戏菜单里「局域网世界」列表听到的是同一个广播。
function startLan() {
  if (G.lanSocket || !S().lanAutoJoin) return;
  try {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', (error) => {
      G.warn(`局域网监听出错（自动加入停用）：${error?.message ?? error}`);
      try { sock.close(); } catch { /* ignore */ }
      if (G.lanSocket === sock) G.lanSocket = null;
    });
    sock.on('message', (buf) => {
      try { onLanPacket(buf); } catch { /* 坏包忽略 */ }
    });
    sock.bind(4445, () => {
      try { sock.addMembership('224.0.2.60'); } catch { /* 没有多播环境就当没听见 */ }
    });
    sock.unref?.();
    G.lanSocket = sock;
  } catch (error) {
    G.warn(`无法监听局域网广播：${error?.message ?? error}`);
  }
}

function parseLanPacket(buf) {
  const text = String(buf ?? '');
  const ad = /\[AD\](\d+)\[\/AD\]/.exec(text);
  if (!ad) return null;
  const port = Number(ad[1]);
  if (!(port > 0 && port < 65536)) return null;
  const motd = (/\[MOTD\]([^\[]*)\[\/MOTD\]/.exec(text)?.[1] || '').trim();
  return { port, motd };
}

function onLanPacket(buf) {
  if (G.bot || G.connecting) return;
  const found = parseLanPacket(buf);
  if (!found) return;
  const now = Date.now();
  if (now < G.lanCooldownUntil) return;
  if (G.lastLanPort === found.port && now - G.lastLanJoinAt < 30000) return;
  G.lastLanPort = found.port;
  G.lastLanJoinAt = now;
  G.log(`发现局域网 MC 世界${found.motd ? `「${found.motd}」` : ''}（端口 ${found.port}），分身正在加入…`);
  connect({ host: '127.0.0.1', port: found.port, source: 'lan' });
}

// ── 游戏连接与生命周期 ─────────────────────────────────────────────────────
function connect({ host, port, version, source = 'manual' } = {}) {
  const s = S();
  const lib = loadLib();
  if (!lib) {
    return { ok: false, error: `依赖未就绪：${G.lastDepsError || 'mineflayer 未安装（需要在 resources/app 下 npm install mineflayer mineflayer-pathfinder）'}` };
  }
  if (G.bot) return { ok: true, already: true, note: '分身已在线' };
  if (G.connecting) return { ok: false, error: '正在连接另一个服务器，稍等几秒' };

  const finalHost = String(host || s.host || '').trim();
  if (!finalHost) {
    return {
      ok: false,
      error: s.lanAutoJoin
        ? '没有可用的服务器地址（设置里没填、本次也没传）。分身正守着局域网广播——主机在游戏里「对局域网开放」后几秒内会自动加入。'
        : '没有可用的服务器地址：请在设置里填「联机服务器地址」，或临时告诉它一个地址。'
    };
  }
  const finalPort = Number(port) > 0 ? Math.round(Number(port)) : s.port;

  G.connecting = { host: finalHost, port: finalPort, source };
  G.lastError = '';
  let bot;
  try {
    const opts = {
      host: finalHost,
      port: finalPort,
      username: resolvedName(),
      auth: 'offline'
    };
    const v = String(version || s.version || '').trim();
    if (v) opts.version = v; // 不填 → mineflayer 自动 ping 探测
    bot = lib.mf.createBot(opts);
  } catch (error) {
    G.connecting = null;
    G.lastError = String(error?.message ?? error);
    return { ok: false, error: `创建连接失败：${G.lastError}` };
  }

  G.bot = bot;
  G.endpoint = { host: finalHost, port: finalPort, source };
  try { bot.loadPlugin(lib.pf.pathfinder); } catch { /* pathfinder 缺失时移动类工具会明确报错 */ }

  attachBotListeners(bot, source);

  if (G.connectTimeout) clearTimeout(G.connectTimeout);
  G.connectTimeout = setTimeout(() => {
    if (!G.connecting) return;
    G.lastError = `连接 ${finalHost}:${finalPort} 超时（30 秒内没有进入游戏）`;
    G.warn(G.lastError);
    if (S().notifyEvents) notifyQQ(`[MC] 连不上 ${finalHost}:${finalPort}：超时`);
    teardownBot(false);
  }, 30000);
  G.connectTimeout.unref?.();

  G.log(`分身开始连接 ${finalHost}:${finalPort}（${source}，名字 ${resolvedName()}）`);
  return { ok: true, connecting: true, host: finalHost, port: finalPort, source };
}

function attachBotListeners(bot, source) {
  bot.on('spawn', () => {
    const first = !G.spawnedOnce && G.connecting;
    G.spawnedOnce = true;
    G.connecting = null;
    if (G.connectTimeout) { clearTimeout(G.connectTimeout); G.connectTimeout = null; }
    try {
      const lib = loadLib();
      if (lib && bot.pathfinder) {
        const movements = new lib.pf.Movements(bot);
        movements.canDig = S().exploreDig;          // 探索默认不拆家
        movements.allow1by1towers = false;          // 不搭柱子
        bot.pathfinder.setMovements(movements);
      }
    } catch { /* 探索配置失败只影响闲逛 */ }
    G.stats.joins += 1;
    updateStatus();
    startExplore();
    startStatusTimer();
    if (first) {
      const st = statusBrief();
      G.log(`分身已进入游戏：${st}`);
      if (S().notifyEvents) notifyQQ(`[MC] 我进游戏了：${bot.username} @ ${G.endpoint?.host ?? '?'}:${G.endpoint?.port ?? '?'}${bot.version ? `（${bot.version}）` : ''}，有事游戏里或群里叫我。`);
    }
  });

  bot.on('chat', (username, message) => {
    try { onMcChat(username, message); } catch (error) { G.warn(`处理游戏聊天出错：${error?.message ?? error}`); }
  });

  bot.on('death', () => {
    G.stats.deaths += 1;
    G.warn('分身死了（3 秒后自动重生）');
    if (S().notifyEvents) notifyQQ('[MC] 我死了……马上重生。');
    setTimeout(() => { try { bot.respawn?.(); } catch { /* 重生失败等服务器踢 */ } }, 3000).unref?.();
  });

  bot.on('kicked', (reason) => {
    if (G.bot !== bot) return;
    G.lastError = `被服务器踢出：${String(reason ?? '').slice(0, 200)}`;
    G.warn(G.lastError);
    if (S().notifyEvents) notifyQQ(`[MC] 我被踢出服务器了：${String(reason ?? '').slice(0, 120)}`);
    handleDisconnect(bot, source, String(reason ?? ''));
  });

  bot.on('error', (error) => {
    if (G.bot !== bot) return;
    G.lastError = String(error?.message ?? error).slice(0, 300);
    // 连接阶段（还没有 spawn 过）的 error 等价于连接失败
    if (!G.spawnedOnce) {
      G.warn(`连接失败：${G.lastError}`);
      if (S().notifyEvents) notifyQQ(`[MC] 连不上：${G.lastError.slice(0, 120)}`);
      teardownBot(false);
    }
  });

  bot.on('end', (reason) => {
    if (G.bot !== bot) return;
    G.warn(`与服务器断开：${String(reason ?? '')}`);
    handleDisconnect(bot, source, String(reason ?? ''));
  });
}

function handleDisconnect(bot, source, reason) {
  const wasSpawned = G.spawnedOnce;
  teardownBot(false);
  if (!wasSpawned) return;
  if (S().notifyEvents) notifyQQ(`[MC] 我掉线了${reason ? `（${String(reason).slice(0, 80)}）` : ''}`);
  if (source === 'lan') {
    // 主机关了世界：不硬重连（端口已失效），等下一次局域网广播；
    // 冷却 90 秒防止世界重开瞬间的抖动连踢。
    G.lanCooldownUntil = Date.now() + 90000;
  } else if (source === 'server' && S().autoRejoin && G.endpoint) {
    const { host, port } = G.endpoint;
    if (G.rejoinTimer) clearTimeout(G.rejoinTimer);
    G.rejoinTimer = setTimeout(() => {
      G.rejoinTimer = null;
      if (!G.bot && !G.connecting && S().autoRejoin) {
        G.log(`按计划重连 ${host}:${port}…`);
        connect({ host, port, source: 'server' });
      }
    }, Math.max(5, S().rejoinDelaySec) * 1000);
    G.rejoinTimer.unref?.();
  }
}

function teardownBot() {
  const bot = G.bot;
  G.bot = null;
  G.connecting = null;
  G.spawnedOnce = false;
  G.followName = null;
  G.lastBehavior = '待命';
  G.busyUntil = 0;
  if (G.connectTimeout) { clearTimeout(G.connectTimeout); G.connectTimeout = null; }
  if (G.statusTimer) { clearInterval(G.statusTimer); G.statusTimer = null; }
  stopExplore();
  if (bot) {
    try { bot.removeAllListeners?.(); } catch { /* ignore */ }
    try { bot.quit?.(); } catch { try { bot.end?.(); } catch { /* ignore */ } }
  }
  updateStatus();
}

function disconnect(reasonText = '') {
  const had = Boolean(G.bot);
  teardownBot();
  if (had && S().notifyEvents && reasonText) notifyQQ(`[MC] ${reasonText}`);
  return { ok: true };
}

// ── 自主玩耍引擎（确定性，零 token）────────────────────────────────────────
// 「让它自己去玩」的实现：每隔 exploreIntervalSec 看一眼自己闲不闲，闲就从
// 行为表里抽一件事做。全部是确定性代码，**一个 token 都不烧**。
//
// 三条硬约束（写死在行为表里，不给关闭开关）：
//   ① 不攻击任何生物 —— 本文件没有任何攻击代码；看到敌对生物只会拉开距离；
//   ② 不破坏地形   —— 只有 autoGather 显式打开才砍原木，且每轮只挖一个；
//   ③ 不粘人       —— 只在 8~40 格外看到玩家时"凑过去看看"，4 格外就不再
//                     逼近；绝不用 follow（那是留给明确指令的）。

// 常见方块/生物的中文名（只为了见闻读起来像人话；没收录的原样显示）
const CN_NAME = {
  oak_log: '橡木', spruce_log: '云杉木', birch_log: '白桦木', jungle_log: '丛林木',
  acacia_log: '金合欢木', dark_oak_log: '深色橡木', mangrove_log: '红树木',
  cherry_log: '樱花木', pale_oak_log: '苍白橡木', crimson_stem: '绯红菌柄', warped_stem: '诡异菌柄',
  cow: '牛', pig: '猪', sheep: '羊', chicken: '鸡', horse: '马', donkey: '驴',
  wolf: '狼', cat: '猫', rabbit: '兔子', fox: '狐狸', panda: '熊猫', turtle: '海龟',
  axolotl: '美西螈', goat: '山羊', llama: '羊驼', camel: '骆驼', bee: '蜜蜂',
  parrot: '鹦鹉', frog: '青蛙', sniffer: '嗅探兽', armadillo: '犰狳', bat: '蝙蝠',
  squid: '鱿鱼', dolphin: '海豚', villager: '村民', iron_golem: '铁傀儡', snow_golem: '雪傀儡',
  bell: '钟', composter: '堆肥桶', bed: '床', chest: '箱子', crafting_table: '工作台',
  furnace: '熔炉', torch: '火把', campfire: '营火', lantern: '灯笼',
  zombie: '僵尸', skeleton: '骷髅', creeper: '苦力怕', spider: '蜘蛛', cave_spider: '洞穴蜘蛛',
  enderman: '末影人', witch: '女巫', drowned: '溺尸', husk: '尸壳', stray: '流浪者',
  blaze: '烈焰人', pillager: '掠夺者', vindicator: '卫道士', ravager: '劫掠兽',
  phantom: '幻翼', slime: '史莱姆', magma_cube: '岩浆怪', wither_skeleton: '凋灵骷髅',
  piglin_brute: '猪灵蛮兵', zoglin: '僵尸猪灵', zombie_villager: '僵尸村民',
  evoker: '唤魔者', vex: '恼鬼', guardian: '守卫者', elder_guardian: '远古守卫者',
  shulker: '潜影贝', breeze: '微风', bogged: '沼骸', creaking: '嘎枝',
  warden: '监守者', wither: '凋灵'
};
const cn = (n) => CN_NAME[String(n || '').toLowerCase().replace(/^minecraft:/, '')] || String(n || '');

const LOG_NAMES = ['_log', 'crimson_stem', 'warped_stem'];                       // 可砍的原木
const SITE_NAMES = ['bell', 'composter', 'crafting_table', 'furnace', 'campfire', // 人类痕迹
  'lantern', 'chest', 'bed', 'torch'];

function isHostileEntity(e) {
  const name = String(e?.name || '').toLowerCase();
  return Boolean(name) && HOSTILE.some((h) => name.includes(h));
}

/** 最近的敌对生物（给 flee 用）。 */
function nearestThreat(bot, maxDist) {
  const mine = bot.entity?.position;
  if (!mine) return null;
  let best = null;
  for (const e of Object.values(bot.entities || {})) {
    if (!isHostileEntity(e)) continue;
    const d = e.position?.distanceTo?.(mine);
    if (d == null || d > maxDist) continue;
    if (!best || d < best.d) best = { name: e.name, position: e.position, d };
  }
  return best;
}

/** 最近的玩家（排除自己）。 */
function nearestPlayer(bot, maxDist) {
  const mine = bot.entity?.position;
  if (!mine) return null;
  let best = null;
  for (const [n, player] of Object.entries(bot.players || {})) {
    if (String(n).toLowerCase() === String(bot.username || '').toLowerCase()) continue;
    const pos = player?.entity?.position;
    const d = pos?.distanceTo?.(mine);
    if (d == null || d > maxDist) continue;
    if (!best || d < best.d) best = { name: n, position: pos, d };
  }
  return best;
}

/** 最近的某类实体（掉落物、动物……）。 */
function nearestEntity(bot, predicate, maxDist) {
  const mine = bot.entity?.position;
  if (!mine) return null;
  let best = null;
  for (const e of Object.values(bot.entities || {})) {
    let hit = false;
    try { hit = predicate(e); } catch { hit = false; }
    if (!hit) continue;
    const d = e.position?.distanceTo?.(mine);
    if (d == null || d > maxDist) continue;
    if (!best || d < best.d) best = { name: e.name, position: e.position, d };
  }
  return best;
}

/** 用名字片段找最近的方块（行为选择时才调用，不在热路径上）。 */
function findNearBlock(bot, fragments, maxDist) {
  try {
    if (!bot.findBlock) return null;
    return bot.findBlock({
      matching: (b) => {
        const n = String(b?.name || '');
        return Boolean(n) && fragments.some((f) => n.includes(f));
      },
      maxDistance: maxDist
    }) || null;
  } catch { return null; }
}

function noteSeen(text, { report = false } = {}) {
  const line = String(text || '').trim();
  if (!line) return;
  G.sightings.push(line);
  if (G.sightings.length > 12) G.sightings.shift();
  if (report) maybeReport(line);
}

/** 见闻上报（autoReport 开启时）：严限流，免得刷屏。 */
function maybeReport(line) {
  if (!S().autoReport) return;
  const now = Date.now();
  if (now - G.lastReportAt < 120000) return;                  // 至少间隔 2 分钟
  if (G.reportHour.key !== hourKey()) G.reportHour = { key: hourKey(), count: 0 };
  if (G.reportHour.count >= 6) return;                        // 每小时最多 6 条
  G.lastReportAt = now;
  G.reportHour.count += 1;
  notifyQQ(`[MC] ${line}`);
}

/** 行为表：按当前处境给候选 + 权重。遇险时短路成「先跑」。 */
function behaviorCandidates(bot, s) {
  if (!bot.entity?.position) return [];

  // ③ 遇险优先：24 格内有敌对生物 → 只剩一个选项
  const threat = nearestThreat(bot, 24);
  if (threat) return [{ id: 'flee', w: 200, arg: threat }];

  const out = [
    { id: 'wander', w: 34 },   // 换个方向走走（主基调）
    { id: 'look', w: 20 },     // 原地张望（最像待机的动作）
    { id: 'sprint', w: 11 },   // 小跑一段
    { id: 'jump', w: 6 }       // 原地蹦一下
  ];

  // 看到玩家 → 凑过去看看（只在 8 格外才动，避免贴脸烦人）
  const pal = nearestPlayer(bot, 40);
  if (pal && pal.d > 8) out.push({ id: 'visit', w: 26, arg: pal });

  // 掉在地上的东西 → 去捡
  const drop = nearestEntity(bot, (e) => String(e?.name) === 'item', 16);
  if (drop) out.push({ id: 'pickup', w: 26, arg: drop });

  // 动物 → 悄悄走近观察
  const animal = nearestEntity(bot,
    (e) => e?.type === 'animal' || e?.type === 'water_creature' || e?.kind === 'animal', 22);
  if (animal) out.push({ id: 'watch', w: 16, arg: animal });

  // 人类痕迹（村庄/营地/屋子）→ 过去看看
  const site = findNearBlock(bot, SITE_NAMES, 32);
  if (site) out.push({ id: 'site', w: 18, arg: site });

  // ② 采集：只有显式开启 autoGather 才会出现
  if (s.autoGather) {
    const log = findNearBlock(bot, LOG_NAMES, 24);
    if (log) out.push({ id: 'gather', w: 30, arg: log });
  }
  return out;
}

function pickBehavior(list) {
  const total = list.reduce((a, b) => a + b.w, 0);
  if (!total) return null;
  let r = Math.random() * total;
  for (const item of list) { r -= item.w; if (r <= 0) return item; }
  return list[list.length - 1];
}

/** 执行一个行为；返回一句给人看的说明（同时写进 lastBehavior）。 */
function runBehavior(bot, lib, b, s) {
  const pf = bot.pathfinder;
  const mine = bot.entity?.position;
  const nearPos = (pos, range) => new lib.pf.goals.GoalNear(
    Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z), range
  );

  switch (b.id) {
    case 'flee': {
      const d = b.arg;
      const dx = mine.x - d.position.x;
      const dz = mine.z - d.position.z;
      const len = Math.hypot(dx, dz) || 1;
      const x = Math.floor(mine.x + (dx / len) * 26);
      const z = Math.floor(mine.z + (dz / len) * 26);
      pf.setGoal(new lib.pf.goals.GoalNearXZ(x, z, 3));
      G.stats.fled += 1;
      noteSeen(`发现${cn(d.name)}，先拉开距离`, { report: true });
      return `躲开${cn(d.name)}`;
    }
    case 'look': {
      try { bot.look(Math.random() * Math.PI * 2 - Math.PI, Math.random() * 0.8 - 0.4, true); } catch { /* ignore */ }
      return '四处张望';
    }
    case 'jump': {
      try {
        bot.setControlState('jump', true);
        const t = setTimeout(() => { try { bot.setControlState('jump', false); } catch { /* ignore */ } }, 450);
        t.unref?.();
      } catch { /* ignore */ }
      return '原地蹦跶';
    }
    case 'sprint': {
      try {
        bot.look(Math.random() * Math.PI * 2 - Math.PI, 0, true);
        bot.setControlState('forward', true);
        bot.setControlState('sprint', true);
        const t = setTimeout(() => {
          try { bot.setControlState('forward', false); bot.setControlState('sprint', false); } catch { /* ignore */ }
        }, 1600);
        t.unref?.();
      } catch { /* ignore */ }
      return '小跑一段';
    }
    case 'visit': {
      pf.setGoal(nearPos(b.arg.position, 4));
      noteSeen(`看到 ${b.arg.name}，凑过去看看`, { report: true });
      return `去看 ${b.arg.name}`;
    }
    case 'watch': {
      pf.setGoal(nearPos(b.arg.position, 3));
      noteSeen(`发现一只${cn(b.arg.name)}，走近看`);
      return `观察${cn(b.arg.name)}`;
    }
    case 'pickup': {
      pf.setGoal(nearPos(b.arg.position, 1));
      return '去捡地上的东西';
    }
    case 'site': {
      pf.setGoal(nearPos(b.arg.position, 4));
      noteSeen(`发现${cn(b.arg.name)}，像是有人来过，过去看看`, { report: true });
      return `探索${cn(b.arg.name)}`;
    }
    case 'gather': {
      const block = b.arg;
      const pos = block.position;
      pf.setGoal(nearPos(pos, 2));
      // 走到附近再动手（异步、不阻塞；一次只挖一个，避免把树剃光）
      const t = setTimeout(async () => {
        try {
          const cur = bot.blockAt(new lib.Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)));
          if (!cur || /air|void/.test(String(cur?.name || ''))) return;
          const d = bot.entity?.position?.distanceTo?.(pos);
          if (d == null || d > 4.5) return;
          await bot.dig(cur);
          G.stats.gathered += 1;
          noteSeen(`砍了 ${cn(cur.name)}`);
        } catch { /* 砍不动就算了，下一轮换别的 */ }
      }, 9000);
      t.unref?.();
      return '去砍点木头';
    }
    case 'wander':
    default: {
      const r = s.exploreRange;
      const ang = Math.random() * Math.PI * 2;
      const dist = r * (0.4 + Math.random() * 0.6);
      const x = Math.floor(mine.x + Math.cos(ang) * dist);
      const z = Math.floor(mine.z + Math.sin(ang) * dist);
      pf.setGoal(new lib.pf.goals.GoalNearXZ(x, z, 2));
      return '到处走走';
    }
  }
}

// 自言自语台词（零 token 的「在玩」感；默认开，但限频很严）
const IDLE_LINES = [
  '这片地方看着还行', '嗯……接下来去哪儿好呢', '走走看看', '咦，那边好像有什么',
  '有点想挖点什么了', '这附近挺安静的', '不知道天黑之前能走多远'
];

function maybeChatter(bot, s) {
  if (!s.autoChatter) return;
  const now = Date.now();
  if (now - G.lastChatterAt < 60000) return;                 // 至少间隔 60 秒
  if (G.chatterHour.key !== hourKey()) G.chatterHour = { key: hourKey(), count: 0 };
  if (G.chatterHour.count >= 3) return;                      // 每小时最多 3 句
  if (Math.random() > 0.22) return;                          // 只有约 1/5 机会真开口
  G.lastChatterAt = now;
  G.chatterHour.count += 1;
  const line = IDLE_LINES[Math.floor(Math.random() * IDLE_LINES.length)];
  try {
    bot.chat(line);
    recordSelfMc(`（自言自语）${line}`);
  } catch { /* 说不了就算了 */ }
}

function startExplore() {
  stopExplore();
  const sec = clamp(S().exploreIntervalSec, 5, 600, 12);
  G.exploreTimer = setInterval(() => { try { exploreTick(); } catch { /* ignore */ } }, sec * 1000);
  G.exploreTimer.unref?.();
}

function stopExplore() {
  if (G.exploreTimer) { clearInterval(G.exploreTimer); G.exploreTimer = null; }
}

/** 每 tick：闲不闲？闲就在行为表里抽一件事做。 */
function exploreTick() {
  const s = S();
  const bot = G.bot;
  if (!bot || !s.autoExplore || !G.wanderOn) return;
  if (G.followName) return;                     // 正在跟人，别打断
  if (bot.pathfinder?.goal) return;             // 正在赶路
  if (Date.now() < G.busyUntil) return;         // 刚做完一个动作，歇会儿
  const lib = loadLib();
  if (!lib || !bot.pathfinder) return;

  const b = pickBehavior(behaviorCandidates(bot, s));
  if (!b) return;
  try {
    G.lastBehavior = runBehavior(bot, lib, b, s);
    G.stats.explores += 1;
    G.busyUntil = Date.now() + (b.id === 'look' || b.id === 'jump' ? 3000 : 1500);
    if (b.id === 'wander' || b.id === 'look') maybeChatter(bot, s);
  } catch { /* 这一轮走不了就下一轮再说 */ }
}

// ── 游戏聊天处理（!命令 + 监听 + 注入/镜像）────────────────────────────────
function mentionsMe(text) {
  const t = String(text ?? '').toLowerCase();
  if (!t) return false;
  const bot = G.bot;
  const names = [
    S().username,
    bot?.username,
    String(getConfig()?.persona?.botName || ''),
    String(getConfig()?.persona?.selfNickname || '')
  ];
  for (const n of names) {
    const v = String(n || '').trim().toLowerCase();
    if (v && t.includes(v)) return true;
  }
  return false;
}

function onMcChat(username, message) {
  const s = S();
  const text = String(message ?? '').trim();
  if (!text) return;
  if (!username || (G.bot && String(username) === G.bot.username)) return; // 自己说的不入库
  G.stats.chats += 1;

  // ① !命令：确定性、零 token、即时在游戏里回应
  if (s.mcCommands && /^[!！]/.test(text)) {
    handleMcCommand(username, text.replace(/^[!！]\s*/, ''));
    return;
  }

  // ② 聊天监听
  if (s.chatMonitor === 'off') return;
  const mentioned = mentionsMe(text);
  if (s.chatMonitor === 'mentions' && !mentioned) return;

  // ③ 镜像（可选，独立于监听）
  if (s.relayToQQ) relayLine(username, text);

  // ④ 注入绑定群存档：叫名字的补 @前缀（档位判定按「被艾特」必定唤醒），
  //    其余原样入库——是否唤醒完全交给 app 的响应档位，本技能不私自烧 token。
  injectChat(username, text, { atPrefix: mentioned });
}

function handleMcCommand(username, cmdText) {
  const bot = G.bot;
  if (!bot) return;
  const cmd = String(cmdText || '').trim().toLowerCase();
  const say = (t) => { try { bot.chat(String(t).slice(0, 150)); } catch { /* ignore */ } };
  G.stats.commands += 1;

  if (/^(come|来|过来|来这|来我这|过来这)/.test(cmd)) {
    const r = moveCome(username);
    say(r.ok ? `${username}，这就过去` : `过不去：${r.error}`);
    return;
  }
  if (/^(follow|跟随|跟着|跟上)/.test(cmd)) {
    const name = String(cmdText).replace(/^(follow|跟随|跟着|跟上)\s*/i, '').trim() || username;
    const r = moveFollow(name);
    say(r.ok ? `好，我跟着 ${name}` : `跟不上：${r.error}`);
    return;
  }
  if (/^(stop|停|停下|别动|站住)/.test(cmd)) {
    stopMoving();
    say('好的，我停了');
    return;
  }
  if (/^(status|状态|在哪|位置|坐标)/.test(cmd)) {
    const p = bot.entity?.position;
    say(p ? `我在 (${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})，血 ${Math.floor(bot.health ?? 20)}/20` : '位置未知');
    return;
  }
  if (/^(help|帮助|命令|指令)/.test(cmd)) {
    say('可用：!来 | !跟随 [名字] | !停 | !状态');
    return;
  }
  say('没听懂。可用：!来 / !跟随 / !停 / !状态');
}

// ── 移动原语 ───────────────────────────────────────────────────────────────
function findPlayer(name) {
  const bot = G.bot;
  if (!bot) return null;
  const want = String(name || '').trim().toLowerCase();
  const entries = Object.entries(bot.players || {})
    .filter(([n]) => String(n).toLowerCase() !== String(bot.username || '').toLowerCase());
  if (!entries.length) return null;
  if (want) {
    const hit = entries.find(([n]) => String(n).toLowerCase().includes(want));
    if (hit) return { name: hit[0], player: hit[1] };
    return null;
  }
  // 没给名字：挑最近的（有实体可见的）
  let best = null;
  for (const [n, player] of entries) {
    const d = player?.entity?.position?.distanceTo?.(bot.entity?.position);
    if (d != null && (best == null || d < best.d)) best = { name: n, player, d };
  }
  return best || null;
}

function moveGoto(x, y, z) {
  const bot = G.bot;
  const lib = loadLib();
  if (!bot) return { ok: false, error: '分身不在线' };
  if (!lib || !bot.pathfinder) return { ok: false, error: '寻路模块不可用' };
  try {
    bot.pathfinder.setGoal(new lib.pf.goals.GoalNear(x, y, z, 1));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

function moveCome(name) {
  const found = findPlayer(name);
  if (!found || !found.player?.entity) {
    return { ok: false, error: '看不到这个玩家（不在视野里或名字不对）' };
  }
  const pos = found.player.entity.position;
  return moveGoto(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
}

function moveFollow(name) {
  const bot = G.bot;
  const lib = loadLib();
  const found = findPlayer(name);
  if (!found || !found.player?.entity) return { ok: false, error: '看不到这个玩家（不在视野里或名字不对）' };
  if (!lib || !bot.pathfinder) return { ok: false, error: '寻路模块不可用' };
  try {
    bot.pathfinder.setGoal(new lib.pf.goals.GoalFollow(found.player.entity, 3), true);
    G.followName = found.name;
    return { ok: true, name: found.name };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

function stopMoving() {
  const bot = G.bot;
  G.followName = null;
  G.wanderOn = false; // 停 = 当下不动 + 暂停自己玩（wander 指令恢复）
  G.lastBehavior = '待命';
  G.busyUntil = 0;
  try {
    // 关掉 sprint/forward 这类手动控制状态，否则 setGoal(null) 后会继续滑
    bot?.setControlState?.('forward', false);
    bot?.setControlState?.('sprint', false);
    bot?.setControlState?.('jump', false);
    bot?.pathfinder?.setGoal(null);
  } catch { /* ignore */ }
}

// ── 状态快照（status provider 与工具共用）──────────────────────────────────
const HOSTILE = ['zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman',
  'witch', 'drowned', 'husk', 'stray', 'blaze', 'pillager', 'vindicator', 'ravager',
  'phantom', 'slime', 'magma_cube', 'wither_skeleton', 'piglin_brute', 'zoglin',
  'zombie_villager', 'evoker', 'vex', 'guardian', 'elder_guardian', 'shulker',
  'breeze', 'bogged', 'creaking', 'warden', 'wither'];

function startStatusTimer() {
  if (G.statusTimer) clearInterval(G.statusTimer);
  G.statusTimer = setInterval(() => { try { updateStatus(); } catch { /* ignore */ } }, 30000);
  G.statusTimer.unref?.();
}

function updateStatus() {
  const bot = G.bot;
  if (!bot) {
    G.lastStatus = {
      connected: false,
      username: resolvedName(),
      lastError: G.lastError,
      bound: boundChatKey(),
      lan: S().lanAutoJoin,
      stats: { ...G.stats }
    };
    return;
  }
  const p = bot.entity?.position;
  G.lastStatus = {
    connected: true,
    username: bot.username,
    version: bot.version,
    endpoint: G.endpoint ? `${G.endpoint.host}:${G.endpoint.port}` : '',
    source: G.endpoint?.source || '',
    pos: p ? [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)] : null,
    health: Math.floor(bot.health ?? 20),
    food: Math.floor(bot.food ?? 20),
    doing: G.followName ? `跟随 ${G.followName}`
      : (bot.pathfinder?.goal ? `赶路中（${G.lastBehavior}）`
        : (G.wanderOn && S().autoExplore ? G.lastBehavior : '待命')),
    lastError: G.lastError,
    bound: boundChatKey(),
    stats: { ...G.stats }
  };
}

function statusBrief() {
  const st = G.lastStatus || {};
  if (!st.connected) {
    return `离线${st.lastError ? `（上次错误：${String(st.lastError).slice(0, 120)}）` : ''}`
      + `${st.lan ? '，正在守局域网广播' : ''}`;
  }
  return `${st.username} 在线 @ ${st.endpoint}${st.version ? `（${st.version}）` : ''}`
    + `，${st.doing}，血 ${st.health}/20`;
}

/** 观察报告：一次给足态势，避免模型连环查询（省 token 的关键一招）。 */
function observeReport() {
  const bot = G.bot;
  updateStatus();
  const st = G.lastStatus;
  const lines = [];
  lines.push(`在线：${st.username} @ ${st.endpoint}${st.version ? `（${st.version}，${st.source === 'lan' ? '局域网世界' : st.source === 'server' ? '联机服务器' : '手动连接'}）` : ''}`);
  if (st.pos) lines.push(`位置：(${st.pos.join(', ')}) | 血量 ${st.health}/20 | 食物 ${st.food}/20 | 状态：${st.doing}`);

  // 玩家（带距离）
  try {
    const mine = bot.entity?.position;
    const players = Object.entries(bot.players || {})
      .filter(([n]) => n !== bot.username)
      .map(([n, player]) => {
        const d = player?.entity?.position && mine ? Math.floor(player.entity.position.distanceTo(mine)) : null;
        return { n, d };
      })
      .sort((a, b) => (a.d ?? 9999) - (b.d ?? 9999))
      .slice(0, 8);
    if (players.length) lines.push(`玩家(${players.length})：${players.map((p) => `${p.n}${p.d != null ? `(${p.d}格)` : '(远处)'}`).join('、')}`);
    else lines.push('玩家：视野内没有其他玩家');
  } catch { /* ignore */ }

  // 威胁
  try {
    const mine = bot.entity?.position;
    const threats = new Map();
    for (const e of Object.values(bot.entities || {})) {
      const name = String(e.name || e.displayName || '').toLowerCase();
      if (!name || !HOSTILE.some((h) => name.includes(h))) continue;
      const d = e.position && mine ? e.position.distanceTo(mine) : 999;
      if (d > 24) continue;
      threats.set(name, (threats.get(name) || 0) + 1);
    }
    if (threats.size) lines.push(`威胁：${[...threats.entries()].map(([n, c]) => `${n}×${c}`).join('、')}（24格内）`);
  } catch { /* ignore */ }

  // 背包摘要
  try {
    const items = bot.inventory?.items?.() || [];
    if (items.length) {
      const byName = new Map();
      for (const it of items) byName.set(it.name, (byName.get(it.name) || 0) + (it.count || 1));
      const summary = [...byName.entries()].slice(0, 12).map(([n, c]) => `${n}×${c}`).join('、');
      lines.push(`背包(${items.length}格)：${summary}${byName.size > 12 ? ' …' : ''}`);
    } else lines.push('背包：空');
    if (bot.heldItem) lines.push(`手持：${bot.heldItem.name}`);
  } catch { /* ignore */ }

  if (st.lastError) lines.push(`上次异常：${String(st.lastError).slice(0, 100)}`);
  // 最近见闻：它自己在玩的时候看到的（零 token 记录的，问它"刚才干嘛了"能答上）
  if (G.sightings.length) lines.push(`最近见闻：${G.sightings.slice(-6).reverse().join('；')}`);
  return lines.join('\n');
}

// ── 记录自己在游戏里说过的话（存档留痕，下一轮它才记得自己说过什么）────────
function recordSelfMc(text) {
  try {
    const target = boundChatKey();
    if (!target || !G.core.store?.appendSelf) return;
    G.core.store.appendSelf(target, { text: `[MC] ${String(text).slice(0, 200)}`, ts: Date.now() });
    G.core.emit?.('chat-update', target);
  } catch { /* 留痕失败不影响动作 */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// 工具注册（模型面向 QQ 侧自然语言的入口）
// ═══════════════════════════════════════════════════════════════════════════

function registerTools(api) {
  // ── mc_control：上线 / 下线 / 查状态 ────────────────────────────────────
  api.registerTool({
    id: 'mc_control',
    name: 'MC 分身控制',
    description: '控制你的 Minecraft 分身：上线（connect）、下线（disconnect）、查状态（status）。connect 不填地址时连设置里配置的服务器；主机开单机世界的话等它对局域网开放后几秒内会自动加入，无需调用。',
    category: 'query',
    icon: '🎮',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'connect', 'disconnect'], description: 'status=查状态；connect=上线；disconnect=下线' },
        host: { type: 'string', description: '可选：本次连接的服务器地址（IP/域名，不含端口）' },
        port: { type: 'number', description: '可选：端口，默认用设置里的（25565）' },
        version: { type: 'string', description: '可选：MC 版本如 1.20.4，留空自动探测' }
      },
      required: ['action']
    },
    async execute(ctx, args) {
      try {
        captureCore(ctx);
        const action = String(args?.action || 'status');
        if (action === 'status') {
          updateStatus();
          return ok(`${statusBrief()}；累计：进游戏 ${G.stats.joins} 次、探索 ${G.stats.explores} 次、听到游戏聊天 ${G.stats.chats} 条${G.lastStatus.bound ? `；聊天桥：${G.lastStatus.bound}` : '；聊天桥未绑定（在某个群里让我上线即可自动绑定）'}`);
        }
        if (action === 'disconnect') {
          if (!G.bot) return ok('分身本来就不在线。');
          disconnect('我下线了，需要再叫我。');
          return ok('已下线。不要输出汇报，简短回应即可。');
        }
        if (action === 'connect') {
          const r = connect({
            host: args?.host,
            port: args?.port,
            version: args?.version,
            source: 'manual'
          });
          if (!r.ok) return err(r.error);
          if (r.already) return ok(`分身已在线：${statusBrief()}`);
          return ok(`已开始连接 ${r.host}:${r.port}（版本${args?.version || '自动探测'}）。进入游戏需要几秒到十几秒，之后我会自动开始闲逛；连上/失败会有通知，先简短告诉用户「正在进游戏」即可。`);
        }
        return err(`未知 action：${action}`);
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  // ── mc_observe：观察态势（一次给全）────────────────────────────────────
  api.registerTool({
    id: 'mc_observe',
    name: 'MC 观察',
    description: '查看分身在游戏里的完整态势：在线状态、位置、血量、附近玩家与怪物、背包摘要、正在做什么。了解游戏内情况优先用它，别反复调用。',
    category: 'query',
    icon: '👀',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      try {
        captureCore(ctx);
        if (!G.bot) {
          const hint = G.connecting
            ? `正在连接 ${G.connecting.host}:${G.connecting.port}，还没进游戏，稍后再查。`
            : `分身不在线${G.lastError ? `（上次错误：${String(G.lastError).slice(0, 120)}）` : ''}。要上线用 mc_control connect。`;
          return err(hint);
        }
        return ok(observeReport());
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  // ── mc_chat：在游戏里说话 ───────────────────────────────────────────────
  api.registerTool({
    id: 'mc_chat',
    name: 'MC 说话',
    description: '让分身在 Minecraft 聊天框发一条消息。游戏里的玩家只有通过这条才能看到你说的话——直接往 QQ 群发消息游戏里的人看不到。',
    category: 'query',
    icon: '💬',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要说的内容（游戏聊天上限约 256 字，超长会截断）' }
      },
      required: ['text']
    },
    async execute(ctx, args) {
      try {
        captureCore(ctx);
        const text = String(args?.text ?? '').trim();
        if (!text) return err('内容为空');
        if (!G.bot) return err('分身不在线，先 mc_control connect。');
        G.bot.chat(text.slice(0, 200));
        recordSelfMc(text);
        return ok('已在游戏聊天框发出。不要复述，继续下一步或收尾。');
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  // ── mc_cmd：执行游戏指令 ────────────────────────────────────────────────
  api.registerTool({
    id: 'mc_cmd',
    name: 'MC 指令',
    description: '以分身名义执行一条 Minecraft 命令（如 tp、give、gamemode）。带 / 不带 / 都行。需要管理员权限的命令在没权限的服务器会被拒绝，如实把失败原因告诉用户即可。',
    category: 'query',
    icon: '⌨️',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '命令内容，如 "tp Steve" 或 "/give @s bread 8"' }
      },
      required: ['command']
    },
    async execute(ctx, args) {
      try {
        captureCore(ctx);
        const raw = String(args?.command ?? '').trim();
        if (!raw) return err('命令为空');
        if (!G.bot) return err('分身不在线，先 mc_control connect。');
        const cmd = raw.startsWith('/') ? raw.slice(1) : raw;
        G.bot.chat(`/${cmd}`.slice(0, 250));
        recordSelfMc(`/${cmd}`);
        return ok(`已提交命令 /${cmd}。若需要权限可能被服务器拒绝，结果不会自动回传，重要操作可用 mc_observe 验证。`);
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  // ── mc_move：移动（异步，下达即返回）────────────────────────────────────
  api.registerTool({
    id: 'mc_move',
    name: 'MC 移动',
    description: '让分身移动：goto=去坐标；come=去某玩家身边；follow=持续跟随某人；stop=停下（并暂停闲逛）；wander=恢复自动闲逛。移动是异步的，下达后先简短回应，稍后用 mc_observe 确认。',
    category: 'query',
    icon: '🧭',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['goto', 'come', 'follow', 'stop', 'wander'], description: '移动方式' },
        x: { type: 'number', description: 'goto 用：目标 X 坐标' },
        y: { type: 'number', description: 'goto 用：目标 Y 坐标' },
        z: { type: 'number', description: 'goto 用：目标 Z 坐标' },
        player: { type: 'string', description: 'come/follow 用：玩家名（come 留空=最近的玩家）' }
      },
      required: ['mode']
    },
    async execute(ctx, args) {
      try {
        captureCore(ctx);
        if (!G.bot) return err('分身不在线，先 mc_control connect。');
        const mode = String(args?.mode || '');
        if (mode === 'stop') {
          stopMoving();
          return ok('已停下，并暂停了自己玩（wander 可恢复）。');
        }
        if (mode === 'wander') {
          G.wanderOn = true;
          G.lastBehavior = '待命';
          G.busyUntil = 0;
          exploreTick();
          return ok('已恢复自己玩。它会自己到处走走、看看四周、遇到玩家凑过去看看、躲开怪物（采集按设置开关）。');
        }
        if (mode === 'goto') {
          const nums = ['x', 'y', 'z'].map((k) => Number(args?.[k]));
          if (nums.some((n) => !Number.isFinite(n))) return err('goto 需要 x/y/z 三个数字坐标（用 mc_observe 查玩家位置）。');
          const [x, y, z] = nums.map((n) => Math.min(1e7, Math.max(-1e7, Math.round(n))));
          const r = moveGoto(x, y, z);
          if (!r.ok) return err(r.error);
          return ok(`已出发前往 (${x}, ${y}, ${z})，路远需要时间，稍后用 mc_observe 确认是否到达。`);
        }
        if (mode === 'come') {
          const r = moveCome(args?.player || '');
          if (!r.ok) return err(r.error);
          return ok(`已出发前往 ${args?.player || '最近的玩家'}，稍后用 mc_observe 确认。`);
        }
        if (mode === 'follow') {
          const name = String(args?.player || '').trim();
          if (!name) return err('follow 需要玩家名（mc_observe 里能看到在场玩家）。');
          const r = moveFollow(name);
          if (!r.ok) return err(r.error);
          return ok(`已开始跟随 ${r.name}（保持约 3 格距离），stop 可解除。`);
        }
        return err(`未知 mode：${mode}`);
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  // ── mc_dig：挖方块 ──────────────────────────────────────────────────────
  api.registerTool({
    id: 'mc_dig',
    name: 'MC 挖方块',
    description: '挖掉指定坐标的一个方块（生存模式需要时间，工具最长等 30 秒）。先 mc_observe 确认坐标再挖，别盲挖。',
    category: 'query',
    icon: '⛏️',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X 坐标' },
        y: { type: 'number', description: 'Y 坐标' },
        z: { type: 'number', description: 'Z 坐标' }
      },
      required: ['x', 'y', 'z']
    },
    async execute(ctx, args) {
      try {
        captureCore(ctx);
        const bot = G.bot;
        const lib = loadLib();
        if (!bot) return err('分身不在线，先 mc_control connect。');
        if (!lib) return err('依赖未就绪');
        const nums = ['x', 'y', 'z'].map((k) => Number(args?.[k]));
        if (nums.some((n) => !Number.isFinite(n))) return err('需要 x/y/z 三个数字坐标。');
        const [x, y, z] = nums.map((n) => Math.min(1e7, Math.max(-1e7, Math.round(n))));
        const block = bot.blockAt(new lib.Vec3(x, y, z));
        if (!block || /air|void/.test(String(block?.name || ''))) return err(`(${x}, ${y}, ${z}) 是空气，没东西可挖。`);
        if (block.name === 'bedrock' || block.unbreakable) return err(`${block.name} 挖不动（基岩类）。`);
        try {
          await Promise.race([bot.dig(block), await0(30000)]);
        } catch (digError) {
          return err(`挖掘失败：${String(digError?.message ?? digError)}（可能是距离太远或工具不合适）`);
        }
        recordSelfMc(`（挖掉了 ${block.name} @ ${x},${y},${z}）`);
        return ok(`已挖掉 ${block.name}（${x}, ${y}, ${z}）。`);
      } catch (error) {
        return err(String(error?.message ?? error));
      }
    }
  });

  // ── mc_place：放方块 ────────────────────────────────────────────────────
  api.registerTool({
    id: 'mc_place',
    name: 'MC 放方块',
    description: '从背包拿一种方块放到指定坐标（该处必须是空气）。item 填背包里的方块名（mc_observe 的背包摘要里有），留空=背包里第一种方块。',
    category: 'query',
    icon: '🧱',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X 坐标' },
        y: { type: 'number', description: 'Y 坐标' },
        z: { type: 'number', description: 'Z 坐标' },
        item: { type: 'string', description: '可选：方块名（如 stone、oak_planks）' }
      },
      required: ['x', 'y', 'z']
    },
    async execute(ctx, args) {
      try {
        captureCore(ctx);
        const bot = G.bot;
        const lib = loadLib();
        if (!bot) return err('分身不在线，先 mc_control connect。');
        if (!lib) return err('依赖未就绪');
        const nums = ['x', 'y', 'z'].map((k) => Number(args?.[k]));
        if (nums.some((n) => !Number.isFinite(n))) return err('需要 x/y/z 三个数字坐标。');
        const [x, y, z] = nums.map((n) => Math.min(1e7, Math.max(-1e7, Math.round(n))));
        const target = bot.blockAt(new lib.Vec3(x, y, z));
        if (target && !/air|void/.test(String(target?.name || ''))) return err(`(${x}, ${y}, ${z}) 不是空的（是 ${target.name}）。`);

        // 找一个相邻的实体方块作为放置参照
        const faces = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
        let ref = null;
        let face = null;
        for (const [dx, dy, dz] of faces) {
          const b = bot.blockAt(new lib.Vec3(x - dx, y - dy, z - dz));
          if (b && b.boundingBox === 'block' && !/air|void/.test(String(b?.name || ''))) {
            ref = b;
            face = new lib.Vec3(dx, dy, dz);
            break;
          }
        }
        if (!ref) return err(`(${x}, ${y}, ${z}) 周围没有可以贴着放的实体方块（悬空放不了）。`);

        // 找物品
        const want = String(args?.item || '').trim().toLowerCase();
        const items = bot.inventory?.items?.() || [];
        const item = want
          ? items.find((it) => String(it.name).toLowerCase().includes(want))
          : items.find((it) => it.name && !['sword', 'pickaxe', 'axe', 'shovel', 'hoe', 'bow', 'food', 'apple', 'bread'].some((w) => String(it.name).includes(w)));
        if (!item) {
          const names = [...new Set(items.map((it) => it.name))].slice(0, 10).join('、');
          return err(`背包里没有${want ? `「${want}」` : '可放置的方块'}。背包现有：${names || '空'}`);
        }
        await bot.equip(item, 'hand');
        await bot.placeBlock(ref, face);
        recordSelfMc(`（把 ${item.name} 放在了 ${x},${y},${z}）`);
        return ok(`已把 ${item.name} 放在 (${x}, ${y}, ${z})。`);
      } catch (error) {
        return err(String(error?.message ?? error));
      }
    }
  });

  // ── mc_inventory：背包操作 ──────────────────────────────────────────────
  api.registerTool({
    id: 'mc_inventory',
    name: 'MC 背包',
    description: '查看/操作背包：list=列出物品；equip=把某物品拿到手上；drop=丢弃某物品。详细摘要其实 mc_observe 已带，只有要专门操作时才用这个。',
    category: 'query',
    icon: '🎒',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'equip', 'drop'], description: 'list=列出；equip=拿到手上；drop=丢一组' },
        item: { type: 'string', description: 'equip/drop 用：物品名（模糊匹配）' }
      },
      required: ['action']
    },
    async execute(ctx, args) {
      try {
        captureCore(ctx);
        const bot = G.bot;
        if (!bot) return err('分身不在线，先 mc_control connect。');
        const action = String(args?.action || 'list');
        const items = bot.inventory?.items?.() || [];
        if (action === 'list') {
          if (!items.length) return ok('背包是空的。');
          const byName = new Map();
          for (const it of items) byName.set(it.name, (byName.get(it.name) || 0) + (it.count || 1));
          return ok(`手持：${bot.heldItem?.name || '无'}\n` + [...byName.entries()].map(([n, c]) => `${n}×${c}`).join('、'));
        }
        const want = String(args?.item || '').trim().toLowerCase();
        if (!want) return err('equip/drop 需要物品名。');
        const item = items.find((it) => String(it.name).toLowerCase().includes(want));
        if (!item) return err(`背包里没有「${want}」。`);
        if (action === 'equip') {
          await bot.equip(item, 'hand');
          return ok(`已把 ${item.name} 拿到手上。`);
        }
        if (action === 'drop') {
          await bot.tossStack(item);
          return ok(`已丢弃 ${item.name}×${item.count || 1}。`);
        }
        return err(`未知 action：${action}`);
      } catch (error) {
        return err(String(error?.message ?? error));
      }
    }
  });
}

// mc_dig 挖掘超时（30 秒）：防呆不挂起会话
function await0(ms) {
  return new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error(`挖掘超时（${Math.round(ms / 1000)} 秒）`)), ms);
    t.unref?.();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 生命周期（setup / available / activate / deactivate / dispose）
// ═══════════════════════════════════════════════════════════════════════════

export function setup(api) {
  G.cfg = api.config || G.cfg;
  G.log = (...a) => { try { api.log?.(...a); } catch { /* ignore */ } };
  G.warn = (...a) => { try { (api.warn ?? api.log)?.(...a); } catch { /* ignore */ } };

  patchOnebot();
  registerTools(api);

  const s = S();
  if (s.qqGroup && /^\d+$/.test(s.qqGroup)) G.boundChatKey = `group:${s.qqGroup}`;
  startLan();
  if (s.autoConnect && s.host) connect({ source: 'auto' });

  G.log(`已加载：MC 分身「${resolvedName()}」；局域网自动加入 ${s.lanAutoJoin ? '开' : '关'}`
    + `，自己玩 ${s.autoExplore ? `开（每 ${s.exploreIntervalSec}s）` : '关'}`
    + `，采集 ${s.autoGather ? '开' : '关'}，自言自语 ${s.autoChatter ? '开' : '关'}`
    + `，游戏聊天监听 ${s.chatMonitor}，!命令 ${s.mcCommands ? '开' : '关'}`
    + `${loadLib() ? '' : `；⚠️ 依赖未就绪：${G.lastDepsError}`}`
    + `${HOST_INFO.standalone ? '；⚠️ 未找到 QQ Agent 宿主，QQ 聊天桥停用（MC 侧与游戏内 !命令正常）' : ''}`);
}

export function available() {
  if (!loadLib()) {
    return { ok: false, reason: `mineflayer 依赖未安装（${G.lastDepsError || '在 resources/app 目录执行 npm install mineflayer mineflayer-pathfinder'}）` };
  }
  return { ok: true };
}

export function activate() {
  // 认领共享状态（热重载后 bot 可能还连着）；固定绑定群重新套上
  const s = S();
  if (s.qqGroup && /^\d+$/.test(s.qqGroup)) G.boundChatKey = `group:${s.qqGroup}`;
  startLan();
  if (G.bot) {
    startExplore();
    startStatusTimer();
  } else if (s.autoConnect && s.host && !G.connecting) {
    connect({ source: 'auto' });
  }
}

export function deactivate(context = {}) {
  // 热重载：让位但不拆台（新实例 setup 会认领 globalThis 里的连接与监听）
  if (context?.reason === 'reload') return;
  teardownAll();
}

export function dispose() {
  teardownAll();
}

function teardownAll() {
  if (G.bot) disconnect('技能已停用，我下线了。');
  stopExplore();
  if (G.statusTimer) { clearInterval(G.statusTimer); G.statusTimer = null; }
  if (G.rejoinTimer) { clearTimeout(G.rejoinTimer); G.rejoinTimer = null; }
  if (G.relayTimer) { clearTimeout(G.relayTimer); G.relayTimer = null; }
  if (G.lanSocket) {
    try { G.lanSocket.close(); } catch { /* ignore */ }
    G.lanSocket = null;
  }
  G.pending.length = 0;
}

// ── before-context：抓 store（typo-sim 同款兜底通道）────────────────────────
export const hooks = {
  'before-context': (ctx) => {
    captureCore(ctx);
  }
};

// ── 状态上报（ai-status 面板）：同步、零 IO ─────────────────────────────────
export const providers = {
  'status.mc-bot': () => {
    const st = G.lastStatus || {};
    const s = S();
    if (!st.connected) {
      return {
        icon: '🎮',
        title: 'MC 分身',
        lines: [
          ['状态', s.lanAutoJoin ? '离线 · 守着局域网广播' : '离线'],
          ['累计', `进游戏 ${G.stats.joins} 次`],
          ['监听', `游戏聊天 ${s.chatMonitor}${s.mcCommands ? ' + !命令' : ''}${s.autoGather ? ' · 允许采集' : ''}`]
        ],
        tips: G.lastDepsError ? ['依赖未安装'] : (G.lastError ? [String(G.lastError).slice(0, 60)] : []),
        priority: 60
      };
    }
    return {
      icon: '🎮',
      title: 'MC 分身',
      lines: [
        ['在线', `${st.username} @ ${st.endpoint}${st.version ? `（${st.version}）` : ''}`],
        ['位置', st.pos ? `(${st.pos.join(', ')})` : '未知'],
        ['状态', `${st.doing} · 血 ${st.health}/20`],
        ['累计', `探索 ${G.stats.explores} · 采集 ${G.stats.gathered} · 听到 ${G.stats.chats} 条聊天`]
      ],
      tips: G.lastError ? [String(G.lastError).slice(0, 60)] : [],
      priority: 60
    };
  }
};

// ── 内部函数暴露给离线自检（不对外提供能力，别依赖）────────────────────────
export const internals = {
  S, resolvedName, synthQqId, buildMcEvent, parseLanPacket, mentionsMe,
  qqAllowed, injectChat, statusBrief,
  // 自主玩耍引擎（供离线自检）
  behaviorCandidates, pickBehavior, runBehavior, cn, noteSeen, maybeChatter,
  isHostileEntity, nearestThreat, nearestPlayer, nearestEntity, findNearBlock, hourKey,
  state: G,
  connectInfo: () => ({ bot: Boolean(G.bot), connecting: G.connecting, endpoint: G.endpoint, bound: boundChatKey() }),
  reset: () => {
    teardownAll();
    G.stats = { joins: 0, deaths: 0, chats: 0, injected: 0, commands: 0, explores: 0, relayed: 0, gathered: 0, fled: 0 };
    G.sightings = [];
    G.lastBehavior = '待命';
    G.lastError = '';
  }
};
