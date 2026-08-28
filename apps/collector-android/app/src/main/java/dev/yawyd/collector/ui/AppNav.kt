package dev.yawyd.collector.ui

import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Assignment
import androidx.compose.material.icons.filled.VideoLibrary
import androidx.compose.material.icons.outlined.AddCircle
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import dev.yawyd.collector.AppContainer
import dev.yawyd.collector.R
import dev.yawyd.collector.ShareEvent
import dev.yawyd.collector.data.ServerConfig
import dev.yawyd.collector.ui.screens.SettingsScreen
import dev.yawyd.collector.ui.screens.ShareConfirmScreen
import dev.yawyd.collector.ui.screens.SubmitScreen
import dev.yawyd.collector.ui.screens.TasksScreen
import dev.yawyd.collector.ui.screens.VideoDetailScreen
import dev.yawyd.collector.ui.screens.VideosScreen
import dev.yawyd.collector.ui.theme.CollectorTheme

private object Routes {
    const val SUBMIT = "submit"
    const val TASKS = "tasks"
    const val VIDEOS = "videos"
    const val CONFIRM = "confirm"
    const val SETTINGS = "settings"
    const val DETAIL = "videos/detail/{source}/{vid}"
}

@Composable
fun AppNav(container: AppContainer, shareEvent: ShareEvent?, onShareConsumed: () -> Unit) {
    val nav = rememberNavController()
    val cfg by container.settings.flow.collectAsStateWithLifecycle(initialValue = ServerConfig())

    // 首启未配置 server → 强制进设置页（保存后清栈回提交页）
    LaunchedEffect(cfg.ready) {
        if (!cfg.ready) nav.navigate(Routes.SETTINGS) { launchSingleTop = true }
    }
    // 分享事件 → 确认页（launchSingleTop：确认页已在顶时只刷新参数）
    LaunchedEffect(shareEvent?.id) {
        if (shareEvent != null) nav.navigate(Routes.CONFIRM) { launchSingleTop = true }
    }

    CollectorTheme {
        Scaffold(bottomBar = { CollectorBottomBar(nav) }) { padding ->
            NavHost(nav, startDestination = Routes.SUBMIT, modifier = Modifier.padding(padding)) {
                composable(Routes.SUBMIT) { SubmitScreen(container, onOpenSettings = { nav.navigate(Routes.SETTINGS) }) }
                composable(Routes.TASKS) { TasksScreen(container) }
                composable(Routes.VIDEOS) {
                    VideosScreen(container, onOpenVideo = { source, vid ->
                        nav.navigate("videos/detail/$source/$vid")
                    })
                }
                composable(Routes.CONFIRM) {
                    ShareConfirmScreen(
                        container = container,
                        text = shareEvent?.text.orEmpty(),
                        onDone = {
                            onShareConsumed()
                            nav.popBackStack()
                        },
                    )
                }
                composable(Routes.SETTINGS) {
                    SettingsScreen(
                        container = container,
                        onSaved = { nav.navigate(Routes.SUBMIT) { popUpTo(0) } },
                        onBack = { nav.popBackStack() },
                    )
                }
                composable(Routes.DETAIL) { entry ->
                    val source = entry.arguments?.getString("source").orEmpty()
                    val vid = entry.arguments?.getString("vid").orEmpty()
                    VideoDetailScreen(container, source, vid, onBack = { nav.popBackStack() })
                }
            }
        }
    }
}

@Composable
private fun CollectorBottomBar(nav: NavHostController) {
    val backStack by nav.currentBackStackEntryAsState()
    val current = backStack?.destination?.route
    NavigationBar {
        NavigationBarItem(
            selected = current == Routes.SUBMIT,
            onClick = { nav.navigateToTab(Routes.SUBMIT) },
            icon = { Icon(Icons.Outlined.AddCircle, contentDescription = null) },
            label = { Text(stringResource(R.string.submit_tab)) },
        )
        NavigationBarItem(
            selected = current == Routes.TASKS,
            onClick = { nav.navigateToTab(Routes.TASKS) },
            icon = { Icon(Icons.Filled.Assignment, contentDescription = null) },
            label = { Text(stringResource(R.string.tasks_tab)) },
        )
        NavigationBarItem(
            selected = current == Routes.VIDEOS,
            onClick = { nav.navigateToTab(Routes.VIDEOS) },
            icon = { Icon(Icons.Filled.VideoLibrary, contentDescription = null) },
            label = { Text(stringResource(R.string.videos_tab)) },
        )
    }
}

// 标准 tab 导航：saveState/restoreState 保各 tab 滚动与筛选状态
private fun NavHostController.navigateToTab(route: String) {
    navigate(route) {
        popUpTo(graph.findStartDestination().id) { saveState = true }
        launchSingleTop = true
        restoreState = true
    }
}
