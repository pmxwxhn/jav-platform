// Telegram 频道关键词监控 → 115 自动离线(模块)
// 来源: F:\telegram-keyword-monitor (Telethon 用户账号 + SQLite)
// 流程: 调 monitor.py --once 增量抓取 → 读其 messages.db → 入平台库 tg_jasna
//       → 确保 115 根目录有 Jasna-LTX → 新记录提交离线下载到该目录
//
// 设计约定:
//   1) 不重写 Telegram 抓取逻辑, 直接复用它已经跑通的 Python 链路(登录/代理/关键词都在那边配)
//   2) 已入库的按 ed2k 唯一键幂等, 重跑不会重复
//   3) 默认只离线「本次新增」的记录; 历史存量走 API 手动分批补(避免一次几百 GB)
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const db = require('../db');
const mcp115 = require('./mcp115');

const LOG_DIR = path.join(__dirname, '..', 'data', 'logs', 'tg-jasna');

// 默认配置(可在 配置页/数据库 settings.tgJasna 覆盖)
const DEFAULTS = {
  enabled: true,
  projectDir: process.env.TGMON_DIR || '/opt/tgmon',
  pythonExe: process.env.PYTHON_BIN || '/usr/bin/python3',
  folder: 'Jasna-LTX',        // 115 根目录下的目标目录
  offline: true,              // 抓完自动离线(仅本次新增)
  scoreLookup: true,          // 新增记录自动查 javdb 评分/人数/女演员
  renameDelaySec: 300,        // 提交离线多少秒后自动规范命名(番号_JasnaLTX[-4K]-U)
  recheckRecent: 400,         // 有「待补链」时, 每次先重扫最近 N 条消息抓补链
  timeoutMs: 10 * 60 * 1000,  // 单个抓取进程超时
};

function cfg() {
  const s = db.getSettings() || {};
  return { ...DEFAULTS, ...(s.tgJasna || {}) };
}

// ===== 日志落盘(与 ai-zone 同款: 每次一个文件, 实时写) =====
function makeRunLogger() {
  const t = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const name = `${t.getFullYear()}${p2(t.getMonth() + 1)}${p2(t.getDate())}-${p2(t.getHours())}${p2(t.getMinutes())}${p2(t.getSeconds())}.log`;
  const file = path.join(LOG_DIR, name);
  const lines = [];
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
  const flush = () => { try { fs.writeFileSync(file, lines.join('\n'), 'utf8'); } catch {} };
  flush();
  return {
    file, name, lines,
    push(...msgs) { for (const m of msgs) lines.push(m); flush(); },
    join: (sep) => lines.join(sep),
  };
}

// ed2k 被 Telegram 截断时(缺 |/ 或 hash 尾部), 用解析到的三段重建
// 频道里偶尔也有 magnet 链接, 原样保留(115 同样支持)
function normalizeEd2k(link) {
  const s = String(link || '').trim();
  if (/^magnet:\?/i.test(s)) return s.split(/\s/)[0];
  const m = s.match(/ed2k:\/\/\|file\|(.+?)\|(\d+)\|([0-9A-Fa-f]{32})/);
  if (!m) return s;
  return `ed2k://|file|${m[1]}|${m[2]}|${m[3]}|/`;
}
function parseEd2k(link) {
  const m = String(link || '').match(/ed2k:\/\/\|file\|(.+?)\|(\d+)\|([0-9A-Fa-f]{32})/);
  if (!m) return { file_name: null, file_size: null };
  return { file_name: m[1], file_size: parseInt(m[2], 10) };
}
// 是否是可提交给 115 的下载链接
function isDownloadLink(s) {
  return /^ed2k:\/\//i.test(s) || /^magnet:\?/i.test(s);
}

