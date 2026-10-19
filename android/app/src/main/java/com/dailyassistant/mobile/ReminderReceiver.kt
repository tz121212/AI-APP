package com.dailyassistant.mobile

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val taskId = intent.getStringExtra(MainActivity.EXTRA_TASK_ID) ?: return
        val title = intent.getStringExtra(MainActivity.EXTRA_TASK_TITLE) ?: "待办提醒"
        val body = intent.getStringExtra(MainActivity.EXTRA_TASK_BODY) ?: "有一项待办需要处理"
        MainActivity.createReminderChannel(context)

        val openApp = PendingIntent.getActivity(
            context,
            taskId.hashCode() and 0x7fffffff,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0
        )
        val notification = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(context, MainActivity.CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(context)
        }.setSmallIcon(android.R.drawable.ic_menu_my_calendar)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(openApp)
            .build()

        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(taskId.hashCode(), notification)
        ReminderScheduler.scheduleNext(context, intent)
    }
}
