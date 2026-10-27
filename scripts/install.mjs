#!/usr/bin/env node
/**
 * install.mjs —— 把本仓库的 skill/ 安装进 QQ Agent
 *
 * 用法：
 *   node scripts/install.mjs --app "D:\QQagent\QQ Agent\resources\app"
 *   node scripts/install.mjs --app "..." --skip-deps   # 只拷文件，不装依赖
 *
 * 做四件事：
 *   1. 校验目标目录确实是 QQ Agent 的 app 根（有 src/plugin-loader.js）；
 *   2. 备份旧的 skills/mc-bot（放到 app/.mc-bot-backup/，不会污染 skills/）；
 *   3. 拷 skill.json / index.js / host.js 到 skills/mc-bot/；
 *   4. 缺 mineflayer 依赖时，在 app 根执行 npm install。
 *
 * 热重载：文件落盘后 QQ Agent 会自己重新加载技能，不需要重启。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_SRC = path.join(REPO, 'skill');
const SKILL_ID = 'mc-bot';
const FILES = ['skill.json', 'index.js', 'host.js'];

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

function log(msg) {
  console.log(msg);
}

function looksLikeAppRoot(dir) {
  try {
    return fs.existsSync(path.join(dir, 'src', 'plugin-loader.js'))
      || fs.existsSync(path.join(dir, 'src', 'config.js'));
  } catch {
    return false;
  }
}

/** 没传 --app 时，试几个常见安装位置。 */
function guessAppRoot() {
  const candidates = [];
  if (process.env.QQ_AGENT_APP_ROOT) candidates.push(process.env.QQ_AGENT_APP_ROOT);
  const { LOCALAPPDATA, PROGRAMFILES, 'PROGRAMFILES(X86)': PF86 } = process.env;
  for (const base of [LOCALAPPDATA && path.join(LOCALAPPDATA, 'Programs'), PROGRAMFILES, PF86]) {
    if (!base) continue;
    for (const name of ['QQ Agent', 'QQAgent', 'qq-agent']) {
      candidates.push(path.join(base, name, 'resources', 'app'));
      candidates.push(path.join(base, name, 'resources', 'app.asar.unpacked'));
    }
  }
  for (const dir of ['D:/QQagent/QQ Agent/resources/app', 'C:/QQagent/QQ Agent/resources/app']) {
    candidates.push(dir);
  }
  return candidates.find(looksLikeAppRoot) || null;
}

// ── 1. 定位目标 ────────────────────────────────────────────────────────────
const appArg = option('--app');
const APP = appArg ? path.resolve(appArg) : guessAppRoot();

if (!APP) {
  fail('找不到 QQ Agent 的 app 目录。请用 --app 指明，例如：\n'
    + '  node scripts/install.mjs --app "D:\\QQagent\\QQ Agent\\resources\\app"\n'
    + '（就是包含 src/、skills/、plugins/ 的那个目录）');
}
if (!looksLikeAppRoot(APP)) {
  fail(`${APP}\n看起来不是 QQ Agent 的 app 目录（缺 src/plugin-loader.js）。`);
}

const SKILLS_DIR = path.join(APP, 'skills');
const DEST = path.join(SKILLS_DIR, SKILL_ID);
if (!fs.existsSync(SKILLS_DIR)) fail(`${SKILLS_DIR} 不存在。`);

log(`▸ 目标：${DEST}`);

// ── 2. 备份 ────────────────────────────────────────────────────────────────
if (fs.existsSync(DEST)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupRoot = path.join(APP, '.mc-bot-backup', stamp);
  fs.mkdirSync(backupRoot, { recursive: true });
  fs.cpSync(DEST, path.join(backupRoot, SKILL_ID), { recursive: true });
  log(`▸ 旧版本已备份：${backupRoot}`);

  // 只清掉本技能自己的旧入口，保留用户可能手放的其它文件（如 README）
  for (const f of FILES) {
    try { fs.rmSync(path.join(DEST, f), { force: true }); } catch { /* ignore */ }
  }
}

// ── 3. 拷贝 ────────────────────────────────────────────────────────────────
fs.mkdirSync(DEST, { recursive: true });
for (const f of FILES) {
  const src = path.join(SKILL_SRC, f);
  if (!fs.existsSync(src)) fail(`仓库缺文件：${src}`);
  fs.copyFileSync(src, path.join(DEST, f));
  log(`  ✓ ${f}`);
}

// 语法闸门：拷完先过一遍 --check，别把坏文件塞进热重载
for (const f of ['index.js', 'host.js']) {
  const r = spawnSync(process.execPath, ['--check', path.join(DEST, f)], { encoding: 'utf8' });
  if (r.status !== 0) fail(`${f} 语法检查失败：\n${r.stderr}`);
}
log('▸ 语法检查通过');

// ── 4. 依赖 ────────────────────────────────────────────────────────────────
const hasDep = () => {
  try {
    const req = path.join(APP, 'node_modules', 'mineflayer', 'package.json');
    return fs.existsSync(req);
  } catch {
    return false;
  }
};

if (flag('--skip-deps')) {
  if (!hasDep()) log('\n⚠ 已跳过依赖安装。请自行在 app 目录执行：\n  npm install mineflayer mineflayer-pathfinder vec3');
} else if (hasDep()) {
  log('▸ mineflayer 依赖已存在，跳过安装');
} else {
  log('▸ 安装 Minecraft 协议依赖（mineflayer / mineflayer-pathfinder / vec3）…');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['install', 'mineflayer', 'mineflayer-pathfinder', 'vec3', '--no-audit', '--no-fund'], {
    cwd: APP,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  if (r.status !== 0) {
    log('\n⚠ 依赖安装失败。网络原因可以改用镜像：\n'
      + '  npm install mineflayer mineflayer-pathfinder vec3 --registry=https://registry.npmmirror.com');
    process.exit(r.status ?? 1);
  }
}

// ── 5. 收尾提示 ────────────────────────────────────────────────────────────
log('');
log('✓ 安装完成。');
log('  · QQ Agent 开着热重载的话，技能页会立刻出现「我的世界分身（MC Bot）」，无需重启');
log('  · 单机：PCL 进入世界 → Esc → 对局域网开放 → 等几秒它自己进来');
log('  · 联机：在技能设置里填服务器地址/端口，或群里说「连 xxx 服务器」');
