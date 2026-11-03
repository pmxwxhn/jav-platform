// 后台刷新 javdb 评论(单部 或 整个日期板块)
// 用法:
//   node refresh-comments.js --id=<videoId>                       刷新单部
//   node refresh-comments.js --board=36 --date=2026-08-13       刷新该日该板块全部
const db = require('./db');
const { fetchScoreCommentsOnly } = require('./modules/javdb');
const report = require('./modules/report');

const getArg = (k) => {
  const a = process.argv.find(x => x.startsWith('--' + k + '='));
  return a ? a.slice(k.length + 3) : null;
};

const videoId = parseInt(getArg('id'));
const board = parseInt(getArg('board'));
const date = getArg('date');

let targets = [];
if (videoId) {
  const v = db.db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
  if (v) targets.push(v);
} else if (board && date) {
  targets = db.getVideos(board, date).filter(v => v.javdb_href);
} else {
  console.log('用法: node refresh-comments.js --id=<id>  或  --board=36 --date=YYYY-MM-DD');
  process.exit(1);
}

if (!targets.length) { console.log('(无匹配影片)'); process.exit(0); }

(async () => {
  console.log(`待刷新 ${targets.length} 部影片的 javdb 数据(评分/人数/评论)`);
  const regen = new Set();   // 需要重新生成报告的 board|date 组合
  for (const v of targets) {
    if (!v.javdb_href) { console.log(`  - ${v.code}: 无 javdb 链接, 跳过`); continue; }
    console.log(`[${v.id}] ${v.code} 重新抓评分/评论...`);
    const { score, votes, comments } = await fetchScoreCommentsOnly(v.javdb_href);
    const fail = (comments.length || score !== null)
      ? null
      : '重抓仍失败: javdb 页面未加载出数据(可能被限流或临时故障), 请稍后再试';
    db.db.prepare('UPDATE videos SET comments_json = ?, comment_fail = ?, score = ?, votes = ? WHERE id = ?')
      .run(
        comments.length ? JSON.stringify(comments) : null,
        fail,
        score !== null ? score : v.score,
        votes !== null ? votes : v.votes,
        v.id
      );
    // 同步 info_json.rating(报告卡片评分显示用的就是它, 否则报告不更新)
    if (score !== null) {
      try {
        const cur = JSON.parse(v.info_json || '{}');
        cur.rating = score.toFixed(2) + '分, 由' + (votes !== null ? votes : (v.votes || 0)) + '人評價';
        db.db.prepare('UPDATE videos SET info_json = ? WHERE id = ?').run(JSON.stringify(cur), v.id);
      } catch {}
    }
    regen.add(v.board + '|' + v.run_date);
    console.log(`  ${comments.length ? '✅ ' + comments.length + ' 条评论' : '⚠️ 评论 0 条'} | 评分: ${score !== null ? score + '分/' + votes + '人' : '(未获取)'}`);
  }
  // 重新生成所有受影响日期的报告(单部/整板块都覆盖)
  const cfg = db.getSettings();
  for (const key of regen) {
    const [b, d] = key.split('|');
    try {
      const videos = db.getVideos(parseInt(b), d);
      if (videos.length) {
        report.saveReport(parseInt(b), d, report.generateBoardReport(parseInt(b), d, videos, cfg));
        console.log('报告已重新生成:', b, d);
      }
    } catch (e) { console.log('报告生成失败:', b, d, e.message); }
  }
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
