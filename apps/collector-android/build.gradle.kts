// 根构建脚本：只声明插件版本（application 到 :app 时生效），无全局任务。
// detekt 配置在 :app 的 build.gradle.kts（等价 lint，四件套的原生等价物之一）。
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.detekt) apply false
}
