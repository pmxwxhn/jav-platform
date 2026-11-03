// 流水线编排: 抓取 → javdb筛选 → 115判重 → 离线 → 云下载验证 → HTML报告
// 用法: node pipeline.js [--board 103|36|all] [--date 1] [--offline true|false] [--date-start YYYY-MM-DD] [--date-end YYYY-MM-DD]
const db = require('./db');
const boardFetch = require('./modules/board-fetch');
const javdb = require('./modules/javdb');
const dupCheck = require('./modules/dup-check');
const actressDir = require('./modules/actress-dir');
const offlineMod = require('./modules/offline');
const cloudVerify = require('./modules/cloud-verify');
const report = require('./modules/report');

// 命令行参数
function parseArgs() {
  const args = process.argv.slice(2);
  const out = { board: 'all', date: null, offline: true, dateStart: null, dateEnd: null, noClean: false, noAiZone: false, noTg: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--board') out.board = args[i + 1] || 'all';
    if (args[i] === '--date') out.date = parseInt(args[i + 1]);
    if (args[i] === '--offline') out.offline = args[i + 1] !== 'false';
    if (args[i] === '--date-start') out.dateStart = args[i + 1];
    if (args[i] === '--date-end') out.dateEnd = args[i + 1];
    if (args[i] === '--no-clean') out.noClean = true;
    if (args[i] === '--no-ai-zone') out.noAiZone = true;
    if (args[i] === '--no-tg') out.noTg = true;
  }
  return out;
}

// 计算目标日期
function targetDate(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() - (offsetDays == null ? 1 : offsetDays));
  return fmtDate(d);
}
// 本地日期 YYYY-MM-DD(不能用 toISOString — 那是 UTC, 在 UTC+8 的凌晨 0~8 点会返回前一天,
// 导致任务把"今天"算成昨天, 漏抓补扫也因此被跳过)
function fmtDate(d) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return fmtDate(d);
}
function dateList(start, end) {
  const out = [];
  let cur = start;
  let guard = 0;
  while (cur <= end && guard < 60) { out.push(cur); cur = addDays(cur, 1); guard++; }
  return out;
}
function daysDiff(offset) { return { start: targetDate(offset), end: targetDate(offset) }; }

// ===== 离线下载判定(纯函数, 便于单测) =====
// 规则(优先级从高到低):
//   1) 115 未存           → 下载
//   2) 115 已存在 4K 版本 → 跳过(已有最优版本, 再下一个低清晰度的没意义, 还堆占空间)
//   3) 115 已存在非 4K 版本 → 看 offline.deleteDuplicate 开关
// 注: 待下资源的清晰度在离线前无法可靠获知 —— 色花堂帖子标题不带 4K/1080p 标记,
//     磁力链接本身也不含文件名, 所以只能采取保守规则: 只要 115 已有 4K, 即认定已有最优版本。
//     (2026-09-03 的 SNOS-257 就是典型: 115 已有 SNOS-257-4K-U.mp4 仍被重复下载)
function shouldDownload(p, cfg) {
  if (!(p.dup && p.dup.exists)) return { download: true };
  const has4k = Array.isArray(p.dup.matched) && p.dup.matched.some(m => m.is4k);
  if (has4k) return { download: false, status: 'skipped', detail: '115 已存在 4K 版本,跳过重复下载' };
  if (cfg.offline && cfg.offline.deleteDuplicate) return { download: true };
  return { download: false, status: 'skipped', detail: '115 已存在,未开启重复下载' };
}

