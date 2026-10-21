package com.dailyassistant.mobile

import com.google.gson.Gson
import com.google.gson.JsonObject
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

class CloudBaseClient(
    private val envId: String,
    private val anonymousAccessToken: String
) {
    private val baseUrl = "https://$envId.api.tcloudbasegateway.com"
    private val gson = Gson()
    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    suspend fun signInWithPassword(username: String, password: String): LoginTokens = withContext(Dispatchers.IO) {
        val payload = gson.toJson(mapOf("username" to username, "password" to password))
        val request = Request.Builder()
            .url("$baseUrl/auth/v1/signin")
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .header("Authorization", "Bearer $anonymousAccessToken")
            .post(payload.toRequestBody("application/json".toMediaType()))
            .build()

        client.newCall(request).execute().use { response ->
            val responseBody = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                throw CloudBaseRequestException(response.code, responseBody)
            }
            val json = gson.fromJson(responseBody, JsonObject::class.java)
                ?: throw CloudBaseRequestException(response.code, "CloudBase 登录响应不是有效 JSON")
            val nextAccessToken = json.stringValue("access_token")
            val refreshToken = json.stringValue("refresh_token")
            if (nextAccessToken.isBlank() || refreshToken.isBlank()) {
                throw CloudBaseRequestException(response.code, "登录响应缺少 access_token 或 refresh_token")
            }
            LoginTokens(nextAccessToken, refreshToken, json.stringValue("sub"))
        }
    }

    private fun JsonObject.stringValue(name: String): String =
        get(name)?.takeUnless { it.isJsonNull }?.asString.orEmpty()

    data class LoginTokens(
        val accessToken: String,
        val refreshToken: String,
        val userId: String
    )

    class CloudBaseRequestException(val statusCode: Int, body: String) :
        IllegalStateException(errorMessage(statusCode, body)) {
        companion object {
            private fun errorMessage(statusCode: Int, body: String): String {
                val response = runCatching { Gson().fromJson(body, JsonObject::class.java) }.getOrNull()
                val code = response?.stringValue("code") ?: response?.stringValue("error")
                val message = response?.stringValue("message")
                    ?: response?.stringValue("error_description")
                    ?: body.take(500)
                return "CloudBase 登录失败（HTTP $statusCode${code?.let { ", $it" } ?: ""}）：$message"
            }

            private fun JsonObject.stringValue(name: String): String =
                get(name)?.takeUnless { it.isJsonNull }?.asString.orEmpty()
        }
    }
}
