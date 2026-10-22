# 日常 · 备忘与待办

面向内部人员的 Android 备忘和待办工具。应用数据保存在本机，不要求账号登录。

## 已实现

- 今日待办、逾期统计、完成状态和近期备忘
- 备忘分类、置顶、搜索、编辑和删除
- 日历月视图、按日期查看待办与备忘，并支持“军/震”两人休息排班
- 待办日期、时间、重复周期；未勾选闹钟时发送持续的通知栏消息，勾选后播放循环系统闹铃
- 重复待办完成后自动生成下一次；提醒在设备重启后恢复
- 本地 JSON 数据导入与导出
- Android 版本启动时检查更新；系统 DownloadManager 在通知栏显示下载进度，完成或失败时发送结果通知，下载完成后交给系统安装器确认
- 离线缓存的手机界面
- 腾讯云开发 CloudBase PostgreSQL 共享“军/震”休息排班；备忘与待办仍保存在本机
- 待办普通消息和闹钟提醒都会持续保留到待办完成或取消；闹钟提醒由前台服务播放铃声
- 已完成或已过期超过一个月的历史待办，以及超过一个月未编辑的备忘，会自动清理；未安排日期的待办保留

## 在本机预览

在项目根目录启动任意静态 HTTP 服务，例如：

```powershell
python -m http.server 4173
```

打开 `http://localhost:4173`。浏览器预览的数据存储在当前浏览器中；系统级定时通知和 APK 更新只在 Android 应用里生效。

## 配置排班同步

1. 在 `cloudbase-config.js` 填入 CloudBase PostgreSQL 环境 ID、地域代码和客户端 Publishable Key；Android 打包会自动从构建环境注入 Key。
2. 使用已登录的 CloudBase CLI 运行 `tcb db pg migration up -e <环境ID>`，应用 `cloudbase/migrations` 中的排班表和共享权限迁移。
3. 安装新版 APK 后打开应用即可同步，无需用户名、密码或短信验证码。“设置与备份 → 排班同步”显示连接状态，也可点击“立即同步”。

客户端通过 CloudBase JS SDK 3.10.3 的 `app.rdb()` 直接使用 Publishable Key 的 `anon` 权限读写排班，不调用登录接口。SDK 使用内存会话配置，避免旧版缓存的失效账号会话影响免登录访问。本机 Android 构建从 Git 忽略的 `.env.local` 读取 `VITE_PUBLISHABLE_KEY`；GitHub Actions 使用同名 Secret。客户端不包含账号密码、管理 API Key 或 service role 密钥。

Android 的排班请求通过异步原生 HTTPS 桥接发送到官方 PostgreSQL REST API，避免免费套餐不允许添加 WebView 安全域名导致的 CORS 拦截。桥接只接受当前环境排班表的 GET/POST 请求，使用 Publishable Key，保留服务端 HTTP 状态和错误详情。浏览器预览继续使用 SDK 默认网络传输。

所有 App 设备使用固定共享组 `daily-assistant-internal-shared`。数据库仍启用 RLS，仅允许 `anon` 和 `authenticated` 读写该组的排班；表约束限制人员为“军/震”。迁移将原账号排班复制到共享组，同一日期同一人的冲突保留服务端更新时间较新的记录，原账号记录保留在表内但不通过新共享策略暴露。按产品要求，获得 App 客户端配置的设备都能读写共享排班。

当前 CloudBase PostgreSQL Realtime 尚未正式上线，App 在前台约每 5 秒查询一次，回到前台立即查询；后台挂起时不保证即时更新。断网修改会保存在本机队列，网络恢复后自动重试。首次连接会合并本机已有休息排班。备忘和待办只保存在本机。

项目使用 Kotlin 编写 Android 原生容器，界面和业务交互使用 HTML、CSS、JavaScript，WebView 负责承载界面，Gradle Kotlin DSL 负责 Android 构建。

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
