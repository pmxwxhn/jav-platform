// AI 专区抓取模块(sehuatang.net fid=166 细分 typeid=884)
// 流程: 抓取专区帖子列表(按日期范围) → 提取番号 → javdb 查询基础信息(评分/人数/演员)
//       → 过滤"有价值"影片(评分>4 且 评分人数>200) → 115 查重 → 入库展示
// 不进帖子详情页, 不做离线; 每个番号只做 javdb 搜索(评分从搜索结果即可拿)
const { sleep, evalJS, navigate, newTab, closeTab } = require('./cdp');
const javdb = require('./javdb');
const dupCheck = require('./dup-check');
const db = require('../db');

const AI_FID = 166;
const AI_TYPEID = 884;   // AI专区细分板块 typeid
const BOARD_TYPE = 'uncensor'; // AI专区资源是无码破解(-U), 按 uncensor 规则查重(-U/-UC)

// ===== 抓取日志落盘 =====
// 每次抓取生成一个 data/logs/ai-zone/YYYYMMDD-HHmmss.log, 每条日志实时写入
// (即使中途崩溃/超时也留痕, 供前端「抓取日志」面板回溯)
const fs = require('fs');
const path = require('path');
const AI_LOG_DIR = path.join(__dirname, '..', 'data', 'logs', 'ai-zone');
function makeRunLogger() {
  const t = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const name = `${t.getFullYear()}${p2(t.getMonth() + 1)}${p2(t.getDate())}-${p2(t.getHours())}${p2(t.getMinutes())}${p2(t.getSeconds())}.log`;
  const file = path.join(AI_LOG_DIR, name);
  const lines = [];
  try { fs.mkdirSync(AI_LOG_DIR, { recursive: true }); } catch {}
  const flush = () => { try { fs.writeFileSync(file, lines.join('\n'), 'utf8'); } catch {} };
  flush(); // 立即创建空文件, 前端能马上看到"正在抓取"
  return {
    file, name, lines,
    push(...msgs) { for (const m of msgs) lines.push(m); flush(); },
    join: (sep) => lines.join(sep),
  };
}

