// 实时枚举 115"演员划分"目录, 生成 data/actress-dirs-115.json
// 用法: node refresh-actress-dirs.js
// 输出: data/actress-dirs-115.json  [{ name, cid }, ...]
// 退出码: 0=成功, 1=失败(无演员划分目录), 2=MCP 不可用
const fs = require('fs');
const path = require('path');
const mcp = require('./modules/mcp115');

const ACTRESS_ROOT_KEYWORD = '演员划分';
const OUT = path.join(__dirname, 'data', 'actress-dirs-115.json');

async function main() {
  const ok = await mcp.ensure();
  if (!ok) {
    console.error('[refresh] MCP 不可用, 无法实时枚举 115');
    process.exit(2);
  }

  // 1. 搜索"演员划分"根目录
  const data = await mcp.searchFiles(ACTRESS_ROOT_KEYWORD, 0, 20);
  if (!data) {
    console.error('[refresh] 搜索"演员划分"无返回, 无法定位根目录');
    process.exit(1);
  }
  const ents = mcp.findEntries(data);
  const root = ents.find(e => !mcp.isFileEntry(e) && (e.file_name || e.name) === ACTRESS_ROOT_KEYWORD);
  if (!root) {
    console.error('[refresh] 未找到"演员划分"根目录');
    process.exit(1);
  }
  const rootCid = String(root.file_id || root.fid || root.id);

  // 2. 分页枚举全部演员目录
  // 注: listFiles 返回的字段名随 115 后端变化, 实测两套键名(fid/fn 短版, file_id/file_name 长版)
  const folders = [];
  for (let page = 0; page < 30; page++) {
    const pageData = await mcp.listFiles(rootCid, page * 200, 200);
    if (!pageData) break;
    const pageEnts = mcp.findEntries(pageData);
    if (!pageEnts.length) break;
    for (const e of pageEnts) {
      // 两套字段都试, 兼容
      const nm = e.fn || e.file_name || e.name || '';
      const cid = String(e.fid || e.file_id || e.id || '');
      if (nm && !mcp.isFileEntry(e)) folders.push({ name: nm, cid });
    }
    if (pageEnts.length < 200) break;
    await new Promise(r => setTimeout(r, 150));
  }

  // 3. 写文件
  fs.writeFileSync(OUT, JSON.stringify(folders, null, 1), 'utf8');
  console.log(`[refresh] 已实时枚举 ${folders.length} 个演员目录 → ${OUT}`);
  process.exit(0);
}

main().catch(e => {
  console.error('[refresh] 异常:', e.message);
  process.exit(1);
});
