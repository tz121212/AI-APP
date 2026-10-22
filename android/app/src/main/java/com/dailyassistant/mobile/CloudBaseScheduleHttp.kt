package com.dailyassistant.mobile

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale

/** Anonymous schedule access only; no auth endpoint or arbitrary URL proxy. */
class CloudBaseScheduleHttp(private val publishableKey: String) {
    fun request(method: String, path: String, headersJson: String, body: String): JSONObject {
        val verb = method.uppercase(Locale.ROOT)
        require(verb == "GET" || verb == "POST") { "Unsupported schedule method" }
        require(path.length <= 8192 && !path.contains('\r') && !path.contains('\n')) { "Invalid schedule path" }
        require(path.substringBefore('?') == "/v1/rdb/rest/schedule_records") { "Unsupported schedule path" }
        require(body.length <= 65536) { "Schedule request is too large" }
        require(publishableKey.isNotBlank()) { "CloudBase Publishable Key is missing" }
        val connection = URL("https://jandz-d7gyvxev845ba48a0.api.tcloudbasegateway.com$path")
            .openConnection() as HttpURLConnection
        try {
            connection.requestMethod = verb
            connection.connectTimeout = 15000
            connection.readTimeout = 25000
            connection.instanceFollowRedirects = false
            connection.setRequestProperty("Authorization", "Bearer $publishableKey")
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("Content-Type", "application/json")
            val allowedHeaders = setOf("prefer", "range", "range-unit", "accept-profile", "content-profile", "x-db-instance", "x-upsert")
            val headers = JSONObject(headersJson)
            headers.keys().forEach { name ->
                if (name.lowercase(Locale.ROOT) in allowedHeaders) {
                    val value = headers.getString(name)
                    require(!value.contains('\r') && !value.contains('\n')) { "Invalid request header" }
                    connection.setRequestProperty(name, value)
                }
            }
            if (verb == "POST") {
                connection.doOutput = true
                connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            require(status in 200..599) { "Invalid CloudBase HTTP response" }
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val responseBody = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
            return JSONObject().put("status", status).put("body", responseBody)
        } finally {
            connection.disconnect()
        }
    }
}