// ===== 抓取 javdb 评论(通过影片 + 关联影片) =====
async function fetchCommentsFor(v, log) {
  // 目标影片详情(演员+评论)
  if (v.targetInfo && v.targetInfo.href && !v.comments) {
    try {
      const detail = await javdb.fetchDetail(v.targetInfo.href, v.code);
      v.comments = detail.comments;
      v.javdbActors = detail.actors;
      v.cover = detail.cover;
      v.samples = detail.samples;
      v.info = detail.info;
      v.javdbTitle = detail.title;
      v.preview = detail.preview;
      log.push(`  [评论] ${v.code} 目标影片: ${(detail.comments || []).length} 条`);
      // 有 javdb 链接但没抓到评论 → 记录原因(报告展示用)
      v.commentFail = (detail.comments || []).length ? null : 'javdb 详情页未加载出评论(可能被限流或临时故障)';
    } catch (e) {
      v.comments = [];
      v.commentFail = '评论抓取异常: ' + e.message;
      log.push(`  [评论] ${v.code} 抓取异常: ${e.message}`);
    }
  }
  // 关联影片详情(演员+评论)
  for (const rel of (v.related || [])) {
    if (rel.comments) continue;
    try {
      const detail = await javdb.fetchDetail(rel.href);
      rel.comments = detail.comments;
      rel.actors = detail.actors;
      rel.commentFail = (detail.comments || []).length ? null : 'javdb 详情页未加载出评论(可能被限流或临时故障)';
      log.push(`  [评论] 关联 ${rel.code}: ${(detail.comments || []).length} 条`);
    } catch (e) {
      rel.comments = [];
      rel.commentFail = '评论抓取异常: ' + e.message;
      log.push(`  [评论] 关联 ${rel.code} 抓取异常: ${e.message}`);
    }
  }
}

