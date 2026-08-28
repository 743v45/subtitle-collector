package dev.yawyd.collector.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Card
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.yawyd.collector.AppContainer
import dev.yawyd.collector.R
import dev.yawyd.collector.data.CollectTask
import dev.yawyd.collector.ui.components.ErrorBox
import dev.yawyd.collector.ui.components.PlatformBadge
import dev.yawyd.collector.ui.components.StatusBadge
import dev.yawyd.collector.ui.components.formatMillis
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

// 任务列表：最近 limit 条 + 前台 2s 轮询（对齐 web 采集页口径）；failed/limited 可重试（原地重置），
// 任意状态可删。错误文案与 result 摘要直接展示（可观察性）。
@Composable
fun TasksScreen(container: AppContainer) {
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    var items by remember { mutableStateOf<List<CollectTask>>(emptyList()) }
    var total by remember { mutableStateOf(0) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var refreshTick by remember { mutableStateOf(0) }

    LaunchedEffect(Unit) {
        while (isActive) {
            try {
                val r = container.api.listTasks(LIMIT)
                items = r.items
                total = r.total
                error = null
            } catch (e: Exception) {
                error = e.message
            } finally {
                loading = false
            }
            delay(POLL_MS)
        }
    }

    fun retry(task: CollectTask) {
        scope.launch {
            try {
                val r = container.api.retryTasks(listOf(task.id))
                snackbar.showSnackbar(if (r.retried > 0) "任务 #${task.id} 已重置重跑" else "任务 #${task.id} 不可重试（在途或已完成）")
            } catch (e: Exception) {
                snackbar.showSnackbar("重试失败：${e.message}")
            }
        }
    }

    fun delete(task: CollectTask) {
        scope.launch {
            try {
                container.api.deleteTask(task.id)
                items = items.filterNot { it.id == task.id }
                total -= 1
                snackbar.showSnackbar("已删除任务 #${task.id}")
            } catch (e: Exception) {
                snackbar.showSnackbar("删除失败：${e.message}")
            }
        }
    }

    Scaffold(snackbarHost = { SnackbarHost(snackbar) }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).padding(horizontal = 16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Text(
                    "${stringResource(R.string.tasks_tab)}（$total）",
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = { refreshTick++ }) {
                    Icon(Icons.Filled.Refresh, contentDescription = "刷新")
                }
            }
            // 手动刷新：仅触发一次立即拉取（轮询照常；轻实现：短 sleep 让出后直接调一次）
            LaunchedEffect(refreshTick) {
                if (refreshTick > 0) {
                    try {
                        val r = container.api.listTasks(LIMIT)
                        items = r.items
                        total = r.total
                        error = null
                    } catch (e: Exception) {
                        error = e.message
                    }
                }
            }
            if (error != null) {
                ErrorBox(error!!)
            } else if (loading && items.isEmpty()) {
                Text("加载中…", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp))
            } else if (items.isEmpty()) {
                Text("暂无任务（提交页或系统分享发起采集）", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp))
            } else {
                LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(items, key = { it.id }) { task ->
                        TaskCard(task, onRetry = { retry(task) }, onDelete = { delete(task) })
                    }
                }
            }
        }
    }
}

@Composable
private fun TaskCard(task: CollectTask, onRetry: () -> Unit, onDelete: () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                StatusBadge(task.status)
                PlatformBadge(task.source)
                Text(
                    task.title ?: task.source_vid,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text(formatMillis(task.created_at), fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            val meta = listOfNotNull(
                task.creator_name?.let { "UP：$it" },
                task.source_vid,
            ).joinToString(" · ")
            Text(
                meta,
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (task.status == "failed" && !task.error.isNullOrBlank()) {
                Text(
                    "错误：${task.error}",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.error,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.align(Alignment.End)) {
                if (task.status == "failed" || task.status == "limited") {
                    TextButton(onClick = onRetry) { Text(stringResource(R.string.retry)) }
                }
                TextButton(onClick = onDelete) { Text(stringResource(R.string.delete)) }
            }
        }
    }
}

private const val LIMIT = 50
private const val POLL_MS = 2_000L