// ===== 1. 调 Python 抓取(增量: 从上次水位到现在的全部命中) =====
function runTelethon(c, log) {
  return new Promise((resolve, reject) => {
    const script = path.join(c.projectDir, 'monitor.py');
    if (!fs.existsSync(c.pythonExe)) return reject(new Error('Python 解释器不存在: ' + c.pythonExe));
    if (!fs.existsSync(script)) return reject(new Error('抓取脚本不存在: ' + script));
    // 持续补链模式运行中: 抓取由它每轮顺带完成(共用连接), 这里跳过, 避免抢 session 文件锁
    if (fetchLoopRunning(c)) {
      log.push('[Jasna-LTX] ♾️ 持续补链运行中(心跳新鲜), 抓取由它每轮完成, 本步跳过');
      return resolve({ code: 0, skipped: true, fetched: null });
    }
    log.push(`[Jasna-LTX] 调用 Telegram 抓取: ${path.basename(c.pythonExe)} monitor.py --once`);
    const child = spawn(c.pythonExe, ['monitor.py', '--once'], {
      cwd: c.projectDir,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      windowsHide: true,
    });
    let out = '', err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      log.push('[Jasna-LTX] ⚠️ 抓取进程超时, 已终止');
    }, c.timeoutMs);
    const onLine = (s) => {
      const t = s.toString().replace(/\r/g, '').trim();
      if (!t) return;
      // Python 侧日志形如 "2026-10-21 20:51:34 [INFO] xxx"
      log.push('  ' + t);
    };
    child.stdout.on('data', (d) => { out += d; d.toString().split('\n').forEach(onLine); });
    child.stderr.on('data', (d) => { err += d; d.toString().split('\n').forEach(onLine); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out && err) return reject(new Error('抓取进程异常退出 code=' + code + ': ' + err.slice(0, 300)));
      const m = out.match(/新增命中\s*(\d+)\s*条/);
      resolve({ code, fetched: m ? parseInt(m[1], 10) : null, out });
    });
  });
}

// ===== 1.5 补链重扫: 频道里有人给无链接的帖子补上 ed2k 后, 只有重扫才能捡回来 =====
function recheckRecent(c, log) {
  return new Promise((resolve) => {
    const script = path.join(c.projectDir, 'backfill_all.py');
    if (!fs.existsSync(script)) return resolve(null);
    const n = c.recheckRecent || 400;
    log.push(`[Jasna-LTX] 存在待补链条目, 先重扫最近 ${n} 条消息找补链...`);
    const child = spawn(c.pythonExe, ['backfill_all.py', '--recent', String(n)], {
      cwd: c.projectDir,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      windowsHide: true,
    });
    let out = '';
    const onData = (d) => { out += d.toString(); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 180000);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('exit', () => {
      clearTimeout(timer);
      out.split('\n').map(s => s.trim()).filter(s => /补链重扫|补到链接/.test(s)).slice(-3).forEach(s => log.push('  ' + s));
      resolve(out);
    });
  });
}

// ===== 2. 读源库并入库 =====
function importMessages(c, log) {
  const src = path.join(c.projectDir, 'data', 'messages.db');
  if (!fs.existsSync(src)) throw new Error('抓取库不存在: ' + src);
  let conn;
  try { conn = new Database(src, { readonly: true, fileMustExist: true }); }
  catch (e) { throw new Error('打开抓取库失败: ' + e.message); }
  let rows = [];
  try {
    rows = conn.prepare(`SELECT chat_id, message_id, msg_date, text, keywords, code, ed2k, forum_url, link_dup, link_dead
                         FROM messages ORDER BY id ASC`).all();
  } finally { try { conn.close(); } catch {} }

  let added = 0, updated = 0, skipped = 0, noLink = 0, skippedDup = 0;
  const fresh = [];
  for (const r of rows) {
    const text = String(r.text || '');
    const rawLink = normalizeEd2k(r.ed2k);
    const hasLink = isDownloadLink(rawLink);
    const code = r.code || extractCode(text);
    // 重发片(平台已有同番号同版本)与已删消息: 不入库, 避免平台出现无链接的占位行
    if (Number(r.link_dup) === 1) { skippedDup++; continue; }
    if (Number(r.link_dead) === 1 && !hasLink) { skipped++; continue; }
    // 10-22 起频道改成「按钮取链」, 正文没有链接: 这类只要认得出番号就照样入库(link_status=missing), 等补链
    if (!hasLink && !code) { skipped++; continue; }
    if (!hasLink) noLink++;
    const date = (String(r.msg_date || '').slice(0, 10)) || new Date().toISOString().slice(0, 10);
    const firstLine = text.split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
    const { file_name, file_size } = hasLink ? parseEd2k(rawLink) : { file_name: null, file_size: null };
    const res = db.upsertTgJasna({
      chat_id: r.chat_id ?? null,
      code,
      run_date: date,
      msg_date: r.msg_date || null,
      msg_id: r.message_id ?? null,
      title: firstLine.slice(0, 200),
      text: text,
      ed2k: hasLink ? rawLink : null,
      forum_url: r.forum_url || null,
      file_name, file_size,
      keywords: r.keywords || null,
    });
    if (res.inserted) { added++; fresh.push(res.id); }
    else if (res.updated) { updated++; fresh.push(res.id); }   // 补链成功 → 也进待离线
  }
  log.push(`[Jasna-LTX] 源库 ${rows.length} 条, 新增入库 ${added} 条(其中无链接 ${noLink} 条待补), 补到链接 ${updated} 条, 跳过(无番号无链接) ${skipped} 条, 重发片跳过 ${skippedDup} 条`);
  return { added, updated, total: rows.length, freshIds: fresh, noLink };
}

