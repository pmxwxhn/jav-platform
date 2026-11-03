# jav-platform（飞牛 NAS 版）

把原本跑在 Windows 上的「115 影视资源自动管理平台」打包成 Linux 容器镜像，
在飞牛 NAS 上无人值守运行。

## 这个仓库是什么

只有构建物料，不含任何数据：

- `src/` —— 平台源码（与原版一致，仅做了 5 处路径/鉴权适配）
- `cdp-proxy/` —— 浏览器 CDP 桥（让 Node 用 HTTP 操作 Chromium）
- `Dockerfile` / `entrypoint.sh` —— 镜像构建
- `.github/workflows/build.yml` —— 推送到 main 自动构建

## 对源码做的改动（全部最小化）

| 文件 | 改动 | 原因 |
|---|---|---|
| `config.js` | `report.outDir` 读 `REPORT_DIR` | Windows 绝对路径改为容器卷 |
| `config.js` | `tgJasna.projectDir/pythonExe` 读 `TGMON_DIR` / `PYTHON_BIN` | 换成容器内路径 |
| `config.js` | `actressDb.fullDbPath` 读 `ACTRESS_DB` | 同上 |
| `config.js` | `server.host` 读 `SERVER_HOST` | 容器内 IPv6 `::` 绑定不可靠 |
| `app.js` | `refresh-comments.js`、python、演员库默认路径改为 `__dirname` / env | 去掉 `F:/`、`C:/` 硬编码 |
| `modules/javdb.js` | ffmpeg 路径读 `FFMPEG_BIN` | 容器内用系统 ffmpeg |
| `modules/mcp115.js` | 新增 `MCP115_TOKEN` → `Authorization: Bearer` | 115Lite 的 MCP 需要鉴权 |

业务逻辑一行没改。

## 产物

```
ghcr.io/<owner>/jav-platform:latest
```

## 许可

上游为私有项目，此处仅作个人部署用。