// ===== 跑单个板块的单个日期 =====
// opts.injectedRows: 有值则跳过抓取, 直接处理这批帖子(供漏抓补扫复用完整流程)
async function runBoardOneDay(fid, runDate, cfg, log, opts = {}) {
  const board = cfg.boards[fid];
  log.push(`--- ${board.name}(fid=${fid}) ${runDate}${opts.injectedRows ? ' [补扫]' : ''} ---`);

  // 1. 抓取
  let fb = null;
  if (opts.injectedRows) {
    log.push(`[1/7] 补扫帖子 ${opts.injectedRows.length} 条(跳过抓取)`);
  } else {
    log.push('[1/7] 抓取帖子...');
    const offset = daysDiffForDate(runDate);
    fb = await boardFetch.fetchBoard(fid, board.name, offset, log);
  }
  const rows = opts.injectedRows || fb.rows;
  if (fb) {
    log.push(`  抓取 ${rows.length} 条 (扫描 ${fb.pages} 页/${fb.scanned} 行, 时间分布: ${fb.distText})`);
    if (fb.reason === 'load-failed') {
      log.push(`  ❌ 板块页面加载失败(已重试1次仍超时) — 网络/登录态异常, 并非当日无帖`);
    } else if (fb.reason === 'time-unknown') {
      log.push(`  ❌ 帖子时间格式无法解析(连续2页) — 疑似页面改版, 需更新 parseTimeDays`);
    } else if (fb.reason === 'no-post') {
      log.push(`  ℹ️ ${runDate} 该板块无新帖(最新帖: ${fb.distText})`);
    }
  }
  const candidates = boardFetch.processRows(rows, board);
  log.push(`  有效番号 ${candidates.length} 个: ${candidates.map(c => c.code).join(', ')}`);
  if (!candidates.length) {
    log.push('  无有效番号,跳过本日');
    return [];
  }

  // 2. javdb 查询 + 筛选
  // 带健康熔断: 连续多个番号全部查不到 = javdb 异常(改版/登录态失效/限流), 中止本轮不入库
  log.push('[2/7] javdb 查询...');
  const results = [];
  const seen = new Set();
  const guard = javdb.createHealthGuard({ probeN: 5 });
  for (const c of candidates) {
    if (seen.has(c.code)) continue;
    seen.add(c.code);
    try {
      const { targetInfo, related } = await javdb.queryJavdb(c.code);
      const abort = guard.check(!!targetInfo.found);
      if (abort) {
        log.push(`  ❌ javdb 健康检查失败: ${abort}`);
        throw new Error(abort);
      }
      const pass = javdb.passFilter(targetInfo, cfg.filter);
      results.push({ ...c, targetInfo, related, pass });
      log.push(`  ${c.code} | ${targetInfo.found ? targetInfo.score + '分/' + targetInfo.votes + '人' : '未找到'} | ${pass ? '✅通过' : ''} | 关联:${related.length}`);
    } catch (e) {
      if (/健康检查失败/.test(e.message)) throw e;   // 熔断错误直接上抛, 不吞掉
      log.push(`  ${c.code} | ❌ javdb 异常: ${e.message}`);
      results.push({ ...c, targetInfo: { found: false }, related: [], pass: false });
    }
  }
  // 样本偏小(<5)未触发熔断, 但全部查无结果时给一条显眼告警, 便于人工判断
  if (results.length >= 3 && !results.some(r => r.targetInfo && r.targetInfo.found)) {
    log.push(`  ⚠️ 本轮 ${results.length} 个番号在 javdb 全部查无结果, 请确认 javdb 是否可访问/登录态是否有效`);
  }

  // 3. 115 判重(对通过的)
  log.push('[3/7] 115 判重...');
  const passed = results.filter(r => r.pass);
  for (const p of passed) {
    try {
      const text = await dupCheck.search115(p.code);
      const d = dupCheck.checkDuplicate(p.code, board.filter, text);
      p.dup = d;
      if (d.failed) {
        // 判重没查成功 ≠ 115 里没有。必须显式区分, 否则会静默重复下载(2026-10-08 的教训)
        log.push(`  ${p.code} | ⚠️ 判重未成功(MCP/CDP 均无响应), 结果不可信, 本轮仍会尝试离线`);
      } else {
        log.push(`  ${p.code} | 已存:${d.exists} | ${d.matched.map(m => m.name).join(',') || '无'}${d.unmatched.length ? ' | 其他:' + d.unmatched.map(m => m.name).join(',') : ''}`);
      }
    } catch (e) {
      log.push(`  ${p.code} | ❌ 判重异常: ${e.message}`);
      p.dup = { exists: false, failed: true };
    }
  }

  // 4. 抓 javdb 评论(通过影片 + 关联影片) —— 报告需要
  log.push('[4/7] javdb 详情/评论...');
  for (const p of passed) {
    await fetchCommentsFor(p, log);
  }

  // 4.5 磁力抓取: 所有影片(含不符合筛选/跳过离线的), 供影片记录展示与报告复制
  log.push('[4.5/7] 磁力抓取(全部影片)...');
  for (const v of results) {
    if (v.magnet) continue;
    try {
      v.magnet = await fetchMagnetFromPost(v);
      log.push(`  ${v.code} 磁力: ${v.magnet ? '✓ 已获取' : '✗ 无磁力'}`);
    } catch (e) {
      log.push(`  ${v.code} 磁力异常: ${e.message}`);
    }
  }

  // 5. 离线清单(判定见 shouldDownload)
  const needDownload = passed.filter(p => {
    const d = shouldDownload(p, cfg);
    if (!d.download) { p.offlineStatus = d.status; p.offlineDetail = d.detail; }
    return d.download;
  });
  const skipped4k = passed.filter(p => /4K/.test(p.offlineDetail || ''));
  const skippedDup = passed.filter(p => p.offlineStatus === 'skipped' && !/4K/.test(p.offlineDetail || ''));
  log.push(`[5/7] 需离线: ${needDownload.length} 条`
    + (skipped4k.length ? ` (已有4K版本跳过 ${skipped4k.length} 条)` : '')
    + (skippedDup.length ? ` (115已存跳过 ${skippedDup.length} 条)` : ''));
  for (const p of skipped4k) log.push(`  ${p.code} | ⏭️ 跳过: 115 已有 4K 版本`);
  for (const p of skippedDup) log.push(`  ${p.code} | ⏭️ 跳过: 115 已存在(未开启重复下载)`);

  // 6. 演员目录判断 + 离线
  log.push('[6/7] 演员目录判断 + 离线...');
  for (const v of needDownload) {
    let dirName = null, dirNote = '';
    // 多人/群交片判定: 按演员人数(用户规则: 演员 > 2 人进"感谢祭、多人", ≤2 人才走演员名称判定)
    // javdbActors 为清洗后的女优数组(fetchDetail 已过滤男优)
    const actorCount = Array.isArray(v.javdbActors) ? v.javdbActors.length : 0;
    const multiLike = actorCount > 2;
    // FC2 影片统一用 FC2 专用目录(根目录>学习资源>FC2), 不识别演员
    // 直接指定 fc2Cid 离线到正确目录, 避免 resolveDir 搜"FC2目录"字符串搜不到而新建错误目录
    if (/^FC2PPV/i.test(v.code)) {
      dirName = 'FC2';
      dirNote = 'FC2 影片(不识别演员, 固定存 学习资源>FC2)';
      if (cfg.mcp115 && cfg.mcp115.fc2Cid) v.mapCid = cfg.mcp115.fc2Cid;
    } else if (multiLike) {
      dirName = '感谢祭、多人';
      dirNote = `多人/群交片(演员${actorCount}人)`;
    } else if (cfg.offline.actressSearch && fid === 36) {
      // resolveActressDir 内部已内置"映射表优先"(javdb 演员名权威键 → 115 目录),
      // 命中映射表直接返回, 绝不拆字搜索; 未命中才回退三级候选拆字搜索
      const dirResult = await actressDir.resolveActressDir(v.actress, v.javdbActors || [], { simplified: cfg.offline.simplified });
      if (dirResult.ok) {
        dirName = dirResult.dir;
        dirNote = dirResult.fromMap ? `映射表:${dirResult.candidate.replace('映射表:', '')}` : (dirResult.candidate ? `命中候选:${dirResult.candidate}` : '');
        if (dirResult.cid) v.mapCid = dirResult.cid;  // 供 offline 直接用 cid
      }
      else { dirNote = '未找到演员目录,待人工判断:' + dirResult.log.slice(0, 3).join('; '); }
    } else if (fid === 103) {
      // 高清中文字幕: 同样先查映射表(javdb 演员名权威键), 命中用映射目录; 未命中才用演员名/标题提取
      const cleanedForMap = cleanActors(v.javdbActors);
      let mapHit = null;
      for (const a of cleanedForMap) { mapHit = db.getActressMapByJavdb(a); if (mapHit && mapHit.cid && mapHit.status === 'mapped') break; }
      if (mapHit && mapHit.cid && mapHit.status === 'mapped') {
        dirName = mapHit.dir_name;
        dirNote = `映射表:${mapHit.javdb_name}`;
        v.mapCid = mapHit.cid;
      } else {
        dirName = cleanedForMap[0]
          || extractActressFromTitle(v.title || '')
          || (v.actress && v.actress.trim().length <= 12 ? v.actress.trim() : null)
          || '待确认';
        dirNote = '高清中文字幕板块(直接按演员名)';
      }
    }
    v.dirName = dirName;
    v.dirNote = dirNote;
    log.push(`  ${v.code} | 目录:${dirName || '无'}${dirNote ? ' (' + dirNote + ')' : ''}`);

    if (!dirName) {
      v.offlineStatus = 'skipped';
      v.offlineDetail = dirNote || '无演员目录,按规则不新建,待人工判断';
      log.push(`    → ⏸️ 跳过(无目录)`);
      continue;
    }
    // 仅当开启离线(默认)且板块启用时执行; --offline false 则只抓取不下载
    const offlineEnabled = (() => {
      const idx = process.argv.indexOf('--offline');
      return idx === -1 ? true : process.argv[idx + 1] !== 'false';
    })();
    if (!offlineEnabled) { v.offlineStatus = 'skipped'; v.offlineDetail = '--offline false 仅抓取'; continue; }
    try {
      // 磁力抓取后回填 v.magnet(落库保存, 供报告显示/复制)
      v.magnet = v.magnet || await fetchMagnetFromPost(v);
      if (!v.magnet) { v.offlineStatus = 'failed'; v.offlineDetail = '无磁力链接'; continue; }
      const mode = dirName === '感谢祭、多人' ? 'multi' : 'single';
      const r = await offlineMod.offlineOne(v.magnet, dirName, mode, { retryTimes: cfg.offline.retryTimes, javdbActors: v.javdbActors || [], mapCid: v.mapCid || null });
      if (r.ok) { v.offlineStatus = 'downloading'; v.offlineDetail = '已提交离线任务(等待云下载验证)'; }
      else { v.offlineStatus = 'failed'; v.offlineDetail = '离线提交失败: ' + r.reason; }
      log.push(`    → ${r.ok ? '✅ 已提交' : '❌ ' + r.reason}`);
    } catch (e) {
      v.offlineStatus = 'failed';
      v.offlineDetail = '离线异常: ' + e.message;
      log.push(`    → ❌ ${e.message}`);
    }
  }

  // 7. 云下载验证
  if (cfg.offline.verifyViaCloud && needDownload.length) {
    log.push('[7/7] 云下载页面验证...');
    try {
      const codes = needDownload.filter(v => v.offlineStatus === 'downloading').map(v => v.code);
      if (codes.length) {
        const verify = await cloudVerify.verifyBatch(codes);
        for (const [code, st] of Object.entries(verify)) {
          const v = needDownload.find(x => x.code === code);
          if (v && st.found) {
            v.offlineStatus = st.state.includes('成功') ? 'success' : (st.state.includes('失败') ? 'failed' : 'downloading');
            v.offlineDetail = '云下载验证: ' + st.state;
            log.push(`  ${code} | ${st.state}`);
          } else if (v) {
            v.offlineDetail = '云下载验证未找到,待人工确认';
            log.push(`  ${code} | ⚠️ 云下载未找到(可能刚提交)`);
          }
        }
      }
    } catch (e) { log.push(`  ⚠️ 云下载验证异常: ${e.message}`); }
  }

  // 8. 落库
  const nowStr = new Date().toLocaleString('zh-CN', { hour12: false });
  for (const v of results) {
    // 演员名称: javdb 演员优先(已是清洗后的女优数组, 直接 join); FC2 用 '-'; 否则帖子名(短名保留, 长标题视为无演员)
    let actors = null;
    if (v.javdbActors && v.javdbActors.length) actors = v.javdbActors.join(',');
    else if (/^FC2PPV/i.test(v.code)) actors = '-';
    else {
      const a = (v.actress || '').trim();
      actors = a && a.length <= 12 ? a : '-';
    }
    // 离线成功时间
    const offlineAt = v.offlineStatus === 'success' ? nowStr : null;
    db.upsertVideo({
      code: v.code, board: fid, run_date: runDate,
      title: v.title, actress: v.actress, post_href: v.href, post_time: v.pubTime,
      magnet: v.magnet || null,
      javdb_href: v.targetInfo ? v.targetInfo.href : null,
      javdb_title: v.targetInfo ? v.targetInfo.title : null,
      score: v.targetInfo ? v.targetInfo.score : null,
      votes: v.targetInfo ? v.targetInfo.votes : null,
      pass: v.pass ? 1 : 0,
      dup_exists: (v.dup && v.dup.exists) ? 1 : 0,
      dup_detail: v.dup ? JSON.stringify(v.dup) : null,
      dir_name: v.dirName, dir_note: v.dirNote,
      offline_status: v.offlineStatus || null,
      offline_detail: v.offlineDetail || null,
      related_json: v.related && v.related.length ? JSON.stringify(v.related) : null,
      comments_json: v.comments && v.comments.length ? JSON.stringify(v.comments) : null,
      comment_fail: v.commentFail || null,
      javdb_actors: actors, offline_at: offlineAt,
      cover_url: v.cover || null,
      samples_json: v.samples && v.samples.length ? JSON.stringify(v.samples) : null,
      info_json: v.info && Object.keys(v.info).length ? JSON.stringify(v.info) : null,
      preview_url: v.preview || null,
    });
  }

  // 9. 生成报告
  const videos = db.getVideos(fid, runDate);
  const html = report.generateBoardReport(fid, runDate, videos, cfg);
  const file = report.saveReport(fid, runDate, html);
  log.push(`  报告: ${file}`);
  return results;
}

