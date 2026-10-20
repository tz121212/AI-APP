# 日常 · 备忘与待办

面向内部人员的 Android 备忘和待办工具。应用数据保存在本机，不要求账号登录。

## 已实现

- 今日待办、逾期统计、完成状态和近期备忘
- 备忘分类、置顶、搜索、编辑和删除
- 日历月视图、按日期查看待办与备忘，并支持“军/震”两人休息排班
- 待办日期、时间、重复周期，以及可单独开关的 Android 闹钟通知
- 重复待办完成后自动生成下一次；提醒在设备重启后恢复
- 本地 JSON 数据导入与导出
- Android 版本启动时检查更新，下载后交给系统安装器确认
- 离线缓存的手机界面
- 腾讯云开发 CloudBase PostgreSQL 共享“军/震”休息排班；备忘与待办仍保存在本机
- 待办可设置带系统闹钟铃声的提醒，通知会持续保留到待办完成或取消
- 已完成或已过期超过一个月的历史待办，以及超过一个月未编辑的备忘，会自动清理；未安排日期的待办保留

## 在本机预览

在项目根目录启动任意静态 HTTP 服务，例如：

```powershell
python -m http.server 4173
```

打开 `http://localhost:4173`。浏览器预览的数据存储在当前浏览器中；系统级定时通知和 APK 更新只在 Android 应用里生效。

## 配置排班同步

1. 在 `cloudbase-config.js` 填入 CloudBase PostgreSQL 环境 ID 和地域代码。
2. 在 CloudBase 身份认证中启用用户名密码登录，并为内部共享账号设置用户名。两台手机使用同一个用户名和密码；不要把密码写进代码或提交到 GitHub。
3. 在 CloudBase CLI 已登录的环境中运行 `tcb db pg migration up -e <环境ID>`，应用 `cloudbase/migrations` 中的排班表和权限迁移。
4. 安装新的 APK，在两台设备的“设置与备份 → 排班同步”中使用共享账号连接。

本机 Android 构建从未提交的 `.env.local` 读取 `VITE_PUBLISHABLE_KEY`。GitHub Actions 构建需要在仓库 Settings → Secrets and variables → Actions 中添加同名 Secret。此 publishable key 会随 Android 客户端发布，只用于初始化 SDK；排班表另由账号会话和 RLS 隔离。

客户端通过 CloudBase SDK 的用户名密码认证和 PostgreSQL `app.rdb()` 读写排班表，认证请求固定走环境所在地域的 Cloud API，以兼容 Android WebView 的跨域限制。当前 CloudBase PostgreSQL Realtime 尚未正式上线，因此 App 在前台约每 5 秒查询一次，回到前台时立即查询；后台挂起时不保证即时更新。登录密码不会保存，CloudBase SDK 会在本机维护登录会话。首次连接时，本机已有的休息排班会合并到云端。备忘和待办仍只保存在本机。

CloudBase SDK 更新或修改 `cloudbase-entry.js` 后，运行 `npm ci` 和 `npm run build:cloudbase` 重新生成本地 SDK 资源，再构建 Android APK。GitHub Actions 会验证同步逻辑并重新打包 SDK。

## 构建 Android APK

使用 Android Studio 打开 `android` 目录，安装 JDK 17、Android SDK Platform 35 和 Build Tools 后同步 Gradle。也可以在安装 Gradle 8.9 的环境中运行：

```powershell
cd android
gradle assembleDebug
```

调试 APK 位于 `android/app/build/outputs/apk/debug/app-debug.apk`。正式内部分发应使用固定的签名密钥；后续版本必须沿用同一签名并递增 `versionCode`。普通 APK 更新会由 Android 系统要求用户确认。

## GitHub 构建和发布

推送普通分支会自动构建调试 APK，文件可在 GitHub 仓库的 Actions 运行记录中下载。正式安装和后续覆盖更新请使用签名发布包。首次发布前，在 GitHub 仓库的 **Settings → Secrets and variables → Actions** 添加以下 Secrets：

- `ANDROID_KEYSTORE_BASE64`：签名密钥文件的 Base64 内容
- `RELEASE_STORE_PASSWORD`、`RELEASE_KEY_ALIAS`、`RELEASE_KEY_PASSWORD`：签名信息

只生成一次长期签名密钥，并妥善备份；后续版本必须使用同一密钥，否则 Android 不允许覆盖安装。安装 JDK 17 后，在项目目录执行以下命令生成密钥：

```powershell
keytool -genkeypair -v -storetype PKCS12 -keystore daily-assistant-release.p12 -alias daily-assistant -keyalg RSA -keysize 2048 -validity 10000
[Convert]::ToBase64String([IO.File]::ReadAllBytes((Resolve-Path .\daily-assistant-release.p12)))
```

将第二条命令输出的 Base64 内容设为 `ANDROID_KEYSTORE_BASE64`，并把生成时设置的密钥库密码、别名 `daily-assistant` 和密钥密码分别设为上述 Secrets。不要将密钥文件或密码提交到 GitHub。示例清单见 [android/update-manifest.example.json](android/update-manifest.example.json)。

本仓库的签名 Secrets 已完成初始化。本机密钥备份为 `daily-assistant-release.p12`，密码备份为 `daily-assistant-release-password.dpapi`；两者均被 Git 忽略。密码备份受当前 Windows 账户保护。请保留并妥善备份这两个文件，不要重新生成签名密钥，否则已安装的 App 将无法覆盖更新。

首次配置 Secrets 后，推送版本标签即可构建 APK 并创建 Release：

```powershell
git tag v1.0.1
git push origin v1.0.1
```

手机可从 [最新 APK](https://github.com/tz121212/AI-APP/releases/latest/download/app-release.apk) 下载并安装。App 内的“检查更新”会读取最新 Release 附带的清单，发现新版本后下载 APK 并交给 Android 系统确认安装。以后将版本标签递增为 `v1.0.2`、`v1.1.0` 等即可发布更新；Android 仍会要求用户确认安装。