// 兜底: 源库没给番号时自己抠(与 Python 侧同规则, 只取常见形态)
function extractCode(text) {
  const s = String(text || '');
  const m = s.match(/(?:^|[\s【\[(（])((?:\d*[A-Za-z][A-Za-z0-9]{1,8})[-_]\d{2,5})(?![0-9])/);
  return m ? m[1].toUpperCase().replace('_', '-') : null;
}

// ===== 3.5 javdb 元数据(评分/人数/女演员), 只补新增记录 =====
const javdb = require('./javdb');
const { sleep, evalJS, newTab, closeTab, reuseTab, cleanupTabs, releaseTabs } = require('./cdp');
const normCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const k2Code = s => normCode(s).replace(/^[0-9]+/, '');
const sameCode = (a, b) => normCode(a) === normCode(b) || (k2Code(a) && k2Code(a) === k2Code(b));
function codeOfTitle(t) {
  const m = String(t || '').match(/^\s*(?:匹配\d+个|未匹配|可播放|中字可播放)?\s*([0-9]*[A-Za-z][A-Za-z0-9]*[-_]?\d+)/);
  return m ? m[1] : '';
}

// 搜 javdb: 先搜索页拿 (评分, 详情链接), 再进详情页拿女演员
let javdbTabUse = 0;   // 复用标签页计数: 每 300 次清理一次, 防止标签堆积
async function grabMeta(code) {
  let st = null, dt = null;
  try {
    st = await reuseTab('https://javdb.com/search?q=' + encodeURIComponent(code) + '&f=all', 'javdb-search');
    await sleep(2200);
    let hit = null;
    for (let i = 0; i < 12 && !hit; i++) {
      let arr = [];
      try {
        const raw = await evalJS(st, `(() => {
          const out = [];
          document.querySelectorAll('.movie-list .item, .grid .item, .item').forEach(el => {
            const a = el.querySelector('a[href*="/v/"]');
            const tEl = el.querySelector('.uid, .title, .video-title');
            const sEl = el.querySelector('.score, .rating, .rate');
            out.push({ t: tEl ? tEl.textContent.trim() : '', s: sEl ? sEl.textContent.trim() : '', href: a ? a.href : '' });
          });
          return JSON.stringify(out.slice(0, 12));
        })()`, 0);
        arr = JSON.parse(raw);
      } catch {}
      hit = arr.find(x => x.href && sameCode(codeOfTitle(x.t), code));
      if (!hit) await sleep(1100);
    }
    if (!hit) return { found: false };
    const sc = javdb.parseScore(hit.s || '');
    let actors = null;
    dt = await reuseTab(hit.href, 'javdb-detail');
    try {
      await sleep(3200);
      for (let i = 0; i < 4; i++) {
        let fem = [], all = [];
        try {
          const r = await evalJS(dt, `(() => {
            var box = document.querySelector('.movie-panel-info') || document;
            var links = [...box.querySelectorAll('a[href*="/actors/"]')];
            var fem = [...new Set(links.filter(a => a.classList.contains('actor-female')).map(a => a.textContent.trim()))]
              .filter(t => t && t.length < 20);
            var all = [...new Set(links.map(a => a.textContent.trim()))]
              .filter(t => t && t.length < 20 && !/有碼|無碼|歐美|推薦/.test(t));
            return JSON.stringify({ fem, all });
          })()`, 0);
          const d = JSON.parse(r);
          fem = d.fem || []; all = d.all || [];
        } catch {}
        // javdb 给女优加 class="actor-female", 男优没有 → 优先只取女优
        const list = fem.length ? fem : all;
        if (list.length) { actors = list.join(' / '); break; }
        await sleep(1600);
      }
    } finally { /* 复用标签页: 不关闭 detail tab, 否则下条记录要重新新建→激活窗口 */ }
    return { found: true, score: sc ? sc.score : null, votes: sc ? sc.votes : null, actors };
  } finally {
    /* 复用标签页: search/detail tab 都常驻, 跑到 300 条时统一清一次, 避免标签堆积 */
    if (++javdbTabUse % 300 === 0) { try { await cleanupTabs(['javdb.com']); } catch {} }
  }
}

// 串行补录(默认并发 2): ids 为空则取库里还缺元数据的
// 回收 javdb 常驻标签: 先关本进程复用池里的, 再扫一遍残留(上一轮异常退出留下的)
async function sweepJavdbTabs(log = null) {
  let closed = 0;
  try { closed += (await releaseTabs('javdb')).length; } catch {}
  try { closed += await cleanupTabs(['javdb.com']); } catch {}
  if (log) log.push(`[Jasna-LTX] 已回收 javdb 标签页 ${closed} 个`);
  return closed;
}

async function enrichRecords(ids = null, log = null) {
  const rows = ids && ids.length
    ? ids.map(i => db.db.prepare('SELECT id,code,score,actors FROM tg_jasna WHERE id=?').get(parseInt(i, 10))).filter(Boolean)
    : db.getTgJasnaNoScore(200);
  // javdb 故障期间整体跳过: 不打任何请求, 也不消耗 meta_try
  if (db.isJavdbPaused && db.isJavdbPaused()) {
    if (log) log.push('[Jasna-LTX] ⏸ javdb 已暂停(站点故障), 跳过元数据补录');
    return { ok: 0, total: 0, skipped: true };
  }
  const todo = rows.filter(r => {
    const hasScore = r.score && r.score > 0;
    const hasActors = r.actors && r.actors !== '' && r.actors !== '-';
    return !(hasScore && hasActors);
  });
  if (!todo.length) {
    await sweepJavdbTabs(log);      // 没事可补也要收摊: 清掉上次异常退出留下的标签
    return { ok: 0, total: 0 };
  }
  if (log) log.push(`[Jasna-LTX] 补 javdb 元数据(评分/人数/女演员): ${todo.length} 条`);
  let ok = 0, n = 0;
  const sem = { n: 1, a: 0, q: [], async acq() { if (this.a < this.n) { this.a++; return; } await new Promise(r => this.q.push(r)); this.a++; }, rel() { this.a--; const r = this.q.shift(); if (r) r(); } };
  try {
    await Promise.all(todo.map(async row => {
      await sem.acq();
      try {
        // 同番号其它版本已有元数据(同一部片): 直接复用, 省一次 javdb 查询
        const sib = db.getSameCodeMeta ? db.getSameCodeMeta(row.code, row.id) : null;
        if (sib) { db.setTgJasnaScore(row.id, sib.score, sib.votes, sib.actors || null); ok++; return; }
        const r = await grabMeta(row.code).catch(() => null);
        if (r && r.found) { db.setTgJasnaScore(row.id, r.score, r.votes, r.actors || null); ok++; }
        else {
          // javdb 查不到: 累计尝试次数, 满 2 次就标记「不需要元数据」, 以后不再反复跑它
          const tries = db.bumpTgJasnaMetaTry ? db.bumpTgJasnaMetaTry(row.id) : 0;
          if (tries >= 2) { try { db.setTgJasnaMetaSkip(row.id, true); } catch {} }
        }
      } finally {
        n++;
        if (log && n % 5 === 0) log.push(`  已补 ${n}/${todo.length}`);
        sem.rel();
        await sleep(250);
      }
    }));
  } finally {
    // 补录期间 grabMeta 会常驻 javdb 搜索/详情标签(避免反复新建把浏览器窗口顶到前台),
    // 一批跑完必须收摊, 否则 javdb 页面会一直挂在浏览器里
    await sweepJavdbTabs(log);
  }
  if (log) log.push(`[Jasna-LTX] 元数据补录完成: 成功 ${ok}/${todo.length}`);
  return { ok, total: todo.length };
}

// ===== 3. 确保 115 根目录存在 Jasna-LTX =====
async function ensureFolder(c, log) {
  const key = 'tgJasna.dirCid';
  const cached = db.getSetting ? db.getSetting(key) : null;
  if (cached) {
    log.push(`[Jasna-LTX] 目标目录 ${c.folder}(cid=${cached})`);
    return String(cached);
  }
  const cid = await mcp115.resolveDir(c.folder, { autoCreate: true, parentCid: '0' });
  if (!cid) {
    log.push(`[Jasna-LTX] ⚠️ 找不到/建不出目录 ${c.folder}: ${mcp115.lastError() || '未知原因'}`);
    return null;
  }
  try { db.setSetting(key, String(cid)); } catch {}
  log.push(`[Jasna-LTX] 目标目录 ${c.folder}(cid=${cid})`);
  return String(cid);
}

// ===== 4. 离线提交(单条) =====
// 注意: 115 的 add_offline_download 对「新任务」返回的是**数组** [{state:true, code:0, info_hash, url}],
//       对「已存在」在 MCP 客户端里被包成 {state:true, already:true}; 两种形态都要认。
async function offlineOne(rec, cid, log) {
  const r = await mcp115.addOfflineDownload([rec.ed2k], cid);
  const item = Array.isArray(r) ? (r[0] || {}) : (r || {});
  const raw = r ? JSON.stringify(r) : '';
  if (item.already) {
    db.setTgJasnaOffline(rec.id, 'exists', '任务已存在(115 离线队列里已有该链接)');
    return 'exists';
  }
  if (item.state === true || item.code === 0) {
    db.setTgJasnaOffline(rec.id, 'submitted', '');
    return 'submitted';
  }
  if (/任务已存在|重复/.test(raw) || /已存在|重复/.test(String(item.error || item.message || ''))) {
    db.setTgJasnaOffline(rec.id, 'exists', '任务已存在(115 里已有该文件)');
    return 'exists';
  }
  const msg = item.error || item.message || (Array.isArray(r) && !r.length ? '接口返回空数组' : '') || mcp115.lastError() || '提交无响应';
  db.setTgJasnaOffline(rec.id, 'failed', String(msg).slice(0, 200));
  log.push(`  ✕ ${rec.code || '-'} 离线失败: ${String(msg).slice(0, 120)}`);
  return 'failed';
}

// 批量离线: ids 为空则取队列里最早的 limit 条
async function offlinePending({ ids = null, limit = 20 } = {}) {
  const c = cfg();
  const log = makeRunLogger();
  const cid = await ensureFolder(c, log);
  if (!cid) return { ok: false, log, cid: null };
  let recs = [];
  if (ids && ids.length) {
    const q = db.db.prepare(`SELECT * FROM tg_jasna WHERE id = ?`);
    recs = ids.map(i => q.get(parseInt(i, 10))).filter(Boolean);
  } else {
    recs = db.getTgJasnaPending(limit);
  }
  log.push(`[Jasna-LTX] 本次离线 ${recs.length} 条 → ${c.folder}`);
  const stat = { submitted: 0, exists: 0, failed: 0 };
  for (const rec of recs) {
    const s = await offlineOne(rec, cid, log);
    stat[s] = (stat[s] || 0) + 1;
    log.push(`  ${s === 'failed' ? '✕' : '✓'} ${rec.code || rec.file_name || rec.id} → ${s}`);
  }
  log.push(`[Jasna-LTX] 完成: 提交 ${stat.submitted} · 已存在 ${stat.exists} · 失败 ${stat.failed}`);
  if (stat.submitted > 0 || stat.exists > 0) scheduleRename(log);
  return { ok: true, log: log.lines, stat, cid };
}

// ===== 5. 离线后延时规范命名 =====
// 离线任务提交后文件不会立刻出现在目录里(秒传即时, 真下载要等), 所以延时跑一次改名:
// 番号_JasnaLTX-U / 番号_JasnaLTX-4K-U。detached 起独立进程, 不拖住流水线。
function scheduleRename(log, delaySec) {
  const c = cfg();
  const wait = delaySec == null ? (c.renameDelaySec ?? 300) : delaySec;
  try {
    const { spawn } = require('child_process');
    const root = path.join(__dirname, '..');
    const child = spawn(process.execPath, [path.join(root, 'tg-rename.js'), '--wait', String(wait)], {
      cwd: root, detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    if (log) log.push(`[Jasna-LTX] 已安排 ${wait}s 后自动规范命名(番号_JasnaLTX[-4K]-U)`);
  } catch (e) {
    if (log) log.push('[Jasna-LTX] ⚠️ 安排改名失败: ' + e.message);
  }
}

// ===== 主入口 =====
async function runTgJasna({ offline = null } = {}) {
  const c = cfg();
  const log = makeRunLogger();
  const startedAt = Date.now();
  let res = { ok: false, added: 0, log: [] };
  try {
    log.push(`[Jasna-LTX] 开始时间: ${new Date().toLocaleString('zh-CN')}`);
    if (!c.enabled) {
      log.push('[Jasna-LTX] 已在配置中禁用(settings.tgJasna.enabled=false), 跳过');
      return { ok: true, added: 0, log: log.lines };
    }
    const r = await runTelethon(c, log);
    log.push(`[Jasna-LTX] 抓取进程结束(code=${(r && r.code) ?? '-'}${r && r.fetched != null ? ', 本次命中 ' + r.fetched + ' 条' : ''}${r && r.skipped ? ' (本轮跳过, 由补链循环代抓)' : ''})`);
    // 有「待补链」的条目时, 先重扫一遍最近的, 捡别人后来补上的链接
    const st0 = db.getTgJasnaStats();
    if (st0.missingLink > 0) {
      await recheckRecent(c, log);
    }
    const imp = importMessages(c, log);
    res.added = imp.added;

    // 补 javdb 评分/人数/女演员(仅本次新增; 配置 tgJasna.scoreLookup=false 可关)
    if (imp.freshIds.length && c.scoreLookup !== false && !(db.isJavdbPaused && db.isJavdbPaused())) {
      try {
        const er = await enrichRecords(imp.freshIds, log);
        res.enriched = er.ok;
      } catch (e) {
        log.push('[Jasna-LTX] ⚠️ javdb 元数据补录异常(已跳过): ' + e.message);
      }
    }

    const doOffline = offline == null ? c.offline !== false : !!offline;
    // 候选 = 本次「新增或补链更新」里有 ed2k 且尚未离线过的
    // 注意: 频道改版后正文无链接, 补链走的是 updated 而不是 added, 不能只看 added
    const q = db.db.prepare('SELECT * FROM tg_jasna WHERE id = ?');
    const cand = imp.freshIds.map(i => q.get(i))
      .filter(r => r && r.ed2k && r.offline_status !== 'submitted' && r.offline_status !== 'exists');
    if (doOffline && cand.length > 0) {
      const cid = await ensureFolder(c, log);
      if (cid) {
        log.push(`[Jasna-LTX] 可离线 ${cand.length} 条(新增 ${imp.added} · 补链 ${imp.updated}) → ${c.folder}`);
        const stat = { submitted: 0, exists: 0, failed: 0 };
        for (const rec of cand) {
          stat[await offlineOne(rec, cid, log)]++;
        }
        log.push(`[Jasna-LTX] 离线结果: 提交 ${stat.submitted} · 已存在 ${stat.exists} · 失败 ${stat.failed}`);
        if (stat.submitted > 0 || stat.exists > 0) scheduleRename(log);
      }
    } else if (doOffline) {
      log.push('[Jasna-LTX] 无待离线记录(新增/补链均无可用链接)');
    } else {
      log.push('[Jasna-LTX] 本次不提交离线(仅入库)');
    }

    // 补齐全库缺「评分/评分人数/演员」的记录(默认 200 条, 避免拖长定时任务)
    if (c.scoreLookup !== false) {
      try {
        const er = await enrichRecords(null, log);
        if (er.total > 0) log.push(`[Jasna-LTX] 历史元数据补齐: 成功 ${er.ok}/${er.total}`);
      } catch (e) {
        log.push('[Jasna-LTX] ⚠️ 历史元数据补齐异常(已跳过): ' + e.message);
      }
    }

    const st = db.getTgJasnaStats();
    log.push(`[Jasna-LTX] 库内合计 ${st.total} 条 · 待离线 ${st.pending} 条 · 最近消息 ${st.lastMsgAt || '-'}`);
    log.push(`[Jasna-LTX] 完成: 新增 ${imp.added} 条, 耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    res.ok = true;
    return { ...res, log: log.lines, stats: st };
  } catch (e) {
    log.push('[Jasna-LTX] ❌ 异常: ' + e.message);
    return { ok: false, error: e.message, log: log.lines, ...res };
  }
}

// ===== 半小时任务: 增量抓取 + 补链 + 同步 + 离线 =====
// 目的: 把 Telegram 抓取/补链从「每天 10 点集中跑」拆成全天每 30 分钟小批量,
//       避开 callback 点击限流(FloodWait), 同时 10 点任务专注元数据
let halfBusy = false;

function fetchLoopRunning(c) {
  // 判活看心跳, 不看"有没有 pythonw 进程"。
  // 2026-10-31 事故: 无关的 avdanyu-server.py 占了 pythonw.exe, 这里误判补链在跑,
  // 于是每轮都跳过抓取, 从 01:31 到 11:30 一条没抓(近 10 小时)。
  // 心跳由 fetch_links.py 每轮写一次(内容=epoch 秒), 10 分钟内更新过才算真在跑。
  try {
    const hbFile = path.join(__dirname, '..', 'data', 'fetch_loop_heartbeat');
    const ts = parseInt(fs.readFileSync(hbFile, 'utf8'), 10) || 0;
    if (!ts) return false;
    const age = Date.now() / 1000 - ts;
    return age >= -60 && age < 10 * 60;
  } catch { return false; }
}

function runFetchLinks(c, log, budget) {
  return new Promise((resolve) => {
    const script = path.join(c.projectDir, 'fetch_links.py');
    if (!fs.existsSync(script)) {
      log.push('[半小时] 补链脚本不存在: ' + script);
      return resolve(null);
    }
    if (fetchLoopRunning(c)) {
      log.push('[半小时] ♾️ 持续补链运行中, 跳过本轮补链');
      return resolve(null);
    }
    log.push(`[半小时] 补链 fetch_links.py --budget ${budget}`);
    const child = spawn(c.pythonExe, ['fetch_links.py', '--budget', String(budget)], {
      cwd: c.projectDir,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      windowsHide: true,
    });
    let out = '';
    const onData = (d) => { out += d.toString(); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 10 * 60 * 1000);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('exit', () => {
      clearTimeout(timer);
      out.split('\n').map(s => s.replace(/\r/g, '').trim())
        .filter(s => /^\[补链\]|^  \[/.test(s)).slice(-8).forEach(s => log.push('  ' + s));
      resolve(out);
    });
  });
}

async function runHalfHour({ budget = 10, offlineLimit = 30 } = {}) {
  if (halfBusy) {
    console.log('[半小时] 上一轮尚未结束, 本轮跳过');
    return { skipped: true };
  }
  halfBusy = true;
  const c = cfg();
  const log = makeRunLogger();
  const t0 = Date.now();
  try {
    log.push('[半小时] 开始 ' + new Date().toLocaleString('zh-CN'));
    // 1) 增量抓频道新消息(monitor.py --once)
    try {
      const r = await runTelethon(c, log);
      log.push('[半小时] 抓取结束 code=' + ((r && r.code) ?? '-') + (r && r.fetched != null ? ', 命中 ' + r.fetched + ' 条' : ''));
    } catch (e) {
      log.push('[半小时] ⚠️ 抓取异常(继续补链): ' + e.message);
    }
    // 2) 补链(受 budget 与全局冷却限制)
    await runFetchLinks(c, log, budget);
    // 3) 同步入库(新增 + 补链更新)
    const imp = importMessages(c, log);
    // 4) 本次有链接的就地离线
    const q = db.db.prepare('SELECT * FROM tg_jasna WHERE id = ?');
    const cand = imp.freshIds.map(i => q.get(i))
      .filter(r => r && r.ed2k && r.offline_status !== 'submitted' && r.offline_status !== 'exists');
    if (cand.length) {
      const cid = await ensureFolder(c, log);
      if (cid) {
        const stat = { submitted: 0, exists: 0, failed: 0 };
        for (const rec of cand.slice(0, offlineLimit)) stat[await offlineOne(rec, cid, log)]++;
        log.push(`[半小时] 离线: 提交 ${stat.submitted} · 已存在 ${stat.exists} · 失败 ${stat.failed}`);
        if (stat.submitted > 0 || stat.exists > 0) scheduleRename(log);
      }
    } else {
      log.push('[半小时] 无新增/补链记录, 跳过离线');
    }
    log.push(`[半小时] 完成, 耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    return { ok: true, log: log.lines };
  } catch (e) {
    log.push('[半小时] ❌ 异常: ' + e.message);
    return { ok: false, error: e.message, log: log.lines };
  } finally {
    halfBusy = false;
  }
}

module.exports = { runTgJasna, runHalfHour, offlinePending, ensureFolder, importMessages, normalizeEd2k, cfg, LOG_DIR, enrichRecords, grabMeta, scheduleRename, fetchLoopRunning };
