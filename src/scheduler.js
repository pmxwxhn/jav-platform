// 调度器: 内置 node-cron 定时触发流水线 + Windows 计划任务注册
const cron = require('node-cron');
const { exec } = require('child_process');
const path = require('path');
const db = require('./db');

let task = null;
let halfTask = null;   // 半小时 Telegram 抓取/补链任务

// 从配置时间('HH:mm' 或 cron 兼容)生成 cron 表达式
function timeToCron(s) {
  if (s.cron && cron.validate(s.cron)) return s.cron;          // 兼容旧配置 cron
  const t = s.time || '08:00';                                  // 新配置 'HH:mm'
  const m = String(t).match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return '0 8 * * *';                                   // fallback 08:00
  const hour = parseInt(m[1]) % 24;
  const min = parseInt(m[2]) % 60;
  return `${min} ${hour} * * *`;
}

// 启动内置调度
function startScheduler() {
  stopScheduler();
  startHalfHour();                 // 半小时抓取独立于每日流水线, 先注册
  const cfg = db.getSettings();
  const s = cfg.schedule;
  if (!s.enabled || s.mode !== 'builtin') {
    console.log('[scheduler] 内置调度未启用(mode=' + s.mode + ', enabled=' + s.enabled + ')');
    return null;
  }
  const expr = timeToCron(s);
  if (!cron.validate(expr)) {
    console.log('[scheduler] cron 表达式无效:', expr);
    return null;
  }
  task = cron.schedule(expr, async () => {
    console.log('[' + new Date().toLocaleString('zh-CN') + '] 定时任务触发,开始跑流水线');
    // 运行标记: 供 10:30 的元数据补齐任务让位, 避免两条线同时抢浏览器/115
    try { require('fs').writeFileSync(require('path').join(__dirname, 'data', 'pipeline_running'), new Date().toISOString(), 'utf8'); } catch {}
    try {
      const { main } = require('./pipeline');
      await main();
      console.log('[scheduler] 本次定时任务完成');
    } catch (e) {
      console.error('[scheduler] 定时任务异常:', e.message);
    } finally {
      try { require('fs').unlinkSync(require('path').join(__dirname, 'data', 'pipeline_running')); } catch {}
    }
  });
  console.log('[scheduler] 内置调度已启动: ' + expr + ' (每天自动运行)');
  return task;
}

function stopScheduler() {
  if (task) { task.stop(); task = null; }
  if (halfTask) { halfTask.stop(); halfTask = null; }
}

// ===== 半小时任务: 增量抓 Telegram + 补链 + 离线 =====
// 关掉方式: settings.tgJasna.halfHour = false
function startHalfHour() {
  const cfg = db.getSettings();
  const t = cfg.tgJasna || {};
  if (t.halfHour === false) {
    console.log('[scheduler] 半小时 Telegram 抓取已禁用(settings.tgJasna.halfHour=false)');
    return null;
  }
  halfTask = cron.schedule('*/30 * * * *', async () => {
    console.log('[' + new Date().toLocaleString('zh-CN') + '] 半小时抓取任务触发');
    try {
      const { runHalfHour } = require('./modules/tg-jasna');
      const r = await runHalfHour({ budget: t.halfHourBudget || 10, offlineLimit: 30 });
      console.log('[scheduler] 半小时任务结束: ' + (r.skipped ? '跳过(上轮未结束)' : r.ok ? '成功' : '失败 ' + (r.error || '')));
    } catch (e) {
      console.error('[scheduler] 半小时任务异常:', e.message);
    }
  });
  console.log('[scheduler] 半小时 Telegram 抓取已启动: */30 * * * *（每 30 分钟）');
  return halfTask;
}

function getHalfActive() {
  return halfTask !== null;
}

// 当前内置调度是否激活
function getActive() {
  return task !== null;
}

// 注册 Windows 计划任务(需要管理员权限)
function registerTaskPlanner() {
  const cfg = db.getSettings();
  const s = cfg.schedule;
  // 从 time('HH:mm') 解析, 兼容旧 cron
  let hour = 8, minute = 0;
  const tm = String(s.time || '').match(/^(\d{1,2}):(\d{1,2})$/);
  if (tm) { hour = parseInt(tm[1]) % 24; minute = parseInt(tm[2]) % 60; }
  else if (s.cron) {
    const parts = String(s.cron).trim().split(/\s+/);
    if (parts.length >= 2) { hour = parseInt(parts[1]) || 8; minute = parseInt(parts[0]) || 0; }
  }
  const nodePath = process.execPath;
  const scriptPath = path.join(__dirname, 'pipeline.js');
  const cmd = `schtasks /create /tn "JavAutoDaily" /tr "\\"${nodePath}\\" \\"${scriptPath}\\"" /sc daily /st ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} /f`;
  return new Promise((resolve, reject) => {
    exec(cmd, { encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new Error('注册失败: ' + (stderr || err.message)));
      else resolve('已注册 Windows 计划任务 JavAutoDaily (每天 ' + hour + ':' + minute + ')');
    });
  });
}

// 取消 Windows 计划任务
function unregisterTaskPlanner() {
  return new Promise((resolve, reject) => {
    exec('schtasks /delete /tn "JavAutoDaily" /f', (err, stdout, stderr) => {
      if (err) reject(new Error('删除失败: ' + (stderr || err.message)));
      else resolve('已删除 Windows 计划任务');
    });
  });
}

module.exports = { startScheduler, stopScheduler, getActive, getHalfActive, startHalfHour, registerTaskPlanner, unregisterTaskPlanner };
