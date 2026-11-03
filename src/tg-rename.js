// 把 Jasna-LTX 目录里的影片统一改名:
//   1080p / 720p  →  番号_JasnaLTX-U.mp4
//   4K           →  番号_JasnaLTX-4K-U.mp4
//   无水印自制版  →  番号_JasnaLTX无水印-U.mp4 (4K 则 番号_JasnaLTX无水印-4K-U.mp4)
// 无水印判定: 影片记录 version='selfmade' 或 文件名/正文含"无水印/自制投稿"
//   ★ 一票否决: 原始文件名(ed2k 里的名字)带 _wm / -wm 等水印标记 → 一律按"有水印"处理,
//     即使 Telegram 标了"自制投稿"、即使 version=selfmade。原因: 频道里带 #自制投稿 标签的
//     很多其实是转载的有水印版(实测 SDSI-002 / STAR-820 / IPX-917 / MIDE-673 都是),
//     只有原始文件名里的 _wm 才是可靠信号。既然只给无水印版加"无水印"标注,
//     有 _wm 的就绝不能带这三个字。
// 4K 判定: 文件名或消息正文含 4K/2160/UHD，或文件 ≥16GB(或 --min-gb 指定)
// 用法: node tg-rename.js [--dry] [--wait 300]
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const db = require('./db');
const mcp = require('./modules/mcp115');

const CID = (db.getSettings().tgJasna || {}).dirCid || '3544790747217659321';
// 两阶段改名时把「占位文件 → 原名」记到磁盘: 万一后续改名失败, 下次启动能把名字还原,
// 不至于只剩下 __tmp_<fid> 这种找不回出处的名字(踩过一次, 2.7GB 的文件丢了原始名)
const TMP_MAP = path.join(__dirname, 'data', '_rename_temp.json');
function loadTmpMap() { try { return JSON.parse(fs.readFileSync(TMP_MAP, 'utf8')) || {}; } catch { return {}; } }
function saveTmpMap(m) {
  try {
    if (!Object.keys(m).length) { try { fs.unlinkSync(TMP_MAP); } catch {} return; }
    fs.mkdirSync(path.dirname(TMP_MAP), { recursive: true });
    fs.writeFileSync(TMP_MAP, JSON.stringify(m, null, 1), 'utf8');
  } catch {}
}
const VIDEO_EXT = /\.(mp4|mkv|avi|ts|wmv|mov)$/i;
// 原始文件名是否带水印标记: _wm / -wm / .wm / " wm" 作为独立词出现
const WM_MARK = /(?:^|[_\-.\s])wm(?:$|[_\-.\s])/i;
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const wi = args.indexOf('--wait');
const WAIT = wi >= 0 ? parseInt(args[wi + 1], 10) || 0 : 0;
const gi = args.indexOf('--min-gb');
const MIN_GB = gi >= 0 ? parseFloat(args[gi + 1]) || 16 : 16;

function parseCodeFromName(name) {
  let n = String(name || '');
  n = n.replace(VIDEO_EXT, '')
    .replace(/^.*?\.(com|la|cc|net|org)@/i, '')
    .replace(/^\[[^\]]*\]/, '')
    .replace(/^www\.98t\.la@/i, '')
    .trim();
  // 去掉开头的非 ASCII 文案(中文/日文/表情): 皆月光MESU-001… → MESU-001…
  // 这类名字以前整条认不出番号, 改名脚本每轮都会跳过它
  n = n.replace(/^[^\x00-\x7F]+/, '').replace(/^[\s_.\-]+/, '');
  const pick = (str) => {
    // 优先把前置数字并入番号(259LUXU-1886 不能削成 LUXU-1886)
    const m = str.match(/^(\d*[A-Za-z]+)[-_ ]?(\d{2,5})/)
      || str.match(/^(\d*[A-Za-z][A-Za-z0-9]*?)[-_ ]?(\d{2,5})/);
    return m ? `${m[1].toUpperCase()}-${m[2]}` : null;
  };
  const direct = pick(n);
  if (direct) return direct;
  // 兜底: 中文夹在中间(如 "某社 MESU-001 xxx" 已被上一行去头后仍不匹配)时,
  // 从整串里找第一个「字母段-数字」片段; 要求字母≥2位, 避免把 2023-10 这类日期当番号
  const g = n.match(/([A-Za-z]{2,6})[-_ ]?(\d{2,5})/);
  return g ? `${g[1].toUpperCase()}-${g[2]}` : null;
}

