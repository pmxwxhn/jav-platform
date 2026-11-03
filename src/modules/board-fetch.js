// 色花堂板块抓取模块
// 抓取指定 fid 指定日期偏移的帖子列表(忽略 FC2PPV/欧美), 提取番号+演员
const { sleep, evalJS, navigate, newTab, closeTab } = require('./cdp');

// 时间 → 相对天数
function parseTimeDays(t) {
  if (/小时前|分钟前|刚刚|秒前/.test(t)) return 0;
  if (/^昨天/.test(t)) return 1;
  if (/^前天/.test(t)) return 2;
  const m = t.match(/^(\d+)\s*天前/);
  if (m) return parseInt(m[1]);
  return -1;
}

// 时间 → { days, hh, mm }(精确到时分, 供漏抓补扫判断"某时刻之后发布")
// 支持: "昨天 16:03" / "前天 11:18" / "3天前 09:30" / "2 小时前" / "刚刚" / "2026-9-4 16:03"
// 返回 null 表示无法解析
function parsePubTime(t) {
  if (!t) return null;
  const s = String(t).trim();
  // 相对时间: N 小时前 → 用当前时刻倒推
  let m = s.match(/^(\d+)\s*小时前/);
  if (m) {
    const d = new Date(Date.now() - parseInt(m[1], 10) * 3600000);
    return { days: 0, hh: d.getHours(), mm: d.getMinutes() };
  }
  if (/分钟前|刚刚|秒前/.test(s)) {
    const d = new Date();
    return { days: 0, hh: d.getHours(), mm: d.getMinutes() };
  }
  // 昨天/前天/N天前 + 时分
  m = s.match(/^(昨天|前天|(\d+)\s*天前)\s*(\d{1,2}):(\d{2})/);
  if (m) {
    const days = m[1] === '昨天' ? 1 : m[1] === '前天' ? 2 : parseInt(m[2], 10);
    return { days, hh: parseInt(m[3], 10), mm: parseInt(m[4], 10) };
  }
  // 绝对时间
  m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (m) {
    const target = new Date(+m[1], +m[2] - 1, +m[3]); target.setHours(0, 0, 0, 0);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return {
      days: Math.round((today - target) / 86400000),
      hh: parseInt(m[4], 10), mm: parseInt(m[5], 10),
    };
  }
  return null;
}

// 欧洲片判断(高清中文字幕板块忽略)
function isEuropean(title) {
  return /^\[中文字幕\].*?(Blacked|Deeper|Milfy|Blackedraw|Pornhub|Brazzers|Naughty|Reality|TeamSkeet|Fake|Vixen|Tushy|Erotico|Mexican|Evil|Digital|Playground|Kink|Hustler|BangBros|Mofos|Babes|Spizoo|Nubiles|Girlsway|TransAngels|FamilyTherapy|MomsBangTeens)/i.test(title);
}

// 提取番号
function extractCodes(title) {
  const codes = [];
  const re = /[A-Z0-9]{2,8}[-.]?\d{2,7}/g;
  let m;
  while ((m = re.exec(title)) !== null) {
    const code = m[0].replace(/\./g, '-');
    if (/^[A-Z0-9]{2,}[-]\d{2,}$/.test(code) && /[A-Z]/.test(code.split('-')[0]) && code.split('-')[0].length >= 2) {
      codes.push(code.toUpperCase());
    }
  }
  return [...new Set(codes)];
}

// 从标题提取演员名(最后一段)
function extractActressFromTitle(title) {
  const cleaned = title
    .replace(/^[A-Z0-9-]+/, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s+/g, ' ').trim();
  const parts = cleaned.split(/\s+/);
  const last = parts[parts.length - 1];
  if (last && last.length >= 2 && /[\u4e00-\u9fff\u3040-\u30ff]/.test(last)) {
    return last;
  }
  return null;
}

