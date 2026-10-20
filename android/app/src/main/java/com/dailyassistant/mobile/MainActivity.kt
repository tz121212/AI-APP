package com.dailyassistant.mobile

import android.Manifest
import android.app.Activity
import android.app.AlarmManager
import android.app.AlertDialog
import android.app.DownloadManager
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.webkit.WebViewAssetLoader
import java.text.SimpleDateFormat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var assetLoader: WebViewAssetLoader
    private val worker = Executors.newSingleThreadExecutor()
    private var pendingInstallId: Long? = null
    @Volatile private var pendingBackup: String? = null
    private var legacyStorageInjectionInProgress = false
    private var exactAlarmsPreviouslyAllowed = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.rgb(244, 247, 245)
        window.navigationBarColor = Color.WHITE
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            window.decorView.systemUiVisibility = android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
        }
        createReminderChannel(this)
        assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = true
            settings.allowContentAccess = true
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    assetLoader.shouldInterceptRequest(request.url)

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                    request.url.host != APP_ASSET_HOST

                override fun onPageFinished(view: WebView, url: String) {
                    super.onPageFinished(view, url)
                    if (url == APP_URL) injectLegacyStorageIfNeeded()
                }
            }
            webChromeClient = WebChromeClient()
            addJavascriptInterface(AppBridge(), "AndroidBridge")
        }
        setContentView(webView)
        loadApp()
        handleInstallIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val alarmManager = getSystemService(AlarmManager::class.java)
            val allowed = alarmManager.canScheduleExactAlarms()
            if (allowed && !exactAlarmsPreviouslyAllowed) ReminderScheduler.rescheduleAll(this)
            exactAlarmsPreviouslyAllowed = allowed
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_NOTIFICATIONS) return
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) requestExactAlarmAccess()
        else toastToWeb("未开启通知权限，待办闹钟无法显示")
    }

    private fun requestExactAlarmAccess() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        val alarmManager = getSystemService(AlarmManager::class.java)
        if (alarmManager.canScheduleExactAlarms()) return
        try {
            startActivity(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM).setData(Uri.parse("package:$packageName")))
        } catch (_: Exception) {
            toastToWeb("请在系统设置中允许精确闹钟，当前将使用普通定时提醒")
        }
    }

    private fun loadApp() {
        val migrated = getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            .getBoolean(KEY_WEB_STORAGE_MIGRATED, false)
        webView.loadUrl(if (migrated) APP_URL else LEGACY_MIGRATION_URL)
    }

    private fun injectLegacyStorageIfNeeded() {
        if (legacyStorageInjectionInProgress) return
        val preferences = getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        val data = preferences.getString(KEY_LEGACY_STORAGE_DATA, null) ?: return
        legacyStorageInjectionInProgress = true
        webView.evaluateJavascript(
            "localStorage.setItem('daily-assistant-data-v1', ${JSONObject.quote(data)}); true;"
        ) {
            preferences.edit().remove(KEY_LEGACY_STORAGE_DATA).apply()
            legacyStorageInjectionInProgress = false
            webView.reload()
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleInstallIntent(intent)
    }

    @Deprecated("Deprecated in Android, kept for the system document picker result")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (resultCode != RESULT_OK) {
            pendingBackup = null
            return
        }
        val uri = data?.data ?: return
        when (requestCode) {
            REQUEST_SAVE_BACKUP -> {
                val content = pendingBackup ?: return
                pendingBackup = null
                try {
                    contentResolver.openOutputStream(uri)?.bufferedWriter()?.use { it.write(content) }
                    toastToWeb("备份文件已导出")
                } catch (_: Exception) {
                    toastToWeb("无法写入备份文件")
                }
            }
            REQUEST_IMPORT_BACKUP -> {
                try {
                    val content = contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() } ?: return
                    webView.evaluateJavascript("window.importBackupJson && window.importBackupJson(${JSONObject.quote(content)})", null)
                } catch (_: Exception) {
                    toastToWeb("无法读取备份文件")
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        val downloadId = pendingInstallId ?: return
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || packageManager.canRequestPackageInstalls()) {
            pendingInstallId = null
            installDownloadedUpdate(downloadId)
        }
    }

    override fun onDestroy() {
        worker.shutdownNow()
        if (::webView.isInitialized) webView.destroy()
        super.onDestroy()
    }

    private fun handleInstallIntent(intent: Intent?) {
        val downloadId = intent?.getLongExtra(EXTRA_INSTALL_DOWNLOAD_ID, -1L) ?: -1L
        if (downloadId > 0) installDownloadedUpdate(downloadId)
    }

    private fun installDownloadedUpdate(downloadId: Long) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !packageManager.canRequestPackageInstalls()) {
            pendingInstallId = downloadId
            startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName")))
            toastToWeb("请允许此应用安装更新包，然后返回应用")
            return
        }
        val downloadManager = getSystemService(DOWNLOAD_SERVICE) as DownloadManager
        val apkUri = downloadManager.getUriForDownloadedFile(downloadId)
        if (apkUri == null) {
            toastToWeb("更新包暂不可用，请重新检查更新")
            return
        }
        val installIntent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(apkUri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        try {
            startActivity(installIntent)
        } catch (_: Exception) {
            toastToWeb("无法打开系统安装程序")
        }
    }

    private fun checkForUpdates() {
        val manifestUrl = BuildConfig.UPDATE_MANIFEST_URL.trim()
        if (manifestUrl.isEmpty()) {
            toastToWeb("更新服务尚未配置")
            return
        }
        toastToWeb("正在检查更新")
        worker.execute {
            try {
                val connection = URL(manifestUrl).openConnection() as HttpURLConnection
                connection.connectTimeout = 8000
                connection.readTimeout = 8000
                connection.requestMethod = "GET"
                val data = connection.inputStream.bufferedReader().use { it.readText() }
                connection.disconnect()
                val manifest = JSONObject(data)
                val latestCode = manifest.optLong("versionCode", -1L)
                val currentCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    packageManager.getPackageInfo(packageName, 0).longVersionCode
                } else {
                    @Suppress("DEPRECATION")
                    packageManager.getPackageInfo(packageName, 0).versionCode.toLong()
                }
                if (latestCode <= currentCode) {
                    toastToWeb("当前已是最新版本")
                    return@execute
                }
                val versionName = manifest.optString("versionName", "新版本")
                val apkUrl = manifest.optString("apkUrl", "")
                val changelog = manifest.optString("changelog", "修复问题并改进使用体验")
                if (apkUrl.isBlank() || !apkUrl.startsWith("https://")) throw IllegalArgumentException("更新包地址无效")
                runOnUiThread {
                    AlertDialog.Builder(this)
                        .setTitle("发现新版本 $versionName")
                        .setMessage(changelog)
                        .setNegativeButton("稍后") { dialog, _ -> dialog.dismiss() }
                        .setPositiveButton("下载更新") { _, _ -> downloadUpdate(apkUrl, versionName) }
                        .show()
                }
            } catch (error: Exception) {
                toastToWeb("检查更新失败：${error.message ?: "网络不可用"}")
            }
        }
    }

    private fun downloadUpdate(apkUrl: String, versionName: String) {
        try {
            val request = DownloadManager.Request(Uri.parse(apkUrl))
                .setTitle("日常 $versionName")
                .setDescription("正在下载内部更新")
                .setMimeType("application/vnd.android.package-archive")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, "daily-assistant-update.apk")
            val id = (getSystemService(DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
            toastToWeb("更新包已加入下载")
        } catch (_: Exception) {
            toastToWeb("无法开始下载更新包")
        }
    }

    private fun toastToWeb(message: String) {
        runOnUiThread {
            Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
            if (::webView.isInitialized) webView.evaluateJavascript("window.onUpdateStatus && window.onUpdateStatus(${JSONObject.quote(message)})", null)
        }
    }

    inner class AppBridge {
        @JavascriptInterface
        fun getAppVersion(): String = try {
            packageManager.getPackageInfo(packageName, 0).versionName ?: "1.0.0"
        } catch (_: Exception) {
            "1.0.0"
        }

        @JavascriptInterface
        fun scheduleReminder(id: String, title: String, body: String, triggerAt: Long, repeat: String) {
            ReminderScheduler.schedule(this@MainActivity, id, title, body, triggerAt, repeat)
        }

        @JavascriptInterface
        fun cancelReminder(id: String) {
            ReminderScheduler.cancel(this@MainActivity, id)
        }

        @JavascriptInterface
        fun requestNotificationPermission() {
            runOnUiThread {
                if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
                } else {
                    requestExactAlarmAccess()
                    toastToWeb("通知权限已开启")
                }
            }
        }

        @JavascriptInterface
        fun checkForUpdates() = this@MainActivity.checkForUpdates()

        @JavascriptInterface
        fun isUpdateConfigured(): Boolean = BuildConfig.UPDATE_MANIFEST_URL.isNotBlank()

        @JavascriptInterface
        fun saveBackup(content: String) {
            runOnUiThread {
                pendingBackup = content
                val filename = "日常备忘备份-${SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()).format(Date())}.json"
                val picker = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "application/json"
                    putExtra(Intent.EXTRA_TITLE, filename)
                }
                startActivityForResult(picker, REQUEST_SAVE_BACKUP)
            }
        }

        @JavascriptInterface
        fun requestImportBackup() {
            runOnUiThread {
                val picker = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "application/json"
                }
                startActivityForResult(picker, REQUEST_IMPORT_BACKUP)
            }
        }

        @JavascriptInterface
        fun completeLegacyStorageMigration(data: String?) {
            val preferences = getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit()
                .putBoolean(KEY_WEB_STORAGE_MIGRATED, true)
            if (!data.isNullOrBlank()) preferences.putString(KEY_LEGACY_STORAGE_DATA, data)
            preferences.apply()
            runOnUiThread { webView.loadUrl(APP_URL) }
        }
    }

    companion object {
        const val CHANNEL_ID = "daily_alarm_reminders_v2"
        const val UPDATE_CHANNEL_ID = "daily_update_downloads"
        const val EXTRA_TASK_ID = "task_id"
        const val EXTRA_TASK_TITLE = "task_title"
        const val EXTRA_TASK_BODY = "task_body"
        const val EXTRA_REPEAT = "repeat"
        const val EXTRA_INSTALL_DOWNLOAD_ID = "install_download_id"
        const val REQUEST_NOTIFICATIONS = 3401
        const val REQUEST_SAVE_BACKUP = 3402
        const val REQUEST_IMPORT_BACKUP = 3403
        private const val PREFERENCES = "daily_assistant_web_storage"
        private const val KEY_WEB_STORAGE_MIGRATED = "web_storage_migrated"
        private const val KEY_LEGACY_STORAGE_DATA = "legacy_storage_data"
        private const val APP_ASSET_HOST = "appassets.androidplatform.net"
        private const val APP_URL = "https://appassets.androidplatform.net/assets/web/index.html"
        private const val LEGACY_MIGRATION_URL = "file:///android_asset/web/index.html?migrate-storage=1"

        fun createReminderChannel(context: Context) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val manager = context.getSystemService(NotificationManager::class.java)
                val channel = android.app.NotificationChannel(CHANNEL_ID, "待办闹钟", android.app.NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "日常待办到期闹钟提醒"
                    setSound(null, null)
                    enableVibration(true)
                    vibrationPattern = longArrayOf(0, 500, 300, 500, 300, 1000)
                }
                manager.createNotificationChannel(channel)
            }
        }

        fun createUpdateChannel(context: Context) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val manager = context.getSystemService(NotificationManager::class.java)
                val channel = android.app.NotificationChannel(UPDATE_CHANNEL_ID, "应用更新", android.app.NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "应用更新包下载完成提醒"
                }
                manager.createNotificationChannel(channel)
            }
        }
    }
}
