package dev.yawyd.collector.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import dev.yawyd.collector.core.ShareTextParser
import dev.yawyd.collector.data.CreateTaskResult
import dev.yawyd.collector.ui.components.PlatformBadge
import kotlinx.coroutines.launch

// 分享确认页（2026-08-26 共识：不静默直建）：本地预解析展示平台+链接 → 用户点「采集」才提交。
// server 解析失败的 400 文案就地展示（可观察性）；成功切成功视图后「完成」退出。
@Composable
fun ShareConfirmScreen(container: AppContainer, text: String, onDone: () -> Unit) {
    val scope = rememberCoroutineScope()
    val preview = remember(text) { ShareTextParser.extract(text) }
    var submitting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var result by remember { mutableStateOf<CreateTaskResult?>(null) }

    fun collect() {
        if (submitting) return
        submitting = true
        scope.launch {
            try {
                result = container.api.createTask(text)
                error = null
            } catch (e: Exception) {
                error = e.message
            } finally {
                submitting = false
            }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("确认采集", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)

        val r = result
        if (r != null) {
            Icon(
                Icons.Filled.CheckCircle,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(48.dp).align(Alignment.CenterHorizontally),
            )
            Text(
                if (r.created) {
                    "已创建任务 #${r.task.id}，可在任务页跟踪"
                } else {
                    "该视频已有在途任务 #${r.task.id}，未重复创建"
                },
                modifier = Modifier.align(Alignment.CenterHorizontally),
            )
            Button(onClick = onDone, modifier = Modifier.fillMaxWidth().height(48.dp)) {
                Text("完成")
            }
        } else {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (preview != null) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            PlatformBadge(preview.platform)
                            Text(
                                preview.url,
                                fontSize = 12.sp,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    } else {
                        Text("未识别出视频链接，提交后由 server 尝试解析", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (text != preview?.url) {
                        Text(
                            text,
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 3,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
            error?.let {
                Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onDone, enabled = !submitting) {
                    Text(stringResource(R.string.cancel))
                }
                Button(
                    onClick = ::collect,
                    enabled = !submitting,
                    modifier = Modifier.weight(1f),
                ) {
                    if (submitting) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.size(8.dp))
                    }
                    Text(stringResource(R.string.collect_now))
                }
            }
        }
    }
}