// 列表页取行脚本
const ROWS_JS = [
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

// 天数 → 可读标签
function dayLabel(d) {
  if (d === 0) return '今天';
  if (d === 1) return '昨天';
  if (d === 2) return '前天';
  if (d < 0) return '无法识别';
  return d + '天前';
}

// 翻页抓取
// 返回 { rows, pages, scanned, distText, reason }
//   reason: 'ok' 成功 | 'no-post' 当日确实无新帖 | 'load-failed' 页面加载失败(已重试) | 'time-unknown' 时间格式无法识别(疑似改版)
// 说明: 旧版在"页面加载失败"和"当日无新帖"两种情况下都静默返回空数组, 外部无法区分,
//       曾导致 2026-09-04 亚洲无码板块抓取失败被误认为"当天没发帖"。现在两者分别标记。
async function fetchBoard(fid, boardName, targetDays, log) {
  const push = (m) => { if (Array.isArray(log)) log.push(m); };
  const boardTab = await newTab(`https://www.sehuatang.net/forum.php?mod=forumdisplay&fid=${fid}`);
  const rows = [];
  const dist = {};
  let page = 1, scanned = 0, reason = 'ok', unknownPages = 0;

  // 加载单页: 最多等 20s; 超时则重新导航重试一次
  async function loadPage(url) {
    for (let attempt = 0; attempt < 2; attempt++) {
      await navigate(url, boardTab);
      let lastN = 0;
      for (let i = 0; i < 10; i++) {
        await sleep(2000);
        try {
          const n = await evalJS(boardTab, 'document.querySelectorAll("tbody[id^=normalthread_] tr").length', 0);
          lastN = n;
          if (n > 5) return JSON.parse(await evalJS(boardTab, ROWS_JS));
        } catch {}
      }
      // 降级: 帖子确实少(不足 6 条)时仍接受, 只有完全取不到行才算失败
      if (lastN > 0) {
        try { return JSON.parse(await evalJS(boardTab, ROWS_JS)); } catch {}
      }
      if (attempt === 0) push(`  ⚠️ 第 ${page} 页加载超时(20s), 重新导航重试...`);
    }
    return null;
  }

  try {
    while (true) {
      const url = `https://www.sehuatang.net/forum.php?mod=forumdisplay&fid=${fid}&page=${page}`;
      const pageRows = await loadPage(url);
      if (!pageRows) { reason = 'load-failed'; break; }

      scanned += pageRows.length;
      let foundOlder = false, unknown = 0;
      for (const r of pageRows) {
        const d = parseTimeDays(r.pubTime);
        dist[d] = (dist[d] || 0) + 1;
        if (d === targetDays) rows.push(r);
        else if (d > targetDays) foundOlder = true;   // 出现比目标更旧的帖子
        else if (d < 0) unknown++;
      }
      // 整页时间都解析不出来 → 疑似页面改版, 连续 2 页即放弃, 避免白翻 20 页
      if (pageRows.length > 0 && unknown === pageRows.length) {
        unknownPages++;
        if (unknownPages >= 2) { reason = 'time-unknown'; break; }
      } else {
        unknownPages = 0;
      }
      // 列表按时间倒序: 只要出现比目标更旧的帖子, 说明目标日期区间已全部翻完
      // (注意: 不能用 !hasTarget 作为停止条件 — 目标日期的帖子可能在第 2/3 页)
      if (foundOlder) break;
      page++;
      if (page > 20) break;
    }
  } finally {
    await closeTab(boardTab);
  }

  if (reason === 'ok' && rows.length === 0) reason = 'no-post';
  const distText = Object.keys(dist).length
    ? Object.keys(dist).sort((a, b) => a - b).map(k => `${dayLabel(+k)}${dist[k]}`).join(' ')
    : '无';
  return { rows, pages: page, scanned, distText, reason };
}

// 过滤+提取番号
function processRows(rows, board) {
  const candidates = [];
  for (const r of rows) {
    if (board.skipEuro && isEuropean(r.text)) continue;
    if (board.skipFC2 && /^FC2PPV/i.test(r.text.trim())) continue;
    const codes = extractCodes(r.text);
    if (codes.length) {
      candidates.push({
        title: r.text,
        href: r.href,
        code: codes[0],
        actress: extractActressFromTitle(r.text),
        pubTime: r.pubTime,
      });
    }
  }
  return candidates;
}

module.exports = { fetchBoard, processRows, extractCodes, parseTimeDays, parsePubTime, dayLabel };
