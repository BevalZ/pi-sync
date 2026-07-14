# pi-sync promotion drafts

Repo: https://github.com/BevalZ/pi-sync  
Install: `pi install git:github.com/BevalZ/pi-sync`  
Release: https://github.com/BevalZ/pi-sync/releases/tag/v1.0.1

---

## English (short)

**pi-sync** — WebDAV backup/restore for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).

Open `/sync`, then **Upload Backup** on one machine and **Download Backup** on another.

```bash
pi install git:github.com/BevalZ/pi-sync
/sync   # main machine  → Upload Backup (Backup to cloud)
/sync   # new machine   → Download Backup (Restore from cloud)
```

Works with any WebDAV (Nextcloud, 坚果云, TeraCLOUD, self-hosted). Restore keeps local `.bak` copies. MIT.

👉 https://github.com/BevalZ/pi-sync

---

## English (Discord / forum)

Hey Pi users — I open-sourced **pi-sync**, a small package that syncs your Pi agent home over WebDAV.

Problem: multi-machine setups mean re-copying `models.json`, skills, and extensions by hand.  
Solution: `/sync push` on the main box, `/sync pull` on the next one.

- Install: `pi install git:github.com/BevalZ/pi-sync`
- Interactive menu: Upload Backup · Download Backup · Configure Sync Settings
- Optional Windows bootstrap script for brand-new machines
- Backup zips tagged by platform (`windows11`, `macos`, …)
- Restore confirms and keeps timestamped local backups

Feedback / issues welcome: https://github.com/BevalZ/pi-sync

---

## 中文（短）

**pi-sync**：给 [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) 用的 WebDAV 配置同步插件。

多机之间一键备份 / 恢复 models、settings、skills、extensions。

```bash
pi install git:github.com/BevalZ/pi-sync
/sync   # 主力机 → Upload Backup (Backup to cloud)
/sync   # 新机器 → Download Backup (Restore from cloud)
```

支持任意 WebDAV（坚果云 / Nextcloud / 自建）。恢复前会做本地备份。MIT 开源。

👉 https://github.com/BevalZ/pi-sync

---

## 中文（朋友圈 / 社区）

换电脑重装 Pi 配置太烦？我做了个小工具 **pi-sync** 并开源了。

- 主力机 `/sync` → **Upload Backup** 把配置打成 zip 传到 WebDAV
- 新机器 `/sync` → **Download Backup** 选择备份并还原
- 覆盖 models / settings / skills / extensions
- 恢复前自动留本地备份，密码建议用应用专用密码 + 环境变量

安装一行：

```bash
pi install git:github.com/BevalZ/pi-sync
```

仓库：https://github.com/BevalZ/pi-sync  
Release：https://github.com/BevalZ/pi-sync/releases/tag/v1.0.1

欢迎试用和提 issue。

---

## Tweet / X (EN)

Multi-machine Pi setup? I open-sourced pi-sync:

`/sync` → Upload Backup → WebDAV  
`/sync` → Download Backup → new machine

models · settings · skills · extensions

`pi install git:github.com/BevalZ/pi-sync`

https://github.com/BevalZ/pi-sync
