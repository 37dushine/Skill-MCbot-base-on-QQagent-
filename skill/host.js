/**
 * host.js —— 宿主（QQ Agent）桥接层
 *
 * 这个文件存在的唯一目的：让 index.js **不再硬编码** `../../src/*.js` 这种
 * "必须正好躺在 resources/app/skills/mc-bot/" 才能活的相对路径。
 *
 * 它做三件事：
 *   1. 定位宿主根目录（环境变量 → 从技能目录向上找 `src/plugin-loader.js`）；
 *   2. 拿到宿主的 getConfig()（读设置 / 人设名 / 白名单口径）；
 *   3. 拿到宿主的 OneBotClient 类（用来包一层原型壳，捕获 onebot 实例）。
 *
 * 三者全部**尽力而为**：找不到宿主时，本模块退化成一个空实现——
 * index.js 照常加载，Minecraft 侧功能（连接、自主游玩、游戏内 !命令）
 * 全部可用，只有「游戏聊天 ↔ QQ 群」这条桥不可用。这样在仓库里直接
 * `node scripts/selfcheck.mjs` 也能跑，不需要先装一份 QQ Agent。
 *
 * 注意：这里用顶层 await 动态 import，而不是 require()。
 * 原因：Electron 内置的 Node 版本不一定支持 require(esm)，
 * 而 loader 本身是 `await import(entryUrl)`，顶层 await 天然安全。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** 宿主的两个标志文件：任意一个存在即认为找到了 app 根目录。 */
const ROOT_MARKERS = ['src/plugin-loader.js', 'src/config.js'];

function looksLikeAppRoot(dir) {
  try {
    return ROOT_MARKERS.some((rel) => fs.existsSync(path.join(dir, rel)));
  } catch {
    return false;
  }
}

/** 定位宿主根目录；找不到返回 null。 */
function findAppRoot() {
  const fromEnv = process.env.QQ_AGENT_APP_ROOT;
  if (fromEnv) {
    const abs = path.resolve(fromEnv);
    if (looksLikeAppRoot(abs)) return abs;
  }
  let dir = HERE;
  for (let i = 0; i < 8; i += 1) {
    if (looksLikeAppRoot(dir)) return dir;
    const nested = path.join(dir, 'resources', 'app'); // 发行版根目录 → resources/app
    if (looksLikeAppRoot(nested)) return nested;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export const APP_ROOT = findAppRoot();

/** 没有宿主时为 true：QQ 桥不可用，MC 侧仍可用。 */
export const STANDALONE = !APP_ROOT;

// ── 配置读取：优先宿主模块，其次直接读 data/config.json，最后空对象 ─────────
function diskConfigPaths() {
  const out = [];
  const dataDir = process.env.QQ_AGENT_DATA_DIR;
  if (dataDir) out.push(path.join(dataDir, 'config.json'));
  if (APP_ROOT) {
    out.push(path.join(APP_ROOT, 'data', 'config.json'));
    out.push(path.join(APP_ROOT, '..', '..', 'data', 'config.json'));
  }
  return out;
}

function readConfigFromDisk() {
  for (const p of diskConfigPaths()) {
    try {
      if (!fs.existsSync(p)) continue;
      return JSON.parse(fs.readFileSync(p, 'utf8')) || {};
    } catch {
      // 配置坏了不该拖垮技能，继续试下一个位置
    }
  }
  return {};
}

let getConfigImpl = readConfigFromDisk;
let OneBotClientClass = null;
let hostConfigModule = false;
let hostOneBotModule = false;

if (APP_ROOT) {
  try {
    const mod = await import(pathToFileURL(path.join(APP_ROOT, 'src', 'config.js')).href);
    if (typeof mod.getConfig === 'function') {
      getConfigImpl = mod.getConfig;
      hostConfigModule = true;
    }
  } catch {
    // 老版本 / 裁剪版没有 config 模块：退回读磁盘
  }
  try {
    const mod = await import(pathToFileURL(path.join(APP_ROOT, 'src', 'onebot.js')).href);
    OneBotClientClass = mod.OneBotClient ?? null;
    hostOneBotModule = Boolean(OneBotClientClass);
  } catch {
    // 没有 OneBot 模块：聊天桥停用，其余不受影响
  }
}

/** 与宿主同源的配置读取（永远不抛错，读不到给空对象）。 */
export function getConfig() {
  try {
    return getConfigImpl() || {};
  } catch {
    return {};
  }
}

/** 宿主的 OneBotClient 类；没有宿主时为 null。 */
export function getOneBotClientClass() {
  return OneBotClientClass;
}

/** 诊断信息（写进启动日志，方便排障）。 */
export const HOST_INFO = {
  appRoot: APP_ROOT,
  standalone: STANDALONE,
  configFromModule: hostConfigModule,
  onebotFromModule: hostOneBotModule,
  node: process.version
};
