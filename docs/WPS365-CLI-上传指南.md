# WPS365 CLI 文件上传完整指南

## 1. 安装 CLI

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/wps365-open/cli/main/install.ps1 | iex
```

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/wps365-open/cli/main/install.sh | bash
```

安装完成后关闭并重新打开终端，或手动刷新 PATH：

```powershell
$env:Path = [Environment]::GetEnvironmentVariable("Path", "User") + ";" + [Environment]::GetEnvironmentVariable("Path", "Machine")
```

验证安装：

```powershell
wps365-cli --version
```

---

## 2. 认证配置

### 2.1 前置准备

前往 [WPS365 开放平台](https://open.wps.cn) 创建 OAuth 应用，获取 `client_id` 和 `client_secret`。

需要申请的权限 scope：

| Scope                 | 用途                        |
| --------------------- | --------------------------- |
| `kso.user_base.read`  | 读取当前用户信息            |
| `kso.file.readwrite`  | 文件上传/下载/管理          |
| `kso.drive.readwrite` | 盘列表查询（获取个人盘 ID） |

### 2.2 配置 OAuth 凭证（仅需一次）

```powershell
wps365-cli auth setup
```

按提示输入 `client_id` 和 `client_secret`。

### 2.3 登录授权

```powershell
wps365-cli auth login --scopes "kso.user_base.read,kso.file.readwrite,kso.drive.readwrite"
```

此命令会打开浏览器进行 OAuth 授权。完成后 CLI 自动获取 token。

### 2.4 验证认证状态

```powershell
wps365-cli auth status
```

确认 `delegated.available` 为 `true`，`granted_scopes` 包含所需权限。

### 2.5 查看当前用户

```powershell
wps365-cli user me
```

---

## 3. 查找个人盘

### 3.1 列出用户盘

```powershell
wps365-cli drive list --allotee-type user
```

返回结果中找到你的个人盘，记录 `id` 字段作为 `drive_id`。

示例返回：

```json
{
  "id": "aEQXPBz",
  "name": "我的企业文档",
  "source": "special"
}
```

### 3.2 查看盘内文件

```powershell
wps365-cli drive files list <drive_id> 0 --page-size 20
```

`0` 表示根目录。

---

## 4. 创建文件夹

```powershell
wps365-cli drive files create <drive_id> <parent_id> --name "文件夹名" --file-type folder
```

示例：

```powershell
wps365-cli drive files create aEQXPBz 0 --name "cursor" --file-type folder
```

记录返回的文件夹 `id`，后续上传文件时作为 `parent_id`。

---

## 5. 上传文件（三阶段流程）

WPS365 文件上传分三个阶段：

```
request_upload → PUT 文件到预签名 URL → commit_upload
```

### 5.1 计算文件哈希

公网上传必须提供 SHA256 和/或 MD5 哈希。

```powershell
$file = "D:\path\to\yourfile.exe"
$sha256 = (Get-FileHash -Algorithm SHA256 $file).Hash.ToLower()

$md5Obj = [System.Security.Cryptography.MD5]::Create()
$stream = [System.IO.File]::OpenRead($file)
$md5Hash = [BitConverter]::ToString($md5Obj.ComputeHash($stream)).Replace("-","").ToLower()
$stream.Close()

$size = (Get-Item $file).Length
$name = (Get-Item $file).Name

Write-Host "文件: $name | 大小: $size bytes | SHA256: $sha256 | MD5: $md5Hash"
```

### 5.2 阶段一：申请上传 (request_upload)

```powershell
$driveId = "<你的盘ID>"
$parentId = "<目标文件夹ID，根目录用 0>"

$body = @"
{
  "name": "$name",
  "size": $size,
  "on_name_conflict": "rename",
  "hashes": [
    {"type": "sha256", "sum": "$sha256"},
    {"type": "md5", "sum": "$md5Hash"}
  ]
}
"@

wps365-cli api post "/v7/drives/$driveId/files/$parentId/request_upload" --data $body
```

**关键参数说明：**

| 参数               | 必填       | 说明                                  |
| ------------------ | ---------- | ------------------------------------- |
| `name`             | 是（公网） | 文件名，需带后缀                      |
| `size`             | 是         | 文件字节数                            |
| `hashes`           | 是（公网） | 至少包含 md5 或 sha256                |
| `on_name_conflict` | 是（公网） | 同名策略：`rename`/`overwrite`/`fail` |

成功后返回：

```json
{
  "data": {
    "upload_id": "xxxxxxxx",
    "store_request": {
      "method": "PUT",
      "url": "https://hwc-bj.ag.wps.cn/api/object/xxxxx"
    }
  }
}
```

记录 `upload_id` 和 `store_request.url`。

### 5.3 阶段二：上传文件内容

将文件二进制内容 PUT 到预签名 URL，需要携带 Bearer Token。

```powershell
$uploadUrl = "<store_request.url>"
$token = wps365-cli auth token

$fileBytes = [System.IO.File]::ReadAllBytes($file)
$headers = @{ "Authorization" = "Bearer $token" }

Invoke-WebRequest -Uri $uploadUrl -Method PUT `
  -Body $fileBytes `
  -ContentType "application/octet-stream" `
  -Headers $headers `
  -UseBasicParsing
```

返回 HTTP 200 即成功。

### 5.4 阶段三：确认上传 (commit_upload)

```powershell
$uploadId = "<阶段一返回的 upload_id>"
$body = "{`"upload_id`":`"$uploadId`"}"

wps365-cli api post "/v7/drives/$driveId/files/$parentId/commit_upload" --data $body
```

成功后返回完整的文件对象，包含 `id`、`link_url`（分享链接）等信息。

---

## 6. 一键上传脚本

将以上三个阶段封装为一个可复用的 PowerShell 函数：

```powershell
function Upload-ToWPS365 {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string]$DriveId,
        [string]$ParentId = "0",
        [string]$ConflictPolicy = "rename"
    )

    $cli = "C:\Users\$env:USERNAME\.wps365\bin\wps365-cli.exe"
    $file = Get-Item $FilePath
    $name = $file.Name
    $size = $file.Length

    Write-Host "[1/4] 计算文件哈希..." -ForegroundColor Cyan
    $sha256 = (Get-FileHash -Algorithm SHA256 $FilePath).Hash.ToLower()
    $md5Obj = [System.Security.Cryptography.MD5]::Create()
    $stream = [System.IO.File]::OpenRead($FilePath)
    $md5 = [BitConverter]::ToString($md5Obj.ComputeHash($stream)).Replace("-","").ToLower()
    $stream.Close()

    Write-Host "[2/4] 申请上传..." -ForegroundColor Cyan
    $reqBody = "{`"name`":`"$name`",`"size`":$size,`"on_name_conflict`":`"$ConflictPolicy`",`"hashes`":[{`"type`":`"sha256`",`"sum`":`"$sha256`"},{`"type`":`"md5`",`"sum`":`"$md5`"}]}"
    $result = & $cli api post "/v7/drives/$DriveId/files/$ParentId/request_upload" --data $reqBody | ConvertFrom-Json

    if ($result.code -ne 0) {
        Write-Host "申请上传失败: $($result.msg)" -ForegroundColor Red
        return
    }

    $uploadId = $result.data.upload_id
    $uploadUrl = $result.data.store_request.url

    Write-Host "[3/4] 上传文件 ($([math]::Round($size/1MB, 1)) MB)..." -ForegroundColor Cyan
    $token = & $cli auth token
    $fileBytes = [System.IO.File]::ReadAllBytes($FilePath)
    $headers = @{ "Authorization" = "Bearer $token" }
    Invoke-WebRequest -Uri $uploadUrl -Method PUT -Body $fileBytes -ContentType "application/octet-stream" -Headers $headers -UseBasicParsing | Out-Null

    Write-Host "[4/4] 确认上传..." -ForegroundColor Cyan
    $commitBody = "{`"upload_id`":`"$uploadId`"}"
    $commitResult = & $cli api post "/v7/drives/$DriveId/files/$ParentId/commit_upload" --data $commitBody | ConvertFrom-Json

    if ($commitResult.code -eq 0) {
        Write-Host "上传成功!" -ForegroundColor Green
        Write-Host "  文件名: $($commitResult.data.name)"
        Write-Host "  文件ID: $($commitResult.data.id)"
        Write-Host "  分享链接: $($commitResult.data.link_url)"
    } else {
        Write-Host "确认上传失败: $($commitResult.msg)" -ForegroundColor Red
    }
}
```

**使用示例：**

```powershell
# 上传到个人盘根目录
Upload-ToWPS365 -FilePath "D:\myfile.pdf" -DriveId "aEQXPBz"

