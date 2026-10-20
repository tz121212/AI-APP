package com.dailyassistant.mobile

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import org.json.JSONObject

object ReminderScheduler {
    fun schedule(context: Context, id: String, title: String, body: String, triggerAt: Long, repeat: String) {
        val manager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pending = reminderIntent(context, id, title, body, repeat)
        val trigger = maxOf(triggerAt, System.currentTimeMillis() + 1000)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && manager.canScheduleExactAlarms()) {
            manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, trigger, pending)
        } else {
            manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, trigger, pending)
        }
        val saved = JSONObject().apply {
            put("id", id)
            put("title", title)
            put("body", body)
            put("triggerAt", triggerAt)
            put("repeat", repeat)
        }
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().putString(id, saved.toString()).apply()
    }

    fun cancel(context: Context, id: String) {
        val manager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pending = PendingIntent.getBroadcast(context, id.hashCode() and 0x7fffffff, Intent(context, ReminderReceiver::class.java), flags())
        manager.cancel(pending)
        pending.cancel()
        (context.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager).cancel(notificationId(id))
        context.stopService(Intent(context, AlarmRingingService::class.java).putExtra(MainActivity.EXTRA_TASK_ID, id))
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().remove(id).apply()
    }

    fun removeSaved(context: Context, id: String) {
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().remove(id).apply()
    }

    fun rescheduleAll(context: Context) {
        val reminders = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).all.values.filterIsInstance<String>()
        reminders.forEach { value ->
            try {
                val reminder = JSONObject(value)
                schedule(context, reminder.getString("id"), reminder.optString("title"), reminder.optString("body"), reminder.getLong("triggerAt"), reminder.optString("repeat", "none"))
            } catch (_: Exception) {
                // Ignore invalid persisted reminder data and continue restoring the rest.
            }
        }
    }

    fun scheduleNext(context: Context, intent: Intent) {
        val repeat = intent.getStringExtra(MainActivity.EXTRA_REPEAT) ?: "none"
        if (repeat == "none") {
            intent.getStringExtra(MainActivity.EXTRA_TASK_ID)?.let { removeSaved(context, it) }
            return
        }
        val calendar = java.util.Calendar.getInstance().apply {
            timeInMillis = System.currentTimeMillis()
            when (repeat) {
                "daily" -> add(java.util.Calendar.DAY_OF_MONTH, 1)
                "weekly" -> add(java.util.Calendar.DAY_OF_MONTH, 7)
                "monthly" -> add(java.util.Calendar.MONTH, 1)
                else -> return
            }
        }
        schedule(
            context,
            intent.getStringExtra(MainActivity.EXTRA_TASK_ID) ?: return,
            intent.getStringExtra(MainActivity.EXTRA_TASK_TITLE) ?: "待办提醒",
            intent.getStringExtra(MainActivity.EXTRA_TASK_BODY) ?: "有一项待办需要处理",
            calendar.timeInMillis,
            repeat
        )
    }

    private fun reminderIntent(context: Context, id: String, title: String, body: String, repeat: String): PendingIntent {
        val intent = Intent(context, ReminderReceiver::class.java).apply {
            putExtra(MainActivity.EXTRA_TASK_ID, id)
            putExtra(MainActivity.EXTRA_TASK_TITLE, title)
            putExtra(MainActivity.EXTRA_TASK_BODY, body)
            putExtra(MainActivity.EXTRA_REPEAT, repeat)
        }
        return PendingIntent.getBroadcast(context, id.hashCode() and 0x7fffffff, intent, flags())
    }

    private fun flags(): Int = PendingIntent.FLAG_UPDATE_CURRENT or if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0

    fun notificationId(id: String): Int = (id.hashCode() and 0x7fffffff).coerceAtLeast(1)

    private const val PREFERENCES = "daily_reminders"
}
