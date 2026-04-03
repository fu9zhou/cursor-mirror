# Windows 服务部署指南

本文档介绍如何使用 NSSM 将 Cursor Mirror 注册为 Windows 系统服务，实现开机无感启动、崩溃自动重启。

---

## 目录

- [什么是 Windows 服务](#什么是-windows-服务)
- [为什么需要 NSSM](#为什么需要-nssm)
- [NSSM 详细介绍](#nssm-详细介绍)
- [安装步骤](#安装步骤)
- [日常管理](#日常管理)
- [NSSM 完整参数手册](#nssm-完整参数手册)
- [日志管理](#日志管理)
- [进程守护与重启策略](#进程守护与重启策略)
- [安全与权限](#安全与权限)
- [与其他方案的对比](#与其他方案的对比)
- [常见问题](#常见问题)

---

## 什么是 Windows 服务

Windows 服务（Windows Service）是一种特殊的后台程序，具有以下特点：

- **开机自动运行** — 不需要任何用户登录，系统启动就能运行
- **后台静默运行** — 没有窗口、没有托盘图标，完全无感
- **由系统管理** — 通过 `services.msc`（服务管理器）统一管理，可以设置启动类型、运行账户等
- **异常恢复** — 可以配置崩溃后自动重启

你日常使用的 Windows 中就有大量服务在后台运行，比如 Windows Update、打印服务、网络服务等。通过 `Win + R` 输入 `services.msc` 可以查看所有已注册的服务。

**但是**，要注册为 Windows 服务，程序必须实现特定的 Windows 服务 API（Service Control Handler）。普通的命令行程序（如 `node.exe`、`python.exe`、`java.exe`）并不具备这个能力——这就是 NSSM 存在的意义。

---

## 为什么需要 NSSM

### 问题：普通程序无法直接注册为服务

Windows 提供了一个原生命令 `sc.exe` 来管理服务，但它有一个致命限制：**只能管理专门为 Windows 服务 API 编写的程序**。

如果你尝试用 `sc` 注册一个普通的 Node.js 程序：

```powershell
sc create MyService binPath= "C:\node\node.exe D:\app\index.js"
```

你会遇到这些问题：

1. **服务启动后立即停止** — `sc` 期望程序调用 `SetServiceStatus` 上报状态，普通程序不会这么做，所以 SCM 认为它启动失败
2. **无法正确停止** — SCM 发送停止信号时使用服务 API，普通程序收不到，只能被强杀
3. **崩溃无人管** — 没有守护机制，进程挂了就没了
4. **没有日志** — stdout/stderr 直接丢失，出了问题无从排查

微软曾提供过一个 `srvany.exe`（Windows Resource Kit 中的工具）来包装普通程序，但它：

- 已经多年未更新
- 不支持 64 位
- 没有日志管理
- 没有进程守护
- 配置复杂需要手改注册表

### 解决：NSSM 作为中间层

NSSM 的思路很简单：**它自己是合规的 Windows 服务，然后它来帮你管理你的程序**。

```
┌─────────────────────────────────────────────────────┐
│               Windows 服务控制管理器 (SCM)            │
│                                                      │
│   SCM 负责管理所有 Windows 服务的生命周期               │
│   它只认识实现了 Service API 的程序                     │
└──────────────────────┬──────────────────────────────┘
                       │ START / STOP / RESTART
                       ▼
┌─────────────────────────────────────────────────────┐
│                   nssm.exe (服务宿主)                 │
│                                                      │
│   ✓ 实现了 Service API，SCM 能正确管理它                │
│   ✓ 启动后作为子进程运行你的实际程序                     │
│   ✓ 持续监控子进程状态                                  │
│   ✓ 捕获 stdout/stderr 写入日志                        │
│   ✓ 收到 STOP 指令 → 优雅通知子进程退出                 │
│   ✓ 子进程异常退出 → 按策略自动重启                      │
└──────────────────────┬──────────────────────────────┘
                       │ 创建子进程
                       ▼
┌─────────────────────────────────────────────────────┐
│            node.exe src/index.js (你的应用)            │
│                                                      │
│   什么都不用改，正常写 console.log 就行                  │
│   NSSM 会把输出捕获到日志文件                           │
└─────────────────────────────────────────────────────┘
```

---

## NSSM 详细介绍

### 基本信息

| 项目         | 内容                        |
| ------------ | --------------------------- |
| 全称         | Non-Sucking Service Manager |
| 官网         | https://nssm.cc             |
| 开源协议     | Public domain (公有领域)    |
| 文件大小     | 约 300KB（单个 exe 文件）   |
| 系统要求     | Windows XP 及以上           |
| 是否需要安装 | 不需要，解压即用            |
| 运行时依赖   | 无                          |
| 支持架构     | 32 位 / 64 位               |

### 核心能力详解

#### 1. 进程守护

NSSM 持续监控你的程序。当检测到进程退出时，会根据退出码和配置策略决定下一步行动：

- **自动重启（Restart）** — 默认行为，等待配置的延迟后重新启动程序
- **忽略（Ignore）** — 什么都不做，服务保持 STOPPED 状态
- **退出（Exit）** — NSSM 自己也退出

你可以针对不同的退出码设置不同的行为。例如：正常退出（退出码 0）不重启，异常退出（非 0）自动重启。

#### 2. 开机自启

注册为服务后，默认启动类型是"自动"（Automatic），意味着：

- 系统开机就启动，不需要任何人登录
- 在用户登录界面出现之前就已经在运行了
- 即使是通过远程桌面断开连接，服务也继续运行

#### 3. 日志管理

NSSM 能捕获程序的标准输出（stdout）和标准错误（stderr），分别写入指定的日志文件。你的程序里只需要正常写 `console.log`，NSSM 会处理剩下的事。

日志轮转功能可以防止日志文件无限增长撑满磁盘。支持按文件大小轮转和按时间轮转。

#### 4. 优雅停止

当你停止服务时，NSSM 不会直接杀掉进程，而是按以下顺序尝试：

1. **发送 Ctrl+C 信号** — 让程序有机会做清理工作（关闭数据库连接、保存状态等）
2. **发送 WM_CLOSE 消息** — 如果程序有窗口的话
3. **发送 WM_QUIT 消息**
4. **调用 TerminateProcess** — 如果以上方法都在超时内没有效果，才会强制杀掉

每一步都有可配置的超时时间，默认是 1500ms。

#### 5. 环境变量

可以为服务单独设置环境变量，不影响系统全局环境变量。在需要为不同服务设置不同的 `NODE_ENV`、`PORT` 等变量时非常有用。

#### 6. GUI 编辑器

运行 `nssm edit <服务名>` 会打开一个图形界面，可以方便地修改服务的所有配置，包括可执行文件路径、参数、工作目录、环境变量、日志设置等。适合不熟悉命令行的用户。

### NSSM 命令一览

```powershell
nssm install <servicename>          # 注册服务（打开 GUI）
nssm install <servicename> <app>    # 注册服务（命令行）
nssm remove <servicename>           # 卸载服务（打开确认对话框）
nssm remove <servicename> confirm   # 卸载服务（无确认）
nssm start <servicename>            # 启动服务
nssm stop <servicename>             # 停止服务
nssm restart <servicename>          # 重启服务
nssm status <servicename>           # 查看服务状态
nssm edit <servicename>             # GUI 编辑服务配置
nssm dump <servicename>             # 导出服务的所有配置
nssm set <servicename> <param> <value>    # 设置参数
nssm get <servicename> <param>            # 获取参数值
nssm reset <servicename> <param>          # 重置参数为默认值
nssm rotate <servicename>                 # 手动触发日志轮转
```

---

## 安装步骤

### 前置条件

- Windows 10 或更高版本
- Node.js >= 18 已安装
- 管理员权限（注册/管理服务需要）

### 1. 下载 NSSM

从 https://nssm.cc/download 下载最新版本的 zip 包。

解压后目录结构如下：

```
nssm-2.24/
├── win32/
│   └── nssm.exe    # 32 位版本
├── win64/
│   └── nssm.exe    # 64 位版本（推荐）
├── src/            # 源码（不需要）
├── ChangeLog.txt
└── README.txt
```

将 `win64/nssm.exe` 复制到项目根目录即可。

> 如何确认系统位数：按 `Win + Pause` 查看"系统类型"，现在绝大多数 Windows 都是 64 位。

### 2. 注册服务

以**管理员权限**打开 PowerShell（右键 PowerShell → "以管理员身份运行"），进入项目目录：

```powershell
cd D:\test-project\cursor-mirror
```

#### 方式 A：一键安装（推荐）

右键 `install-service.bat` → **以管理员身份运行**。

脚本会自动完成以下操作：

- 检测 `node.exe` 的完整路径
- 创建 `logs/` 日志目录
- 注册 `CursorMirror` 服务
- 配置工作目录、显示名称、描述
- 配置日志输出和轮转（5MB）
- 配置崩溃 5 秒后自动重启
- 启动服务

#### 方式 B：手动逐步安装

如果你想了解每一步在做什么，可以手动执行：

**第一步：找到 node.exe 的完整路径**

```powershell
(Get-Command node).Source
# 输出示例：C:\nvm4w\nodejs\node.exe
```

**第二步：注册服务**

```powershell
.\nssm.exe install CursorMirror "C:\nvm4w\nodejs\node.exe" "D:\test-project\cursor-mirror\src\index.js"
```

这行命令的含义：

- `install` — 注册一个新服务
- `CursorMirror` — 服务名称（内部标识，唯一）
- 第一个路径 — 要运行的可执行文件（node.exe）
- 第二个路径 — 传递给 node.exe 的参数（你的入口文件）

**第三步：配置工作目录**

```powershell
.\nssm.exe set CursorMirror AppDirectory "D:\test-project\cursor-mirror"
```

工作目录决定了程序运行时的 `process.cwd()`。如果不设置，默认是 `nssm.exe` 所在的目录。我们的程序需要读取 `config.json`、写入 `downloads/` 目录，所以必须设为项目根目录。

**第四步：设置显示名称和描述**

```powershell
.\nssm.exe set CursorMirror DisplayName "Cursor Mirror"
.\nssm.exe set CursorMirror Description "Cursor IDE 安装包内网镜像下载站"
```

`DisplayName` 是在 `services.msc` 中显示的名称，可以包含空格和中文，更人性化。`Description` 是服务描述，帮助你记住这个服务是干什么的。

**第五步：配置日志**

```powershell
# 创建日志目录
mkdir logs -ErrorAction SilentlyContinue

# 标准输出日志
.\nssm.exe set CursorMirror AppStdout "D:\test-project\cursor-mirror\logs\service.log"

# 错误输出日志
.\nssm.exe set CursorMirror AppStderr "D:\test-project\cursor-mirror\logs\service-error.log"

# 启用日志轮转
.\nssm.exe set CursorMirror AppRotateFiles 1

# 日志文件超过 5MB 自动轮转
.\nssm.exe set CursorMirror AppRotateBytes 5242880
```

如果不配置日志，程序的所有 `console.log` 输出都会丢失，出问题时无从排查。

**第六步：配置崩溃重启**

```powershell
# 程序退出后 5 秒自动重启
.\nssm.exe set CursorMirror AppRestartDelay 5000
```

默认情况下，NSSM 对任何退出码都会执行重启。5000 毫秒（5 秒）的延迟可以防止程序在启动就崩溃的情况下疯狂重启消耗资源。

**第七步：启动服务**

```powershell
.\nssm.exe start CursorMirror
```

### 3. 验证

```powershell
# 查看服务状态（应该显示 SERVICE_RUNNING）
.\nssm.exe status CursorMirror

# 测试 HTTP 访问
curl http://localhost:6700

# 查看日志是否正常写入
Get-Content logs\service.log -Tail 10
```

如果一切正常，你会看到：

```
[Proxy] No proxy configured, connecting directly
[Cron] Scheduled 3 check points: 0 3 * * *, 0 6 * * *, 0 21 * * *
[Server] Cursor Mirror started:
  Local:   http://localhost:6700
  Network: http://192.168.1.100:6700
```

---

## 日常管理

### 方式一：管理脚本（推荐）

双击 `service.bat` 打开交互式菜单，按数字选择对应操作：

```
+==========================================+
:       Cursor Mirror Service Manager      :
+==========================================+
:   1.  Status                             :
:   2.  Start                              :
:   3.  Stop                               :
:   4.  Restart                            :
:   5.  View recent logs                   :
:   6.  Open services.msc                  :
:   7.  Edit config (NSSM GUI)             :
:   0.  Exit                               :
+==========================================+
```

卸载服务时，双击 `uninstall-service.bat` 即可。

### 方式二：直接使用 NSSM 命令

```powershell
.\nssm.exe status CursorMirror          # 查看状态
.\nssm.exe start CursorMirror           # 启动服务
.\nssm.exe stop CursorMirror            # 停止服务
.\nssm.exe restart CursorMirror         # 重启服务
.\nssm.exe edit CursorMirror            # 打开 GUI 编辑配置
.\nssm.exe dump CursorMirror            # 查看所有当前配置
.\nssm.exe remove CursorMirror confirm  # 卸载服务
```

### 方式三：Windows 服务管理器

1. 按 `Win + R`，输入 `services.msc`，回车
2. 找到 `Cursor Mirror`（按名称排序更容易找到）
3. 右键可以：启动、停止、重启、查看属性
4. 在"属性 → 常规"标签页可以修改启动类型（自动/手动/禁用）
5. 在"属性 → 恢复"标签页可以配置失败后的操作

---

## NSSM 完整参数手册

### 应用程序参数

| 参数                  | 类型   | 说明               | 示例                            |
| --------------------- | ------ | ------------------ | ------------------------------- |
| `Application`         | 路径   | 要运行的可执行文件 | `C:\nvm4w\nodejs\node.exe`      |
| `AppParameters`       | 字符串 | 传递给程序的参数   | `src/index.js`                  |
| `AppDirectory`        | 路径   | 工作目录           | `D:\test-project\cursor-mirror` |
| `AppEnvironmentExtra` | 多值   | 额外的环境变量     | `NODE_ENV=production`           |

### 服务属性参数

| 参数              | 类型   | 说明                     | 示例                        |
| ----------------- | ------ | ------------------------ | --------------------------- |
| `DisplayName`     | 字符串 | 在服务管理器中显示的名称 | `Cursor Mirror`             |
| `Description`     | 字符串 | 服务描述                 | `Cursor IDE 镜像站`         |
| `Start`           | 枚举   | 启动类型                 | `SERVICE_AUTO_START`        |
| `ObjectName`      | 字符串 | 运行服务的账户           | `LocalSystem`               |
| `Type`            | 枚举   | 服务类型                 | `SERVICE_WIN32_OWN_PROCESS` |
| `DependOnService` | 多值   | 依赖的其他服务           | `Tcpip`                     |

`Start` 可选值：

| 值                           | 含义                           |
| ---------------------------- | ------------------------------ |
| `SERVICE_AUTO_START`         | 开机自动启动（默认）           |
| `SERVICE_DELAYED_AUTO_START` | 延迟自动启动（系统完全启动后） |
| `SERVICE_DEMAND_START`       | 手动启动                       |
| `SERVICE_DISABLED`           | 禁用                           |

### 日志参数

| 参数                           | 类型 | 说明                   | 默认值   |
| ------------------------------ | ---- | ---------------------- | -------- |
| `AppStdout`                    | 路径 | stdout 日志文件路径    | 不记录   |
| `AppStderr`                    | 路径 | stderr 日志文件路径    | 不记录   |
| `AppStdoutCreationDisposition` | 数字 | stdout 写入模式        | 4 (追加) |
| `AppStderrCreationDisposition` | 数字 | stderr 写入模式        | 4 (追加) |
| `AppRotateFiles`               | 0/1  | 是否启用日志轮转       | 0        |
| `AppRotateOnline`              | 0/1  | 是否支持运行中轮转     | 0        |
| `AppRotateBytes`               | 数字 | 按大小轮转阈值（字节） | 0 (不限) |
| `AppRotateSeconds`             | 数字 | 按时间轮转间隔（秒）   | 0 (不限) |

`CreationDisposition` 可选值：

| 值  | 含义                                             |
| --- | ------------------------------------------------ |
| 1   | `CREATE_NEW` — 只在文件不存在时创建              |
| 2   | `CREATE_ALWAYS` — 每次覆盖                       |
| 3   | `OPEN_EXISTING` — 只打开已存在的文件             |
| 4   | `OPEN_ALWAYS` — 存在则追加，不存在则创建（推荐） |

### 退出行为参数

| 参数                 | 类型 | 说明               | 默认值       |
| -------------------- | ---- | ------------------ | ------------ |
| `AppExit Default`    | 枚举 | 默认退出行为       | Restart      |
| `AppExit <exitcode>` | 枚举 | 特定退出码的行为   | 继承 Default |
| `AppRestartDelay`    | 毫秒 | 重启前等待时间     | 0            |
| `AppThrottle`        | 毫秒 | 快速重启的最短间隔 | 1500         |

`AppExit` 可选值：

| 值        | 含义                          |
| --------- | ----------------------------- |
| `Restart` | 自动重启程序                  |
| `Ignore`  | 什么都不做，服务变为 STOPPED  |
| `Exit`    | NSSM 自己也退出               |
| `Suicide` | NSSM 标记服务为崩溃状态后退出 |

针对特定退出码设置不同行为的示例：

```powershell
# 正常退出（代码 0）不重启
.\nssm.exe set CursorMirror AppExit 0 Exit

# 其他退出码自动重启（默认行为）
.\nssm.exe set CursorMirror AppExit Default Restart
```

### 停止控制参数

| 参数                   | 类型   | 说明                | 默认值 |
| ---------------------- | ------ | ------------------- | ------ |
| `AppStopMethodSkip`    | 位掩码 | 跳过某些停止方法    | 0      |
| `AppStopMethodConsole` | 毫秒   | Ctrl+C 的超时时间   | 1500   |
| `AppStopMethodWindow`  | 毫秒   | WM_CLOSE 的超时时间 | 1500   |
| `AppStopMethodThreads` | 毫秒   | WM_QUIT 的超时时间  | 1500   |
| `AppKillProcessTree`   | 0/1    | 是否杀掉整个进程树  | 1      |

`AppStopMethodSkip` 位掩码含义：

| 位  | 跳过的方法            |
| --- | --------------------- |
| 1   | 跳过 Ctrl+C           |
| 2   | 跳过 WM_CLOSE         |
| 4   | 跳过 WM_QUIT          |
| 8   | 跳过 TerminateProcess |

例如设为 6 (= 2+4) 就跳过 WM_CLOSE 和 WM_QUIT，只用 Ctrl+C 和 TerminateProcess。

### 进程优先级参数

```powershell
# 设置进程优先级
.\nssm.exe set CursorMirror AppPriority NORMAL_PRIORITY_CLASS
```

可选值：`REALTIME_PRIORITY_CLASS`、`HIGH_PRIORITY_CLASS`、`ABOVE_NORMAL_PRIORITY_CLASS`、`NORMAL_PRIORITY_CLASS`、`BELOW_NORMAL_PRIORITY_CLASS`、`IDLE_PRIORITY_CLASS`

### CPU 亲和性参数

```powershell
# 绑定到特定 CPU 核心（位掩码，3 = 核心 0 和 1）
.\nssm.exe set CursorMirror AppAffinity 3
```

---

## 日志管理

### 日志文件位置

服务运行日志存储在 `logs/` 目录：

```
logs/
├── service.log           # 标准输出（程序正常日志）
├── service-error.log     # 错误输出
├── service.log.1         # 轮转的历史日志（按序号递增）
├── service.log.2
└── ...
```

### 查看日志

```powershell
# 查看最后 50 行
Get-Content logs\service.log -Tail 50

# 搜索特定关键词
Select-String -Path logs\service.log -Pattern "Error"

# 查看错误日志
Get-Content logs\service-error.log -Tail 20
```

### 日志轮转

本项目配置了按大小轮转（5MB）。当 `service.log` 超过 5MB 时，NSSM 会将其重命名为 `service.log.1`，然后创建新的 `service.log`。

如果需要按时间轮转：

```powershell
# 每 86400 秒（24 小时）轮转一次
.\nssm.exe set CursorMirror AppRotateSeconds 86400
```

手动触发日志轮转：

```powershell
.\nssm.exe rotate CursorMirror
```

---

## 进程守护与重启策略

### 默认行为

NSSM 的默认配置是：**无论程序以什么退出码退出，都自动重启**。本项目额外配置了 5 秒重启延迟。

### 重启节流（Throttle）

NSSM 内置了一个节流机制：如果程序在启动后很短时间内就崩溃了（可能是配置错误导致的无限重启循环），NSSM 会逐步增加重启等待时间，避免 CPU 空转。

默认节流阈值是 1500ms——如果程序在启动后 1500ms 内就退出了，NSSM 会开始延长等待时间。

### 自定义策略示例

```powershell
# 场景：正常退出不重启，异常退出重启
.\nssm.exe set CursorMirror AppExit 0 Ignore      # 退出码 0 = 不重启
.\nssm.exe set CursorMirror AppExit Default Restart # 其他退出码 = 重启

# 场景：重启延迟 10 秒
.\nssm.exe set CursorMirror AppRestartDelay 10000

# 场景：崩溃后触发 Windows 恢复操作（在 services.msc 的"恢复"标签中配置）
.\nssm.exe set CursorMirror AppExit Default Suicide
```

---

## 安全与权限

### 运行账户

默认情况下，NSSM 注册的服务以 `LocalSystem` 账户运行，这是 Windows 中权限最高的内置账户。对于内网工具来说这通常没问题。

如果需要更精细的权限控制：

```powershell
# 以特定用户身份运行
.\nssm.exe set CursorMirror ObjectName "DOMAIN\username" "password"

# 以 NetworkService 身份运行（权限较低）
.\nssm.exe set CursorMirror ObjectName "NT AUTHORITY\NetworkService"

# 以 LocalService 身份运行（权限最低）
.\nssm.exe set CursorMirror ObjectName "NT AUTHORITY\LocalService"
```

### 注意事项

- 以 `LocalSystem` 运行的服务可以访问本机所有文件，但不能直接访问网络共享
- 修改运行账户后，需要确保该账户对项目目录和日志目录有读写权限
- 使用 NVM 管理 Node.js 时，`node.exe` 路径可能因版本切换而变化，需要注意

---

## 与其他方案的对比

| 特性           | NSSM  | PM2   | 任务计划程序 | sc.exe | Docker |
| -------------- | ----- | ----- | ------------ | ------ | ------ |
| 崩溃自重启     | ✓     | ✓     | ✗            | ✗      | ✓      |
| 无需登录       | ✓     | ✗     | 可配置       | ✓      | ✓      |
| 日志管理       | ✓     | ✓     | ✗            | ✗      | ✓      |
| 日志轮转       | ✓     | ✓     | ✗            | ✗      | ✓      |
| 图形界面       | ✓     | ✗     | ✓            | ✗      | ✗      |
| 无额外运行时   | ✓     | ✗     | ✓            | ✓      | ✗      |
| 支持任意程序   | ✓     | ✗     | ✓            | ✗      | ✓      |
| 环境变量隔离   | ✓     | ✓     | ✗            | ✗      | ✓      |
| 学习成本       | 低    | 中    | 低           | 高     | 高     |
| Windows 集成度 | 高    | 低    | 中           | 高     | 低     |
| 文件大小       | 300KB | ~50MB | 内置         | 内置   | >100MB |

**NSSM 的最大优势**：零依赖、轻量（300KB）、完美集成 Windows 服务体系、支持任意程序。

---

## 常见问题

### 服务启动失败

1. **检查 node.exe 路径是否正确**

```powershell
(Get-Command node).Source
# 确认输出的路径和注册服务时用的一致
.\nssm.exe get CursorMirror Application
```

2. **检查入口文件路径**

```powershell
.\nssm.exe get CursorMirror AppParameters
# 确认文件存在
Test-Path "D:\test-project\cursor-mirror\src\index.js"
```

3. **查看错误日志**

```powershell
Get-Content logs\service-error.log -Tail 20
```

4. **手动运行确认程序本身没问题**

```powershell
cd D:\test-project\cursor-mirror
node src/index.js
```

5. **查看 Windows 事件日志**

```powershell
Get-EventLog -LogName Application -Source nssm -Newest 10
```

### 端口被占用

```powershell
# 查看 6700 端口被谁占用
netstat -ano | findstr :6700

# 根据 PID 找到进程名
tasklist /FI "PID eq <pid>"

# 杀掉占用端口的进程
taskkill /PID <pid> /F

# 重启服务
.\nssm.exe restart CursorMirror
```

### 修改代码后如何生效

NSSM 不会自动检测文件变化。修改代码后需要手动重启：

```powershell
.\nssm.exe restart CursorMirror
```

或双击 `service.bat` 选择 4 (Restart)。

### NVM 切换 Node 版本后服务启动失败

如果你用 NVM 管理 Node.js 版本，切换版本后 `node.exe` 的路径可能发生变化。需要更新服务配置：

```powershell
# 查看当前 node 路径
(Get-Command node).Source

# 更新服务的可执行文件路径
.\nssm.exe set CursorMirror Application "C:\new\path\to\node.exe"

# 重启服务
.\nssm.exe restart CursorMirror
```

### 如何完全卸载

双击 `uninstall-service.bat`，或手动执行：

```powershell
.\nssm.exe stop CursorMirror
.\nssm.exe remove CursorMirror confirm

# 删除 NSSM 和日志（可选）
Remove-Item nssm.exe
Remove-Item logs -Recurse
```

卸载服务不会删除你的项目文件和下载的安装包。

### 服务正在运行但无法访问页面

1. 检查防火墙是否放行了端口 6700
2. 检查是否绑定了正确的地址（应该是 `0.0.0.0` 而不是 `127.0.0.1`）
3. 检查日志中是否有错误信息

```powershell
# 查看 Windows 防火墙规则
netsh advfirewall firewall show rule name=all | findstr "6700"

# 添加防火墙规则（如果需要）
netsh advfirewall firewall add rule name="CursorMirror" dir=in action=allow protocol=tcp localport=6700
```