# 上传到指定文件夹
Upload-ToWPS365 -FilePath "D:\setup.exe" -DriveId "aEQXPBz" -ParentId "apKMqfHmo1MVUSNLQxxT1xAQiFv4DCp5o"

# 同名覆盖
Upload-ToWPS365 -FilePath "D:\report.docx" -DriveId "aEQXPBz" -ConflictPolicy "overwrite"
```

---

## 7. 认证机制说明

WPS365 CLI 使用 **OAuth 2.0 Bearer Token** 认证：

- 每次 API 请求自动注入 `Authorization: Bearer <token>` 头
- Token 过期前 10 秒自动刷新
- 401 时透明重试
- 凭证存储在 Windows Credential Manager (AES-256-GCM 加密)

## 8. 上传机制说明

### 普通上传（适用于大多数文件）

三阶段流程：`request_upload` → `PUT` → `commit_upload`

### 分片上传（超大文件）

使用 `create_multipart_upload_task` API，服务端返回分片数量和每片大小，按片上传后通过 `commit_multipart_upload_task` 合并。

### 秒传 (rapid_upload)

通过文件哈希匹配，如果服务端已有相同文件，直接关联而不实际传输。

## 9. 文件分享配置

上传完成后，默认只有文件所有者可以查看。如需让其他人通过链接查看文件，需要开启分享链接。

### 9.1 查询可用角色

```powershell
wps365-cli drive roles list <drive_id>
```

返回示例：

```json
[
  { "id": "21020028", "name": "仅查看" },
  { "id": "21020029", "name": "可查看" },
  { "id": "21020030", "name": "可编辑" },
  { "id": "21020031", "name": "可评论" },
  { "id": "21020032", "name": "可管理" }
]
```

常用角色说明：

| 角色 ID | 名称 | 权限 |
| ------- | ---- | ---- |
| `21020028` | 仅查看 | 仅预览，不可下载/复制/打印 |
| `21020029` | 可查看 | 预览 + 下载 + 复制 + 打印 |
| `21020030` | 可编辑 | 查看 + 编辑 + 上传 |
| `21020032` | 可管理 | 全部权限 |

### 9.2 分享范围（scope）

| scope 值 | 对应 UI 显示 | 说明 |
| --------- | ----------- | ---- |
| `anyone` | 任何人 | 任何拿到链接的人均可访问 |
| `company` | 本企业成员 | 仅组织内成员可通过链接访问 |
| `users` | 仅指定用户 | 需通过权限 API 单独授权 |

### 9.3 开启分享链接

```powershell
wps365-cli drive file-link open <drive_id> <file_id> --role-id <角色ID> --scope <scope>
```

**注意：** `open_link` API 首次创建链接时可能默认 scope 为 `anyone`，即使传了其他值。需要通过 update API 修改已有链接的 scope：

```powershell
$body = '{"scope":"company","role_id":"21020029"}'
wps365-cli api post "/v7/links/<link_id>/update" --data $body
```

### 9.4 在 config.json 中配置自动分享

在 `wps365` 配置块中添加 `share` 子项，上传完成后会自动开启分享链接：

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

| 字段 | 类型 | 说明 |
| ---- | ---- | ---- |
| `share.enabled` | boolean | 是否在上传后自动开启分享 |
| `share.scope` | string | 分享范围：`anyone` / `company` / `users` |
| `share.roleId` | string | 权限角色 ID，通过 `drive roles list` 查询 |

### 9.5 所需 OAuth Scope

开启文件分享功能需要在登录时追加 `kso.file_link.readwrite` 权限：

```powershell
wps365-cli auth login --scopes "kso.user_base.read,kso.file.readwrite,kso.drive.readwrite,kso.file_link.readwrite"
```

---

## 10. 常见问题

### Q: 上传时报 400000004 "请求参数不支持"

公网调用 `request_upload` 时，`hashes`（需包含 sha256 或 md5）和 `on_name_conflict` 是必传参数，即使 OpenAPI spec 中未标为 required。

### Q: PUT 上传时报 "userNotLogin"

预签名 URL 也需要 Bearer Token。在 PUT 请求头中加入 `Authorization: Bearer <token>`。

### Q: 如何获取 token？

```powershell
wps365-cli auth token
```

### Q: scope 不够怎么办？

重新登录并追加 scope：

```powershell
wps365-cli auth login --scopes "kso.user_base.read,kso.file.readwrite,kso.drive.readwrite"
```
