// Web 管理后台服务入口
const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const scheduler = require('./scheduler');
const report = require('./modules/report');
const netcheck = require('./modules/netcheck');

const app = express();
const cfg = db.getSettings();
const PORT = cfg.server.port || 8730;

// ===== 崩溃留痕: 服务曾多次「无声退出」, 没有日志很难查 =====
// 任何未捕获异常/未处理拒绝都追加到 data/app-crash.log, 便于事后定位
const CRASH_LOG = path.join(__dirname, 'data', 'app-crash.log');
function logCrash(tag, e) {
  try {
    const line = `[${new Date().toLocaleString('zh-CN')}] ${tag}: ${e && e.stack ? e.stack : e}\n`;
    fs.appendFileSync(CRASH_LOG, line, 'utf8');
  } catch {}
}
process.on('uncaughtException', (e) => { logCrash('uncaughtException', e); console.error('uncaughtException', e); });
process.on('unhandledRejection', (e) => { logCrash('unhandledRejection', e); console.error('unhandledRejection', e); });
process.on('exit', (code) => { if (code && code !== 0) logCrash('exit', `code=${code}`); });

app.use(express.json());

// ===== 公网只读网关 =====
// 只对「Cloudflare 隧道转发进来的请求」生效(识别 cf-ray / cf-connecting-ip 头),
// 本机 127.0.0.1 直连完全不受影响, 仍是全功能后台。
// 公网侧: 先过访问口令 -> 再走只读白名单, 非 GET 一律 403。
const publicMode = require('./public-mode');
app.use(publicMode.middleware());

// 预告片本地文件(报告内直接播放, 不依赖 javdb 登录态)
const PREVIEW_DIR = path.join(__dirname, 'data', 'previews');
if (!fs.existsSync(PREVIEW_DIR)) fs.mkdirSync(PREVIEW_DIR, { recursive: true });
app.use('/previews', express.static(PREVIEW_DIR, { maxAge: 0, etag: false }));
// 静态资源禁用缓存(开发期: 前端改动即时生效, 避免浏览器缓存旧文件)
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: 0, etag: false,
  setHeaders(res, p) {
    if (p.endsWith('.html') || p.endsWith('.js') || p.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  },
}));
app.use('/reports', express.static(path.join(__dirname, 'reports')));

// ===== API: 只读访客探测(前端据此隐藏管理入口) =====
app.get('/api/pub-mode', (req, res) => {
  res.json({
    ok: true,
    readonly: publicMode.isReadonlyRequest(req),
  });
});

// ===== API: 仪表盘统计 =====
app.get('/api/stats', (req, res) => {
  res.json(db.getStats());
});

