package com.dailyassistant.mobile

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

class AlarmRingingService : Service() {
    private var mediaPlayer: MediaPlayer? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var taskId: String? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val id = intent?.getStringExtra(MainActivity.EXTRA_TASK_ID)
        if (intent?.action == ACTION_STOP) {
            taskId = id ?: taskId
            stopRinging()
            taskId?.let { id ->
                val stoppedNotification = buildNotification(id, "已停止响铃，请处理待办", null)
                getSystemService(android.app.NotificationManager::class.java).notify(ReminderScheduler.notificationId(id), stoppedNotification)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_DETACH)
            stopSelfResult(startId)
            return START_NOT_STICKY
        }

        if (id.isNullOrBlank()) {
            stopSelf(startId)
            return START_NOT_STICKY
        }

        taskId = id
        val title = intent.getStringExtra(MainActivity.EXTRA_TASK_TITLE) ?: "待办闹钟"
        val body = intent.getStringExtra(MainActivity.EXTRA_TASK_BODY) ?: "有一项待办需要处理"
        MainActivity.createReminderChannel(this)
        startForeground(ReminderScheduler.notificationId(id), buildNotification(id, "$body\n闹钟正在响铃", title))
        startRinging()
        return START_NOT_STICKY
    }

    private fun buildNotification(id: String, body: String, titleOverride: String?): Notification {
        val title = titleOverride ?: getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getString(id, null)
            ?.let { runCatching { org.json.JSONObject(it).optString("title") }.getOrNull() }
            ?.takeIf { it.isNotBlank() } ?: "待办闹钟"
        val openApp = PendingIntent.getActivity(
            this,
            ReminderScheduler.notificationId(id),
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0
        )
        val stopIntent = Intent(this, AlarmRingingService::class.java).apply {
            action = ACTION_STOP
            putExtra(MainActivity.EXTRA_TASK_ID, id)
        }
        val stopPending = PendingIntent.getService(
            this,
            ReminderScheduler.notificationId(id),
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, MainActivity.CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }.setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_ALARM)
            .setPriority(Notification.PRIORITY_HIGH)
            .setContentIntent(openApp)

        if (titleOverride != null) builder.addAction(android.R.drawable.ic_media_pause, "停止响铃", stopPending)
        return builder.build()
    }

    private fun startRinging() {
        stopRinging()
        val powerManager = getSystemService(PowerManager::class.java)
        wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:todo-alarm").apply {
            setReferenceCounted(false)
            acquire()
        }
        try {
            val sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
            mediaPlayer = MediaPlayer().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build()
                )
                setDataSource(this@AlarmRingingService, sound)
                isLooping = true
                prepare()
                start()
            }
        } catch (_: Exception) {
            stopRinging()
        }
    }

    private fun stopRinging() {
        runCatching { mediaPlayer?.stop() }
        runCatching { mediaPlayer?.release() }
        mediaPlayer = null
        runCatching { if (wakeLock?.isHeld == true) wakeLock?.release() }
        wakeLock = null
    }

    override fun onDestroy() {
        stopRinging()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val ACTION_STOP = "com.dailyassistant.mobile.action.STOP_ALARM"
        private const val PREFERENCES = "daily_reminders"
    }
}