// 计算某日期对应的 offset(给 fetchBoard 用)
function daysDiffForDate(dateStr) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr + 'T00:00:00Z');
  const diff = Math.round((today - target) / 86400000);
  return diff < 0 ? 0 : diff;
}

// ===== 漏抓补扫 =====
// 背景: 定时任务每天 10:00 跑, 只覆盖当天 00:00~10:00 发布的帖。
//       若某板块在任务跑完之后才发帖(实测 2026-09-04 亚洲无码板块 16:00 才发),
//       这批帖子第二天也抓不到(任务只抓当天), 会永久漏掉。
// 方案: 跑"当天"任务时, 顺带扫一遍"前一天任务运行时刻之后"发布的帖, 有漏就补跑一次,
//       补到的条目记前一天日期(与当天数据不冲突, upsert 按 code+board+run_date 覆盖)。
//       再往后一天这些帖子就变成 2 天前, 不会被重复补扫。

// 前一天任务的运行时刻(小时), 取自配置 schedule.time
function catchupHour(cfg) {
  const t = (cfg.schedule && cfg.schedule.time) || '10:00';
  const h = parseInt(String(t).split(':')[0], 10);
  return Number.isNaN(h) ? 10 : h;
}

// 距今 n 天的本地日期字符串(用本地时间, 不用 UTC — 避免凌晨跑差一天)
function dateOffsetStr(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function catchupMissed(fid, cfg, log, runDate) {
  if (daysDiffForDate(runDate) !== 0) return;   // 仅对"今天"的任务生效(手动补跑历史日期不触发)
  const board = cfg.boards[fid];
  const hour = catchupHour(cfg);
  const prevDate = dateOffsetStr(1);
  let fb;
  try {
    fb = await boardFetch.fetchBoard(fid, board.name, 1, log);
  } catch (e) {
    log.push(`  ⚠️ 补扫中断(${prevDate}): ${e.message}`);
    return;
  }
  if (fb.reason === 'load-failed') {
    log.push(`  ⚠️ 补扫跳过: 板块页面加载失败, 无法确认前一天是否漏抓`);
    return;
  }
  // 只取前一天 hour:00 之后发布的帖(之前的已由前一天那次任务覆盖)
  const missed = fb.rows.filter((r) => {
    const t = boardFetch.parsePubTime(r.pubTime);
    if (!t || t.days !== 1) return false;
    return t.hh > hour || (t.hh === hour && t.mm > 0);
  });
  if (!missed.length) {
    log.push(`  ✓ 补扫: ${prevDate} ${hour}:00 之后无漏抓`);
    return;
  }
  log.push(`  🔄 补扫发现漏抓 ${missed.length} 条(${prevDate} ${hour}:00 之后发布, 上次任务未覆盖):`);
  for (const r of missed) log.push(`     ${r.pubTime} | ${r.text.slice(0, 50)}`);
  await runBoardOneDay(fid, prevDate, cfg, log, { injectedRows: missed });
}

// ===== 板块主流程(日期范围循环) =====
async function runBoard(fid, cfg, log, cli) {
  const board = cfg.boards[fid];
  if (!board.enabled) { log.push(`[${board.name}] 已禁用,跳过`); return; }
  // 确定日期范围: 命令行优先, 其次配置 dateStart/dateEnd, 最后默认当天
  let start, end;
  if (cli.dateStart && cli.dateEnd) { start = cli.dateStart; end = cli.dateEnd; }
  else if (cli.date != null) { start = end = targetDate(cli.date); }
  else if (board.dateStart && board.dateEnd) { start = board.dateStart; end = board.dateEnd; }
  else { start = end = targetDate(0); }
  if (start > end) { const t = start; start = end; end = t; }
  const dates = dateList(start, end);
  log.push(`=== 板块 ${board.name}(fid=${fid}) 日期范围 ${start} ~ ${end} (${dates.length}天) ===`);
  for (const d of dates) {
    await runBoardOneDay(fid, d, cfg, log);
  }
  // 漏抓补扫: 校验前一天任务时刻之后是否有漏抓, 有则一并补跑
  await catchupMissed(fid, cfg, log, dates[dates.length - 1]);
}

// 从帖子提取磁力
// 从标题尾部提取演员名(分隔符后 2-6 个中日文字符, 如 "...爸爸-月野かすみ" → "月野かすみ")
function extractActressFromTitle(title) {
  if (!title) return null;
  const m = String(title).match(/[，,、：:．.\-\s]\s*([\u4e00-\u9fff\u3040-\u30ff]{2,6})$/);
  return m ? m[1] : null;
}

// 清洗 javdb 演员列表(去 ♀♂ 符号)
// 清洗演员: 只保留 ♀ 女性演员(用户要求, 男优不展示); 无 ♀ 时退回过滤掉 ♂
// 兼容: 某些页面演员无符号 → 保留全部
function cleanActors(list) {
  const raw = (list || []).map(a => String(a).trim()).filter(Boolean);
  const females = raw.filter(a => a.includes('♀'));
  if (females.length) return females.map(a => a.replace(/[♀♂]/g, '').trim()).filter(Boolean);
  const noMale = raw.filter(a => !a.includes('♂')).map(a => a.replace(/[♀♂]/g, '').trim()).filter(Boolean);
  if (noMale.length) return noMale;
  return raw.map(a => a.replace(/[♀♂]/g, '').trim()).filter(Boolean);
}

async function fetchMagnetFromPost(v) {
  const { newTab, closeTab, sleep, evalJS } = require('./modules/cdp');
  try {
    const tab = await newTab(v.href);
    let magnets = [];
    for (let i = 0; i < 5; i++) {
      await sleep(2500);
      try {
        const res = await evalJS(tab, `(() => {
          var html = document.body ? document.body.innerHTML : '';
          var mags = html.match(/magnet:[^\\\\s\\"'<>]+/g) || [];
          return JSON.stringify(mags.filter(m => /btih:/.test(m)));
        })()`, 0);
        const arr = JSON.parse(res);
        if (arr.length) { magnets = [...new Set(arr)]; break; }
      } catch {}
    }
    await closeTab(tab);
    return magnets[0] || null;
  } catch { return null; }
}

// 日志对象: 每次 push 实时写库(前端任务页可实时看到日志)
// 注意: push 必须支持多参数(log.push(...arr) 这种展开写法), 否则只会写入第一条
function makeLog(runId) {
  const lines = [];
  return {
    lines,
    push(...msgs) {
      for (const m of msgs) lines.push(m);
      try { db.updateRunLog(runId, lines.join('\n')); } catch {}
    },
    join(sep) { return lines.join(sep); },
  };
}

// 主入口
async function main() {
  const cli = parseArgs();
  const cfg = db.getSettings();
  // 目标日期(与 runBoard 日期解析一致): 命令行 > 板块配置 > 今天; 供运行历史展示
  const boardCfg = cfg.boards[103] || cfg.boards[36] || {};
  const runDate = cli.dateStart || (cli.date != null ? targetDate(cli.date) : null)
    || boardCfg.dateStart || targetDate(0);
  const runId = db.startRun('daily', cli.board === 'all' ? null : parseInt(cli.board), runDate);
  const log = makeLog(runId);

  // 清理上次残留的抓取标签(sehuatang/javdb), 防止 tab 累积
  try {
    const { cleanupTabs } = require('./modules/cdp');
    await cleanupTabs();
  } catch {}

  try {
    if (cli.board === 'all' || cli.board === '103') {
      await runBoard(103, cfg, log, cli);
    }
    if (cli.board === 'all' || cli.board === '36') {
      await runBoard(36, cfg, log, cli);
    }
    // 跑完板块后: 自动垃圾+前缀清理(默认开启, --no-clean 关闭)
    if (!cli.noClean) {
      try {
        log.push('');
        const { runAutoClean } = require('./modules/auto-clean');
        const cr = await runAutoClean();
        log.push(...cr.log);
      } catch (e) {
        log.push('⚠️ 自动清理异常(已跳过): ' + e.message);
      }
    }
    // 合并 AI 专区抓取(默认开启, --no-ai-zone 关闭): 与板块任务同日执行
    if (!cli.noAiZone) {
      try {
        log.push('');
        const { runAiZone } = require('./modules/ai-zone');
        const ar = await runAiZone({ dateStart: cli.dateStart || null, dateEnd: cli.dateEnd || null });
        log.push(...ar.log);
      } catch (e) {
        log.push('⚠️ AI专区抓取异常(已跳过): ' + e.message);
      }
    }
    // Telegram Jasna-LTX: 抓取/补链已拆分到全天每 30 分钟(scheduler 的半小时任务),
    // 每日任务默认不再重复抓, 只做统一收尾(元数据由 10:05 的计划任务补齐)
    // 需要恢复"每日任务里抓一次": settings.tgJasna.dailyRun = true
    if (!cli.noTg) {
      const tgSet = (db.getSettings() || {}).tgJasna || {};
      if (tgSet.dailyRun === true) {
        try {
          log.push('');
          const { runTgJasna } = require('./modules/tg-jasna');
          const tr = await runTgJasna({});
          log.push(...tr.log);
        } catch (e) {
          log.push('⚠️ Jasna-LTX 抓取异常(已跳过): ' + e.message);
        }
      } else {
        log.push('');
        log.push('📡 Telegram Jasna-LTX 抓取已改为全天每 30 分钟执行(半小时任务), 每日任务本次跳过');
      }
    }
    db.finishRun(runId, 'success', log.join('\n'));
    console.log(log.join('\n'));
    console.log('\n✅ 流水线完成');
  } catch (e) {
    log.push('❌ 流水线异常: ' + e.message);
    db.finishRun(runId, 'failed', log.join('\n'));
    console.error(log.join('\n'));
    console.error('FATAL:', e);
    process.exitCode = 1;
  }
}

// 直接运行时执行
if (require.main === module) {
  main();
}

module.exports = { main, runBoard, runBoardOneDay, dateList, shouldDownload };
