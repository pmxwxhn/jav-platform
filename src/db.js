// SQLite 数据层
// 表: settings(配置) / task_runs(运行历史) / videos(影片记录)
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const defaultConfig = require('./config');

const DB_PATH = path.join(__dirname, 'data', 'config.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ===== 建表 =====
db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS task_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,            -- daily | board | single
  board INTEGER,                 -- 103 | 36 | NULL(全部)
  run_date TEXT,                 -- 目标日期 YYYY-MM-DD
  status TEXT,                   -- running | success | partial | failed | stopped
  started_at TEXT,
  finished_at TEXT,
  duration_ms INTEGER,
  log TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  board INTEGER NOT NULL,
  run_date TEXT NOT NULL,
  title TEXT,
  actress TEXT,
  post_href TEXT,
  post_time TEXT,
  magnet TEXT,
  javdb_href TEXT,
  javdb_title TEXT,
  score REAL,
  votes INTEGER,
  pass INTEGER DEFAULT 0,
  dup_exists INTEGER DEFAULT 0,
  dup_detail TEXT,
  dir_name TEXT,
  dir_note TEXT,
  offline_status TEXT,           -- success | downloading | pending | skipped | failed
  offline_detail TEXT,
  related_json TEXT,
  comments_json TEXT,
  visited_javdb INTEGER DEFAULT 0,   -- 1=已点开过 javdb 详情页
  visited_post INTEGER DEFAULT 0,    -- 1=已点开过论坛原贴
  created_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(code, board, run_date)
);
CREATE INDEX IF NOT EXISTS idx_videos_board_date ON videos(board, run_date);
CREATE INDEX IF NOT EXISTS idx_runs_date ON task_runs(run_date);
CREATE TABLE IF NOT EXISTS netcheck_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  checked_at TEXT DEFAULT (datetime('now','localtime')),
  summary TEXT,
  results_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_netcheck_time ON netcheck_history(checked_at);
CREATE TABLE IF NOT EXISTS cleanup_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,          -- 'file' 精确文件名 | 'prefix' 前缀
  name TEXT NOT NULL,
  UNIQUE(type, name)
);
CREATE TABLE IF NOT EXISTS cleanup_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  action TEXT,          -- scan | delete
  summary TEXT,
  detail_json TEXT
);
-- 演员映射表: javdb 演员日文名 ↔ 115 演员目录名 ↔ cid
-- 离线时优先查此表直接拿 cid, 免去逐级搜索
CREATE TABLE IF NOT EXISTS actress_map (
  javdb_name TEXT PRIMARY KEY,   -- javdb 演员日文名(规范名)
  dir_name TEXT,                 -- 115 演员目录名
  cid TEXT,                      -- 115 目录 cid
  via TEXT,                      -- 匹配方式: auto_name/auto_cn/auto_sc/auto_roma/auto_alias/manual/dup/excluded
  status TEXT DEFAULT 'mapped',  -- mapped(已映射) | pending(待人工) | excluded(排除)
  note TEXT,                     -- 备注(重复目录提示/跳过原因)
  count INTEGER DEFAULT 0,       -- 该演员在影片记录中出现次数
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_actress_map_dir ON actress_map(dir_name);
CREATE INDEX IF NOT EXISTS idx_actress_map_status ON actress_map(status);
-- AI专区抓取记录: 只存有价值的影片(评分>4 且 评分人数>200), 不进帖子详情, 仅 javdb 基础信息
CREATE TABLE IF NOT EXISTS ai_zone_videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,            -- 番号
  run_date TEXT NOT NULL,        -- 帖子发布日期 YYYY-MM-DD
  title TEXT,                    -- 帖子标题
  post_href TEXT,                -- 色花堂帖子链接
  post_time TEXT,                -- 帖子发布时间原文
  javdb_href TEXT,               -- javdb 详情链接
  javdb_title TEXT,              -- javdb 标题
  score REAL,                    -- javdb 评分
  votes INTEGER,                 -- javdb 评分人数
  actors TEXT,                   -- 演员(逗号分隔)
  dup_exists INTEGER DEFAULT 0,
  dup_detail TEXT,
  visited_javdb INTEGER DEFAULT 0,   -- 1=已点开过 javdb 详情页
  visited_post INTEGER DEFAULT 0,    -- 1=已点开过论坛原贴
  created_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(code, run_date)
);
CREATE INDEX IF NOT EXISTS idx_ai_zone_date ON ai_zone_videos(run_date);

-- Telegram 频道关键词监控(jasna无码资源共享 @jasnashare)抓到的资源
-- 源: F:\telegram-keyword-monitor 的 Telethon 抓取 → SQLite 入库 → 115 离线到 Jasna-LTX
CREATE TABLE IF NOT EXISTS tg_jasna (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT,                    -- 番号
  run_date TEXT NOT NULL,       -- 消息日期 YYYY-MM-DD(页面按日期筛选/统计用)
  msg_date TEXT,                -- 消息时间 YYYY-MM-DD HH:mm:ss
  msg_id INTEGER,               -- Telegram message id
  title TEXT,                   -- 消息首行(标题)
  text TEXT,                    -- 完整消息正文
  ed2k TEXT,                    -- 下载链接(ed2k/magnet, 已补全被截断的尾部; 无则为 NULL)
  link_status TEXT DEFAULT 'ok',-- ok=有链接 / missing=频道暂未放链接(等补链)
  forum_url TEXT,               -- 论坛源地址
  file_name TEXT,               -- ed2k 里的文件名
  file_size INTEGER,            -- 文件大小(字节)
  score REAL,                   -- javdb 评分
  votes INTEGER,                -- javdb 评分人数
  actors TEXT,                  -- 女演员(逗号分隔, javdb 详情页)
  keywords TEXT,                -- 命中的关键词
  offline_status TEXT DEFAULT 'pending',  -- pending/submitted/exists/failed/skipped
  offline_note TEXT,            -- 115 返回的原始提示(排错用)
  offline_at TEXT,              -- 最近一次离线提交时间
  created_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(ed2k)
);
CREATE INDEX IF NOT EXISTS idx_tg_jasna_date ON tg_jasna(run_date);
CREATE INDEX IF NOT EXISTS idx_tg_jasna_code ON tg_jasna(code);
CREATE INDEX IF NOT EXISTS idx_tg_jasna_off ON tg_jasna(offline_status);
`);

// 兼容旧库: 补充新增列
(() => {
  const cols = db.prepare('PRAGMA table_info(videos)').all().map(c => c.name);
  if (!cols.includes('javdb_actors')) db.exec('ALTER TABLE videos ADD COLUMN javdb_actors TEXT');
  if (!cols.includes('offline_at')) db.exec('ALTER TABLE videos ADD COLUMN offline_at TEXT');
  if (!cols.includes('cover_url')) db.exec('ALTER TABLE videos ADD COLUMN cover_url TEXT');
  if (!cols.includes('samples_json')) db.exec('ALTER TABLE videos ADD COLUMN samples_json TEXT');
  if (!cols.includes('info_json')) db.exec('ALTER TABLE videos ADD COLUMN info_json TEXT');
  if (!cols.includes('preview_url')) db.exec('ALTER TABLE videos ADD COLUMN preview_url TEXT');
  if (!cols.includes('comment_fail')) db.exec('ALTER TABLE videos ADD COLUMN comment_fail TEXT');
})();

// actress_map 兼容迁移: 老库无 note 列, 补上
(() => {
  const cols = db.prepare('PRAGMA table_info(actress_map)').all().map(c => c.name);
  if (!cols.includes('note')) db.exec('ALTER TABLE actress_map ADD COLUMN note TEXT');
})();

// ai_zone_videos 兼容迁移: 老库无 dup 列, 补上
(() => {
  try {
    const cols = db.prepare('PRAGMA table_info(ai_zone_videos)').all().map(c => c.name);
    if (!cols.includes('dup_exists')) db.exec('ALTER TABLE ai_zone_videos ADD COLUMN dup_exists INTEGER DEFAULT 0');
    if (!cols.includes('dup_detail')) db.exec('ALTER TABLE ai_zone_videos ADD COLUMN dup_detail TEXT');
  } catch {}
})();

// 人工处理进度标记迁移: 点开 javdb / 原贴各记一次, 两者都点过 = 该片已处理
(() => {
  const addCol = (table, col) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} INTEGER DEFAULT 0`);
  };
  try {
    addCol('videos', 'visited_javdb');
    addCol('videos', 'visited_post');
    addCol('ai_zone_videos', 'visited_javdb');
    addCol('ai_zone_videos', 'visited_post');
  } catch (e) { console.error('visited 列迁移失败:', e.message); }
})();