(async () => {
  if (WAIT > 0) {
    console.log(`[tg-rename] 等待 ${WAIT}s 后开始改名...`);
    await new Promise(r => setTimeout(r, WAIT * 1000));
  }

  // 目录内容
  // 注意: MCP 的分页不稳定(偶尔返回不足 100 条 / 重复页), 早先用 "a.length<100 就退出"
  // 会只拿到 1596/1989 条, 导致部分文件永远改不到名。这里改成按 fid 去重 + 空页才停。
  const listAll = async () => {
    const seenFid = new Set();
    const items = [];
    // 页长 1000: MCP 对 100 条/页的翻页很不稳定(会漏/重), 1000 条/页实测正常
    for (let off = 0; off < 40000; off += 1000) {
      const p = await mcp.listFiles(CID, off, 1000);
      const a = Array.isArray(p) ? p : (p && p.data) || [];
      if (!a.length) break;
      let added = 0;
      for (const e of a) {
        const id = String(e.fid || e.file_id || '');
        if (!id || seenFid.has(id)) continue;
        seenFid.add(id); items.push(e); added++;
      }
      if (!added) break;
      await new Promise(r => setTimeout(r, 120));
    }
    return items;
  };
  const items = await listAll();

  // 上次异常留下的临时名: 用映射里的原名还原(文件还在就还原, 免得只剩 __tmp_<fid>)
  {
    const m0 = loadTmpMap();
    let restored = 0;
    for (const [fid, orig] of Object.entries(m0)) {
      const cur = items.find(x => String(x.fid) === String(fid));
      if (!cur || !/^__tmp_/.test(String(cur.fn))) { delete m0[fid]; continue; }
      if (String(cur.fn) === orig) { delete m0[fid]; continue; }
      await mcp.renameFile(cur.fid, orig);
      if (!mcp.lastError()) { restored++; delete m0[fid]; }
      await new Promise(r => setTimeout(r, 150));
    }
    saveTmpMap(m0);
    if (restored) console.log(`[tg-rename] 已还原上轮遗留的临时名 ${restored} 个`);
  }
  const files = items.filter(x => VIDEO_EXT.test(String(x.fn || '')));

  // 库内记录(按文件名建索引, 用于取番号和正文里的 4K 标记)
  const rows = db.db.prepare('SELECT code, file_name, text, file_size, version, ed2k FROM tg_jasna').all();
  const norm = s => String(s || '').toLowerCase().replace(/%40/g, '@').replace(/\s+/g, '');
  const byName = {};
  const byCodeSize = {};
  for (const r of rows) {
    byName[norm(r.file_name)] = r;
    // 有的记录 file_name 还停在原始 98T 名字(历史同步漏了), 单靠文件名认不出 → 用番号+字节数兜底
    const k = String(r.code || '').toUpperCase() + '|' + r.file_size;
    (byCodeSize[k] ||= []).push(r);
  }
  const pickByCodeSize = (code, size) => {
    if (!code || !size) return null;
    const list = byCodeSize[String(code).toUpperCase() + '|' + size] || [];
    return list[0] || null;
  };

  const existing = new Set(files.map(f => String(f.fn)));
  const plan = [];
  let wmFixed = 0;   // 原名带 _wm、但仍有多加无水印的历史文件数(统计用)
  for (const f of files) {
    const name = String(f.fn);
    const size0 = Number(f.fs || 0);
    const nameCode = parseCodeFromName(name);
    // 名字对上但字节数不符 → 说明库内 file_name 记串了(双版本常见), 不可信, 改用番号+字节数
    let rec = byName[norm(name)];
    if (rec && Number(rec.file_size) !== size0) rec = null;
    rec = rec || pickByCodeSize(nameCode, size0) || {};
    // 临时名/人工标记的文件不参与改名: 否则 __tmp_xxx 会被解析成 TMP-35477 这种假番号
    if (/^__tmp_/i.test(name) || /^未识别/.test(name)) { plan.push({ skip: '临时名/待人工识别', name }); continue; }
    const code = (rec.code || nameCode || '').toUpperCase();
    if (!code) { plan.push({ skip: '认不出番号', name }); continue; }
    const size = Number(f.fs || rec.file_size || 0);
    // 注意: 只看标题部分(截到 ed2k 链接前), 否则 ed2k 的 hash 里可能出现 "4K" 造成误判
    const titlePart = String(rec.text || '').split('ed2k://')[0];
    const is4k = /4K|2160|UHD/i.test(name) || /4K|2160|UHD/i.test(titlePart) || size >= MIN_GB * 1024 ** 3;
    // 无水印(自制投稿)版: 文件名里加「无水印」, 与常规有水印版区分
    // ★ 原始文件名(ed2k 里的)带 _wm → 一票否决, 不管 Telegram 怎么标都不加"无水印"
    const origName = (String(rec.ed2k || '').match(/\|file\|([^|]+)\|/) || [])[1] || '';
    const baseForWm = (origName || name).replace(VIDEO_EXT, '');
    const hasWmMark = WM_MARK.test(baseForWm);
    const isSelfmade = !hasWmMark && (
      rec.version === 'selfmade'
      || /无水印|自制投稿/.test(name)
      || /自制投稿|无水印/.test(titlePart)
    );
    if (hasWmMark) wmFixed++;
    const ext = (name.match(VIDEO_EXT) || ['.mp4'])[0].toLowerCase();
    const target = `${code}_JasnaLTX${isSelfmade ? '无水印' : ''}-${is4k ? '4K-' : ''}U${ext}`;
    if (name === target) { plan.push({ skip: '已是目标名', name, target }); continue; }
    plan.push({ fid: String(f.file_id || f.fid), name, target, size, is4k });
  }

  const todo = plan.filter(p => p.fid);
  if (wmFixed) console.log(`[tg-rename] 其中 ${wmFixed} 个原始文件名带 _wm(有水印), 强制不加「无水印」标注`);
  console.log(`[tg-rename] 目录 ${files.length} 个视频, 需改名 ${todo.length} 个 (4K ${todo.filter(p => p.is4k).length})`);
  if (DRY) {
    todo.slice(0, 40).forEach(p => console.log(`  ${p.is4k ? '4K ' : '   '} ${p.name.slice(0, 60)}\n      → ${p.target}`));
    if (todo.length > 40) console.log(`  ... 其余 ${todo.length - 40} 条省略`);
    const skipped = plan.filter(p => p.skip);
    if (skipped.length) console.log(`[tg-rename] 跳过 ${skipped.length}: ${skipped.slice(0, 5).map(s => s.skip + ':' + s.name.slice(0, 30)).join(' | ')}`);
    process.exit(0);
  }

  let ok = 0, fail = 0, skipDup = 0, swapped = 0;
  const byFid = new Map(todo.map(p => [String(p.fid), p]));
  const done = new Set();

  // 改一个名字; 目标名被占用时直接放弃(由第二轮处理)
  const tryRename = async (fid, from, to) => {
    if (existing.has(to)) return false;
    const before = mcp.lastError();
    await mcp.renameFile(fid, to);
    const err = mcp.lastError();
    if (!err || err === before) { existing.delete(from); existing.add(to); return true; }
    console.log(`  ✕ ${String(from).slice(0, 46)} → ${to} 失败: ${err}`);
    return false;
  };

  // ===== 第一轮: 目标名空闲的直接改 =====
  for (const p of todo) {
    if (existing.has(p.target)) continue;          // 留给第二轮
    if (await tryRename(p.fid, p.name, p.target)) { ok++; done.add(p.fid); }
    else fail++;
    await new Promise(r2 => setTimeout(r2, 250));
  }

  // ===== 第二轮: 目标名被别的文件占着 =====
  // 典型场景: 同番号双版本(无水印 / 有水印), 两个文件名互相错位, 必须先把占位者挪到临时名,
  // 腾出位置再改, 最后把占位者改成它自己的目标名(不在计划里就还原原名)。绝不覆盖原文件。
  for (const p of todo) {
    if (done.has(p.fid)) continue;
    if (!existing.has(p.target)) {                 // 第一轮失败但名字已经空了, 补一次
      if (await tryRename(p.fid, p.name, p.target)) { ok++; done.add(p.fid); } else fail++;
      continue;
    }
    const occ = items.find(x => String(x.fn) === p.target);
    if (!occ) { skipDup++; console.log(`  ⚠️ 目标名被占用且找不到文件, 跳过: ${p.target}`); continue; }
    const ext = (String(occ.fn).match(VIDEO_EXT) || ['.mp4'])[0];
    const tmp = `__tmp_${occ.fid}${ext}`;
    const m1 = loadTmpMap();
    m1[String(occ.fid)] = String(occ.fn);   // 先记原名, 再挪; 失败也能还原
    saveTmpMap(m1);
    if (!await tryRename(occ.fid, occ.fn, tmp)) {
      const m2 = loadTmpMap(); delete m2[String(occ.fid)]; saveTmpMap(m2);
      skipDup++; console.log(`  ⚠️ 占位文件改名失败, 跳过: ${p.target}`); continue;
    }
    await new Promise(r2 => setTimeout(r2, 200));
    if (await tryRename(p.fid, p.name, p.target)) { ok++; done.add(p.fid); swapped++; }
    else fail++;
    await new Promise(r2 => setTimeout(r2, 200));
    // 占位者: 在自己的计划里 → 改成它的目标名; 否则还原原名
    const occItem = byFid.get(String(occ.fid));
    let settled = false;
    if (occItem && !done.has(occItem.fid)) {
      if (await tryRename(occ.fid, tmp, occItem.target)) { ok++; done.add(occItem.fid); settled = true; }
      else if (await tryRename(occ.fid, tmp, occItem.name)) { ok++; done.add(occItem.fid); settled = true; }
    } else {
      if (await tryRename(occ.fid, tmp, occ.fn)) { settled = true; }   // 还原原名, 不计入改名数
    }
    if (settled) {
      const m3 = loadTmpMap(); delete m3[String(occ.fid)]; saveTmpMap(m3);
    } else {
      fail++;
      console.log(`  ✕ 临时名残留: ${tmp}（原名已记在 data/_rename_temp.json，下次运行会自动还原）`);
    }
    await new Promise(r2 => setTimeout(r2, 250));
  }
  if (swapped) console.log(`[tg-rename] 其中 ${swapped} 个是互换名(先挪临时名再改)`);
  // 复查: 重新列目录, 看还剩多少没改成
  const check = await listAll();
  const vids = check.filter(x => VIDEO_EXT.test(String(x.fn || '')));
  const still = vids.filter(x => !/_JasnaLTX(?:无水印)?-(?:4K-)?U\.[a-z0-9]+$/i.test(String(x.fn || '')));
  console.log(`[tg-rename] 完成: 改名 ${ok}, 失败 ${fail}, 跳过(重名) ${skipDup}`);
  console.log(`[tg-rename] 复查: 目录视频 ${vids.length}, 仍未按规范命名 ${still.length}${still.length ? ': ' + still.slice(0, 5).map(s => String(s.fn).slice(0, 40)).join(' | ') : ''}`);

  // ===== 回写库: 把 tg_jasna.file_name 同步成改名后的名字 =====
  // 否则页面「影片文件名」列和「115 目录核对」都会对不上(改名后原文件名已不存在)
  try {
    const nowNames = new Set(vids.map(v => String(v.fn)));
    const recs = db.db.prepare('SELECT id, code, file_name, file_size FROM tg_jasna').all();
    const byCode = {};
    for (const r of recs) (byCode[String(r.code || '').toUpperCase()] ||= []).push(r);
    let sync = 0;
    for (const v of vids) {
      const nm = String(v.fn);
      const m = nm.match(/^(.+?)_JasnaLTX(?:无水印)?-(?:4K-)?U\./i);
      if (!m) continue;
      const list = byCode[m[1].toUpperCase()] || [];
      if (!list.length) continue;
      // 同一番号可能有"无水印/有水印"两条记录: 必须先用字节数锁定对应那条。
      // 以前是"只要有任一记录叫这个名字就跳过", 双版本名字互换时会被误判成"已同步"而永远不修。
      const sameSize = list.filter(r => Number(r.file_size) === Number(v.fs || 0));
      const pool = sameSize.length ? sameSize : list;
      const target = pool.find(r => !nowNames.has(String(r.file_name))) || pool[0];
      if (target && target.file_name !== nm) {
        db.db.prepare('UPDATE tg_jasna SET file_name=? WHERE id=?').run(nm, target.id);
        sync++;
      }
    }
    if (sync) console.log(`[tg-rename] 已同步库内文件名 ${sync} 条`);
  } catch (e) {
    console.log('[tg-rename] 库同步失败(不影响改名):', e.message);
  }
  process.exit(0);
})().catch(e => { console.error('[tg-rename] FATAL', e); process.exit(1); });
