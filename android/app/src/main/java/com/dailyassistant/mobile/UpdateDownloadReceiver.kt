package com.dailyassistant.mobile

import android.app.DownloadManager
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

class UpdateDownloadReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val downloadId = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L)
        if (downloadId <= 0L) return
        val manager = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        val query = DownloadManager.Query().setFilterById(downloadId)
        var status = DownloadManager.STATUS_FAILED
        var reason = 0
        manager.query(query).use { cursor ->
            if (!cursor.moveToFirst()) return
            status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
            reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON))
        }

        MainActivity.createUpdateChannel(context)
        if (status != DownloadManager.STATUS_SUCCESSFUL) {
            val message = when (status) {
                DownloadManager.STATUS_PAUSED -> "更新下载已暂停"
                DownloadManager.STATUS_PENDING -> "更新下载未开始"
                else -> "更新下载失败"
            }
            val detail = if (reason > 0) reasonText(reason) else "下载未能完成，请检查网络和手机存储空间后重试"
            notifyFailure(context, message, detail)
            return
        }
        val install = Intent(context, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            putExtra(MainActivity.EXTRA_INSTALL_DOWNLOAD_ID, downloadId)
        }
        val pending = PendingIntent.getActivity(
            context,
            downloadId.toInt(),
            install,
            PendingIntent.FLAG_UPDATE_CURRENT or if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0
        )
        val notification = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(context, MainActivity.UPDATE_CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(context)
        }.setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle("更新包已下载")
            .setContentText("点击安装日常新版本")
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(downloadId.toInt(), notification)
    }

    companion object {
        fun notifyFailure(context: Context, title: String, detail: String) {
            MainActivity.createUpdateChannel(context)
            val notification = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(context, MainActivity.UPDATE_CHANNEL_ID)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(context)
            }.setSmallIcon(android.R.drawable.stat_notify_error)
                .setContentTitle(title)
                .setContentText(detail)
                .setAutoCancel(true)
                .build()
            (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .notify((System.currentTimeMillis() and 0x7fffffff).toInt(), notification)
        }

        private fun reasonText(reason: Int): String = when (reason) {
            DownloadManager.ERROR_CANNOT_RESUME -> "下载无法继续，请重试"
            DownloadManager.ERROR_DEVICE_NOT_FOUND -> "找不到下载存储位置"
            DownloadManager.ERROR_FILE_ALREADY_EXISTS -> "下载文件已存在，请重新检查更新"
            DownloadManager.ERROR_FILE_ERROR -> "无法写入下载文件"
            DownloadManager.ERROR_HTTP_DATA_ERROR -> "服务器返回数据错误"
            DownloadManager.ERROR_INSUFFICIENT_SPACE -> "手机存储空间不足"
            DownloadManager.ERROR_TOO_MANY_REDIRECTS -> "下载地址重定向次数过多"
            DownloadManager.ERROR_UNHANDLED_HTTP_CODE -> "服务器不支持此下载请求"
            DownloadManager.ERROR_UNKNOWN -> "请检查网络后重试"
            else -> "请检查网络、存储空间后重试（错误码 $reason）"
        }
    }
}