// tg_jasna 兼容迁移: 老库补 score/votes(评分/评分人数)
(() => {
  try {
    const cols = db.prepare('PRAGMA table_info(tg_jasna)').all().map(c => c.name);
    if (!cols.includes('score')) db.exec('ALTER TABLE tg_jasna ADD COLUMN score REAL');
    if (!cols.includes('votes')) db.exec('ALTER TABLE tg_jasna ADD COLUMN votes INTEGER');
    if (!cols.includes('actors')) db.exec('ALTER TABLE tg_jasna ADD COLUMN actors TEXT');
    if (!cols.includes('link_status')) db.exec("ALTER TABLE tg_jasna ADD COLUMN link_status TEXT DEFAULT 'ok'");
    // msg_id 唯一: 无链接的记录 ed2k 为 NULL, 靠它去重(UNIQUE(ed2k) 对 NULL 不生效)
    // 2026-10-27 起判重维度 = (chat_id, msg_id): 新旧群 msg_id 各自独立计数, 单 msg_id 会让两群互相串行
    try { db.exec('DROP INDEX IF EXISTS ux_tg_jasna_msg'); } catch {}
    if (!cols.includes('chat_id')) db.exec('ALTER TABLE tg_jasna ADD COLUMN chat_id INTEGER');
    if (!cols.includes('version')) db.exec("ALTER TABLE tg_jasna ADD COLUMN version TEXT");
    if (!cols.includes('resolution')) db.exec('ALTER TABLE tg_jasna ADD COLUMN resolution TEXT');
    if (!cols.includes('fps60')) {
      db.exec('ALTER TABLE tg_jasna ADD COLUMN fps60 INTEGER DEFAULT 0');
      try {
        const r = db.prepare("UPDATE tg_jasna SET fps60=1 WHERE text LIKE '%60帧%' OR text LIKE '%60FPS%' OR text LIKE '%60fps%' OR file_name LIKE '%60帧%' OR file_name LIKE '%60FPS%'").run();
        console.log('[db] fps60 存量回填', r.changes, '条');
      } catch (e) { console.error('fps60 回填失败:', e.message); }
    }
    if (!cols.includes('meta_skip')) db.exec('ALTER TABLE tg_jasna ADD COLUMN meta_skip INTEGER DEFAULT 0');
    if (!cols.includes('meta_try')) db.exec('ALTER TABLE tg_jasna ADD COLUMN meta_try INTEGER DEFAULT 0');
    if (!cols.includes('deleted')) db.exec('ALTER TABLE tg_jasna ADD COLUMN deleted INTEGER DEFAULT 0');
    try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_tg_jasna_chat_msg ON tg_jasna(chat_id, msg_id) WHERE msg_id IS NOT NULL'); } catch (e) { console.error('(chat_id,msg_id) 唯一索引创建失败:', e.message); }
  } catch (e) { console.error('tg_jasna 评分列迁移失败:', e.message); }
})();

// 清理规则迁移: 旧 settings.cleanup(JSON) → cleanup_rules 表(仅首次)
try { migrateCleanupRules(); } catch (e) { console.error('cleanup 规则迁移失败:', e.message); }

// ===== settings =====
function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const merged = JSON.parse(JSON.stringify(defaultConfig));
  for (const r of rows) {
    try {
      const keys = r.key.split('.');
      let obj = merged;
      for (let i = 0; i < keys.length - 1; i++) obj = obj[keys[i]];
      obj[keys[keys.length - 1]] = JSON.parse(r.value);
    } catch (e) { /* 忽略无法解析的配置 */ }
  }
  return merged;
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return undefined;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function setSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now','localtime'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, JSON.stringify(value));
}

