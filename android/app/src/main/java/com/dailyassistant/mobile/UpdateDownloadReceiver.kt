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
        manager.query(query).use { cursor ->
            if (!cursor.moveToFirst()) return
            val status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
            if (status != DownloadManager.STATUS_SUCCESSFUL) return
        }

        MainActivity.createReminderChannel(context)
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
            Notification.Builder(context, MainActivity.CHANNEL_ID)
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
}
