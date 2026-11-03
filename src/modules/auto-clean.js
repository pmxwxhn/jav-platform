// 自动清理模块: 跑完板块任务后自动执行垃圾扫描 + 前缀扫描并全部处理
// 流程:
//   1. 读 cleanup_rules(文件名精确名单 + 前缀名单)
//   2. 文件名规则命中 → 直接删除(进回收站)
//   3. 前缀规则命中 → 直接去前缀重命名
//   4. 结果写入 cleanup_logs
const cleanup = require('./cleanup');
const db = require('../db');

async function runAutoClean() {
  const log = [];
  log.push('🧹 ===== 自动垃圾/前缀清理开始 =====');
  try {
    const { files, prefixes } = db.getCleanupRules();
    log.push(`规则: 文件名精确 ${files.length} 条, 前缀 ${prefixes.length} 条`);
    let delTotal = 0, renTotal = 0;

    // 1. 文件名规则 → 精确扫描 → 删除(进回收站)
    for (const kw of files) {
      const r = await cleanup.scanForReport(kw, 'exact');
      const items = r.items || [];
      if (!items.length) { log.push(`  [删除]「${kw}」: 无匹配, 跳过`); continue; }
      const fids = items.map(f => f.fid);
      const d = await cleanup.deleteByIds(fids, { confirm: true });
      delTotal += (d.deleted || 0);
      log.push(`  [删除]「${kw}」: 命中 ${items.length} 个文件 → ${d.ok ? '✅ 已删除 ' + d.deleted + ' 个(回收站)' : '❌ ' + (d.log[d.log.length - 1] || '失败')}`);
    }

    // 2. 前缀规则 → 前缀扫描 → 去前缀重命名
    for (const kw of prefixes) {
      const r = await cleanup.scanForReport(kw, 'prefix');
      const items = (r.items || []).map(f => ({ fid: f.fid, newName: f.name.startsWith(kw) ? f.name.slice(kw.length) : f.name }));
      const valid = items.filter(x => x.newName && x.newName !== (r.items.find(f => f.fid === x.fid) || {}).name);
      if (!items.length) { log.push(`  [前缀]「${kw}」: 无匹配, 跳过`); continue; }
      const rn = await cleanup.renameByIds(valid, { confirm: true });
      renTotal += (rn.renamed || 0);
      log.push(`  [前缀]「${kw}」: 命中 ${items.length} 个文件 → ${rn.ok ? '✅ 已去前缀重命名 ' + rn.renamed + ' 个' : '❌ ' + (rn.log[rn.log.length - 1] || '失败')}`);
    }

    log.push(`✅ 自动清理完成: 删除 ${delTotal} 项, 去前缀重命名 ${renTotal} 项`);
    db.saveCleanupLog('auto', `自动清理: 删除 ${delTotal}, 重命名 ${renTotal}`, { logs: log });
    return { ok: true, delTotal, renTotal, log };
  } catch (e) {
    log.push('❌ 自动清理异常: ' + e.message);
    db.saveCleanupLog('auto', '自动清理异常: ' + e.message, { logs: log });
    return { ok: false, log };
  }
}

module.exports = { runAutoClean };