// javdb 暂停开关: 站点故障期间(2026-11-02 起)所有评分/人数补录一律跳过, 不发任何请求。
// 存在 settings 表 key='javdbPaused', value='1'。恢复: db.setJavdbPaused(false)
function isJavdbPaused() {
  try {
    const r = db.prepare("SELECT value FROM settings WHERE key='javdbPaused'").get();
    return !!r && String(r.value) === '1';
  } catch { return false; }
}
function setJavdbPaused(on) {
  db.prepare(`INSERT INTO settings(key, value) VALUES('javdbPaused', ?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(on ? '1' : '0');
  return isJavdbPaused();
}

function setSettingsBulk(obj, prefix = '') {
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) setSettingsBulk(v, key);
      else setSetting(key, v);
    }
  });
  tx();
}

function resetSettings() {
  db.prepare('DELETE FROM settings').run();
}

// ===== task_runs =====
function startRun(type, board, runDate) {
  const info = db.prepare(`INSERT INTO task_runs (type, board, run_date, status, started_at) VALUES (?, ?, ?, 'running', datetime('now','localtime'))`)
    .run(type, board || null, runDate || null);
  return info.lastInsertRowid;
}

function finishRun(id, status, log) {
  db.prepare(`UPDATE task_runs SET status = ?, finished_at = datetime('now','localtime'),
              duration_ms = (strftime('%s','now','localtime') - strftime('%s', started_at)) * 1000, log = ?
              WHERE id = ?`).run(status, log || null, id);
}

function updateRunLog(id, log) {
  db.prepare('UPDATE task_runs SET log = ? WHERE id = ?').run(log, id);
}

function getRuns(limit = 50) {
  return db.prepare('SELECT * FROM task_runs ORDER BY id DESC LIMIT ?').all(limit);
}

function getRun(id) {
  return db.prepare('SELECT * FROM task_runs WHERE id = ?').get(id);
}

function deleteRun(id) {
  return db.prepare('DELETE FROM task_runs WHERE id = ?').run(id).changes;
}

// 级联删除: run + 对应 board/date 的 videos + 报告文件
function deleteRunCascade(id) {
  const run = db.prepare('SELECT board, run_date FROM task_runs WHERE id = ?').get(id);
  if (!run || !run.run_date) return { ok: false, error: '记录不存在或缺少日期信息' };
  const board = run.board == null ? null : run.board;
  const tx = db.transaction(() => {
    if (board === null) {
      // daily 全板块运行: 删除该日期所有板块的影片记录
      db.prepare('DELETE FROM videos WHERE run_date = ?').run(run.run_date);
    } else {
      db.prepare('DELETE FROM videos WHERE board = ? AND run_date = ?').run(board, run.run_date);
    }
    db.prepare('DELETE FROM task_runs WHERE id = ?').run(id);
  });
  tx();
  // 删报告文件(daily 时删该日期所有板块报告)
  const reportDir = path.join(__dirname, 'reports', run.run_date);
  if (fs.existsSync(reportDir)) {
    try {
      const files = fs.readdirSync(reportDir);
      for (const f of files) {
        if (!f.endsWith('.html')) continue;
        const datePart = run.run_date.replace(/-/g, '-');
        if (board === null) {
          if (f.includes(datePart)) { try { fs.unlinkSync(path.join(reportDir, f)); } catch {} }
        } else if (f === `${board}-${datePart}.html`) {
          try { fs.unlinkSync(path.join(reportDir, f)); } catch {}
        }
      }
    } catch {}
  }
  return { ok: true, message: `已级联删除: 运行记录 #${id} + ${board === null ? '全部板块' : board + '板块'} ${run.run_date} 的影片记录与资源报告` };
}

// ===== videos =====
function upsertVideo(v) {
  const data = {
    code: v.code, board: v.board, run_date: v.run_date,
    title: v.title || null, actress: v.actress || null,
    post_href: v.post_href || null, post_time: v.post_time || null,
    magnet: v.magnet || null,
    javdb_href: v.javdb_href || null, javdb_title: v.javdb_title || null,
    score: v.score ?? null, votes: v.votes ?? null,
    pass: v.pass ? 1 : 0, dup_exists: v.dup_exists ? 1 : 0,
    dup_detail: v.dup_detail || null, dir_name: v.dir_name || null,
    dir_note: v.dir_note || null, offline_status: v.offline_status || null,
    offline_detail: v.offline_detail || null,
    related_json: v.related_json || null, comments_json: v.comments_json || null,
    javdb_actors: v.javdb_actors || null, offline_at: v.offline_at || null,
    cover_url: v.cover_url || null,
    samples_json: v.samples_json || null, info_json: v.info_json || null,
    preview_url: v.preview_url || null,
  };
  db.prepare(`INSERT INTO videos (code, board, run_date, title, actress, post_href, post_time, magnet,
              javdb_href, javdb_title, score, votes, pass, dup_exists, dup_detail, dir_name, dir_note,
              offline_status, offline_detail, related_json, comments_json, javdb_actors, offline_at, cover_url,
              samples_json, info_json, preview_url)
              VALUES (@code, @board, @run_date, @title, @actress, @post_href, @post_time, @magnet,
              @javdb_href, @javdb_title, @score, @votes, @pass, @dup_exists, @dup_detail, @dir_name, @dir_note,
              @offline_status, @offline_detail, @related_json, @comments_json, @javdb_actors, @offline_at, @cover_url,
              @samples_json, @info_json, @preview_url)
              ON CONFLICT(code, board, run_date) DO UPDATE SET
              title=excluded.title, actress=excluded.actress, magnet=excluded.magnet,
              javdb_title=excluded.javdb_title, score=excluded.score, votes=excluded.votes,
              pass=excluded.pass, dup_exists=excluded.dup_exists, dup_detail=excluded.dup_detail,
              dir_name=excluded.dir_name, dir_note=excluded.dir_note,
              offline_status=excluded.offline_status, offline_detail=excluded.offline_detail,
              related_json=excluded.related_json, comments_json=excluded.comments_json,
              javdb_actors=excluded.javdb_actors, offline_at=excluded.offline_at,
              cover_url=excluded.cover_url, samples_json=excluded.samples_json,
              info_json=excluded.info_json, preview_url=excluded.preview_url`)
    .run(data);
}

function getVideos(board, runDate) {
  return db.prepare('SELECT * FROM videos WHERE board = ? AND run_date = ? ORDER BY pass DESC, score DESC').all(board, runDate);
}

function getAllVideos(limit = 200) {
  // 默认按日期倒序(最新在前), 同日期按 id 倒序
  return db.prepare('SELECT * FROM videos ORDER BY run_date DESC, id DESC LIMIT ?').all(limit);
}

// 影片记录存在的日期列表(倒序), 供前端日期下拉
function getVideoDates(board = null) {
  const rows = board
    ? db.prepare('SELECT DISTINCT run_date FROM videos WHERE board = ? ORDER BY run_date DESC').all(board)
    : db.prepare('SELECT DISTINCT run_date FROM videos ORDER BY run_date DESC').all();
  return rows.map(r => r.run_date).filter(Boolean);
}

function getVideo(code, board, runDate) {
  return db.prepare('SELECT * FROM videos WHERE code = ? AND board = ? AND run_date = ?').get(code, board, runDate);
}

// ===== AI 专区(ai_zone_videos) =====
function upsertAiZoneVideo(v) {
  db.prepare(`INSERT INTO ai_zone_videos (code, run_date, title, post_href, post_time, javdb_href, javdb_title, score, votes, actors, dup_exists, dup_detail)
              VALUES (@code, @run_date, @title, @post_href, @post_time, @javdb_href, @javdb_title, @score, @votes, @actors, @dup_exists, @dup_detail)
              ON CONFLICT(code, run_date) DO UPDATE SET
              title=excluded.title, post_href=excluded.post_href, post_time=excluded.post_time,
              javdb_href=excluded.javdb_href, javdb_title=excluded.javdb_title,
              score=excluded.score, votes=excluded.votes, actors=excluded.actors,
              dup_exists=excluded.dup_exists, dup_detail=excluded.dup_detail`)
    .run({
      code: v.code, run_date: v.run_date,
      title: v.title || null, post_href: v.post_href || null, post_time: v.post_time || null,
      javdb_href: v.javdb_href || null, javdb_title: v.javdb_title || null,
      score: v.score ?? null, votes: v.votes ?? null, actors: v.actors || null,
      dup_exists: v.dup_exists ? 1 : 0, dup_detail: v.dup_detail || null,
    });
}
// 查询 AI 专区记录: 支持日期范围/番号关键字
function getAiZoneVideos({ dateStart = null, dateEnd = null, keyword = '', limit = 500 } = {}) {
  let sql = 'SELECT * FROM ai_zone_videos WHERE 1=1';
  const args = [];
  if (dateStart) { sql += ' AND run_date >= ?'; args.push(dateStart); }
  if (dateEnd) { sql += ' AND run_date <= ?'; args.push(dateEnd); }
  if (keyword) { sql += ' AND (code LIKE ? OR title LIKE ? OR actors LIKE ?)'; args.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`); }
  sql += ' ORDER BY run_date DESC, score DESC LIMIT ?';
  args.push(parseInt(limit) || 500);
  return db.prepare(sql).all(...args);
}
// AI 专区存在的日期列表(倒序)
function getAiZoneDates() {
  return db.prepare('SELECT DISTINCT run_date FROM ai_zone_videos ORDER BY run_date DESC').all().map(r => r.run_date).filter(Boolean);
}
// 删除 AI 专区记录(按日期或全部)
function deleteAiZoneVideos(runDate = null) {
  if (runDate) return db.prepare('DELETE FROM ai_zone_videos WHERE run_date = ?').run(runDate).changes;
  return db.prepare('DELETE FROM ai_zone_videos').run().changes;
}
// 原样导出待删除的行 —— 删库前兜底备份用(按日期就只导该日期)
function dumpAiZoneVideos(runDate = null) {
  if (runDate) return db.prepare('SELECT * FROM ai_zone_videos WHERE run_date = ? ORDER BY id ASC').all(runDate);
  return db.prepare('SELECT * FROM ai_zone_videos ORDER BY id ASC').all();
}

// ===== Telegram Jasna-LTX(tg_jasna) =====
// 插入一条(按 msg_id 幂等); 若原记录没链接、这次补到了链接 → 就地更新并置为待离线
// 返回 { inserted, updated, id }
// ed2k 文件指纹: |大小|hash| —— 同一文件的 hash 必相同, 文件名/广告前缀可能不同
// 指纹相同 = 同一个文件, 判重按指纹而不是整条链接字符串
function fpOf(ed2k) {
  const m = String(ed2k || '').match(/\|(\d+)\|([0-9A-Fa-f]{32})\|/);
  return m ? (m[1] + '|' + m[2].toLowerCase()) : null;
}

// 版本识别: 消息含「自制投稿」= 无水印自制版, 与常规(有水印)版是不同资源, 判重必须区分
function versionOf(text) {
  const t = String(text || '');
  // 2026-10-31: 频道新增「BT无水印搬运版」「无水印H265磁链搬运版」等写法,
  // 正文出现「无水印」也算无水印版(原来只认「自制投稿」)
  if (/自制投稿|无水印/.test(t)) return 'selfmade';
  return 'normal';                             // 常规(有水印)
}
function versionLabel(v) {
  return v === 'selfmade' ? '无水印' : (v === 'normal' ? '有水印' : '');
}

// 60 帧标记: 正文/文件名出现「60帧」「60fps」→ 1(与分辨率并列的独立标签, 不替换分辨率)
function detectFps60(name, text) {
  const s = String(name || '') + ' ' + String(text || '');
  return /60\s*帧|60\s*fps/i.test(s) ? 1 : 0;
}

// 清晰度判定: 文件名/正文标题含 4K/2160/UHD → 4K; 含 1080/FHD → 1080P; 含 720 → 720P;
// 都没有时按文件大小推断(≥16G 4K / ≥4G 1080P / ≥1.5G 720P / 其余 SD)
function detectResolution(name, text, size) {
  const n = String(name || '');
  const t = String(text || '').split('ed2k://')[0];   // 只看标题段, 避免 ed2k hash 里出现 "4k" 误判
  const s = Number(size || 0);
  if (/4K|2160|UHD/i.test(n) || /4K|2160|UHD/i.test(t) || s >= 16 * 1024 ** 3) return '4K';
  if (/1080|FHD/i.test(n) || /1080|FHD/i.test(t)) return '1080P';
  if (/720/i.test(n) || /720/i.test(t)) return '720P';
  if (s > 0) {
    if (s >= 4 * 1024 ** 3) return '1080P';
    if (s >= 1.5 * 1024 ** 3) return '720P';
    return 'SD';
  }
  return null;
}

function upsertTgJasna(v) {
  // 判重维度 = (chat_id, msg_id): 新旧群 msg_id 各自独立计数, 只按 msg_id 会互相串行
  const exist = (v.chat_id != null && v.msg_id != null)
    ? db.prepare('SELECT id, ed2k, link_status FROM tg_jasna WHERE chat_id = ? AND msg_id = ?').get(v.chat_id, v.msg_id)
    : (v.msg_id != null
        ? db.prepare('SELECT id, ed2k, link_status FROM tg_jasna WHERE chat_id IS NULL AND msg_id = ?').get(v.msg_id)
        : null);
  if (exist) {
    if (v.ed2k && !exist.ed2k) {
      // 回填前按文件指纹查重: 同一文件已由另一条记录占用 → 跳过(不重复离线);
      // 不同文件(大小或 hash 不同) → 正常回填, 两条各自离线
      const fp = fpOf(v.ed2k);
      const dup = fp
        ? db.prepare('SELECT id FROM tg_jasna WHERE ed2k LIKE ? AND id <> ?').get('%|' + fp + '|/%', exist.id)
        : db.prepare('SELECT id FROM tg_jasna WHERE ed2k = ? AND id <> ?').get(v.ed2k, exist.id);
      if (!dup) {
        db.prepare(`UPDATE tg_jasna SET ed2k=?, file_name=?, file_size=?, resolution=?, fps60=?, link_status='ok',
            offline_status='pending', offline_note=NULL, forum_url=COALESCE(?, forum_url), text=COALESCE(?, text)
            WHERE id=?`).run(v.ed2k, v.file_name || null, v.file_size ?? null, detectResolution(v.file_name, v.text, v.file_size), detectFps60(v.file_name, v.text), v.forum_url || null, v.text || null, exist.id);
        return { inserted: 0, updated: 1, id: exist.id };
      }
      // 同一文件已由另一条记录入库(旧群已发过/重发): 删除当前行 —— 平台只保留一条,
      // 页面不会出现重复条目也不会一直显示"待补链"; 下轮同步指纹预查会拦截该消息不再插回
      db.prepare('DELETE FROM tg_jasna WHERE id=?').run(exist.id);
      return { inserted: 0, updated: 0, id: dup.id };
    }
    return { inserted: 0, updated: 0, id: exist.id };
  }
  // 新消息入库前按文件指纹查重: 同一文件(哪怕链接字符串不同)不入库, 避免平台出现重复条目
  if (v.ed2k) {
    const fp = fpOf(v.ed2k);
    if (fp) {
      const dup = db.prepare('SELECT id FROM tg_jasna WHERE ed2k LIKE ?').get('%|' + fp + '|/%');
      if (dup) return { inserted: 0, updated: 0, id: dup.id, skippedByFingerprint: true };
    }
  }
  const info = db.prepare(`INSERT INTO tg_jasna
      (chat_id, code, run_date, msg_date, msg_id, title, text, ed2k, link_status, forum_url, file_name, file_size, keywords, version, resolution, fps60)
      VALUES (@chat_id, @code, @run_date, @msg_date, @msg_id, @title, @text, @ed2k, @link_status, @forum_url, @file_name, @file_size, @keywords, @version, @resolution, @fps60)
      ON CONFLICT(ed2k) DO NOTHING`)
    .run({
      chat_id: v.chat_id ?? null,
      code: v.code || null, run_date: v.run_date, msg_date: v.msg_date || null,
      msg_id: v.msg_id ?? null, title: v.title || null, text: v.text || null,
      ed2k: v.ed2k || null, link_status: v.ed2k ? 'ok' : 'missing', forum_url: v.forum_url || null,
      file_name: v.file_name || null, file_size: v.file_size ?? null,
      keywords: v.keywords || null,
      version: v.version || versionOf(v.text),
      resolution: v.resolution || detectResolution(v.file_name, v.text, v.file_size),
      fps60: v.fps60 != null ? v.fps60 : detectFps60(v.file_name, v.text),
    });
  if (info.changes > 0) return { inserted: 1, updated: 0, id: info.lastInsertRowid };
  const row = v.ed2k ? db.prepare('SELECT id FROM tg_jasna WHERE ed2k = ?').get(v.ed2k) : null;
  return { inserted: 0, updated: 0, id: row ? row.id : null };
}
// 查询: 日期范围 / 关键字(番号/文件名/正文) / 离线状态
function getTgJasna({ dateStart = null, dateEnd = null, keyword = '', offline = '', meta = '', scoreBand = '', votesBand = '', actor = '', msgDate = '', visit = '', resolution = '', dual = '', limit = 2000 } = {}) {
  let sql = `SELECT *, (
      SELECT COUNT(*) FROM tg_jasna o
      WHERE tg_jasna.code IS NOT NULL AND tg_jasna.code <> ''
        AND o.code = tg_jasna.code
        AND COALESCE(o.version,'') <> COALESCE(tg_jasna.version,'')
    ) AS other_ver FROM tg_jasna WHERE COALESCE(deleted,0)=0`;
  const args = [];
  if (dateStart) { sql += ' AND run_date >= ?'; args.push(dateStart); }
  if (dateEnd) { sql += ' AND run_date <= ?'; args.push(dateEnd); }
  // 消息日期(单选): 按 msg_date 的日期部分过滤
  if (msgDate) { sql += ' AND substr(msg_date,1,10) = ?'; args.push(String(msgDate).slice(0, 10)); }
  // 清晰度: 4K / 1080P / 720P / SD
  if (resolution) {
    // 60FPS 不是分辨率档位, 是独立的帧率标签
    if (String(resolution).toUpperCase() === '60FPS') sql += ' AND COALESCE(fps60,0) = 1';
    else { sql += ' AND resolution = ?'; args.push(String(resolution).toUpperCase()); }
  }
  // 版本: dual=只看有另一版本(自制/常规)的番号 · single=只看单版本
  //       selfmade=无水印自制版 · normal=色花堂发帖版(非自制)
  // 判定条件与上面 other_ver 子查询完全一致, 保证和行内「🔀 双版本」徽标同一口径
  if (dual === 'dual' || dual === 'single') {
    const cnt = "SELECT COUNT(*) FROM tg_jasna o WHERE tg_jasna.code IS NOT NULL AND tg_jasna.code <> ''"
      + " AND o.code = tg_jasna.code AND COALESCE(o.version,'') <> COALESCE(tg_jasna.version,'')";
    sql += dual === 'dual' ? ` AND (${cnt}) > 0` : ` AND (${cnt}) = 0`;
  } else if (dual === 'selfmade') {
    sql += " AND version = 'selfmade'";
  } else if (dual === 'normal') {
    sql += " AND COALESCE(version,'') <> 'selfmade'";
  }
  // 已读/已存状态: done=已存 · undone=未存
  if (visit === 'done') { sql += ' AND visited_javdb = 1'; }
  else if (visit === 'undone') { sql += ' AND COALESCE(visited_javdb,0) = 0'; }
  if (keyword) {
    sql += ' AND (code LIKE ? OR file_name LIKE ? OR text LIKE ? OR forum_url LIKE ?)';
    const k = `%${keyword}%`; args.push(k, k, k, k);
  }
  if (offline === 'missing') { sql += ' AND (ed2k IS NULL OR ed2k = \'\')'; }
  else if (offline) { sql += ' AND offline_status = ?'; args.push(offline); }
  // meta=missing: 只看缺评分或演员的(点状态条「待补元数据」触发的筛选)
  if (meta === 'missing') {
    sql += " AND code IS NOT NULL AND code <> '' AND ((score IS NULL OR score <= 0) OR actors IS NULL OR actors = '')";
  }
  // 评分区间
  if (scoreBand === 'none') { sql += ' AND (score IS NULL OR score <= 0)'; }
  else if (scoreBand === '4.5+') { sql += ' AND score >= 4.5'; }
  else if (scoreBand === '4.0-4.5') { sql += ' AND score >= 4.0 AND score < 4.5'; }
  else if (scoreBand === '3.5-4.0') { sql += ' AND score >= 3.5 AND score < 4.0'; }
  else if (scoreBand === '-3.5') { sql += ' AND score > 0 AND score < 3.5'; }
  // 评分人数区间
  if (votesBand === 'none') { sql += ' AND (votes IS NULL OR votes <= 0)'; }
  else if (votesBand === '1000+') { sql += ' AND votes >= 1000'; }
  else if (votesBand === '500-1000') { sql += ' AND votes >= 500 AND votes < 1000'; }
  else if (votesBand === '100-500') { sql += ' AND votes >= 100 AND votes < 500'; }
  else if (votesBand === '-100') { sql += ' AND votes > 0 AND votes < 100'; }
  // 女演员(actors 是 "A / B / C" 形式, 用 LIKE 模糊匹配整名)
  if (actor) { sql += ' AND actors LIKE ?'; args.push(`%${actor}%`); }
  sql += ' ORDER BY msg_date DESC, id DESC LIMIT ?';
  args.push(parseInt(limit) || 2000);
  return db.prepare(sql).all(...args);
}
function getTgJasnaDates() {
  return db.prepare('SELECT DISTINCT run_date FROM tg_jasna ORDER BY run_date DESC').all().map(r => r.run_date).filter(Boolean);
}
// 消息日期列表(前端单选下拉用), 倒序
function getTgJasnaMsgDates() {
  return db.prepare("SELECT DISTINCT substr(msg_date,1,10) AS d FROM tg_jasna WHERE msg_date IS NOT NULL AND msg_date <> '' ORDER BY d DESC")
    .all().map(r => r.d).filter(Boolean);
}
// 顶部统计卡片用
function getTgJasnaStats() {
  const one = (sql, ...a) => { const r = db.prepare(sql).get(...a); return r ? (r.n || 0) : 0; };
  const today = db.prepare("SELECT date('now','localtime') d").get().d;
  return {
    total: one('SELECT COUNT(*) n FROM tg_jasna WHERE COALESCE(deleted,0)=0'),
    today: one('SELECT COUNT(*) n FROM tg_jasna WHERE COALESCE(deleted,0)=0 AND run_date = ?', today),
    submitted: one("SELECT COUNT(*) n FROM tg_jasna WHERE COALESCE(deleted,0)=0 AND offline_status IN ('submitted','exists')"),
    pending: one("SELECT COUNT(*) n FROM tg_jasna WHERE COALESCE(deleted,0)=0 AND offline_status NOT IN ('submitted','exists') AND ed2k IS NOT NULL AND ed2k <> ''"),
    missingLink: one("SELECT COUNT(*) n FROM tg_jasna WHERE COALESCE(deleted,0)=0 AND ed2k IS NULL OR ed2k = ''"),
    bytes: one('SELECT SUM(file_size) n FROM tg_jasna WHERE COALESCE(deleted,0)=0'),
    lastMsgAt: (db.prepare('SELECT MAX(msg_date) m FROM tg_jasna WHERE COALESCE(deleted,0)=0').get() || {}).m || null,
  };
}
// 待离线队列(提交时按 id 升序, 先来先下)
function getTgJasnaPending(limit = 50) {
  return db.prepare(`SELECT * FROM tg_jasna
    WHERE offline_status NOT IN ('submitted','exists') AND ed2k IS NOT NULL AND ed2k <> ''
    ORDER BY id ASC LIMIT ?`).all(parseInt(limit) || 50);
}
function setTgJasnaOffline(id, status, note = '') {
  return db.prepare(`UPDATE tg_jasna SET offline_status=?, offline_note=?,
      offline_at=datetime('now','localtime') WHERE id=?`).run(status, note || null, parseInt(id, 10)).changes;
}
// 回填 javdb 评分/人数/女演员
function setTgJasnaScore(id, score, votes, actors = null) {
  const cur = db.prepare('SELECT actors FROM tg_jasna WHERE id=?').get(parseInt(id, 10)) || {};
  return db.prepare('UPDATE tg_jasna SET score=?, votes=?, actors=? WHERE id=?')
    .run(score == null ? null : Number(score),
      votes == null ? null : parseInt(votes, 10),
      actors != null ? actors : (cur.actors || null),
      parseInt(id, 10)).changes;
}
// 还没查全(评分或演员缺)的记录, 供批量回填
function getTgJasnaNoScore(limit = 500) {
  return db.prepare(`SELECT id, code, score, actors FROM tg_jasna
    WHERE code IS NOT NULL AND code <> ''
      AND COALESCE(meta_skip,0)=0
      AND ((score IS NULL OR score <= 0) OR actors IS NULL OR actors = '')
    ORDER BY id ASC LIMIT ?`).all(parseInt(limit) || 500);
}
// 标记/取消"不需要补元数据"(javdb 本身没这片的记录, 反复重试没意义)
// 删除错误记录(软删除): 只从页面隐藏, 保留行以便抓取端指纹预查仍能拦住同一条消息不再插回
// 注意: 旧版本这里也叫 deleteTgJasna, 被下面同名函数(硬删除)覆盖, 从未生效过;
//       2026-10-29 改名 softDeleteTgJasna, 单条删除走它, 整表清空才走硬删。
function softDeleteTgJasna(id) {
  return db.prepare('UPDATE tg_jasna SET deleted=1 WHERE id=?').run(parseInt(id, 10)).changes;
}

// 手动修正下载链接(链接抓错/失效时): 重新解析文件名/大小/清晰度, 并把离线状态重置为 pending 以便重推
function setTgJasnaEd2k(id, ed2k) {
  const rid = parseInt(id, 10);
  const link = ed2k ? String(ed2k).trim() : null;
  let fileName = null, fileSize = null;
  if (link) {
    const m = link.match(/ed2k:\/\/\|file\|(.+?)\|(\d+)\|([0-9A-Fa-f]{32})/);
    if (m) { fileName = m[1]; fileSize = parseInt(m[2], 10); }
  }
  return db.prepare(`UPDATE tg_jasna SET ed2k=?, file_name=?, file_size=?, resolution=?,
      link_status=?, offline_status='pending', offline_note=NULL WHERE id=?`)
    .run(link, fileName, fileSize, detectResolution(fileName, null, fileSize),
      link ? 'ok' : 'missing', rid).changes;
}

function setTgJasnaMetaSkip(id, skip) {
  return db.prepare('UPDATE tg_jasna SET meta_skip=? WHERE id=?').run(skip ? 1 : 0, parseInt(id, 10)).changes;
}
function bumpTgJasnaMetaTry(id) {
  const rid = parseInt(id, 10);
  db.prepare('UPDATE tg_jasna SET meta_try=COALESCE(meta_try,0)+1 WHERE id=?').run(rid);
  const r = db.prepare('SELECT meta_try FROM tg_jasna WHERE id=?').get(rid);
  return r ? (Number(r.meta_try) || 0) : 0;
}
// 同番号其它版本已有的元数据(同一部片, 评分/人数/演员通用) —— 补录前先复用, 不用再查 javdb
function getSameCodeMeta(code, excludeId) {
  if (!code) return null;
  const r = db.prepare(`SELECT score, votes, actors FROM tg_jasna
    WHERE code = ? AND id <> ? AND score IS NOT NULL AND score > 0
    ORDER BY (CASE WHEN actors IS NULL OR actors='' THEN 1 ELSE 0 END), id ASC LIMIT 1`)
    .get(String(code), parseInt(excludeId, 10) || 0);
  return r || null;
}
// 手动改番号(识别错误时纠正): 同时清空旧评分/人数/演员, 让下次补录按新番号重查
function setTgJasnaCode(id, code) {
  return db.prepare(`UPDATE tg_jasna SET code=?, score=NULL, votes=NULL, actors=NULL WHERE id=?`)
    .run(String(code || '').trim().toUpperCase(), parseInt(id, 10)).changes;
}
// javdb 日文名 → 115 演员目录名(中文) 映射字典
function getActressCnMap() {
  const rows = db.prepare("SELECT javdb_name, dir_name FROM actress_map WHERE status='mapped' AND dir_name IS NOT NULL AND dir_name <> ''").all();
  const map = {};
  for (const r of rows) map[r.javdb_name] = r.dir_name;
  return map;
}

// 女演员统计: 拆 actors("A / B / C") 后计数, 按片数降序(同名去重, 同条记录只算一次)
function getTgJasnaActors() {
  const rows = db.prepare("SELECT actors FROM tg_jasna WHERE actors IS NOT NULL AND actors <> '' AND actors <> '-'").all();
  const map = new Map();
  for (const r of rows) {
    const seen = new Set();
    for (const raw of String(r.actors).split('/')) {
      const n = raw.trim();
      if (!n || seen.has(n)) continue;
      seen.add(n);
      map.set(n, (map.get(n) || 0) + 1);
    }
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name), 'zh'));
}

function deleteTgJasna(id = null) {
  if (id) return db.prepare('DELETE FROM tg_jasna WHERE id = ?').run(parseInt(id, 10)).changes;
  return db.prepare('DELETE FROM tg_jasna').run().changes;
}

// 整表原样导出(含已软删除的行) —— 清空前的兜底备份用, 保证能一条不落地还原
function dumpTgJasna() {
  return db.prepare('SELECT * FROM tg_jasna ORDER BY id ASC').all();
}

// ===== 人工处理进度标记(点开 javdb / 原贴) =====
// 两个都点过 = 已处理(done); 只点一个 = 处理中(doing); 都没点 = 未处理(undone)
// Jasna-LTX 也接入「已读/已处理」标记(复用视频板块那套 visited_* 字段)
try { db.exec('ALTER TABLE tg_jasna ADD COLUMN visited_javdb INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE tg_jasna ADD COLUMN visited_post INTEGER DEFAULT 0'); } catch {}

const VISIT_SOURCES = { videos: 'videos', 'ai-zone': 'ai_zone_videos', 'tg-jasna': 'tg_jasna' };
const VISIT_COLS = { javdb: 'visited_javdb', post: 'visited_post' };

function visitStateOf(v) {
  if (!v) return 'undone';
  const j = v.visited_javdb ? 1 : 0;
  const p = v.visited_post ? 1 : 0;
  if (j && p) return 'done';
  if (j || p) return 'doing';
  return 'undone';
}
// 记录点开 javdb / 原贴(value=0 可单项取消), 返回最新状态
function markVisited(source, id, kind, value = 1) {
  const table = VISIT_SOURCES[source];
  const col = VISIT_COLS[kind];
  if (!table || !col) return null;
  db.prepare(`UPDATE ${table} SET ${col}=? WHERE id=?`).run(value ? 1 : 0, parseInt(id, 10));
  return getVisitedState(source, id);
}
// 重置整行标记(误点撤销)
function resetVisited(source, id) {
  const table = VISIT_SOURCES[source];
  if (!table) return null;
  db.prepare(`UPDATE ${table} SET visited_javdb=0, visited_post=0 WHERE id=?`).run(parseInt(id, 10));
  return getVisitedState(source, id);
}
function getVisitedState(source, id) {
  const table = VISIT_SOURCES[source];
  if (!table) return null;
  const row = db.prepare(`SELECT visited_javdb, visited_post FROM ${table} WHERE id=?`).get(parseInt(id, 10));
  if (!row) return null;
  return { visited_javdb: row.visited_javdb ? 1 : 0, visited_post: row.visited_post ? 1 : 0, state: visitStateOf(row) };
}
// 批量标记/取消(勾选多行后一次性置为已处理或还原)
// ids: number[]; value: 1=标记已处理(javdb+原贴都置1), 0=还原未处理
function markVisitedBulk(source, ids, value = 1) {
  const table = VISIT_SOURCES[source];
  if (!table) return 0;
  const list = (Array.isArray(ids) ? ids : []).map(x => parseInt(x, 10)).filter(n => Number.isFinite(n));
  if (!list.length) return 0;
  const v = value ? 1 : 0;
  const ph = list.map(() => '?').join(',');
  return db.prepare(`UPDATE ${table} SET visited_javdb=?, visited_post=? WHERE id IN (${ph})`).run(v, v, ...list).changes;
}
// 批量重置(按板块/日期维度清一次进度)
function resetVisitedBulk(source, { board = null, date = null, dateStart = null, dateEnd = null } = {}) {
  const table = VISIT_SOURCES[source];
  if (!table) return 0;
  let sql = `UPDATE ${table} SET visited_javdb=0, visited_post=0 WHERE 1=1`;
  const args = [];
  if (board != null) { sql += ' AND board = ?'; args.push(parseInt(board, 10)); }
  if (date) { sql += ' AND run_date = ?'; args.push(date); }
  if (dateStart) { sql += ' AND run_date >= ?'; args.push(dateStart); }
  if (dateEnd) { sql += ' AND run_date <= ?'; args.push(dateEnd); }
  return db.prepare(sql).run(...args).changes;
}

// ===== 统计 =====
function getStats() {
  const stats = {};
  stats.totalVideos = db.prepare('SELECT COUNT(*) c FROM videos').get().c;
  stats.totalRuns = db.prepare('SELECT COUNT(*) c FROM task_runs').get().c;
  stats.successRuns = db.prepare(`SELECT COUNT(*) c FROM task_runs WHERE status IN ('success','partial')`).get().c;
  stats.pendingOffline = db.prepare(`SELECT COUNT(*) c FROM videos WHERE pass = 1 AND offline_status = 'pending'`).get().c;
  stats.downloading = db.prepare(`SELECT COUNT(*) c FROM videos WHERE offline_status = 'downloading'`).get().c;
  stats.downloaded = db.prepare(`SELECT COUNT(*) c FROM videos WHERE offline_status = 'success'`).get().c;
  stats.byBoard = {
    103: db.prepare(`SELECT COUNT(*) c FROM videos WHERE board = 103 AND pass = 1`).get().c,
    36: db.prepare(`SELECT COUNT(*) c FROM videos WHERE board = 36 AND pass = 1`).get().c,
  };
  // 最近运行
  stats.recentRuns = db.prepare('SELECT id, type, board, run_date, status, started_at, duration_ms FROM task_runs ORDER BY id DESC LIMIT 10').all();
  return stats;
}

module.exports = {
  isJavdbPaused, setJavdbPaused,
  db, getSettings, getSetting, setSetting, setSettingsBulk, resetSettings,
  startRun, finishRun, updateRunLog, getRuns, getRun, deleteRun, deleteRunCascade,
  upsertVideo, getVideos, getAllVideos, getVideo, getVideoDates, getStats,
  saveNetcheck, getNetcheckHistory, getNetcheckHistoryDetail,
  saveCleanupLog, getCleanupLogs, getCleanupLog,
  getCleanupRules, setCleanupRules, migrateCleanupRules,
  getActressMap, getActressMapByJavdb, getActressMapByDir, upsertActressMap, setActressMapStatus, deleteActressMap, getActressMapStats,
  getActressMapDirs, countActressMapDirs, renameActressDir, deleteActressDir,
  getSeenActresses, getMappedActressNames,
  upsertAiZoneVideo, getAiZoneVideos, getAiZoneDates, deleteAiZoneVideos,
  dumpAiZoneVideos,
  upsertTgJasna, getTgJasna, getTgJasnaDates, getTgJasnaMsgDates, getTgJasnaStats, getTgJasnaPending, setTgJasnaOffline, deleteTgJasna,
  softDeleteTgJasna,
  dumpTgJasna,
  setTgJasnaScore, getTgJasnaNoScore, setTgJasnaCode, getTgJasnaActors, getActressCnMap,
  setTgJasnaMetaSkip, bumpTgJasnaMetaTry, getSameCodeMeta, setTgJasnaEd2k, deleteTgJasna,
  visitStateOf, markVisited, resetVisited, getVisitedState, resetVisitedBulk, markVisitedBulk,
};

// ===== 115 垃圾清理规则(独立表持久化) =====
function getCleanupRules() {
  const rows = db.prepare('SELECT type, name FROM cleanup_rules ORDER BY id').all();
  return {
    files: rows.filter(r => r.type === 'file').map(r => r.name),
    prefixes: rows.filter(r => r.type === 'prefix').map(r => r.name),
  };
}
// 保存规则(整体替换); 迁移: 若表空且 settings 有旧 cleanup 配置, 先搬入
function setCleanupRules(files, prefixes) {
  const ins = db.prepare('INSERT OR IGNORE INTO cleanup_rules (type, name) VALUES (?, ?)');
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM cleanup_rules').run();
    for (const f of files || []) if (f) ins.run('file', f);
    for (const p of prefixes || []) if (p) ins.run('prefix', p);
  });
  tx();
  return getCleanupRules();
}
// 一次性迁移: 旧的 settings.cleanup(JSON) 搬到 cleanup_rules 表
function migrateCleanupRules() {
  const cnt = db.prepare('SELECT COUNT(*) c FROM cleanup_rules').get().c;
  if (cnt > 0) return;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'cleanup'").get();
  if (!row) return;
  let c = null;
  try { c = JSON.parse(row.value); } catch { try { c = JSON.parse(JSON.parse(row.value)); } catch {} }
  if (!c || typeof c !== 'object') return;
  setCleanupRules(c.files || [], c.prefixes || []);
  db.prepare("DELETE FROM settings WHERE key = 'cleanup'").run();
}

// ===== 115 垃圾清理日志 =====
function saveCleanupLog(action, summary, detail) {
  return db.prepare('INSERT INTO cleanup_logs (action, summary, detail_json) VALUES (?, ?, ?)')
    .run(action, summary, JSON.stringify(detail || {}));
}
function getCleanupLogs(limit = 20) {
  return db.prepare('SELECT id, created_at, action, summary FROM cleanup_logs ORDER BY id DESC LIMIT ?').all(limit);
}
function getCleanupLog(id) {
  return db.prepare('SELECT * FROM cleanup_logs WHERE id = ?').get(id);
}

// ===== 网络检测历史 =====
function saveNetcheck(results) {
  const ok = results.filter(r => r.ok).length;
  const summary = `${ok}/${results.length} 项通过`;
  const info = db.prepare('INSERT INTO netcheck_history (summary, results_json) VALUES (?, ?)')
    .run(summary, JSON.stringify(results));
  // 只保留最近 30 条
  db.prepare('DELETE FROM netcheck_history WHERE id NOT IN (SELECT id FROM netcheck_history ORDER BY id DESC LIMIT 30)').run();
  return info.lastInsertRowid;
}

function getNetcheckHistory(limit = 10) {
  return db.prepare('SELECT id, checked_at, summary FROM netcheck_history ORDER BY id DESC LIMIT ?').all(limit);
}

function getNetcheckHistoryDetail(id) {
  return db.prepare('SELECT * FROM netcheck_history WHERE id = ?').get(id);
}

// ===== 演员映射表 actress_map =====
// 列出映射(支持 关键词/状态 过滤, limit 分页)
function getActressMap({ keyword = '', status = '', limit = 500, offset = 0 } = {}) {
  let sql = 'SELECT * FROM actress_map WHERE 1=1';
  const args = [];
  if (keyword) { sql += ' AND (javdb_name LIKE ? OR dir_name LIKE ? OR cid LIKE ?)'; args.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`); }
  if (status) { sql += ' AND status = ?'; args.push(status); }
  sql += ' ORDER BY count DESC, javdb_name LIMIT ? OFFSET ?';
  args.push(limit, offset);
  return db.prepare(sql).all(...args);
}
// 按 javdb 名精确查(离线用)
function getActressMapByJavdb(javdbName) {
  if (!javdbName) return null;
  return db.prepare("SELECT * FROM actress_map WHERE javdb_name = ? AND status = 'mapped'").get(javdbName);
}
// 按 115 目录名查(反向, 管理页用)
function getActressMapByDir(dirName) {
  if (!dirName) return null;
  return db.prepare('SELECT * FROM actress_map WHERE dir_name = ? LIMIT 1').get(dirName);
}
// 插入或更新(覆盖式; 支持 note)
function upsertActressMap(row) {
  db.prepare(`INSERT INTO actress_map (javdb_name, dir_name, cid, via, status, note, count, updated_at)
              VALUES (@javdb_name, @dir_name, @cid, @via, @status, @note, @count, datetime('now','localtime'))
              ON CONFLICT(javdb_name) DO UPDATE SET
              dir_name=excluded.dir_name, cid=excluded.cid, via=excluded.via,
              status=excluded.status, note=excluded.note,
              count=excluded.count, updated_at=excluded.updated_at`)
    .run({
      javdb_name: row.javdb_name, dir_name: row.dir_name || null, cid: row.cid || null,
      via: row.via || 'manual', status: row.status || 'mapped',
      note: row.note || null, count: row.count || 0,
    });
}
// 改状态(mapped/pending/excluded) 或 补录映射
function setActressMapStatus(javdbName, status, patch = {}) {
  const cur = db.prepare('SELECT * FROM actress_map WHERE javdb_name = ?').get(javdbName);
  const d = cur || { javdb_name: javdbName, dir_name: null, cid: null, via: 'manual', count: 0 };
  const dir_name = patch.dir_name !== undefined ? patch.dir_name : d.dir_name;
  const cid = patch.cid !== undefined ? patch.cid : d.cid;
  const via = patch.via || d.via || 'manual';
  upsertActressMap({ javdb_name: javdbName, dir_name, cid, via, status: status || d.status || 'mapped', count: d.count || 0 });
}
function deleteActressMap(javdbName) {
  return db.prepare('DELETE FROM actress_map WHERE javdb_name = ?').run(javdbName).changes;
}
// 按 115 目录名分组: 一组 = 一个目录 + 它下面的所有 javdb 别名
// 返回 [{ dir_name, cid, alias_count, total_count, mapped_count, aliases:[{javdb_name,via,status,count,note}] }]
function getActressMapDirs({ keyword = '', status = '', limit = 200, offset = 0 } = {}) {
  const args = [];
  let where = `WHERE COALESCE(dir_name, '') <> ''`;
  if (keyword) {
    where += ' AND (dir_name LIKE ? OR cid LIKE ? OR javdb_name LIKE ?)';
    args.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  if (status) { where += ' AND status = ?'; args.push(status); }
  // 分页在"目录"维度, 而非行维度
  const dirSql = `SELECT dir_name,
                         MAX(cid)  AS cid,
                         SUM(COALESCE(count,0)) AS total_count,
                         COUNT(*)  AS alias_count,
                         SUM(CASE WHEN status='mapped' THEN 1 ELSE 0 END) AS mapped_count
                  FROM actress_map ${where}
                  GROUP BY dir_name
                  ORDER BY total_count DESC, dir_name
                  LIMIT ? OFFSET ?`;
  const groups = db.prepare(dirSql).all(...args, limit, offset);
  const detail = db.prepare('SELECT dir_name, javdb_name, via, status, note, count FROM actress_map WHERE dir_name = ? ORDER BY count DESC, javdb_name');
  return groups.map(g => ({ ...g, aliases: detail.all(g.dir_name) }));
}
// 目录维度计数(分页用)
function countActressMapDirs({ keyword = '', status = '' } = {}) {
  const args = [];
  let where = `WHERE COALESCE(dir_name, '') <> ''`;
  if (keyword) {
    where += ' AND (dir_name LIKE ? OR cid LIKE ? OR javdb_name LIKE ?)';
    args.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  if (status) { where += ' AND status = ?'; args.push(status); }
  return db.prepare(`SELECT COUNT(*) c FROM (SELECT dir_name FROM actress_map ${where} GROUP BY dir_name)`).get(...args).c;
}
// 目录改名/改 cid: 该目录下所有别名行一起同步, 避免只改一行导致其他别名失联
function renameActressDir(oldDir, newDir, cid = null) {
  if (!oldDir) return 0;
  const tx = db.transaction(() => {
    let n = 0;
    if (newDir && newDir !== oldDir) {
      n = db.prepare("UPDATE actress_map SET dir_name = ?, updated_at = datetime('now','localtime') WHERE dir_name = ?").run(newDir, oldDir).changes;
    }
    const target = (newDir && newDir !== oldDir) ? newDir : oldDir;
    if (cid) {
      db.prepare("UPDATE actress_map SET cid = ?, updated_at = datetime('now','localtime') WHERE dir_name = ?").run(cid, target);
    }
    return n || (cid ? db.prepare('SELECT COUNT(*) c FROM actress_map WHERE dir_name = ?').get(target).c : 0);
  });
  return tx();
}
// 删除整个目录(及其下所有别名行)
function deleteActressDir(dirName) {
  return db.prepare('DELETE FROM actress_map WHERE dir_name = ?').run(dirName).changes;
}
// 统计
function getActressMapStats() {
  return {
    total: db.prepare('SELECT COUNT(*) c FROM actress_map').get().c,
    mapped: db.prepare("SELECT COUNT(*) c FROM actress_map WHERE status = 'mapped'").get().c,
    pending: db.prepare("SELECT COUNT(*) c FROM actress_map WHERE status = 'pending'").get().c,
    excluded: db.prepare("SELECT COUNT(*) c FROM actress_map WHERE status = 'excluded'").get().c,
  };
}

// 平台 videos.javdb_actors 已遇到过的演员(去重+出现次数), 供下拉选空查询时返回
// 避免全量库脏数据(12JAV / *** 等)污染候选
function getSeenActresses() {
  const seen = {};
  for (const r of db.prepare("SELECT javdb_actors FROM videos WHERE javdb_actors IS NOT NULL AND javdb_actors != ''").all()) {
    let arr = null;
    try { arr = JSON.parse(r.javdb_actors); } catch { arr = String(r.javdb_actors).split(/[、,，]/); }
    for (const a of (arr || [])) {
      const n = String(a).trim();
      if (n && n !== '-' && n.length >= 2) seen[n] = (seen[n] || 0) + 1;
    }
  }
  return seen;
}

// actress_map 已映射的 javdb_name 集合(非占位 mapped 行)
function getMappedActressNames() {
  const set = new Set();
  for (const r of db.prepare("SELECT javdb_name FROM actress_map WHERE status = 'mapped' AND javdb_name NOT LIKE '@DIR:%'").all()) {
    set.add(r.javdb_name);
  }
  return set;
}
