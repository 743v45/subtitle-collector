package dev.yawyd.collector.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore(name = "settings")

data class ServerConfig(val url: String = "", val token: String = "") {
    val ready: Boolean get() = url.isNotBlank()
}

// server 连接配置（DataStore 持久化）：url 支持局域网 / 组网 / 公网任意形态，
// token 对应 server 的 COLLECTOR_TOKEN（loopback 部署可不设 → 免鉴权）。
class SettingsRepository(private val context: Context) {
    val flow: Flow<ServerConfig> = context.dataStore.data.map { p ->
        ServerConfig(p[URL_KEY].orEmpty().trim(), p[TOKEN_KEY].orEmpty().trim())
    }

    suspend fun save(url: String, token: String) {
        context.dataStore.edit {
            it[URL_KEY] = url.trim()
            it[TOKEN_KEY] = token.trim()
        }
    }

    private companion object {
        val URL_KEY = stringPreferencesKey("server_url")
        val TOKEN_KEY = stringPreferencesKey("server_token")
    }
}
