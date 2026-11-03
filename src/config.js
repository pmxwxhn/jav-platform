// 默认配置(首次运行时写入 SQLite,之后以数据库配置为准)
// 所有配置项可在管理后台「配置」页修改
const path = require('path');

module.exports = {
  // ===== 服务 =====
  server: {
    port: 8730,
    // '::' = 监听全部网卡(IPv6 双栈, 同时接受 IPv4), 支持局域网与公网 IPv6 直连访问
    host: process.env.SERVER_HOST || '::',
  },

  // ===== 115/CDP =====
  cdp: {
    proxyPort: 3457,          // cdp-proxy 端口(115 浏览器自动化通道)
    wsPort: 9222,             // 115 浏览器调试端口
    browserPath: 'C:\\Users\\pmxwx\\AppData\\Local\\115Chrome\\Application\\115chrome.exe',
    windowW: 1280,            // 窗口被拖得过小时纠正到的宽度(不改变最小化/最大化状态)
    windowH: 800,
    // 紧急回滚开关: true = 恢复旧行为(每次"真实点击"前都 Page.bringToFront 把窗口顶到前台)。
    // 默认 false —— 窗口是否显示只由用户决定, 抓取任务不得抢前台。
    bringToFront: false,
    // 是否由 start-all.cmd 拉起 Windows 窗口守护(tools/win-guard), 把被顶起来的窗口压回最小化
    windowGuard: true,
  },

  // ===== 115 MCP(115-Desktop AI整理服务, 默认 127.0.0.1:11502) =====
  // 开启后 115 判重/演员目录/离线下载 走 MCP(稳定), 不可用自动回退 CDP
  mcp115: {
    enabled: true,            // 总开关: false 则全部走 CDP
    autoCreateDir: true,      // 离线目录找不到时自动创建
    rootCid: '0',             // 自动建目录的默认父目录(根目录)
    actressDirCid: '2788978239272622903',  // 演员划分目录(根目录>学习资源>演员划分), 新演员文件夹固定建在此下
    fc2Cid: '2493844355843070344',  // FC2 专用目录(根目录>学习资源>FC2), 离线 FC2 影片固定存此
  },

  // ===== 网络连通性检测 =====
  netcheck: {
    timeoutMs: 5000,          // 单项检测超时(毫秒)
    retries: 1,               // 失败重试次数(0 = 不重试)
  },

  // ===== 115 垃圾文件清理(已注释停用, 保留代码以便恢复) =====
  // cleanup: {
  //   files: [],                // 精确文件名名单(完全一致才删)
  //   prefixes: [],             // 前缀规则(删除所有以该前缀开头的文件)
  // },

  // ===== 板块配置 =====
  boards: {
    103: {
      name: '高清中文字幕',
      enabled: true,          // 是否启用该板块
      dateStart: null,        // 抓取开始日期(含), null=自动(昨天)
      dateEnd: null,          // 抓取结束日期(含), null=与开始相同
      skipEuro: true,         // 忽略欧美片
      filter: 'sub',          // 判重标记: sub=中文字幕(-C/.chs), uncensor=破解(-U)
    },
    36: {
      name: '亚洲无码原创',
      enabled: true,
      dateStart: null,
      dateEnd: null,
      skipFC2: true,          // 忽略 FC2PPV
      filter: 'uncensor',
    },
  },

  // ===== 筛选规则(数组,任一满足即通过; 可增删) =====
  // 每条: { id, score, votes, force }
  //   force=true 表示"评分>score 无条件通过"(忽略 votes)
  filter: {
    rules: [
      { id: 'r1', score: 4.0, votes: 200, force: false },
      { id: 'r2', score: 4.2, votes: 100, force: false },
      { id: 'r3', score: 4.5, votes: 0, force: true },
    ],
    relatedScore: 4.0, relatedVotes: 300,  // 关联影片记录门槛
  },

  // ===== 离线行为 =====
  offline: {
    actressSearch: true,      // 演员目录三级判断(帖子名→javdb名→汉字前缀)
    simplified: true,         // 繁体转简体搜索(115 目录多为简体)
    // 115 已存在同名资源时, 是否仍重新下载(原设计意图: 重下后删掉旧文件, 实现"版本替换")
    // 注意: 负责删旧文件的 handleDuplicate() 目前没有任何调用点,
    //       开启即为"只下不删", 会在 115 持续堆积重复文件(2026-09-03 一天就重复下了 8 部)
    // 且与前端文案「建议保持关闭仅提示」矛盾, 故默认改为关闭
    deleteDuplicate: false,
    retryTimes: 2,            // 提交失败重试次数
    verifyViaCloud: false,    // 云下载页面验证(获取离线状态), 用户要求不需要 → 默认关闭
  },

  // ===== 报告 =====
  report: {
    outDir: process.env.REPORT_DIR || path.join(__dirname, 'reports'),
    includeComments: true,    // 报告包含全部评论
    includeCharts: true,      // 包含图表
  },

  // ===== AI 专区(sehuatang fid=166 typeid=884) =====
  aiZone: {
    score: 4,      // 有价值的影片: 评分阈值(>)
    votes: 200,    // 评分人数阈值(>)
  },

  // ===== Telegram Jasna-LTX(频道 jasna无码资源共享 @jasnashare) =====
  // 抓取链路复用 F:\telegram-keyword-monitor 的 Telethon 程序(登录态/代理都在那边)
  // 每日随流水线在 AI 专区之后执行, 新增记录自动离线到 115 根目录的 folder
  tgJasna: {
    enabled: true,
    projectDir: process.env.TGMON_DIR || '/opt/tgmon',
    pythonExe: process.env.PYTHON_BIN || '/usr/bin/python3',
    folder: 'Jasna-LTX',       // 115 根目录下的目标文件夹(不存在会自动创建)
    offline: true,             // 抓完自动离线(只下本次新增, 存量走「补离线」)
    scoreLookup: true,         // 新增记录自动查 javdb 评分/评分人数/女演员
    dirCid: null,              // 首次解析后自动缓存目录 id, 免去每次搜索
    timeoutMs: 600000,         // 单个抓取进程超时(10 分钟)
  },

  // ===== 全量演员库(桥接字典, 供 build-actress-map.py 与 /api/actress-names 使用) =====
  actressDb: {
    fullDbPath: process.env.ACTRESS_DB || path.join(__dirname, 'data', 'Actress-20250220.db'),
  },

  // ===== 调度 =====
  schedule: {
    enabled: true,
    time: '10:00',            // 每天运行时间(HH:mm, 最小粒度半小时: 00/30分)
    mode: 'builtin',          // builtin=内置调度 | taskplanner=Windows 计划任务
  },
};
