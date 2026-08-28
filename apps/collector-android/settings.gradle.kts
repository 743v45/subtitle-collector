// collector-android 构建入口。
// 构建链：JDK 21 + Android SDK（ANDROID_HOME 或 local.properties 的 sdk.dir 指向 SDK 根）。
// 纪律：gradle 任务不进 `pnpm qa`（node 链），package.json scripts 刻意避开 build/test 命名
// 防 turbo 误挂（RULES §10 豁免登记，2026-08-26）。
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "collector-android"
include(":app")
