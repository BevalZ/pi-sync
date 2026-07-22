# pi-sync

[English](./README.md) | **简体中文**

[![pi package](https://img.shields.io/badge/pi-package-blue)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![release](https://img.shields.io/github/v/release/BevalZ/pi-sync?display_name=tag&sort=semver)](https://github.com/BevalZ/pi-sync/releases)

面向 [Pi](https://github.com/earendil-works/pi-coding-agent) 的 WebDAV / S3 配置同步工具 —— 跨机器备份与恢复 **models**、**settings**、**skills**、**extensions**。

在 Pi 里输入 `/sync`，从菜单选择操作。一台机器上传，另一台下载并恢复。支持 **WebDAV**（Nextcloud、坚果云……）和 **S3 兼容**存储（AWS S3、Cloudflare R2、阿里云 OSS、MinIO……）。

<p align="center">
  <img src="docs/sync-menu.png" alt="Pi Sync 菜单" width="720" />
</p>

<p align="center"><sub><b>Pi Synchronization</b> —— 输入 <code>/sync</code> 后的交互菜单</sub></p>

## 为什么需要它

如果你在多台 PC / WSL / 服务器上使用 Pi，手工重装 models、skills、extensions 很痛苦。`pi-sync` 会把 agent 主目录打包成带时间戳的 zip，上传到云端存储，并在恢复时保留本地安全备份。

## 安装

需要 [Pi coding agent](https://github.com/earendil-works/pi-coding-agent)，兼容任意 WebDAV 或 S3 兼容存储。

```bash
pi install git:github.com/BevalZ/pi-sync
```

然后重启 Pi，或执行 `/reload`。

## 用法

在 Pi 中输入 **`/sync`**。没有命令行子命令 —— 全部通过交互菜单完成：

| 菜单项 | 作用 |
|--------|------|
| ☁️ **Upload Backup (Backup to cloud)** | 打包当前配置并上传到存储 |
| 📥 **Download Backup (Restore from cloud)** | 列出云端备份，下载并在确认后恢复 |
| ⚙️ **Configure Sync Settings** | 存储类型、凭证，以及同步范围 |
| ❌ **Cancel** | 退出菜单 |

TUI 提示：`↵` 选择 · `↑↓` 导航 · `Esc` 取消。

### 首次配置

```bash
# 1. 安装
pi install git:github.com/BevalZ/pi-sync

# 2. 打开菜单（若尚未配置存储，会先进入设置向导）
/sync

# 3. 如需修改：Configure Sync Settings
#    选择存储后端（WebDAV / S3）并填写凭证
#    建议：密码填 $PI_WEBDAV_PASS / $PI_S3_SECRET_KEY，并在 shell 中 export

# 4. 主力机 → Upload Backup (Backup to cloud)
# 5. 新机器（安装并配置后）→ Download Backup (Restore from cloud)
```

### 会同步哪些内容

| 组件 | 默认 | 说明 |
|------|------|------|
| Config | 开 | `models.json`、`settings.json`、`auth.json` |
| Skills | 开 | 整个 `~/.pi/agent/skills` |
| Extensions | 开 | `~/.pi/agent/extensions`（zip 中会排除 sync 插件自身） |

可在 **Configure Sync Settings** 中分别开关。

### 备份文件名

归档文件形如：

```text
pi_sync_backup_2026-7-14_20260714120000_windows11.zip
```

末尾的平台标签（`windows11` / `windows10` / `macos` / `linux`）标明该备份由哪类主机生成。

### 恢复时的安全机制

- 覆盖前，已有配置文件会生成带时间戳的 `.bak` 副本
- 已有 skills / extensions 目录会先改名为 `*-backup-<timestamp>`，再替换/合并
- 恢复前会展示计划，并要求确认
- 恢复成功后可选择 reload agent runtime，以应用 skills / extensions

## 新机引导（Windows，尚未安装 Pi）

若还没装 Pi，也可先用辅助脚本拉取最新 zip：

```powershell
# 优先用环境变量，避免密钥进入 shell 历史
$env:PI_WEBDAV_URL  = "https://your-webdav.example/dav/Pi"
$env:PI_WEBDAV_USER = "your-user"
$env:PI_WEBDAV_PASS = "your-app-password"
.\pi-bootstrap.ps1
```

或使用占位符一行命令（运行前请替换）：

```powershell
$url="https://your-webdav.example/dav/Pi"; $user="your-user"; $pass="your-app-password"
$pair="$user`:$pass"; $auth=[Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
$resp=Invoke-RestMethod -Uri $url -Method PROPFIND -Headers @{Authorization="Basic $auth";Depth="1"} -ContentType "application/xml"
$files=([regex]'<d:href>([^<]+)</d:href>').Matches($resp) | %{$_.Groups[1].Value} | ?{$_ -match "pi_sync_backup_.*\.zip$"} | Sort-Object -Descending
$latest=$files[0]; $name=Split-Path $latest -Leaf
Invoke-WebRequest -Uri "$url/$name" -Headers @{Authorization="Basic $auth"} -OutFile "$env:TEMP\$name"
```

之后安装 Pi，后续更新用 `/sync` → **Download Backup** 即可。

> **注意：**`pi-bootstrap.ps1` 目前仅支持 WebDAV。若使用 S3，请先安装 Pi，再通过 `/sync` 恢复。

## 安全建议

- 凭证保存在本机 `~/.pi/agent/sync_config.json`
- 优先使用**应用专用密码 / API Token**（不要用主账号密码）
- 更推荐环境变量引用：界面里密码填 `$PI_WEBDAV_PASS` 或 `$PI_S3_SECRET_KEY`，再在 shell profile 中 export
- 若开启相关选项，备份可能包含 `auth.json` / API key —— 请把云端存储当敏感数据对待
- 切勿把真实凭证提交进 git

## 故障排查

### WebDAV Backend

| 现象 | 处理 |
|------|------|
| HTTP 401 / 403 | 检查用户名密码；改用应用专用密码；确认 URL 含正确 DAV 路径 |
| PROPFIND 失败 / 列表为空 | 服务端可能禁用 PROPFIND；换 WebDAV 提供商；确认允许 Depth:1 |
| tar / zip 报错 | PATH 中需要可用的 `tar`（Windows 10+ 自带；Git Bash / WSL 亦可） |
| 恢复覆盖了本地内容 | 在 agent 目录旁查找 `*.bak-*` 与 `skills-backup-*` / `extensions-backup-*` |
| 恢复后插件不见了 | 重新执行 `pi install git:github.com/BevalZ/pi-sync` —— 归档会排除 sync 包自身 |

### S3 Backend

| 现象 | 处理 |
|------|------|
| HTTP 403 / SignatureDoesNotMatch | 检查 Endpoint URL 格式；核对 Access Key / Secret Key；确认 region 正确（R2 用 `auto`） |
| 列表为空 | 核对 bucket 名称和 S3 Path 前缀；确认 IAM / API Token 包含 `s3:ListBucket` 权限 |

## 目录结构

```text
pi-sync/
  package.json
  LICENSE
  README.md
  README.zh-CN.md
  pi-bootstrap.ps1
  docs/
    sync-menu.png          # /sync 菜单截图
  extensions/
    sync/
      index.ts             # /sync 命令
      storage.ts           # 存储接口 + 工厂
      storage-webdav.ts    # WebDAV 后端
      storage-s3.ts        # S3 后端（AWS SigV4，零依赖）
    _shared/
      json-io.ts
      enhanced-select.ts
      spawn.ts
      fetch-utils.ts
      box-drawing.ts
```

## 更新日志

### v1.1.0

- 新增 **S3 兼容存储**后端（AWS S3、Cloudflare R2、阿里云 OSS、MinIO……）
  - AWS Signature V4 签名，零 npm 依赖
  - 设置向导和配置菜单中可选择存储类型
  - 支持 S3 Path 嵌套目录（如 `backup/xxx/pi/`）
- 重构存储层：`storage.ts` 接口 + `storage-webdav.ts` / `storage-s3.ts` 后端

### v1.0.1

- 备份 zip 文件名增加主机平台标签（`windows11` / `macos` / `linux` 等）
- 从 bootstrap 脚本示例中移除真实凭证
- 增加 MIT `LICENSE`，扩充 README（安全、恢复保护、故障排查、菜单截图）

### v1.0.0

- 首次公开发布：基于 WebDAV 的交互式 `/sync` 菜单
  - Upload Backup · Download Backup · Configure Sync Settings
- Windows 新机引导脚本

## 许可证

MIT — 见 [LICENSE](./LICENSE)。

## 致谢

本开源项目已链接并获 [LINUX DO](https://linux.do) 社区认可。
