package com.dailyassistant.mobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val taskId = intent.getStringExtra(MainActivity.EXTRA_TASK_ID) ?: return
        val title = intent.getStringExtra(MainActivity.EXTRA_TASK_TITLE) ?: "待办提醒"
        val body = intent.getStringExtra(MainActivity.EXTRA_TASK_BODY) ?: "有一项待办需要处理"
        val alarm = intent.getBooleanExtra(MainActivity.EXTRA_ALARM, true)
        if (alarm) {
            MainActivity.createReminderChannel(context)
            val serviceIntent = Intent(context, AlarmRingingService::class.java).apply {
                putExtra(MainActivity.EXTRA_TASK_ID, taskId)
                putExtra(MainActivity.EXTRA_TASK_TITLE, title)
                putExtra(MainActivity.EXTRA_TASK_BODY, body)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(serviceIntent)
            else context.startService(serviceIntent)
        } else {
            MainActivity.postTaskMessageNotification(context, taskId, title, body)
        }
        ReminderScheduler.scheduleNext(context, intent)
    }
}
