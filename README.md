# 日常 · 备忘与待办

面向内部人员的 Android 备忘和待办工具。应用数据保存在本机，不要求账号登录。

## 已实现

- 今日待办、逾期统计、完成状态和近期备忘
- 备忘分类、置顶、搜索、编辑和删除
- 日历月视图与按日期查看待办、备忘
- 待办日期、时间、重复周期和 Android 系统通知
- 重复待办完成后自动生成下一次；提醒在设备重启后恢复
- 本地 JSON 数据导入与导出
- Android 版本启动时检查更新，下载后交给系统安装器确认
- 离线缓存的手机界面

## 在本机预览

在项目根目录启动任意静态 HTTP 服务，例如：

```powershell
python -m http.server 4173
```

打开 `http://localhost:4173`。浏览器预览的数据存储在当前浏览器中；系统级定时通知和 APK 更新只在 Android 应用里生效。

## 构建 Android APK

使用 Android Studio 打开 `android` 目录，安装 JDK 17、Android SDK Platform 35 和 Build Tools 后同步 Gradle。也可以在安装 Gradle 8.9 的环境中运行：

```powershell
cd android
gradle assembleDebug
```

调试 APK 位于 `android/app/build/outputs/apk/debug/app-debug.apk`。正式内部分发应使用固定的签名密钥；后续版本必须沿用同一签名并递增 `versionCode`。普通 APK 更新会由 Android 系统要求用户确认。

## GitHub 构建和发布

将项目推送到 GitHub 后，`.github/workflows/android.yml` 会在普通分支构建调试 APK，并在推送 `v*` 标签时构建签名发布包、创建 GitHub Release。发布前在仓库 Secrets 中配置：

- `ANDROID_KEYSTORE_BASE64`：签名密钥文件的 Base64 内容
- `RELEASE_STORE_PASSWORD`、`RELEASE_KEY_ALIAS`、`RELEASE_KEY_PASSWORD`：签名信息
- `UPDATE_MANIFEST_URL`：应用更新清单的 HTTPS 地址

清单格式见 [android/update-manifest.example.json](android/update-manifest.example.json)。更新清单和 APK 应放在内部人员可访问的 HTTPS 地址；不要把 GitHub 私有访问令牌写进 App。递增版本号后推送标签（例如 `v1.1.0`）即可触发正式构建。由于 Android 安装包需要固定签名密钥，首次发布前必须配置签名 Secrets。