// ===== API: AI 专区(sehuatang fid=166, 只取有价值影片 评分>4且人数>200) =====
// 列表查询: ?date-start=&date-end=&keyword=
app.get('/api/ai-zone', (req, res) => {
  const rows = db.getAiZoneVideos({
    dateStart: req.query['date-start'] || req.query.dateStart || null,
    dateEnd: req.query['date-end'] || req.query.dateEnd || null,
    keyword: req.query.keyword || '',
    limit: parseInt(req.query.limit) || 500,
  });
  res.json({ ok: true, rows, dates: db.getAiZoneDates(), config: db.getSettings().aiZone || { score: 4, votes: 200 } });
});
// 评分/评分人数阈值(抓取过滤用, 实时生效)
app.get('/api/ai-zone/config', (req, res) => {
  res.json({ ok: true, config: db.getSettings().aiZone || { score: 4, votes: 200 } });
});
app.post('/api/ai-zone/config', (req, res) => {
  const { score, votes } = req.body || {};
  const cur = db.getSettings().aiZone || {};
  db.setSetting('aiZone.score', score != null ? parseFloat(score) : cur.score);
  db.setSetting('aiZone.votes', votes != null ? parseInt(votes) : cur.votes);
  res.json({ ok: true, config: db.getSettings().aiZone });
});
// 触发抓取(子进程, 避免阻塞)
let aiZoneRunning = false;
app.post('/api/ai-zone/run', (req, res) => {
  if (aiZoneRunning) return res.json({ ok: false, error: 'AI专区抓取已在运行中' });
  aiZoneRunning = true;
  const { dateStart = null, dateEnd = null } = req.body || {};
  try {
    const { spawn } = require('child_process');
    const args = ['ai-zone.js'];
    if (dateStart) args.push('--date-start', dateStart);
    if (dateEnd) args.push('--date-end', dateEnd);
    const child = spawn(process.execPath, args, { cwd: __dirname, stdio: 'ignore', windowsHide: true });
    child.on('exit', (code) => {
      aiZoneRunning = false;
      console.log('[ai-zone] 抓取完成 exit=', code);
    });
    child.on('error', (e) => { aiZoneRunning = false; res.status(500).json({ ok: false, error: e.message }); });
    res.json({ ok: true, message: 'AI专区抓取已启动(' + (dateStart || '今天') + (dateEnd && dateEnd !== dateStart ? ' ~ ' + dateEnd : '') + ')' });
  } catch (e) {
    aiZoneRunning = false;
    res.status(500).json({ ok: false, error: e.message });
  }
});
// ===== API: AI 专区抓取日志(回溯历史抓取) =====
// 日志目录需与 modules/ai-zone.js 的 AI_LOG_DIR 保持一致
// (这里不 require 该模块, 避免为读日志而拉起 cdp/javdb 等重依赖)
const AI_LOG_DIR = path.join(__dirname, 'data', 'logs', 'ai-zone');
const isSafeLogName = (n) => /^\d{8}-\d{6}\.log$/.test(String(n));
// 日志列表(新的在前)
app.get('/api/ai-zone/logs', (req, res) => {
  try {
    if (!fs.existsSync(AI_LOG_DIR)) return res.json({ ok: true, logs: [] });
    const logs = fs.readdirSync(AI_LOG_DIR)
      .filter(f => isSafeLogName(f))
      .map(f => {
        const st = fs.statSync(path.join(AI_LOG_DIR, f));
        const d = st.mtime, p2 = (n) => String(n).padStart(2, '0');
        // 用本地时间(toISOString 会是 UTC, 与文件名里的本地时间戳对不上)
        const mtime = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
        return { name: f, size: st.size, mtime };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
    res.json({ ok: true, logs });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// 读取单个日志内容
app.get('/api/ai-zone/logs/:name', (req, res) => {
  const name = isSafeLogName(req.params.name) ? req.params.name : null;
  if (!name) return res.status(400).json({ ok: false, error: '日志名非法' });
  const file = path.join(AI_LOG_DIR, name);
  if (!fs.existsSync(file)) return res.status(404).json({ ok: false, error: '日志不存在' });
  res.json({ ok: true, name, content: fs.readFileSync(file, 'utf8') });
});
// 删除单个日志
app.delete('/api/ai-zone/logs/:name', (req, res) => {
  const name = isSafeLogName(req.params.name) ? req.params.name : null;
  if (!name) return res.status(400).json({ ok: false, error: '日志名非法' });
  const file = path.join(AI_LOG_DIR, name);
  if (!fs.existsSync(file)) return res.status(404).json({ ok: false, error: '日志不存在' });
  fs.unlinkSync(file);
  res.json({ ok: true, deleted: name });
});

// ===== API: Telegram Jasna-LTX(频道 jasanashare 关键词 Jasna-Ltx) =====
// 列表: ?date-start=&date-end=&keyword=&offline=pending|submitted|exists|failed
app.get('/api/tg-jasna', (req, res) => {
  let rows = db.getTgJasna({
    dateStart: req.query['date-start'] || req.query.dateStart || null,
    dateEnd: req.query['date-end'] || req.query.dateEnd || null,
    keyword: req.query.keyword || '',
    offline: req.query.offline || '',
    meta: req.query.meta || '',
    scoreBand: req.query['score-band'] || req.query.scoreBand || '',
    votesBand: req.query['votes-band'] || req.query.votesBand || '',
    actor: req.query.actor || '',
    msgDate: req.query['msg-date'] || req.query.msgDate || '',
    visit: req.query.visit || '',
    resolution: req.query.resolution || '',
    dual: req.query.dual || '',
    limit: parseInt(req.query.limit) || 2000,
  });
  // 演员名映射成 115 中文目录名(未映射的保留 javdb 日文名)
  const cnMap = db.getActressCnMap();
  rows = rows.map(r => {
    if (!r.actors) return r;
    const parts = String(r.actors).split('/').map(s => s.trim()).filter(Boolean);
    return { ...r, actors_cn: parts.map(n => cnMap[n] || n).join(' / ') };
  });
  const cfgTg = db.getSettings().tgJasna || {};
  res.json({
    ok: true, rows,
    dates: db.getTgJasnaDates(),
    msgDates: db.getTgJasnaMsgDates(),
    stats: db.getTgJasnaStats(),
    config: { folder: cfgTg.folder || 'Jasna-LTX', dirCid: cfgTg.dirCid || null, enabled: cfgTg.enabled !== false },
  });
});

// 女演员目录树: [{name,count}] 按片数降序, 供前端树形筛选
// 女演员目录树: [{name,cn,count,initial}] 按片数降序, 供前端平铺 + 首字母筛选
const { pinyin } = require('pinyin-pro');
// 取名字首字的拼音首字母; 非中英文(纯假名等)归到 '#'
function initialOf(name) {
  const s = String(name || '').trim();
  if (!s) return '#';
  const first = s[0];
  if (/[A-Za-z]/.test(first)) return first.toUpperCase();
  if (/[0-9]/.test(first)) return '#';
  try {
    const r = String(pinyin(first, { pattern: 'first', toneType: 'none' }) || '').trim();
    if (r && /[A-Za-z]/.test(r[0])) return r[0].toUpperCase();
  } catch {}
  return '#';
}

app.get('/api/tg-jasna/actors', (req, res) => {
  try {
    const actors = db.getTgJasnaActors();
    const cnMap = db.getActressCnMap();
    const withCn = actors.map(a => ({
      name: a.name,
      cn: cnMap[a.name] || null,
      count: a.count,
      initial: initialOf(cnMap[a.name] || a.name),
    }));
    res.json({ ok: true, total: withCn.length, actors: withCn });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 一键导出 Excel(按当前筛选条件, 13 列)
app.get('/api/tg-jasna/export', async (req, res) => {
  try {
    const dateStart = req.query['date-start'] || req.query.dateStart || null;
    const dateEnd = req.query['date-end'] || req.query.dateEnd || null;
    const keyword = req.query.keyword || '';
    const offline = req.query.offline || '';
    const meta = req.query.meta || '';
    const scoreBand = req.query['score-band'] || req.query.scoreBand || '';
    const votesBand = req.query['votes-band'] || req.query.votesBand || '';
    const actor = req.query.actor || '';
    const msgDate = req.query['msg-date'] || req.query.msgDate || '';
    const visit = req.query.visit || '';
    const resolution = req.query.resolution || '';
    const rows = db.getTgJasna({ dateStart, dateEnd, keyword, offline, meta, scoreBand, votesBand, actor, msgDate, visit, resolution, limit: 5000 });

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = '115影视资源自动管理平台';
    wb.created = new Date();
    const ws = wb.addWorksheet('Jasna-LTX资源清单', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    ws.columns = [
      { header: '序号', key: 'idx', width: 6 },
      { header: '消息时间', key: 'msg_date', width: 18 },
      { header: '番号', key: 'code', width: 13 },
      { header: '评分', key: 'score', width: 7, style: { numFmt: '0.00' } },
      { header: '评分人数', key: 'votes', width: 10, style: { numFmt: '#,##0' } },
      { header: '女演员', key: 'actors', width: 22 },
      { header: '影片文件名', key: 'file_name', width: 36 },
      { header: '大小(GB)', key: 'size_gb', width: 9, style: { numFmt: '0.00' } },
      { header: '下载链接', key: 'link', width: 52 },
      { header: '源地址', key: 'forum', width: 40 },
      { header: '离线状态', key: 'offline', width: 10 },
      { header: '消息正文', key: 'text', width: 60 },
    ];
    // 表头样式
    const head = ws.getRow(1);
    head.height = 22;
    head.eachCell(c => {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
      c.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    const OFFLINE_TXT = { submitted: '已提交', exists: '115已有', failed: '失败', pending: '待离线', skipped: '跳过' };
    rows.forEach((r, i) => {
      const row = ws.addRow({
        idx: i + 1,
        msg_date: r.msg_date || '',
        code: r.code || '',
        score: r.score > 0 ? r.score : null,
        votes: r.votes > 0 ? r.votes : null,
        actors: r.actors || '',
        file_name: r.file_name || '',
        size_gb: r.file_size ? +(r.file_size / 1073741824).toFixed(2) : null,
        link: r.ed2k || '',
        forum: r.forum_url || '',
        offline: OFFLINE_TXT[r.offline_status] || r.offline_status || '',
        text: r.text || '',
      });
      ['file_name', 'link', 'forum', 'text'].forEach(k => {
        row.getCell(k).alignment = { vertical: 'top', wrapText: true };
      });
      const fu = r.forum_url || '';
      if (/^https?:\/\//i.test(fu)) {
        const c = row.getCell('forum');
        c.value = { text: fu, hyperlink: fu };
        c.font = { color: { argb: 'FF0563C1' }, underline: true };
      }
    });
    ws.autoFilter = { from: 'A1', to: `L${rows.length + 1}` };

    const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`;
    const fname = `Jasna-LTX资源清单_${stamp}.xlsx`;
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="jasna-ltx-${stamp}.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(Buffer.from(buf));
  } catch (e) {
    console.error('[tg-jasna/export]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 触发抓取(子进程, 不阻塞): 默认走完整流程 = 抓新消息 + 补链 + 离线
let tgRunning = false;
app.post('/api/tg-jasna/run', (req, res) => {
  if (tgRunning) return res.json({ ok: false, error: 'Jasna-LTX 抓取已在运行中' });
  tgRunning = true;
  const { noOffline = false, budget = 10 } = req.body || {};
  try {
    const { spawn } = require('child_process');
    const args = ['tg-jasna.js'];
    if (noOffline) {
      args.push('--no-offline');
    } else {
      args.push('--half-hour', '--budget', String(budget));
    }
    const child = spawn(process.execPath, args, { cwd: __dirname, stdio: 'ignore', windowsHide: true });
    child.on('exit', (code) => { tgRunning = false; console.log('[tg-jasna] 抓取完成 exit=', code); });
    child.on('error', (e) => { tgRunning = false; res.status(500).json({ ok: false, error: e.message }); });
    res.json({ ok: true, message: noOffline ? 'Jasna-LTX 抓取已启动(仅入库)' : `完整流程已启动: 抓新消息 + 补链 ${budget} 条 + 离线` });
  } catch (e) {
    tgRunning = false;
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 补链进度(有链/缺链/已删除/全局冷却) —— 前端「断点状态」展示 + 手动恢复参考
app.get('/api/tg-jasna/link-status', (req, res) => {
  try {
    const fs = require('fs');
    const Database = require('better-sqlite3');
    const tj = require('./modules/tg-jasna');
    const c = tj.cfg();
    const dbPath = path.join(c.projectDir, 'data', 'messages.db');
    if (!fs.existsSync(dbPath)) return res.json({ ok: false, error: '抓取库不存在: ' + dbPath });
    const conn = new Database(dbPath, { readonly: true, fileMustExist: true });
    let st = {}, cooldown = null;
    try {
      st = conn.prepare(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN ed2k IS NOT NULL AND ed2k<>'' THEN 1 ELSE 0 END) AS linked,
        SUM(CASE WHEN (ed2k IS NULL OR ed2k='') AND COALESCE(link_dead,0)=1 THEN 1 ELSE 0 END) AS dead,
        SUM(CASE WHEN (ed2k IS NULL OR ed2k='') AND COALESCE(link_dead,0)=0 AND COALESCE(link_dup,0)=0 THEN 1 ELSE 0 END) AS missing,
        SUM(CASE WHEN COALESCE(link_dup,0)=1 THEN 1 ELSE 0 END) AS skippedDup
        FROM messages WHERE chat_id = -1004327845391`).get() || {};
      try { cooldown = (conn.prepare("SELECT v FROM kv WHERE k='link_cooldown_until'").get() || {}).v || null; } catch {}
      // 实时抓取进度: 已抓到的最新消息
      try {
        var latest = conn.prepare("SELECT MAX(message_id) m, MAX(msg_date) d FROM messages WHERE chat_id = -1004327845391").get() || {};
      } catch {}
    } finally { try { conn.close(); } catch {} }
    // 缺元数据(评分/演员)的条数, 供前端显示
    let metaMissing = 0;
    try {
      const cdb = new Database(path.join(__dirname, 'data', 'config.db'), { readonly: true, fileMustExist: true });
      try {
        metaMissing = (cdb.prepare("SELECT COUNT(*) AS c FROM tg_jasna WHERE code IS NOT NULL AND code<>'' AND COALESCE(meta_skip,0)=0 AND ((score IS NULL OR score<=0) OR actors IS NULL OR actors='')").get() || {}).c || 0;
      } finally { try { cdb.close(); } catch {} }
    } catch {}
    // 平台库总记录数(用户在表格里能看到的全部影片, 含新旧群)
    let platformTotal = 0;
    try { platformTotal = _countSql('SELECT COUNT(*) n FROM tg_jasna'); } catch {}
    res.json({ ok: true, platformTotal, total: st.total || 0, totalExclDup: Math.max(0, (st.total || 0) - (st.skippedDup || 0)), linked: st.linked || 0, dead: st.dead || 0, missing: st.missing || 0, skippedDup: st.skippedDup || 0, cooldown, metaMissing: metaMissing || 0, halfActive: !!scheduler.getHalfActive(), fetchLoop: !!tj.fetchLoopRunning(c), latestMsgId: (typeof latest !== 'undefined' && latest && latest.m) || 0, latestMsgAt: (typeof latest !== 'undefined' && latest && latest.d) || null });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// 持续补链模式: 循环跑 fetch_links --loop 直到待补清零(触发限流会自动等待冷却)
app.post('/api/tg-jasna/fetch-loop/start', (req, res) => {
  try {
    const { spawn } = require('child_process');
    const tg = require('./modules/tg-jasna');
    const c = tg.cfg();
    if (tg.fetchLoopRunning(c)) return res.json({ ok: true, message: '持续补链已在运行中' });
    const pidFile = path.join(c.projectDir, 'data', 'fetch_loop.pid');
    try { fs.unlinkSync(pidFile); } catch {}
    const stopFile = path.join(c.projectDir, 'data', 'fetch_loop_stop');
    try { fs.unlinkSync(stopFile); } catch {}
    const pythonw = c.pythonExe.replace(/python\.exe$/i, 'pythonw.exe');
    const exe = fs.existsSync(pythonw) ? pythonw : c.pythonExe;
    const child = spawn(exe, ['fetch_links.py', '--loop', '--budget', '20'], {
      cwd: c.projectDir, detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    fs.writeFileSync(pidFile, String(child.pid), 'utf8');
    // 打开保活开关: 看门狗每 5 分钟检查, 补链进程挂了自动重启
    fs.writeFileSync(path.join(c.projectDir, 'data', 'fetch_loop_enabled'), '1', 'utf8');
    setTimeout(() => {
      let alive = true;
      try { process.kill(child.pid, 0); } catch { alive = false; }
      if (!alive) { try { fs.unlinkSync(pidFile); } catch {} }
    }, 8000);
    res.json({ ok: true, message: '持续补链已启动(每轮 20 条, 循环运行, 触发限流自动等待, 看门狗保活)', pid: child.pid });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/tg-jasna/fetch-loop/stop', (req, res) => {
  try {
    const tg = require('./modules/tg-jasna');
    const c = tg.cfg();
    const pidFile = path.join(c.projectDir, 'data', 'fetch_loop.pid');
    let pid = null;
    try { pid = parseInt(fs.readFileSync(pidFile, 'utf8'), 10); } catch {}
    fs.writeFileSync(path.join(c.projectDir, 'data', 'fetch_loop_stop'), String(Date.now()), 'utf8');
    // 关闭保活开关: 看门狗不再自动重启补链
    try { fs.unlinkSync(path.join(c.projectDir, 'data', 'fetch_loop_enabled')); } catch {}
    if (pid) { try { process.kill(pid); } catch {} try { fs.unlinkSync(pidFile); } catch {} }
    res.json({ ok: true, message: '停止指令已发出(循环会在当前条目完成后退出)' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 手动修改番号(识别错误时纠正): 同时清空旧评分/人数/演员, 下次补录按新番号重查
app.patch('/api/tg-jasna/:id/code', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const code = String((req.body || {}).code || '').trim().toUpperCase();
    if (!id) return res.status(400).json({ ok: false, error: 'id 无效' });
    if (!code) return res.status(400).json({ ok: false, error: '番号不能为空' });
    if (!/^[A-Z0-9][A-Z0-9_-]{1,24}$/.test(code)) {
      return res.status(400).json({ ok: false, error: '番号格式不对(只能用字母/数字/横杠/下划线)' });
    }
    const n = db.setTgJasnaCode(id, code);
    if (!n) return res.json({ ok: false, error: '记录不存在' });
    res.json({ ok: true, message: `番号已改为 ${code}（旧评分/演员已清空，点「📊 补录元数据」按新番号重查）` });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 补录 javdb 元数据(评分/评分人数/演员): 子进程执行, 不阻塞请求
let tgEnriching = false;
app.post('/api/tg-jasna/enrich', (req, res) => {
  if (tgEnriching) return res.json({ ok: false, error: '元数据补录正在进行中, 请等这一轮结束' });
  tgEnriching = true;
  try {
    const { spawn } = require('child_process');
    // 日志落文件: 补录是独立进程, stdio 丢弃的话"回收了几个标签/补了几条"都看不见
    const logDir = path.join(__dirname, 'data', 'logs', 'tg-jasna');
    fs.mkdirSync(logDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const logFile = path.join(logDir, `enrich-${stamp}.log`);
    const fd = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, ['tg-jasna.js', '--enrich'],
      { cwd: __dirname, stdio: ['ignore', fd, fd], windowsHide: true });
    const closeFd = () => { try { fs.closeSync(fd); } catch {} };
    child.on('exit', (code) => {
      tgEnriching = false;
      closeFd();
      console.log('[tg-jasna] 元数据补录完成 exit=', code, '日志:', path.relative(__dirname, logFile));
    });
    child.on('error', (e) => {
      tgEnriching = false;
      closeFd();
      res.status(500).json({ ok: false, error: e.message });
    });
    res.json({
      ok: true,
      log: path.relative(__dirname, logFile).replace(/\\/g, '/'),
      message: '元数据补录已启动(扫描全库缺评分/演员的记录, 每轮最多 200 条, 约 1 条/4 秒; 跑完自动回收 javdb 标签页)',
    });
  } catch (e) {
    tgEnriching = false;
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 删除错误记录(软删除: 只从页面移除; 保留行让抓取端指纹预查仍能拦住同一条消息不再插回)
app.post('/api/tg-jasna/delete', (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.json({ ok: false, error: '缺少 id' });
    const n = db.softDeleteTgJasna(id);
    res.json({ ok: true, changed: n, message: '已删除该条记录（不会影响 115 网盘里的资源）' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 手动修正下载链接(抓错/失效时): 改完自动重置离线状态, 可重新推离线
app.post('/api/tg-jasna/set-ed2k', (req, res) => {
  try {
    const { id, ed2k } = req.body || {};
    if (!id) return res.json({ ok: false, error: '缺少 id' });
    const v = String(ed2k || '').trim();
    if (v && !/^(ed2k:\/\/|magnet:\?)/i.test(v)) {
      return res.json({ ok: false, error: '链接必须以 ed2k:// 或 magnet:? 开头' });
    }
    const n = db.setTgJasnaEd2k(id, v || null);
    res.json({ ok: true, changed: n, message: v ? '下载链接已更新，可重新执行离线' : '已清空链接（标记为待补链）' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 标记/取消「不需要补元数据」(javdb 本身没这片的记录, 反复跑没意义)
app.post('/api/tg-jasna/meta-skip', (req, res) => {
  try {
    const { id, skip } = req.body || {};
    if (!id) return res.json({ ok: false, error: '缺少 id' });
    const n = db.setTgJasnaMetaSkip(id, !!skip);
    res.json({ ok: true, changed: n, skip: !!skip });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 补离线: 队列里最早的 N 条(默认 20), 防止一次性把存量几百 GB 全推下去
let tgOfflining = false;
app.post('/api/tg-jasna/offline', (req, res) => {
  if (tgOfflining) return res.json({ ok: false, error: '正在提交离线, 请等这一批结束' });
  const limit = Math.min(Math.max(parseInt((req.body || {}).limit) || 20, 1), 100);
  tgOfflining = true;
  try {
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, ['tg-jasna.js', '--offline-pending', String(limit)], { cwd: __dirname, stdio: 'ignore', windowsHide: true });
    child.on('exit', (code) => { tgOfflining = false; console.log('[tg-jasna] 补离线完成 exit=', code); });
    child.on('error', (e) => { tgOfflining = false; res.status(500).json({ ok: false, error: e.message }); });
    res.json({ ok: true, message: `已开始提交 ${limit} 条待离线记录` });
  } catch (e) {
    tgOfflining = false;
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== 自动流水线: 补链后即时离线 + 元数据自动补录 =====
function _countSql(sql) {  try {
    const Database = require('better-sqlite3');
    const conn = new Database(path.join(__dirname, 'data', 'config.db'), { readonly: true, fileMustExist: true });
    try { return (conn.prepare(sql).get() || {}).n || 0; } finally { conn.close(); }
  } catch { return 0; }
}

// 每 2 分钟把抓取库同步进平台: 补链一成功, 平台 2 分钟内就有链接, 不再显示"待补链"假象
setInterval(() => {
  try {
    const tj = require('./modules/tg-jasna');
    const r = tj.importMessages(tj.cfg(), { push: () => {} });
    if (r.added || r.updated) console.log('[自动同步] 新增', r.added, '条 · 回填链接', r.updated, '条');
  } catch (e) { /* 静默, 下轮再试 */ }
}, 2 * 60 * 1000);

// 待离线队列攒到 5 条就自动提交(每批最多 50 条), 不再等半小时任务堆积
setInterval(() => {
  if (process.env.STANDBY === '1') return;   // 待命模式不自动离线
  if (tgOfflining) return;
  const n = _countSql("SELECT COUNT(*) n FROM tg_jasna WHERE offline_status='pending' AND ed2k IS NOT NULL AND ed2k<>''");
  if (n < 5) return;
  const { spawn } = require('child_process');
  tgOfflining = true;
  const child = spawn(process.execPath, ['tg-jasna.js', '--offline-pending', '50'], { cwd: __dirname, stdio: 'ignore', windowsHide: true });
  child.on('exit', () => { tgOfflining = false; console.log('[自动离线] 一批完成, 队列原有', n, '条'); });
  child.on('error', () => { tgOfflining = false; });
  console.log('[自动离线] 待离线', n, '条 → 已提交一批(最多 50)');
}, 2 * 60 * 1000);

// 缺评分/演员的记录: 每天 10:30 之后补齐(等 10:00 主流水线跑完才动手, 避免两条线抢浏览器/115)
let _enrichDayDone = '';
setInterval(() => {
  if (process.env.STANDBY === '1') return;   // 待命模式不自动补录评分
  const now = new Date();
  const hm = now.getHours() * 60 + now.getMinutes();
  const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  if (hm < 10 * 60 + 30 || _enrichDayDone === day) return;       // 10:30 之前不跑
  if (fs.existsSync(path.join(__dirname, 'data', 'pipeline_running'))) return;  // 主流水线还在跑 → 让位, 下一分钟再看
  const n0 = _countSql("SELECT COUNT(*) n FROM tg_jasna WHERE code IS NOT NULL AND code<>'' AND ((score IS NULL OR score<=0) OR actors IS NULL OR actors='')");
  if (n0 < 1) { _enrichDayDone = day; return; }
  _enrichDayDone = day;
  (async () => {
    console.log('[自动元数据] 主流水线已结束, 开始补齐', n0, '条');
    for (let i = 0; i < 20; i++) {   // 最多 20 批(4000 条), 补齐即停
      const n = _countSql("SELECT COUNT(*) n FROM tg_jasna WHERE code IS NOT NULL AND code<>'' AND ((score IS NULL OR score<=0) OR actors IS NULL OR actors='')");
      if (n < 1) { console.log('[自动元数据] 已补齐'); break; }
      await new Promise((res) => {
        const { spawn } = require('child_process');
        const child = spawn(process.execPath, ['tg-jasna.js', '--enrich'], { cwd: __dirname, stdio: 'ignore', windowsHide: true });
        child.on('exit', res); child.on('error', res);
      });
    }
    console.log('[自动元数据] 补齐结束');
  })();
}, 60 * 1000);

// 规范命名: 番号_JasnaLTX-U / 番号_JasnaLTX-4K-U(子进程, 186 个文件约 1~2 分钟)
let tgRenaming = false;
app.post('/api/tg-jasna/rename', (req, res) => {  if (tgRenaming) return res.json({ ok: false, error: '正在改名中, 请稍后' });
  tgRenaming = true;
  try {
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, ['tg-rename.js'], { cwd: __dirname, stdio: 'ignore', windowsHide: true });
    child.on('exit', (code) => { tgRenaming = false; console.log('[tg-rename] 完成 exit=', code); });
    child.on('error', (e) => { tgRenaming = false; console.log('[tg-rename] 异常', e.message); });
    res.json({ ok: true, message: '已开始规范命名(番号_JasnaLTX[-4K]-U), 完成后自动刷新' });
  } catch (e) {
    tgRenaming = false;
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 抓取日志(与 modules/tg-jasna.js 的 LOG_DIR 保持一致)
const TG_LOG_DIR = path.join(__dirname, 'data', 'logs', 'tg-jasna');
app.get('/api/tg-jasna/logs', (req, res) => {
  try {
    if (!fs.existsSync(TG_LOG_DIR)) return res.json({ ok: true, logs: [] });
    const logs = fs.readdirSync(TG_LOG_DIR)
      .filter(isSafeLogName)
      .map(f => {
        const st = fs.statSync(path.join(TG_LOG_DIR, f));
        const d = st.mtime, p2 = (n) => String(n).padStart(2, '0');
        const mtime = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
        return { name: f, size: st.size, mtime };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
    res.json({ ok: true, logs });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/tg-jasna/logs/:name', (req, res) => {
  const name = isSafeLogName(req.params.name) ? req.params.name : null;
  if (!name) return res.status(400).json({ ok: false, error: '日志名非法' });
  const file = path.join(TG_LOG_DIR, name);
  if (!fs.existsSync(file)) return res.status(404).json({ ok: false, error: '日志不存在' });
  res.json({ ok: true, name, content: fs.readFileSync(file, 'utf8') });
});
app.delete('/api/tg-jasna/logs/:name', (req, res) => {
  const name = isSafeLogName(req.params.name) ? req.params.name : null;
  if (!name) return res.status(400).json({ ok: false, error: '日志名非法' });
  const file = path.join(TG_LOG_DIR, name);
  if (!fs.existsSync(file)) return res.status(404).json({ ok: false, error: '日志不存在' });
  fs.unlinkSync(file);
  res.json({ ok: true, deleted: name });
});

// ---- 删库前的统一兜底: 把待删的行原样落成 JSON ----
// 物理删除不可恢复, 所以两个"清空"接口都先写备份; 写失败就抛错, 由调用方中止删除。
// prefix 只用固定串 + 已过滤的日期, 不接受任意用户输入当文件名。
function backupRowsToFile(prefix, rows) {
  const dir = path.join(__dirname, 'data', 'backup');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `${prefix}_${stamp}.json`);
  fs.writeFileSync(file,
    JSON.stringify({ backedUpAt: new Date().toISOString(), count: rows.length, rows }, null, 1), 'utf8');
  return path.relative(__dirname, file).replace(/\\/g, '/');
}

// 清空记录(按 id 或全部)
app.delete('/api/tg-jasna', (req, res) => {
  const id = req.query.id || null;
  let backup = null;
  if (!id) {
    try {
      const rows = db.dumpTgJasna();
      backup = backupRowsToFile('tg_jasna', rows);
      console.log(`[tg-jasna] 清空前备份 ${rows.length} 条 → ${backup}`);
    } catch (e) {
      console.error('[tg-jasna] 清空前备份失败, 已中止:', e.message);
      return res.status(500).json({ ok: false, error: `清空前备份失败, 已中止: ${e.message}` });
    }
  }
  const n = db.deleteTgJasna(id);
  res.json({ ok: true, deleted: n, backup });
});

// 删除记录(按日期或全部) —— 同样先备份
app.delete('/api/ai-zone', (req, res) => {
  const date = req.query.date || null;
  let backup = null;
  try {
    const rows = db.dumpAiZoneVideos(date);
    if (rows.length) {
      const safeDate = date ? String(date).replace(/[^0-9-]/g, '') : '';
      backup = backupRowsToFile(safeDate ? `ai_zone_${safeDate}` : 'ai_zone', rows);
      console.log(`[ai-zone] 删除前备份 ${rows.length} 条 → ${backup}`);
    }
  } catch (e) {
    console.error('[ai-zone] 删除前备份失败, 已中止:', e.message);
    return res.status(500).json({ ok: false, error: `删除前备份失败, 已中止: ${e.message}` });
  }
  const n = db.deleteAiZoneVideos(date);
  res.json({ ok: true, deleted: n, backup });
});

// ===== API: 配置 =====
app.get('/api/config', (req, res) => {
  res.json(db.getSettings());
});

app.post('/api/config', (req, res) => {
  try {
    const { board103, board36, ...rest } = req.body;
    // 按表单结构保存
    db.setSettingsBulk(req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/config/reset', (req, res) => {
  db.resetSettings();
  res.json({ ok: true });
});

// ===== API: 运行 =====
let running = false;
app.post('/api/run', async (req, res) => {
  if (running) return res.json({ ok: false, error: '已有任务在运行中' });
  running = true;
  const { board = 'all', offline = true, dateStart = null, dateEnd = null, noClean = false, noAiZone = false } = req.body || {};
  try {
    // 用子进程跑,避免阻塞
    const { spawn } = require('child_process');
    const args = ['pipeline.js', '--board', board];
    if (dateStart) args.push('--date-start', dateStart);
    if (dateEnd) args.push('--date-end', dateEnd);
    if (!offline) args.push('--offline', 'false');
    if (noClean) args.push('--no-clean');
    if (noAiZone) args.push('--no-ai-zone');
    const child = spawn(process.execPath, args, { cwd: __dirname, stdio: 'ignore', windowsHide: true });
    child.on('exit', () => { running = false; });
    child.on('error', (e) => { running = false; res.status(500).json({ ok: false, error: e.message }); });
    res.json({ ok: true, message: '已启动流水线(board=' + board + (dateStart ? ', ' + dateStart + '~' + (dateEnd || dateStart) : '') + ')' });
  } catch (e) {
    running = false;
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== API: 运行历史 =====
app.get('/api/runs', (req, res) => {
  res.json(db.getRuns(parseInt(req.query.limit) || 50));
});

app.get('/api/runs/:id', (req, res) => {
  const run = db.getRun(req.params.id);
  if (!run) return res.status(404).json({ ok: false });
  res.json(run);
});

// 删除运行记录; cascade=true 级联删除关联影片记录与资源报告
// 删除资源报告文件(运行记录删除时联动)
// board=null 表示 daily 全板块运行, 删除该日期所有板块的报告
function deleteReportFile(board, date) {
  if (!date) return;
  const reportDir = path.join(__dirname, 'reports', date);
  if (!fs.existsSync(reportDir)) return;
  try {
    const files = fs.readdirSync(reportDir);
    for (const f of files) {
      if (!f.endsWith('.html')) continue;
      if (board == null) {
        if (f.includes(date)) { try { fs.unlinkSync(path.join(reportDir, f)); } catch {} }
      } else if (f === `${board}-${date}.html`) {
        try { fs.unlinkSync(path.join(reportDir, f)); } catch {}
      }
    }
  } catch {}
}

app.delete('/api/runs/:id', (req, res) => {
  const cascade = req.query.cascade === 'true' || req.query.cascade === '1';
  const run = db.getRun(req.params.id);
  if (!run) return res.status(404).json({ ok: false, error: '记录不存在' });
  // 无论是否级联, 资源报告文件都一并删除(报告是运行记录的产物)
  deleteReportFile(run.board, run.run_date);
  if (cascade) {
    const r = db.deleteRunCascade(req.params.id);
    if (!r.ok) return res.status(404).json(r);
    return res.json({ ok: true, message: r.message });
  }
  const n = db.deleteRun(req.params.id);
  if (!n) return res.status(404).json({ ok: false, error: '记录不存在' });
  res.json({ ok: true, message: `已删除运行记录 #${run.id}(资源报告已删除, 影片记录保留)` });
});

// 后台刷新 javdb 评论(单部 id 或 整日 board+date)
app.post('/api/refresh-comments', (req, res) => {
  const { videoId, board, date } = req.body || {};
  const args = [];
  if (videoId) args.push('--id=' + videoId);
  else if (board != null && date) args.push('--board=' + board, '--date=' + date);
  else return res.json({ ok: false, error: '需要 videoId 或 board+date' });
  const { spawn } = require('child_process');
  // 用当前正在运行的 node 可执行文件(process.execPath) —— 不写死版本路径,
  // 因为 .workbuddy/binaries/node/versions/ 下的版本目录会被系统轮换清理
  const proc = spawn(
    process.execPath,
    [path.join(__dirname, 'refresh-comments.js'), ...args],
    { detached: true, stdio: 'ignore', cwd: __dirname }
  );
  proc.unref();
  res.json({ ok: true, message: '已启动后台刷新任务(单部约 30 秒, 全部按影片数), 完成后请刷新页面' });
});

// ===== API: 影片记录 =====
app.get('/api/videos', (req, res) => {
  const { board, date, limit } = req.query;
  // 附带演员映射解析: 若 dir_name 是 javdb 演员名(映射表 javdb_name 有对应), 返回映射后的 115 目录名 dir_display
  const resolveDirDisplay = (rows) => rows.map(v => {
    let dirDisplay = v.dir_name || null;
    if (dirDisplay) {
      const mapped = db.getActressMapByJavdb(dirDisplay);
      if (mapped && mapped.dir_name && mapped.dir_name !== dirDisplay) dirDisplay = mapped.dir_name;
    }
    return { ...v, dir_display: dirDisplay };
  });
  if (board && date) return res.json(resolveDirDisplay(db.getVideos(parseInt(board), date)));
  if (date && !board) {
    // 全部板块指定日期(倒序)
    const rows = db.getAllVideos(parseInt(limit) || 1000).filter(v => v.run_date === date);
    return res.json(resolveDirDisplay(rows));
  }
  if (board && !date) {
    // 只看某板块: 全部日期倒序
    const rows = db.getAllVideos(parseInt(limit) || 500).filter(v => v.board === parseInt(board));
    return res.json(resolveDirDisplay(rows));
  }
  res.json(resolveDirDisplay(db.getAllVideos(parseInt(limit) || 500)));
});

// ===== API: 人工处理进度标记(点开 javdb / 原贴) =====
// body: { source: 'videos'|'ai-zone', id, kind: 'javdb'|'post', value: 1|0 }
app.post('/api/visit', (req, res) => {
  const { source, id, kind, value = 1 } = req.body || {};
  if (!source || !id || !kind) return res.status(400).json({ ok: false, error: '缺少 source/id/kind' });
  const state = db.markVisited(source, id, kind, value);
  if (!state) return res.status(400).json({ ok: false, error: 'source 或 kind 非法' });
  res.json({ ok: true, id: parseInt(id, 10), ...state });
});
// 重置单行标记(误点撤销)
// body: { source, id }
app.post('/api/visit/reset', (req, res) => {
  const { source, id } = req.body || {};
  if (!source || !id) return res.status(400).json({ ok: false, error: '缺少 source/id' });
  const state = db.resetVisited(source, id);
  if (!state) return res.status(400).json({ ok: false, error: 'source 非法' });
  res.json({ ok: true, id: parseInt(id, 10), ...state });
});
// 批量标记/取消(勾选多行后一次性置为已处理或还原)
// body: { source, ids: number[], value: 1|0 }
app.post('/api/visit/batch', (req, res) => {
  const { source, ids, value = 1 } = req.body || {};
  if (!source || !Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ ok: false, error: '缺少 source 或 ids' });
  }
  if (ids.length > 2000) return res.status(400).json({ ok: false, error: '单次最多 2000 条' });
  const updated = db.markVisitedBulk(source, ids, value);
  res.json({ ok: true, updated, value: value ? 1 : 0 });
});
// 批量重置当前筛选范围的进度(重新过一遍列表时用)
// body: { source, board?, date?, dateStart?, dateEnd? }
app.post('/api/visit/reset-bulk', (req, res) => {
  const { source, board = null, date = null, dateStart = null, dateEnd = null } = req.body || {};
  if (!source) return res.status(400).json({ ok: false, error: '缺少 source' });
  const n = db.resetVisitedBulk(source, { board, date, dateStart, dateEnd });
  res.json({ ok: true, reset: n });
});

// 影片记录存在的日期列表(供日期下拉)
app.get('/api/videos/dates', (req, res) => {
  const { board } = req.query;
  res.json(db.getVideoDates(board ? parseInt(board) : null));
});

// 重新生成指定板块/日期的资源报告(供影片记录"跳转报告"定位, 保证锚点与最新数据一致)
app.post('/api/reports/regenerate', (req, res) => {
  const { board, date } = req.body || {};
  if (!board || !date) return res.status(400).json({ ok: false, error: '缺少 board/date' });
  const boardId = parseInt(board);
  const vids = db.getVideos(boardId, date);
  if (!vids.length) return res.json({ ok: false, error: '该板块/日期无影片数据' });
  try {
    report.saveReport(boardId, date, report.generateBoardReport(boardId, date, vids, db.getSettings()));
    res.json({ ok: true, url: `/reports/${date}/${boardId}-${date}.html` });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== API: 115 垃圾文件清理(MCP 实现) =====
// 用 115-Desktop MCP 搜索+删除+重命名, 替代旧 CDP 网页操作(更稳定)
const cleanup = require('./modules/cleanup');

// 清理配置(独立表 cleanup_rules 持久化; 文件名 + 前缀两类)
function cleanupCfg() {
  return db.getCleanupRules();
}
app.get('/api/cleanup/config', (req, res) => {
  res.json({ ok: true, ...cleanupCfg() });
});
app.post('/api/cleanup/config', (req, res) => {
  const { files, prefixes } = req.body || {};
  const clean = {
    files: (files || []).map(x => String(x).trim()).filter(Boolean),
    prefixes: (prefixes || []).map(x => String(x).trim()).filter(Boolean),
  };
  const saved = db.setCleanupRules(clean.files, clean.prefixes);
  res.json({ ok: true, ...saved });
});

// 扫描: 分两类返回
//   - deleteTargets: 文件名规则(精确匹配) → 待删除文件
//   - renameTargets: 前缀规则(前缀匹配) → 待去前缀重命名文件
app.post('/api/cleanup/scan', async (req, res) => {
  try {
    const { files, prefixes } = cleanupCfg();
    if (!files.length && !prefixes.length) return res.json({ ok: false, error: '请先在配置中维护文件名/前缀名单' });
    const deleteTargets = [];  // {keyword, type, items}
    const renameTargets = [];  // {keyword, items}
    // 1. 文件名规则 → 待删除
    for (const kw of files) {
      const r = await cleanup.scanForReport(kw, 'exact');
      deleteTargets.push({ keyword: kw, type: '文件名', count: r.notFound ? 0 : r.count, items: r.notFound ? [] : r.items });
    }
    // 2. 前缀规则 → 待去前缀重命名
    for (const kw of prefixes) {
      const r = await cleanup.scanForReport(kw, 'prefix');
      const items = (r.items || []).map(it => ({ ...it, newName: it.name.startsWith(kw) ? it.name.slice(kw.length) : it.name }));
      renameTargets.push({ keyword: kw, type: '前缀', count: r.notFound ? 0 : r.count, items });
    }
    const delTotal = deleteTargets.reduce((n, r) => n + r.count, 0);
    const renTotal = renameTargets.reduce((n, r) => n + r.count, 0);
    // 查重仅对删除类有意义(去重文件后删多余)
    const allFiles = deleteTargets.flatMap(t => t.items);
    const dups = cleanup.groupDuplicates(allFiles);
    db.saveCleanupLog('scan', `扫描: 待删 ${delTotal} 项, 待去前缀 ${renTotal} 项, 查重 ${dups.length} 组`, { deleteTargets, renameTargets, dups });
    res.json({ ok: true, delTotal, renTotal, deleteTargets, renameTargets, dups: dups.map(g => ({ sha1: g.sha1, count: g.count, files: g.files.map(f => ({ name: f.name, fid: f.fid, size: f.size })) })) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 删除: 前端传 fid 白名单 → MCP delete_files(进回收站)
app.post('/api/cleanup/delete', (req, res) => {
  try {
    const { fids, confirm = false } = req.body || {};
    const ids = [].concat(fids || []).map(String).filter(Boolean);
    if (!ids.length) return res.json({ ok: false, error: '缺少待删除文件 fid 列表' });
    if (!confirm) return res.json({ ok: false, error: '需要 confirm=true 才执行删除' });
    const r = cleanup.deleteByIds(ids, { confirm: true });
    if (r.ok) db.saveCleanupLog('delete', `已删除 ${r.deleted} 个文件(进回收站)`, { logs: r.log });
    // 不再用 ok 字段(115 MCP 响应里 r.ok 可能因空响应误判失败); 真实失败带 error
    res.json({ deleted: r.deleted || 0, logs: r.log, error: r.ok === false ? (r.log && r.log[r.log.length - 1]) : undefined });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 重命名: 前端传 items[{fid, newName}] → MCP batch_rename 去掉前缀
app.post('/api/cleanup/rename', (req, res) => {
  try {
    const { items, confirm = false } = req.body || {};
    if (!confirm) return res.json({ ok: false, error: '需要 confirm=true 才执行重命名' });
    const r = cleanup.renameByIds(items, { confirm: true });
    if (r.ok) db.saveCleanupLog('rename', `已重命名 ${r.renamed} 个文件(去前缀)`, { logs: r.log });
    // 不再用 ok 字段(同 delete)
    res.json({ renamed: r.renamed || 0, logs: r.log, error: r.ok === false ? (r.log && r.log[r.log.length - 1]) : undefined });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/cleanup/logs', (req, res) => {
  res.json(db.getCleanupLogs(parseInt(req.query.limit) || 20));
});
app.get('/api/cleanup/logs/:id', (req, res) => {
  res.json(db.getCleanupLog(req.params.id) || { ok: false });
});

// ===== API: 网络连通性检测(主动触发, 非任务前强制校验) =====
function netcheckOpts() {
  const s = db.getSettings();
  return {
    timeoutMs: parseInt((s.netcheck && s.netcheck.timeoutMs) || 5000),
    retries: parseInt((s.netcheck && s.netcheck.retries) == null ? 1 : s.netcheck.retries),
  };
}
app.get('/api/netcheck', async (req, res) => {
  try {
    const results = await netcheck.runAll(netcheckOpts());
    const id = db.saveNetcheck(results);
    res.json({ ok: true, id, checked_at: new Date().toLocaleString('zh-CN', { hour12: false }), results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.post('/api/netcheck/retry', async (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ ok: false, error: '缺少检测项 id' });
  try {
    const r = await netcheck.runOne(id, netcheckOpts());
    res.json({ ok: true, result: r });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.get('/api/netcheck/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  res.json(db.getNetcheckHistory(limit));
});
app.get('/api/netcheck/history/:id', (req, res) => {
  const h = db.getNetcheckHistoryDetail(req.params.id);
  if (!h) return res.status(404).json({ ok: false });
  res.json(h);
});

// ===== API: 报告索引 =====
function scanReports() {
  const reportsDir = path.join(__dirname, 'reports');
  const list = [];
  if (fs.existsSync(reportsDir)) {
    const dates = fs.readdirSync(reportsDir).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
    for (const date of dates) {
      const dateDir = path.join(reportsDir, date);
      let files = [];
      try { files = fs.readdirSync(dateDir).filter(f => f.endsWith('.html')); } catch {}
      for (const f of files) {
        const boardId = parseInt(f.split('-')[0]);
        list.push({
          date, boardId,
          board: report.BOARD_NAMES[boardId] || boardId,
          file: f, relPath: `/reports/${date}/${f}`,
        });
      }
    }
  }
  list.sort((a, b) => (b.date + b.boardId).localeCompare(a.date + a.boardId));
  return list;
}

app.get('/api/reports', (req, res) => {
  const { date } = req.query;
  let list = scanReports();
  if (date) list = list.filter(r => r.date === date);
  res.json(list);
});

// 全部有报告的日期(降序)
app.get('/api/reports/dates', (req, res) => {
  const list = scanReports();
  const dates = [...new Set(list.map(r => r.date))].sort((a, b) => b.localeCompare(a));
  res.json(dates);
});

// 最新日期 + 两个板块的报告
app.get('/api/reports/latest', (req, res) => {
  const list = scanReports();
  if (!list.length) return res.json({ date: null, reports: {} });
  const latestDate = list[0].date;
  const reports = {};
  for (const r of list) {
    if (r.date !== latestDate) break;
    reports[r.boardId] = r.relPath;
  }
  res.json({ date: latestDate, reports });
});

// ===== API: 调度 =====
app.get('/api/schedule', (req, res) => {
  const s = db.getSettings().schedule;
  res.json({ ...s, builtinActive: !!scheduler.getActive() });
});

app.post('/api/schedule/restart', (req, res) => {
  scheduler.startScheduler();
  res.json({ ok: true, message: '调度器已重启' });
});

app.post('/api/schedule/register', async (req, res) => {
  try {
    const msg = await scheduler.registerTaskPlanner();
    res.json({ ok: true, message: msg });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/schedule/unregister', async (req, res) => {
  try {
    const msg = await scheduler.unregisterTaskPlanner();
    res.json({ ok: true, message: msg });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== API: 演员映射(actress_map) =====
// 列表(搜索/状态过滤/分页)
app.get('/api/actress-map', (req, res) => {
  const { keyword, status, limit, offset } = req.query;
  const rows = db.getActressMap({
    keyword: keyword || '', status: status || '',
    limit: parseInt(limit) || 500, offset: parseInt(offset) || 0,
  });
  res.json({ ok: true, rows, stats: db.getActressMapStats() });
});

// 补录/修改映射: 主体 { javdb_name, dir_name?, cid?, via?, status?, note? }
app.post('/api/actress-map', (req, res) => {
  try {
    const { javdb_name, dir_name, cid, via, status, note } = req.body || {};
    if (!javdb_name) return res.status(400).json({ ok: false, error: '缺少 javdb_name' });
    // 若传入的是 @DIR:xxx 占位名且给了真实 javdb 名, 转为正式映射
    let name = javdb_name;
    const isPendingPlaceholder = String(javdb_name).startsWith('@DIR:');
    if (isPendingPlaceholder && dir_name && !String(javdb_name).startsWith('@DIR:')) name = dir_name;
    db.upsertActressMap({
      javdb_name: name,
      dir_name: dir_name || null,
      cid: cid || null,
      via: via || 'manual',
      status: status || 'mapped',
      note: note || null,
    });
    // 占位名完成映射后, 删除占位记录, 避免重复
    if (isPendingPlaceholder && name !== javdb_name) db.deleteActressMap(javdb_name);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 按 115 目录分组(一个目录 N 个 javdb 别名), 供"目录视图"使用
app.get('/api/actress-map/dirs', (req, res) => {
  const { keyword, status, limit, offset } = req.query;
  const opt = {
    keyword: keyword || '', status: status || '',
    limit: parseInt(limit) || 100, offset: parseInt(offset) || 0,
  };
  res.json({
    ok: true,
    rows: db.getActressMapDirs(opt),
    total: db.countActressMapDirs(opt),
    stats: db.getActressMapStats(),
  });
});

// 目录改名 / 改 cid: 该目录下所有别名行一起同步, 避免只改一行导致其他别名失联
app.post('/api/actress-map/rename-dir', (req, res) => {
  try {
    const { old_dir, new_dir, cid } = req.body || {};
    if (!old_dir) return res.status(400).json({ ok: false, error: '缺少 old_dir' });
    const n = db.renameActressDir(old_dir, new_dir || old_dir, cid || null);
    res.json({ ok: true, updated: n });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 删除整个目录(含其下所有别名行)
app.delete('/api/actress-map/dir/:dir', (req, res) => {
  const n = db.deleteActressDir(decodeURIComponent(req.params.dir));
  res.json({ ok: true, deleted: n });
});

// 删除映射(单个 javdb 别名)
app.delete('/api/actress-map/:name', (req, res) => {
  const n = db.deleteActressMap(decodeURIComponent(req.params.name));
  res.json({ ok: true, deleted: n });
});

// 一键重新构建(调用 build-actress-map.py, 后台运行)
app.post('/api/actress-map/sync', (req, res) => {
  const { mode = 'merge' } = req.body || {};
  if (!['merge', 'rebuild'].includes(mode)) return res.status(400).json({ ok: false, error: 'mode 必须是 merge 或 rebuild' });
  const { spawn } = require('child_process');
  const py = process.env.PYTHON_BIN || '/usr/bin/python3';
  const proc = spawn(py, [path.join(__dirname, 'build-actress-map.py'), '--mode=' + mode], {
    detached: true, stdio: 'ignore', cwd: __dirname,
  });
  proc.unref();
  res.json({ ok: true, message: `已启动演员映射${mode === 'rebuild' ? '全量重建' : '重新构建'}(保留 manual), 完成后 stats 会自动更新` });
});

// 全量演员库 Name 查询(供编辑弹窗 javdb 名下拉选)
// 直连全量库只读查询, 按 Name/NameCN/Roma 模糊 + 精确排序
const Database = require('better-sqlite3');
let _fullDb = null;
function fullDb() {
  if (!_fullDb) {
    const p = (cfg.actressDb && cfg.actressDb.fullDbPath) || path.join(__dirname, 'data', 'Actress-20250220.db');
    _fullDb = new Database(p, { readonly: true });
  }
  return _fullDb;
}
app.get('/api/actress-names', (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    let rows;
    if (!q) {
      // 空查询: 返回平台已遇到/已映射过的演员, 按出现次数倒序
      // 避免全量库脏数据(12JAV / *** 等)污染候选, 也让用户优先看到相关的
      const seen = db.getSeenActresses();
      // 叠加 actress_map 已映射的 javdb_name(半权重)
      for (const n of db.getMappedActressNames()) {
        if (!seen[n]) seen[n] = 0.5;
      }
      const sorted = Object.entries(seen).sort((a, b) => b[1] - a[1]).slice(0, limit);
      const names = sorted.map(t => t[0]);
      if (!names.length) { rows = []; }
      else {
        const ph = names.map(() => '?').join(',');
        const infoRows = fullDb().prepare(`SELECT Name, NameCN, Roma FROM Info WHERE Name IN (${ph})`).all(...names);
        const infoMap = new Map(infoRows.map(r => [r.Name, r]));
        rows = names.map(n => infoMap.get(n) || { Name: n, NameCN: null, Roma: '' });
      }
    } else {
      // 非空查询: 全量库模糊匹配 + 精确优先排序 + 去重
      const like = '%' + q + '%';
      const raw = fullDb().prepare(`
        SELECT Name, NameCN, Roma FROM Info
        WHERE Name LIKE ? OR NameCN LIKE ? OR Roma LIKE ?
        ORDER BY (CASE WHEN Name = ? THEN 0
                       WHEN NameCN = ? THEN 1
                       WHEN Roma = ? THEN 2 ELSE 3 END), Name
        LIMIT ?`).all(like, like, like, q, q, q, limit);
      const seenNames = new Set();
      const uniq = [];
      for (const r of raw) {
        if (!seenNames.has(r.Name)) { seenNames.add(r.Name); uniq.push(r); }
      }
      rows = uniq;
    }
    res.json({ ok: true, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== 启动 =====
app.listen(PORT, cfg.server.host, () => {
  console.log('==========================================');
  console.log('  115影视资源自动管理平台 已启动');
  console.log(`  管理后台: http://${cfg.server.host}:${PORT}`);
  console.log('==========================================');
  scheduler.startScheduler();

  // 预热 javdb 搜索页标签: 平台启动后建好这个常驻 tab,
  // 之后补录(独立进程)会按 URL 特征复用, 不再每次新建 → 不会再把 115 浏览器顶到前台
  // (详情页 tab 由首次补录创建后常驻复用, 只会有一次)
  setTimeout(async () => {
    try {
      const cdp = require('./modules/cdp');
      await cdp.reuseTab('https://javdb.com/search?q=javdb&f=all', 'javdb-search');
      console.log('  javdb 搜索页标签已预热(补录时复用, 不再抢前台)');
    } catch (e) {
      console.log('  javdb 预热跳过: ' + e.message);
    }
  }, 40000);
});
