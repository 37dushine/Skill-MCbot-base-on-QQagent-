#!/usr/bin/env node
/**
 * selfcheck.mjs —— 离线自检（不需要 Minecraft、不需要 QQ、不需要装依赖）
 *
 * 做法：在系统临时目录里搭一个「最小 QQ Agent 影子目录」——
 *   <tmp>/resources/app/src/config.js      ← 假配置模块（带 persona）
 *   <tmp>/resources/app/skills/mc-bot/     ← 本仓库的 skill/ 原样拷进去
 *   <tmp>/resources/app/node_modules/*     ← mineflayer / pathfinder / vec3 的桩
 * 然后把技能 import 进来，走 setup() + 一堆断言。
 *
 * 这样验证的是**真实加载路径**（host.js 的向上查找、8 个工具注册、
 * 自主玩耍引擎的决策分支），而不是把逻辑从文件里抠出来单测。
 *
 * 用法：node scripts/selfcheck.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_SRC = path.join(REPO, 'skill');

let pass = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

function eq(name, actual, expected) {
  check(name, Object.is(actual, expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

// ── 1. 搭影子宿主 ──────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcbot-selfcheck-'));
const APP = path.join(tmp, 'resources', 'app');
const SKILL_DIR = path.join(APP, 'skills', 'mc-bot');

fs.mkdirSync(path.join(APP, 'src'), { recursive: true });
fs.mkdirSync(path.join(APP, 'skills'), { recursive: true });
fs.cpSync(SKILL_SRC, SKILL_DIR, { recursive: true });

fs.writeFileSync(path.join(APP, 'src', 'config.js'), `
export const DEFAULT_CONFIG = { persona: {}, allow: {}, allowAllWhenEmpty: false };
export function getConfig() { return globalThis.__STUB_CONFIG__ || DEFAULT_CONFIG; }
`);

fs.writeFileSync(path.join(APP, 'src', 'plugin-loader.js'), 'export async function loadPlugins() { return { skills: [], plugins: [] }; }\n');

function writeStub(name, pkg, code) {
  const dir = path.join(APP, 'node_modules', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0-selfcheck', main: 'index.js', ...pkg }, null, 2));
  fs.writeFileSync(path.join(dir, 'index.js'), code);
}

writeStub('mineflayer', {}, `
module.exports = { createBot() { throw new Error('selfcheck 环境没有真实 mineflayer'); } };
`);

writeStub('mineflayer-pathfinder', {}, `
class Goal { constructor(...args) { this.args = args; } }
class GoalNear extends Goal {}
class GoalNearXZ extends Goal {}
class GoalFollow extends Goal {}
module.exports = { pathfinder: {}, Movements: class Movements {}, goals: { Goal, GoalNear, GoalNearXZ, GoalFollow } };
`);

writeStub('vec3', {}, `
class Vec3 { constructor(x, y, z) { this.x = x; this.y = y; this.z = z; } }
module.exports = { Vec3 };
`);

// ── 2. 载入技能（走真实加载路径）───────────────────────────────────────────
globalThis.__STUB_CONFIG__ = {
  persona: { botName: '测试鱼', selfNickname: '小鱼' },
  allow: {},
  allowAllWhenEmpty: false
};

const settings = {
  username: '',
  host: '',
  port: 25565,
  version: '',
  autoConnect: false,
  lanAutoJoin: false, // 自检不占用 4445 端口
  autoRejoin: true,
  rejoinDelaySec: 15,
  autoExplore: true,
  exploreIntervalSec: 12,
  exploreRange: 48,
  exploreDig: false,
  autoGather: false,
  autoChatter: true,
  autoReport: false,
  chatMonitor: 'mentions',
  relayToQQ: false,
  qqGroup: '',
  mcCommands: true,
  notifyEvents: true
};

const tools = new Map();
const logs = [];
const api = {
  config: () => settings,
  log: (...a) => logs.push(a.join(' ')),
  warn: (...a) => logs.push(`[warn] ${a.join(' ')}`),
  registerTool: (t) => tools.set(t.id, t)
};

const mod = await import(pathToFileURL(path.join(SKILL_DIR, 'index.js')).href);
mod.setup(api);

const { internals, hooks, providers } = mod;
const G = internals.state;

// ── 3. 宿主桥接 ────────────────────────────────────────────────────────────
{
  const host = await import(pathToFileURL(path.join(SKILL_DIR, 'host.js')).href);
  eq('host: 找到 app 根目录', path.resolve(host.APP_ROOT || ''), path.resolve(APP));
  eq('host: 不是独立模式', host.STANDALONE, false);
  eq('host: 配置来自宿主模块', host.HOST_INFO.configFromModule, true);
  eq('host: 读到 persona', host.getConfig().persona.botName, '测试鱼');
  eq('host: 找不到 OneBot 时返回 null', host.getOneBotClientClass(), null);
}

// ── 4. 清单与注册 ──────────────────────────────────────────────────────────
const manifest = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'skill.json'), 'utf8'));

eq('清单: id', manifest.id, 'mc-bot');
eq('清单: apiVersion', manifest.apiVersion, 1);
eq('清单: 能力数', (manifest.capabilities || []).length, 1);

const EXPECTED_TOOLS = ['mc_control', 'mc_observe', 'mc_chat', 'mc_cmd', 'mc_move', 'mc_dig', 'mc_place', 'mc_inventory'];
eq('工具: 注册数量', tools.size, EXPECTED_TOOLS.length);
for (const id of EXPECTED_TOOLS) check(`工具: 存在 ${id}`, tools.has(id));
for (const [id, t] of tools) {
  check(`工具 ${id}: 有描述`, Boolean(t.description && t.description.length >= 8));
  check(`工具 ${id}: 有参数定义`, t.parameters?.type === 'object');
  check(`工具 ${id}: 有 execute`, typeof t.execute === 'function');
  check(`工具 ${id}: id 长度合法（宿主加前缀后 < 64）`, `mc-bot__${id}`.length < 64);
}
check('钩子: before-context', typeof hooks['before-context'] === 'function');
check('能力: status.mc-bot', typeof providers['status.mc-bot'] === 'function');
eq('可用性: 依赖桩就绪时 ok', mod.available().ok, true);
eq('命名: 空设置时回落到 persona', internals.resolvedName(), '测试鱼');
check('启动日志: 记录了加载信息', logs.some((l) => l.includes('已加载')));
check('启动日志: 没有告警', !logs.some((l) => l.startsWith('[warn]')), logs.filter((l) => l.startsWith('[warn]')).join(' | '));

// 清单与默认值对账
const setKeys = Object.keys(manifest.settings);
const schemaKeys = Object.keys(manifest.configSchema);
eq('清单: settings 数量', setKeys.length, 20);
check('清单: settings 都有 configSchema 声明', setKeys.every((k) => schemaKeys.includes(k)),
  setKeys.filter((k) => !schemaKeys.includes(k)).join(','));
check('清单: configSchema 没有多余键', schemaKeys.every((k) => setKeys.includes(k)),
  schemaKeys.filter((k) => !setKeys.includes(k)).join(','));
for (const k of setKeys) {
  const d = manifest.configSchema[k] || {};
  const v = manifest.settings[k];
  const typeOk = (d.type === 'number' && typeof v === 'number')
    || (d.type === 'string' && typeof v === 'string')
    || (d.type === 'boolean' && typeof v === 'boolean')
    || (d.type === 'enum' && Array.isArray(d.values) && d.values.includes(v));
  check(`清单 ${k}: 默认值与类型一致`, typeOk, `${d.type} / ${JSON.stringify(v)}`);
  check(`清单 ${k}: 有 label`, Boolean(d.label));
  if (d.type === 'enum') check(`清单 ${k}: enum 有 values`, Array.isArray(d.values) && d.values.length > 0);
  if (d.type === 'number') {
    check(`清单 ${k}: 默认值在 min/max 内`, (d.min == null || v >= d.min) && (d.max == null || v <= d.max), `${v} 不在 [${d.min}, ${d.max}]`);
  }
}

// ── 5. 自主玩耍引擎 ────────────────────────────────────────────────────────
const mkPos = (x, y, z) => ({
  x, y, z,
  distanceTo(o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z); }
});

function mkBot({ pos = [0, 64, 0], entities = {}, players = {}, findBlockResult = null, goal = null } = {}) {
  const goals = [];
  const bot = {
    username: '测试鱼',
    entity: { position: mkPos(...pos) },
    entities,
    players,
    health: 20,
    food: 20,
    pathfinder: { goal, setGoal(g) { this.goal = g; goals.push(g); } },
    look() {},
    setControlState() {},
    chat() {},
    blockAt() { return null; },
    findBlock: findBlockResult === null ? undefined : () => findBlockResult,
    inventory: { items: () => [] }
  };
  return { bot, goals };
}

const NO_THREAT = () => ({});
const S = internals.S;

// 空场景：只有 4 个基础行为
{
  const { bot } = mkBot();
  const list = internals.behaviorCandidates(bot, S());
  eq('行为: 空场景候选数', list.length, 4);
  check('行为: 空场景含 wander/look/sprint/jump',
    ['wander', 'look', 'sprint', 'jump'].every((id) => list.some((b) => b.id === id)));
}

// 遇怪短路
{
  const { bot } = mkBot({ entities: { 1: { name: 'zombie', position: mkPos(10, 64, 0) } } });
  const list = internals.behaviorCandidates(bot, S());
  eq('行为: 24 格内遇怪只剩一个选项', list.length, 1);
  eq('行为: 遇怪优先 flee', list[0]?.id, 'flee');
  check('行为: flee 权重压倒性', list[0]?.w >= 100);
}
{
  const { bot } = mkBot({ entities: { 1: { name: 'zombie', position: mkPos(30, 64, 0) } } });
  const list = internals.behaviorCandidates(bot, S());
  check('行为: 30 格外的怪不触发逃跑', list.length > 1);
}

// 玩家距离阈值
{
  const at = (d) => internals.behaviorCandidates(
    mkBot({ players: { Steve: { entity: { position: mkPos(d, 64, 0) } } } }).bot, S()
  ).some((b) => b.id === 'visit');
  eq('行为: 玩家 10 格 → 会凑过去', at(10), true);
  eq('行为: 玩家 5 格 → 不贴脸', at(5), false);
  eq('行为: 玩家 60 格 → 看不到', at(60), false);
}
{
  // 自己不该被算成"附近玩家"
  const { bot } = mkBot({ players: { 测试鱼: { entity: { position: mkPos(0, 64, 0) } } } });
  check('行为: 不会把自己当玩家', !internals.behaviorCandidates(bot, S()).some((b) => b.id === 'visit'));
}

// 掉落物 / 动物 / 人类痕迹
{
  const { bot } = mkBot({ entities: { 1: { name: 'item', position: mkPos(5, 64, 0) } } });
  check('行为: 识别掉落物', internals.behaviorCandidates(bot, S()).some((b) => b.id === 'pickup'));
}
{
  const { bot } = mkBot({ entities: { 1: { name: 'cow', type: 'animal', position: mkPos(6, 64, 0) } } });
  check('行为: 识别动物', internals.behaviorCandidates(bot, S()).some((b) => b.id === 'watch'));
}
{
  const { bot } = mkBot({ findBlockResult: { name: 'crafting_table', position: mkPos(8, 64, 0) } });
  check('行为: 识别村庄/营地痕迹', internals.behaviorCandidates(bot, S()).some((b) => b.id === 'site'));
}
{
  const block = { name: 'oak_log', position: mkPos(8, 64, 0) };
  const { bot } = mkBot({ findBlockResult: block });
  const off = internals.behaviorCandidates(bot, S()).some((b) => b.id === 'gather');
  const on = (() => { settings.autoGather = true; const r = internals.behaviorCandidates(bot, S()).some((b) => b.id === 'gather'); settings.autoGather = false; return r; })();
  eq('行为: 采集默认关闭', off, false);
  eq('行为: 采集开关打开后出现', on, true);
}

// 每个行为都能安全执行
{
  const cases = [
    ['wander', null], ['look', null], ['jump', null], ['sprint', null],
    ['visit', { name: 'Steve', position: mkPos(10, 64, 0) }],
    ['watch', { name: 'cow', position: mkPos(6, 64, 0) }],
    ['pickup', { name: 'item', position: mkPos(5, 64, 0) }],
    ['site', { name: 'bell', position: mkPos(8, 64, 0) }],
    ['gather', { name: 'oak_log', position: mkPos(8, 64, 0) }],
    ['flee', { name: 'creeper', position: mkPos(6, 64, 0) }]
  ];
  const lib = {
    pf: { goals: { GoalNear: class { constructor(...a) { this.a = a; } }, GoalNearXZ: class { constructor(...a) { this.a = a; } } } },
    Vec3: class { constructor(x, y, z) { this.x = x; this.y = y; this.z = z; } }
  };
  for (const [id, arg] of cases) {
    const { bot } = mkBot();
    let out = null;
    let thrown = null;
    try {
      out = internals.runBehavior(bot, lib, { id, w: 1, arg }, S());
    } catch (e) {
      thrown = e;
    }
    check(`行为 ${id}: 不抛错`, !thrown, thrown?.message);
    check(`行为 ${id}: 返回一句说明`, typeof out === 'string' && out.length > 0);
  }
}

// 抽签分布
{
  const counts = {};
  const list = [
    { id: 'wander', w: 34 }, { id: 'look', w: 20 }, { id: 'sprint', w: 11 }, { id: 'jump', w: 6 }
  ];
  for (let i = 0; i < 20000; i += 1) {
    const b = internals.pickBehavior(list);
    counts[b.id] = (counts[b.id] || 0) + 1;
  }
  // wander 权重 34 / 总权重 71 ≈ 48%
  check('抽签: 权重按比例生效', (counts.wander || 0) > 20000 * 0.44 && (counts.wander || 0) < 20000 * 0.52,
    `wander ${counts.wander}`);
  check('抽签: 次要行为也按比例', (counts.look || 0) > 20000 * 0.24 && (counts.look || 0) < 20000 * 0.32,
    `look ${counts.look}`);
  check('抽签: 每个候选都可能命中', ['wander', 'look', 'sprint', 'jump'].every((id) => (counts[id] || 0) > 0));
  eq('抽签: 空表返回 null', internals.pickBehavior([]), null);
}

// 见闻环形
{
  G.sightings.length = 0;
  for (let i = 0; i < 30; i += 1) internals.noteSeen(`见闻${i}`);
  eq('见闻: 最多保留 12 条', G.sightings.length, 12);
  eq('见闻: 丢掉最早的那条', G.sightings[0], '见闻18');
  check('见闻: 留下最新的', G.sightings[11] === '见闻29');
  G.sightings.length = 0;
}

// 自言自语限流
{
  const realRandom = Math.random;
  Math.random = () => 0; // 必定通过"开口"判定
  const { bot } = mkBot();
  const spoken = [];
  bot.chat = (t) => spoken.push(t);
  G.lastChatterAt = 0;
  G.chatterHour = { key: internals.hourKey(), count: 0 };
  for (let i = 0; i < 20; i += 1) {
    G.lastChatterAt = 0; // 绕开 60 秒间隔，只测"每小时 3 句"上限
    internals.maybeChatter(bot, S());
  }
  check('自言自语: 每小时最多 3 句', spoken.length <= 3, `实际 ${spoken.length} 句`);
  Math.random = realRandom;
}

// 名字识别
{
  eq('识别: 命中设置里的名字', internals.mentionsMe('测试鱼 过来一下'), true);
  eq('识别: 命中 persona 名', internals.mentionsMe('喂 测试鱼 在吗'), true);
  eq('识别: 无关闲聊不唤醒', internals.mentionsMe('今天吃啥'), false);
}

// 局域网广播解析
{
  const okPacket = internals.parseLanPacket(Buffer.from('[MOTD]A Minecraft Server[/MOTD][AD]51234[/AD]'));
  eq('局域网: 解析出端口', okPacket?.port, 51234);
  eq('局域网: 解析出 MOTD', okPacket?.motd, 'A Minecraft Server');
  eq('局域网: 坏包返回 null', internals.parseLanPacket(Buffer.from('hello')), null);
}

// QQ 侧
{
  eq('QQ: 白名单未放行时不注入', internals.injectChat('Steve', 'hi'), false);
  const a = internals.synthQqId('Steve');
  const b = internals.synthQqId('Alex');
  check('QQ: 合成号不撞真人号段', a > 4294967295, String(a));
  check('QQ: 不同玩家不同号', a !== b);
  const evt = internals.buildMcEvent('group:123456', 'Steve', 'hello');
  eq('QQ: 事件类型', evt.message_type, 'group');
  eq('QQ: 事件群号', evt.group_id, 123456);
  eq('QQ: 昵称带 MC 前缀', evt.sender.nickname, 'MC·Steve');
  check('QQ: 消息 id 是负数', evt.message_id < 0);
}

// 状态上报
{
  const st = providers['status.mc-bot']();
  eq('状态: 图标', st.icon, '🎮');
  check('状态: 离线时提示守着局域网', S().lanAutoJoin === false || st.lines.some(([, v]) => String(v).includes('局域网')));
  eq('状态: 离线时 connected=false', G.lastStatus.connected, false);
  check('状态: statusBrief 说明离线', internals.statusBrief().includes('离线'));
}

// ── 6. 收尾 ────────────────────────────────────────────────────────────────
internals.reset();
mod.deactivate({ reason: 'reload' }); // 热重载语义：不应该拆掉任何东西
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n通过 ${pass} 项`);
if (failures.length) {
  console.error(`失败 ${failures.length} 项：`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('全部通过 ✅');
process.exit(0);
