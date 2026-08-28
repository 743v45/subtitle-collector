package dev.yawyd.collector

import android.app.Application
import android.content.Context
import dev.yawyd.collector.data.ApiClient
import dev.yawyd.collector.data.SettingsRepository

class CollectorApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}

// 手动 DI 容器（MVP 规模不引 Hilt）：settings 常驻，api 惰性单例（其内部按次读配置，改配置即生效）
class AppContainer(context: Context) {
    val settings: SettingsRepository = SettingsRepository(context)
    val api: ApiClient by lazy { ApiClient(settings) }
}
