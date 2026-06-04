# Cursor Mirror

内网 Cursor IDE 安装包镜像下载站。通过 API 自动检测并拉取最新版本的全平台安装包，保存到本地，并提供一个 Web 界面供局域网内其他设备直接下载。支持 Docker 部署。

## 功能特性

- **定时自动拉取** — 按 cron 配置定时拉取（默认 4:30 / 21:30），每个整点自动检查官方最新版本
- **三级版本号** — 通过 API 302 重定向探测获取完整的三级版本号（如 3.6.31），无需解析网页
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
- **WPS365 云端同步**（可选） — 安装包拉取后自动上传到 WPS365 企业云盘，内网用户通过云盘链接下载，不依赖本地服务器带宽
- **拉一个传一个** — WPS365 上传采用串行流水线，每个安装包下载完成后立即上传，失败不阻塞后续文件
- **云端状态文件** — 在 WPS365 文件夹中自动维护一个状态信息文件，文件名动态展示镜像版本和更新时间
- **下载模式切换** — 默认走云端链接，点击页面标识可一键切换到本地下载模式（也可通过 URL 加 `?local` 切换）
- **智能兜底** — 云端上传失败的文件仍可通过本地服务器下载，前端自动回退

## 系统架构

```
            +---------------------+
            |  api2.cursor.sh     |
            |  (302 版本探测+下载) |
            +---------+-----------+
                      |
                      v
+----------------------------------------------+
|            Cursor Mirror Server               |
|                                               |
|  scraper --> downloader --> disk              |
|  (302探测)   (https/重试)   |                 |
|                             v                 |
|  cron       uploader --> WPS365 云盘(可选)    |
|  (定时器)   (拉一个传一个)                      |
|                                               |
|  express ---------> :6700                     |
|  (Web + API)                                  |
+----------------------------------------------+
               |                    |
       +-------+-------+    WPS365 云盘链接
       v       v       v           |
   内网设备A 设备B   设备C  <------+
```

## 快速开始

### 方式一：直接运行

**环境要求：** Node.js >= 18

