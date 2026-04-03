# Cursor Mirror

内网 Cursor IDE 安装包镜像下载站。自动从 [cursor.com](https://cursor.com/cn/download) 拉取最新版本的全平台安装包，保存到本地，并提供一个 Web 界面供局域网内其他设备直接下载。

## 功能特性

- **定时自动拉取** — 按 cron 配置定时拉取（默认 4:00 / 21:00），每个整点自动检查官方最新版本
- **三级版本号** — 通过 302 重定向探测获取完整的三级版本号（如 2.6.22），而非官网页面上的二级版本
- **完整性校验** — 下载完成后对比 Content-Length 校验文件大小，每次同步时自动检验已有文件完整性
- **原子版本切换** — 新版本全部安装包下载成功后才切换版本号，下载期间旧版本正常可用
- **多版本历史** — 保留历史版本记录，支持折叠展开查看和下载旧版本安装包
- **官方文件名** — 自动获取官方 CDN 重定向后的文件名（如 `CursorSetup-x64-2.6.22.exe`）
- **增量更新** — 本地已有最新版本且校验通过时自动跳过，不浪费流量和磁盘
- **全平台覆盖** — 支持 macOS / Windows / Linux 共 13 个安装包变体（可按需筛选）
- **内网下载页面** — 简洁的暗色主题 Web 界面，按操作系统分类展示，一键下载
- **版本状态对比** — 页面同时展示官方最新版本和本地镜像版本，直观了解同步状态
- **手动触发同步** — 本地访问时可通过"立即拉取"按钮手动触发，正在进行中会先终止再重新开始
- **实时同步日志** — 同步过程中通过 SSE 推送下载进度，页面实时展示
- **同步终止** — 同步过程中可随时点击"终止"按钮停止当前同步，已完成的下载不受影响
- **安全管理** — 管理操作（触发/终止同步、查看日志）仅限 localhost 访问，内网其他设备只能查看和下载
- **代理支持** — 自动检测 Windows 系统代理 / VPN，也支持手动配置或环境变量
- **稳定下载** — 临时文件下载 + 原子重命名，支持重定向跟随、失败重试（指数退避）
- **优雅退出** — SIGTERM/SIGINT 时正确关闭 HTTP 服务器、终止下载、清理临时文件

## 系统架构

```
                +-------------------+
                |   cursor.com      |
                |  (官方下载页)      |
                +--------+----------+
                         | 抓取版本 + 下载
                         v
+----------------------------------------------+
|            Cursor Mirror Server               |
|                                               |
|  scraper --> downloader --> disk              |
|  (cheerio)   (https/重试)                      |
|                                               |
|  cron         express ---------> :6700        |
|  (定时器)     (Web + API)                      |
+----------------------------------------------+
                         |
            +------------+------------+
            v            v            v
        内网设备A    内网设备B    内网设备C
```

## 快速开始

### 环境要求

- Node.js >= 18

### 安装

```bash
git clone <your-repo-url> cursor-mirror
cd cursor-mirror
npm install
```

### 运行

```bash
npm start
```

启动后控制台会显示访问地址：

```
[Server] Cursor Mirror started:
  Local:   http://localhost:6700
  Network: http://192.168.1.100:6700
```

- **本地浏览器**打开 `http://localhost:6700` — 可看到"立即拉取"按钮、同步日志和管理功能
- **内网其他设备**打开 `http://<你的IP>:6700` — 可查看版本信息和下载安装包，但无法触发/终止同步

### 开机自启动（Windows 服务）

推荐使用 [NSSM](https://nssm.cc) 将程序注册为 Windows 系统服务，实现开机无感启动、崩溃自动重启。

- **安装服务** → 双击 `install-service.bat`
- **卸载服务** → 双击 `uninstall-service.bat`
- **日常管理** → 双击 `service.bat`（状态查看、启停、重启、日志）

详细的 NSSM 介绍、参数说明和常见问题，请参考 **[Windows 服务部署指南](docs/windows-service.md)**。

## 配置说明

编辑项目根目录下的 `config.json`：

```json
{
  "port": 6700,
  "cron": ["0 4 * * *", "0 21 * * *"],
  "downloadDir": "./downloads",
  "runOnStart": false,
  "proxy": "",
  "platforms": "all",
  "platformFilter": {
    "macOS": true,
    "windows": true,
    "linux": true
  },
  "specificPlatforms": []
}
```

### 字段说明

| 字段                | 类型               | 默认值                        | 说明                                                                                                  |
| ------------------- | ------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `port`              | number             | `6700`                        | Web 服务监听端口                                                                                      |
| `cron`              | string \| string[] | `["0 4 * * *", "0 21 * * *"]` | 定时拉取的 cron 表达式，支持单个字符串或数组                                                          |
| `downloadDir`       | string             | `"./downloads"`               | 安装包存储目录                                                                                        |
| `runOnStart`        | boolean            | `false`                       | 启动时是否立即执行一次同步                                                                            |
| `proxy`             | string             | `""`                          | HTTP 代理地址，如 `"http://127.0.0.1:7890"`。留空则依次检查环境变量 `HTTPS_PROXY` 和 Windows 系统代理 |
| `platforms`         | string             | `"all"`                       | 平台选择模式：`"all"` 全部、`"filter"` 按类别、`"specific"` 指定平台                                  |
| `platformFilter`    | object             | 全 true                       | 当 `platforms="filter"` 时，按 macOS/windows/linux 类别开关                                           |
| `specificPlatforms` | string[]           | `[]`                          | 当 `platforms="specific"` 时，列出具体平台 key                                                        |

### 平台筛选示例

**只下载 Windows 安装包：**

```json
{
  "platforms": "filter",
  "platformFilter": {
    "macOS": false,
    "windows": true,
    "linux": false
  }
}
```

**只下载特定版本：**

```json
{
  "platforms": "specific",
  "specificPlatforms": ["win32-x64-user", "darwin-arm64"]
}
```

### 支持的平台 key

| key                | 说明                             |
| ------------------ | -------------------------------- |
| `darwin-arm64`     | Mac (Apple Silicon)              |
| `darwin-x64`       | Mac (Intel)                      |
| `darwin-universal` | Mac Universal                    |
| `win32-x64`        | Windows x64 (System Installer)   |
| `win32-x64-user`   | Windows x64 (User Installer)     |
| `win32-arm64`      | Windows ARM64 (System Installer) |
| `win32-arm64-user` | Windows ARM64 (User Installer)   |
| `linux-arm64-deb`  | Linux .deb (ARM64)               |
| `linux-x64-deb`    | Linux .deb (x64)                 |
| `linux-arm64-rpm`  | Linux RPM (ARM64)                |
| `linux-x64-rpm`    | Linux RPM (x64)                  |
| `linux-arm64`      | Linux AppImage (ARM64)           |
| `linux-x64`        | Linux AppImage (x64)             |

## 工作流程

1. **启动** — Express 服务器先启动并监听端口，页面立即可访问
2. **初始同步** — 若 `runOnStart=true`，后台自动执行首次同步
3. **整点检查** — 每小时整点自动抓取 `cursor.com/cn/download`，获取官方最新三级版本号并缓存
4. **定时拉取** — 按 cron 配置（默认 4:00 / 21:00）触发完整拉取流程
5. **版本比对** — 与本地 `downloads/version.json` 记录的版本对比
6. **完整性校验** — 即使版本号相同，也校验已有文件大小是否与预期一致
7. **增量下载** — 仅在版本不同或文件不完整时下载缺失的安装包，使用 `.tmp` 临时文件 + 原子重命名
8. **原子切换** — 全部安装包下载成功后才更新 `version.json` 中的当前版本
9. **手动触发** — 本地访问时点击"立即拉取"可随时手动同步，与定时拉取使用同一套逻辑

## API 接口

| 方法 | 路径                       | 访问限制 | 说明                               |
| ---- | -------------------------- | -------- | ---------------------------------- |
| GET  | `/`                        | 无       | 下载页面（静态 HTML + 客户端渲染） |
| GET  | `/api/page-data`           | 无       | 返回版本数据、同步状态、调度信息   |
| GET  | `/api/status`              | 无       | 返回同步状态、官方版本、本地版本   |
| GET  | `/download/:version/:file` | 无       | 下载指定版本的安装包               |
| POST | `/api/sync/trigger`        | 仅本机   | 触发手动同步                       |
| POST | `/api/sync/abort`          | 仅本机   | 终止正在进行的同步                 |
| GET  | `/api/sync/stream`         | 仅本机   | SSE 实时日志流                     |

## 目录结构

```
cursor-mirror/
├── config.json          # 配置文件
├── package.json
├── nssm.exe             # NSSM 服务管理工具（可选，用于注册 Windows 服务）
├── install-service.bat  # 一键安装服务（双击运行）
├── uninstall-service.bat # 一键卸载服务（双击运行）
├── service.bat          # 服务日常管理菜单（双击运行）
├── docs/
│   └── windows-service.md  # Windows 服务部署指南 & NSSM 详解
├── logs/                # 服务日志（自动创建）
├── public/              # 前端静态资源
│   ├── index.html       # 页面骨架
│   ├── style.css        # 页面样式
│   └── app.js           # 客户端渲染 + 交互逻辑（SSE、按钮、日志面板）
├── src/
│   ├── index.js         # 入口：cron 调度 + 服务器启动
│   ├── scraper.js       # 官网抓取：版本号解析 + 下载链接生成
│   ├── downloader.js    # 下载器：增量下载 + 重试 + 事件推送 + 终止支持
│   ├── server.js        # Web 服务：路由 + API + SSE
│   └── proxy.js         # 代理配置：支持 HTTP/SOCKS5 代理
├── downloads/           # 安装包存储（自动创建）
│   ├── version.json     # 本地版本记录（current + history）
│   └── <version>/       # 按版本分目录，如 2.6.22/
│       ├── CursorSetup-x64-2.6.22.exe
│       ├── cursor-2.6.22-arm64.dmg
│       └── ...
└── .gitignore
```

## License

ISC