// 本地日期 YYYY-MM-DD(不能用 toISOString, 那是 UTC, 凌晨会差一天)
function ymdLocal(d) {
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
// 本地时间 'YYYY-MM-DD HH:mm:ss'
function ymdhmsLocal(d) {
  const p2 = (n) => String(n).padStart(2, '0');
  return `${ymdLocal(d)} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
// 解析 'YYYY-MM-DD HH:mm:ss' → Date(存的是本地时间字符串, 统一按本地解析)
function parseLocalStr(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(/-/g, '/'));   // 兼容各引擎
  return Number.isFinite(d.getTime()) ? d : null;
}

// 帖子时间原文 → { date: 'YYYY-MM-DD', ts: 毫秒时间戳 | null }
// 能精确到"分"就返回 ts(用于增量窗口精确过滤); 只有日期粒度的返回 ts=null(调用方按日期兜底, 宁可重复抓不漏)
function parsePubTs(t, now = new Date()) {
  const src = String(t || '').trim();
  let m;
  // "昨天 09:37" / "前天 02:19"
  if ((m = src.match(/^(昨天|前天)\s*(\d{1,2}):(\d{2})$/))) {
    const d = new Date(now);
    d.setDate(d.getDate() - (m[1] === '前天' ? 2 : 1));
    d.setHours(parseInt(m[2], 10), parseInt(m[3], 10), 0, 0);
    return { date: ymdLocal(d), ts: d.getTime() };
  }
  // "2026-8-29 22:30"(带时分)
  if ((m = src.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[\sT]+(\d{1,2}):(\d{2})/))) {
    const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0);
    return { date: ymdLocal(d), ts: d.getTime() };
  }
  // "9 小时前" / "30 分钟前" / "20 秒前"
  if ((m = src.match(/^(\d+)\s*(小时|分钟|秒)前$/))) {
    const n = parseInt(m[1], 10);
    const ms = m[2] === '小时' ? n * 3600e3 : m[2] === '分钟' ? n * 60e3 : n * 1000;
    const d = new Date(now.getTime() - ms);
    return { date: ymdLocal(d), ts: d.getTime() };
  }
  if (/刚刚/.test(src)) return { date: ymdLocal(now), ts: now.getTime() };
  // 以下只有天粒度
  if ((m = src.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) {
    return { date: `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`, ts: null };
  }
  if (/^昨天/.test(src)) { const d = new Date(now); d.setDate(d.getDate() - 1); return { date: ymdLocal(d), ts: null }; }
  if (/^前天/.test(src)) { const d = new Date(now); d.setDate(d.getDate() - 2); return { date: ymdLocal(d), ts: null }; }
  if ((m = src.match(/^(\d+)\s*天前/))) {
    const d = new Date(now); d.setDate(d.getDate() - parseInt(m[1], 10)); return { date: ymdLocal(d), ts: null };
  }
  return { date: ymdLocal(now), ts: null };   // 兜底按今天
}
// 兼容旧导出: 只要日期部分
function parsePubDate(t, today = new Date()) { return parsePubTs(t, today).date; }

// 提取番号(与 board-fetch 相同规则)
// 提取番号
// 注意: 标题里的【...】是压制组/版本/规格标签(如【破解/ED2K/LADA0.91】),
// 全文直接匹配会把 "LADA0.91" 这类标签误当成番号(真实番号是紧跟在】后面的 DDB-248),
// 所以优先从"去掉【】的正文主体"提取, 主体取不到再兜底用全文
function extractCodes(title) {
  const src = String(title || '');
  const body = src.replace(/【[^】]*】/g, ' ');
  const codes = matchCodes(body);
  return codes.length ? codes : matchCodes(src);
}
function matchCodes(s) {
  const codes = [];
  // 加 i: 番号可能写成小写(如 "nhdtb-215"), 输出统一转大写
  const re = /[A-Z0-9]{2,8}[-.]?\d{2,7}/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const code = m[0].replace(/\./g, '-');
    // 校验正则同样要带 i, 否则小写番号会被判为不合法
    if (/^[A-Z0-9]{2,}[-]\d{2,}$/i.test(code) && /[A-Z]/i.test(code.split('-')[0]) && code.split('-')[0].length >= 2) {
      codes.push(code.toUpperCase());
    }
  }
  return [...new Set(codes)];
}

// 翻页抓取帖子列表, 返回 [ {text, href, pubDate, pubTime, ts} ]
// targetDates: [startDate, endDate] YYYY-MM-DD, 只保留日期在范围内的帖子
// sinceTs: 增量水位(毫秒). 给了就只收 ts > sinceTs 的帖子; 帖子取不到精确时间(ts=null)时按日期保留
async function fetchPosts(startDate, endDate, today = new Date(), sinceTs = null, maxPages = 10) {
  const listUrl = `https://www.sehuatang.net/forum.php?mod=forumdisplay&fid=${AI_FID}&typeid=${AI_TYPEID}&filter=author&orderby=dateline`;
  const tab = await newTab(listUrl);
  const posts = [];
  try {
    let page = 1;
    while (true) {
      const url = page === 1 ? listUrl : `${listUrl}&page=${page}`;
      await navigate(url, tab);
      let loaded = false;
      for (let i = 0; i < 10; i++) {
        await sleep(2000);
        try {
          const n = await evalJS(tab, 'document.querySelectorAll("tbody[id^=normalthread_] tr").length', 0);
          if (n > 3) { loaded = true; break; }
        } catch {}
      }
      if (!loaded) break;
      const js = [
        "var rows = [];",
        "var trs = document.querySelectorAll('tbody[id^=normalthread_] tr');",
        "for (var i = 0; i < trs.length; i++) {",
        "  var tr = trs[i];",
        "  var a = tr.querySelector('a.xst, a.s.xst, a[href*=\"thread-\"]');",
        "  if (!a) continue;",
        "  var authorTd = tr.children[2];",
        "  var timeText = authorTd ? (authorTd.textContent || '').trim() : '';",
        "  var lines = timeText.split(String.fromCharCode(10)).map(function(s){return s.trim()}).filter(Boolean);",
        "  var pubTime = lines.length > 1 ? lines[1] : (lines[0] || '');",
        "  rows.push({text: a.textContent.trim(), href: a.href, pubTime: pubTime});",
        "}",
        "JSON.stringify(rows)"
      ].join('\n');
      const pageRows = JSON.parse(await evalJS(tab, js));
      let hasInRange = false, foundBeforeStart = false;
      for (const r of pageRows) {
        const { date: d, ts } = parsePubTs(r.pubTime, today);
        // 比范围更早(列表按时间倒序, 出现即说明翻完了)
        if (d < startDate) { foundBeforeStart = true; continue; }
        if (d > endDate) continue;
        // 增量水位: 能精确到"分"就按时间点过滤, 取不到精确时间的按日期保留(宁可重复抓, 不漏)
        if (sinceTs && ts != null && ts <= sinceTs) continue;
        posts.push({ text: r.text, href: r.href, pubDate: d, pubTime: r.pubTime, ts });
        hasInRange = true;
      }
      if (foundBeforeStart) break;
      page++;
      if (page > maxPages) break;   // 增量窗口通常 1~2 页就够; 全量补抓时调大
    }
  } finally {
    await closeTab(tab);
  }
  return posts;
}

// 主流程: 抓取 → 提取番号 → javdb 查询 → 过滤 → 入库
// 返回 { ok, total, saved, skipped, failed, items, window }
//
// ==== 抓取窗口(增量) ====
// 每天定时跑一次(10:00), 若只抓"当天"的帖子, 上次跑完之后到 24:00 之间发的帖子就永远漏掉了
// (下次再跑时已经是"第二天", 抓的是第二天的帖子)。
// 正确做法: 本次窗口 = (上次抓取时间点 → 现在), 即跨天的一段连续区间。
//   - 传了 dateStart/dateEnd = 手动补抓, 按指定日期范围抓, 且不动水位
//   - 不传 = 自动增量, 抓完把水位更新为本次【开始】时间
//     (用开始时间而不是结束时间: 抓取过程中新发的帖子这次可能没刷到, 下次再抓一次, 宁可重复不漏)
async function runAiZone({
  dateStart = null, dateEnd = null,
  skipExisting = false,   // true = 跳过库里已有番号的 javdb 查询(补抓时省大量时间)
  maxPages = 10,          // 列表翻页上限(全量补抓要调大)
} = {}) {
  const startedAt = Date.now();
  // javdb 故障期间 AI 专区抓不了评分, 整轮跳过(否则会不断失败+触发健康熔断)
  try {
    const d = require('../db');
    if (d.isJavdbPaused && d.isJavdbPaused()) {
      return { ok: true, skipped: true, log: ['[AI专区] ⏸ javdb 已暂停(站点故障), 本轮跳过'] };
    }
  } catch {}
  const now = new Date();
  const logger = makeRunLogger();
  const log = logger;   // 下面所有 log.push(...) 用法不变, 只是额外实时落盘

  // 过滤阈值: 实时读 settings(前端可配置), 默认 4分/200人
  const azCfg = db.getSettings().aiZone || {};
  const minScore = (azCfg.score != null ? parseFloat(azCfg.score) : 4) || 4;
  const minVotes = (azCfg.votes != null ? parseInt(azCfg.votes) : 200) || 200;

  // ---- 计算抓取窗口 ----
  const MAX_LOOKBACK_MS = 7 * 24 * 3600 * 1000;   // 最多回溯 7 天, 防止停机太久一次抓爆
  const manual = !!(dateStart || dateEnd);
  let startDate, endDate, sinceTs = null;
  if (manual) {
    startDate = dateStart || ymdLocal(now);
    endDate = dateEnd || startDate;
  } else {
    const lastStr = (azCfg.lastRunAt || '').trim();
    const lastDate = parseLocalStr(lastStr);
    let lastTs = lastDate ? lastDate.getTime() : NaN;
    if (!Number.isFinite(lastTs)) lastTs = startedAt - 24 * 3600 * 1000;   // 首次运行: 默认最近 24 小时
    if (startedAt - lastTs > MAX_LOOKBACK_MS) lastTs = startedAt - MAX_LOOKBACK_MS;
    sinceTs = lastTs;
    startDate = ymdLocal(new Date(lastTs));
    endDate = ymdLocal(now);
  }

  log.push(`[AI专区] 开始时间: ${new Date(startedAt).toLocaleString('zh-CN')}`);
  log.push(`[AI专区] 抓取窗口: ${manual
    ? `${startDate} ~ ${endDate} (手动补抓, 不动水位)`
    : `${new Date(sinceTs).toLocaleString('zh-CN')} → ${now.toLocaleString('zh-CN')} (增量)`} (fid=${AI_FID}, typeid=${AI_TYPEID})`);
  log.push(`[AI专区] 过滤阈值: 评分>=${minScore} 且 人数>${minVotes}`);
  const posts = await fetchPosts(startDate, endDate, now, sinceTs, maxPages);
  log.push(`[AI专区] 帖子数: ${posts.length}${sinceTs ? ' (已排除水位之前的老帖)' : ''}`);

  // 提取番号(去重)
  const byCode = new Map();
  for (const p of posts) {
    const codes = extractCodes(p.text);
    if (codes.length && !byCode.has(codes[0])) {
      byCode.set(codes[0], { code: codes[0], title: p.text, href: p.href, pubDate: p.pubDate, pubTime: p.pubTime });
    }
  }
  const candidates = [...byCode.values()];
  log.push(`[AI专区] 提取番号: ${candidates.length} 个`);

  // 补抓模式: 跳过库里已有的番号, 只处理没入库过的(省掉大量重复 javdb 查询)
  let existSet = null;
  if (skipExisting) {
    existSet = new Set(db.db.prepare('SELECT code FROM ai_zone_videos').all().map(r => String(r.code).toUpperCase()));
    log.push(`[AI专区] 库内已有 ${existSet.size} 个番号, 将跳过不重复查询`);
  }
  let skippedExisting = 0;

  let saved = 0, skipped = 0, failed = 0;
  const items = [];
  // 健康熔断(与 pipeline 一致): 连续多个番号全部查不到 = javdb 异常, 中止本轮
  const guard = javdb.createHealthGuard({ probeN: 5 });
  for (const c of candidates) {
    if (existSet && existSet.has(c.code.toUpperCase())) { skippedExisting++; continue; }
    try {
      const { targetInfo } = await javdb.queryJavdb(c.code);
      const abort = guard.check(!!targetInfo.found);
      if (abort) {
        log.push(`  ❌ javdb 健康检查失败: ${abort}`);
        throw new Error(abort);
      }
      if (!targetInfo.found || targetInfo.score === null || targetInfo.votes === null) {
        skipped++;
        log.push(`  ${c.code} | 未找到javdb信息 | 跳过`);
        continue;
      }
      // 过滤: 评分 >= 阈值(含等于, 如阈值4则4.00分算达标) 且 评分人数 > 阈值 (用户可配置, 默认 4/200)
      if (!(targetInfo.score >= minScore && targetInfo.votes > minVotes)) {
        skipped++;
        log.push(`  ${c.code} | ${targetInfo.score}分/${targetInfo.votes}人 | 低于阈值 | 跳过`);
        continue;
      }
      // 轻量取演员(搜索结果没有演员, 需进详情页取)
      let actors = null;
      try {
        if (targetInfo.href) {
          actors = await javdb.fetchActorsOnly(targetInfo.href);
        }
      } catch {}
      // 115 查重(与任务模块同规则: 只看视频文件, sub 板块匹配 -C/.chs/-UC)
      let dupExists = 0, dupDetail = null;
      try {
        const search = await dupCheck.search115(c.code);
        const d = dupCheck.checkDuplicate(c.code, BOARD_TYPE, search);
        dupExists = d.exists ? 1 : 0;
        dupDetail = JSON.stringify(d);
      } catch (e) {
        log.push(`  ${c.code} | 115查重异常: ${e.message}`);
      }
      const record = {
        code: c.code, run_date: c.pubDate,
        title: c.title, post_href: c.href, post_time: c.pubTime,
        javdb_href: targetInfo.href || null,
        javdb_title: targetInfo.title || null,
        score: targetInfo.score, votes: targetInfo.votes,
        actors: actors ? actors.join(',') : null,
        dup_exists: dupExists, dup_detail: dupDetail,
      };
      db.upsertAiZoneVideo(record);
      saved++;
      items.push(record);
      log.push(`  ${c.code} | ✅ ${targetInfo.score}分/${targetInfo.votes}人 | ${(actors || []).slice(0, 3).join(',') || '无演员'} | 115:${dupExists ? '已存' : '未存'}`);
    } catch (e) {
      if (/健康检查失败/.test(e.message)) throw e;   // 熔断错误上抛: 中止本轮且不推进水位, 下次重抓
      failed++;
      log.push(`  ${c.code} | ❌ ${e.message}`);
    }
  }
  // 更新水位(仅自动增量模式): 用本次【开始】时间, 保证抓取期间新发的帖子下次还能被抓到
  if (!manual) {
    const water = ymdhmsLocal(new Date(startedAt));
    db.setSetting('aiZone.lastRunAt', water);
    log.push(`[AI专区] 水位已更新: ${water}`);
  }
  const cost = ((Date.now() - startedAt) / 1000).toFixed(1);
  log.push(`[AI专区] 完成: 入库 ${saved} 部, 阈值过滤 ${skipped} 部, 失败 ${failed} 部`
    + (skippedExisting ? `, 已在库跳过 ${skippedExisting} 部` : '') + ` | 耗时 ${cost}s`);
  return {
    ok: true, total: candidates.length, saved, skipped, failed,
    log: logger.lines, logFile: logger.name, items,
    window: { manual, startDate, endDate, sinceTs },
  };
}

module.exports = { runAiZone, fetchPosts, extractCodes, parsePubDate, parsePubTs, AI_FID, AI_TYPEID, BOARD_TYPE, AI_LOG_DIR };