```bash
git clone <your-repo-url> cursor-mirror
cd cursor-mirror
npm install
cp config.example.json config.json  # 编辑配置
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

### 方式二：Docker 部署

```bash
git clone <your-repo-url> cursor-mirror
cd cursor-mirror
cp config.example.json config.json  # 编辑配置
docker compose up -d
```

如需使用代理，取消 `docker-compose.yml` 中 `HTTPS_PROXY` 的注释并填入代理地址。

#### Docker + WPS365 云端同步

Docker 镜像已内置 `wps365-cli`，但需要预先准备好 OAuth 凭据（容器内无浏览器，无法交互登录）。

**第 1 步：在任意有浏览器的机器上登录**

在你的电脑（Windows/Mac/Linux 均可）安装 `wps365-cli` 并完成登录：

```bash
wps365-cli auth setup              # 输入 client_id 和 client_secret
wps365-cli auth login --scopes "kso.user_base.read,kso.file.readwrite,kso.drive.readwrite,kso.file_link.readwrite"
```

**第 2 步：导出凭据文件到项目目录**

```bash
mkdir -p wps365-config
```

Windows 下复制：

```powershell
copy "$env:APPDATA\wps365-cli\config.json" wps365-config\
copy "$env:APPDATA\wps365-cli\token_delegated.json" wps365-config\
```

macOS / Linux 下复制：

```bash
cp ~/.config/wps365-cli/config.json wps365-config/
cp ~/.config/wps365-cli/token_delegated.json wps365-config/
```

如果 `token_delegated.json` 不存在，手动导出一次：

```bash
wps365-cli auth token   # 确认能输出 token
wps365-cli auth status -o json > /tmp/status.json
```

然后在项目目录创建 `wps365-config/token_delegated.json`：

```json
{
  "access_token": "<wps365-cli auth token 的输出>",
  "refresh_token": "",
  "token_type": "bearer",
  "access_token_expires_at": "2099-01-01T00:00:00Z"
}
```

**第 3 步：启动容器**

```bash
docker compose up -d
```

`docker-compose.yml` 已自动将 `./wps365-config` 挂载到容器内，程序会读取其中的 `config.json`（OAuth 凭证）和 `token_delegated.json`（访问令牌），并在过期时自动刷新。

### 开机自启动（Windows 服务）

推荐使用 [NSSM](https://nssm.cc) 将程序注册为 Windows 系统服务，实现开机无感启动、崩溃自动重启。

- **安装服务** → 双击 `install-service.bat`
- **卸载服务** → 双击 `uninstall-service.bat`
- **日常管理** → 双击 `service.bat`（状态查看、启停、重启、日志）

详细的 NSSM 介绍、参数说明和常见问题，请参考 **[Windows 服务部署指南](docs/windows-service.md)**。

## 配置说明

复制 `config.example.json` 为 `config.json` 后编辑：

```json
{
  "port": 6700,
  "cron": ["30 4 * * *", "30 21 * * *"],
  "downloadDir": "./downloads",
  "runOnStart": false,
  "proxy": "",
  "platforms": "all",
  "platformFilter": {
    "macOS": true,
    "windows": true,
    "linux": true
  },
  "specificPlatforms": [],
  "wps365": {
    "enabled": false,
    "driveId": "",
    "parentFolderId": "0",
    "rootFolderName": "cursor-mirror",
    "useParentAsRoot": false,
    "share": {
      "enabled": false,
      "scope": "company",
      "roleId": "21020029"
    }
  }
}
```

### 字段说明

| 字段                     | 类型               | 默认值                        | 说明                                                                                                           |
| ------------------------ | ------------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `port`                   | number             | `6700`                        | Web 服务监听端口                                                                                               |
| `cron`                   | string \| string[] | `["0 4 * * *", "0 21 * * *"]` | 定时拉取的 cron 表达式，支持单个字符串或数组                                                                   |
| `downloadDir`            | string             | `"./downloads"`               | 安装包存储目录                                                                                                 |
| `runOnStart`             | boolean            | `false`                       | 启动时是否立即执行一次同步                                                                                     |
| `proxy`                  | string             | `""`                          | HTTP 代理地址，如 `"http://127.0.0.1:7890"`。留空则依次检查环境变量 `HTTPS_PROXY` 和 Windows 系统代理          |
| `platforms`              | string             | `"all"`                       | 平台选择模式：`"all"` 全部、`"filter"` 按类别、`"specific"` 指定平台                                           |
| `platformFilter`         | object             | 全 true                       | 当 `platforms="filter"` 时，按 macOS/windows/linux 类别开关                                                    |
| `specificPlatforms`      | string[]           | `[]`                          | 当 `platforms="specific"` 时，列出具体平台 key                                                                 |
| `wps365.enabled`         | boolean            | `false`                       | 是否启用 WPS365 云端同步                                                                                       |
| `wps365.driveId`         | string             | `""`                          | WPS365 盘 ID（通过 `wps365-cli drive list` 获取）                                                              |
| `wps365.parentFolderId`  | string             | `"0"`                         | 父文件夹 ID，`"0"` 表示根目录                                                                                  |
| `wps365.rootFolderName`  | string             | `"cursor-mirror"`             | 在 WPS365 中创建的根文件夹名称                                                                                 |
| `wps365.useParentAsRoot` | boolean            | `false`                       | 设为 `true` 时直接将 `parentFolderId` 作为根文件夹，不再在其下创建子文件夹（适用于协作者使用共享文件夹的场景） |
| `wps365.share.enabled`   | boolean            | `false`                       | 是否在上传后自动开启分享链接                                                                                   |
| `wps365.share.scope`     | string             | —                             | 分享范围：`anyone`（任何人）/ `company`（本企业成员）/ `users`（指定用户）                                     |
| `wps365.share.roleId`    | string             | —                             | 权限角色 ID，如 `"21020029"`（可查看），通过 `wps365-cli drive roles list` 查询                                |

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

### WPS365 云端同步配置

启用后，安装包下载完成后会自动上传到 WPS365 企业云盘，内网用户可通过云盘链接下载。

**前置条件：**

1. 安装 [WPS365 CLI](https://github.com/wps365-open/cli)
2. 配置 OAuth 凭证并登录授权（参考 [docs/WPS365-CLI-上传指南.md](docs/WPS365-CLI-上传指南.md)）
3. 获取盘 ID：`wps365-cli drive list --allotee-type user`
4. 如需自动分享，登录时需追加 scope：`wps365-cli auth login --scopes "...,kso.file_link.readwrite"`
5. （Windows 服务部署）首次登录后需导出凭据到文件，详见下方说明

**Windows 服务环境说明：**

以 Windows 服务方式运行时，`wps365-cli` 的 OAuth 凭据存储在 Windows Credential Manager 中，而服务进程（Session 0）无法访问用户的凭据存储。程序会自动从 CLI 配置目录下的 `token_delegated.json` 文件读取 token，并在 token 过期时通过 OAuth API 自动刷新（需要 `config.json` 中包含 `client_secret`）。

首次部署时需在交互式终端中执行一次登录，然后将凭据导出到文件系统。详细步骤参考 [docs/WPS365-CLI-上传指南.md](docs/WPS365-CLI-上传指南.md)。

**配置示例（首次部署，自动创建文件夹）：**

```json
{
  "wps365": {
    "enabled": true,
    "driveId": "你的盘ID",
    "parentFolderId": "0",
    "rootFolderName": "cursor-mirror",
    "share": {
      "enabled": true,
      "scope": "company",
      "roleId": "21020029"
    }
  }
}
```

首次运行后会在盘根目录创建 `cursor-mirror` 文件夹。建议创建后获取该文件夹 ID，改为 `useParentAsRoot` 模式：

```json
{
  "wps365": {
    "enabled": true,
    "driveId": "你的盘ID",
    "parentFolderId": "<cursor-mirror文件夹的ID>",
    "useParentAsRoot": true,
    "rootFolderName": "cursor-mirror",
    "share": {
      "enabled": true,
      "scope": "company",
      "roleId": "21020029"
    }
  }
}
```

获取文件夹 ID：`wps365-cli drive files list <driveId> 0 --page-size 20`，找到 `cursor-mirror` 的 `id` 字段。

启用后：

- 拉取时每个文件**下载完立即上传**到 WPS365 对应版本文件夹
- 上传完成后**自动开启分享链接**（需配置 `share`），内网用户可直接通过链接访问
- 页面默认展示云端下载链接，点击标识可切换到本地下载模式
- WPS365 文件夹中自动维护一个状态信息文件（`【镜像vX.X.X_官方vX.X.X_MM-DD HHmm拉取_MM-DD HHmm更新】.txt`）
- 上传失败的文件仍可通过本地服务器下载

### 协作者共享文件夹配置

当你希望另一台机器（其他人的电脑）也运行本项目并上传到**你的** WPS365 文件夹时：

1. 在你的 WPS365 云盘中将 `cursor-mirror` 文件夹分享给对方并授予**管理员权限**
2. 对方在自己机器上安装 `wps365-cli` 并登录自己的账号
3. 对方使用与你完全相同的 `wps365` 配置（同一个 `driveId`、`parentFolderId`、`useParentAsRoot: true`）

所有者和协作者可以使用完全一致的配置，只要对方对该文件夹有管理员权限即可。

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
2. **初始同步** — 若 `runOnStart=true`，后台自动执行首次同步；若 WPS365 已启用，自动迁移已有版本到云端
3. **整点检查** — 每小时整点通过 API 302 探测获取官方最新三级版本号并缓存，同步更新 WPS365 状态文件
4. **定时拉取** — 按 cron 配置（默认 4:30 / 21:30）触发完整拉取流程
5. **版本比对** — 与本地 `downloads/version.json` 记录的版本对比
6. **完整性校验** — 即使版本号相同，也校验已有文件大小是否与预期一致
7. **增量下载** — 仅在版本不同或文件不完整时下载缺失的安装包，使用 `.tmp` 临时文件 + 原子重命名
8. **云端上传** — 若启用 WPS365，每个文件下载完成后立即上传到云盘版本文件夹，上传失败不阻塞后续文件
9. **原子切换** — 全部安装包下载成功后才更新 `version.json` 中的当前版本
10. **手动触发** — 本地访问时点击"立即拉取"可随时手动同步，与定时拉取使用同一套逻辑

## API 接口

| 方法 | 路径                       | 访问限制 | 说明                               |
| ---- | -------------------------- | -------- | ---------------------------------- |
| GET  | `/`                        | 无       | 下载页面（静态 HTML + 客户端渲染） |
| GET  | `/api/page-data`           | 无       | 返回版本数据、同步状态、调度信息   |
| GET  | `/api/status`              | 无       | 返回同步状态、官方版本、本地版本   |
| GET  | `/download/:version/:file` | 无       | 下载指定版本的安装包               |
| POST | `/api/sync/trigger`        | 仅本机   | 触发手动同步                       |
| POST | `/api/sync/abort`          | 仅本机   | 终止正在进行的同步                 |
| POST | `/api/sync/migrate`        | 仅本机   | 将已有版本迁移上传到 WPS365        |
| GET  | `/api/sync/stream`         | 仅本机   | SSE 实时日志流                     |

## 目录结构

```
cursor-mirror/
├── config.json          # 配置文件（从 config.example.json 复制）
├── config.example.json  # 配置模板
├── package.json
├── Dockerfile           # Docker 镜像构建
├── docker-compose.yml   # Docker Compose 编排
├── nssm.exe             # NSSM 服务管理工具（可选，用于注册 Windows 服务）
├── install-service.bat  # 一键安装服务（双击运行）
├── uninstall-service.bat # 一键卸载服务（双击运行）
├── service.bat          # 服务日常管理菜单（双击运行）
├── docs/
│   ├── windows-service.md     # Windows 服务部署指南 & NSSM 详解
│   └── WPS365-CLI-上传指南.md  # WPS365 CLI 安装与上传指南
├── logs/                # 服务日志（自动创建）
├── public/              # 前端静态资源
│   ├── index.html       # 页面骨架
│   ├── style.css        # 页面样式
│   └── app.js           # 客户端渲染 + 交互逻辑（SSE、按钮、日志面板）
├── src/
│   ├── index.js         # 入口：cron 调度 + 服务器启动
│   ├── scraper.js       # 版本探测：API 302 重定向版本号解析 + 下载链接生成
│   ├── downloader.js    # 下载器：增量下载 + 重试 + 事件推送 + 终止支持
│   ├── uploader.js      # WPS365 上传：三阶段上传 + 秒传 + 信息文件维护
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
