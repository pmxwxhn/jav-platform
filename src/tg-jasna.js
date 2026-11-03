// Telegram Jasna-LTX 抓取入口(独立运行)
// 用法:
//   node tg-jasna.js               # 增量抓取 + 新增记录自动离线到 115 的 Jasna-LTX
//   node tg-jasna.js --half-hour   # 半小时任务完整流程: 抓取 + 补链(budget 条) + 离线
//   node tg-jasna.js --no-offline  # 只入库, 不提交离线(首次导入存量用这个)
//   node tg-jasna.js --offline-pending 20   # 把队列里最早的 20 条待离线补提交
//   node tg-jasna.js --enrich      # 补齐全库缺失的 javdb 元数据(评分/人数/演员)
const { runTgJasna, runHalfHour, offlinePending, enrichRecords } = require('./modules/tg-jasna');

function parseArgs() {
  const a = process.argv.slice(2);
  const out = { noOffline: false, pending: 0, halfHour: false, budget: 10, enrich: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--no-offline') out.noOffline = true;
    if (a[i] === '--half-hour') out.halfHour = true;
    if (a[i] === '--enrich') out.enrich = true;
    if (a[i] === '--budget') out.budget = parseInt(a[i + 1], 10) || 10;
    if (a[i] === '--offline-pending') out.pending = parseInt(a[i + 1], 10) || 20;
  }
  return out;
}

(async () => {
  const args = parseArgs();
  if (args.pending > 0) {
    const r = await offlinePending({ limit: args.pending });
    console.log('\n' + (r.log || []).join('\n'));
    process.exit(r.ok ? 0 : 1);
  }
  if (args.enrich) {
    const log = { push: (...m) => { for (const x of m) console.log(x); } };
    const r = await enrichRecords(null, log);
    console.log(`\n元数据补录完成: 成功 ${r.ok}/${r.total}`);
    process.exit(0);
  }
  if (args.halfHour) {
    const r = await runHalfHour({ budget: args.budget });
    console.log('\n' + (r.log || []).join('\n'));
    process.exit(r.ok ? 0 : 1);
  }
  const r = await runTgJasna({ offline: args.noOffline ? false : null });
  console.log('\n' + r.log.join('\n'));
  process.exit(r.ok ? 0 : 1);
})();
