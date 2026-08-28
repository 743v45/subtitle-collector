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
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.yawyd.collector.AppContainer
import dev.yawyd.collector.R
import dev.yawyd.collector.core.ShareTextParser
import dev.yawyd.collector.ui.components.PlatformBadge
import kotlinx.coroutines.launch

// 提交采集：粘贴分享文本/链接 → 本地预解析提示（平台+URL）→ POST text（解析权威在 server）。
// 结果反馈：created=false（同视频已有在途任务）与失败 error 文案都在 snackbar 可见。
@Composable
fun SubmitScreen(container: AppContainer, onOpenSettings: () -> Unit) {
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    var text by remember { mutableStateOf("") }
    var submitting by remember { mutableStateOf(false) }
    val preview = remember(text) { ShareTextParser.extract(text) }

    fun submit() {
        if (text.isBlank() || submitting) return
        submitting = true
        scope.launch {
            try {
                val r = container.api.createTask(text)
                val msg = if (r.created) {
                    "已创建任务 #${r.task.id}（${r.task.source_vid}）"
                } else {
                    "该视频已有在途任务 #${r.task.id}，未重复创建"
                }
                snackbar.showSnackbar(msg)
                text = ""
            } catch (e: Exception) {
                snackbar.showSnackbar("提交失败：${e.message}")
            } finally {
                submitting = false
            }
        }
    }

    Scaffold(snackbarHost = { SnackbarHost(snackbar) }) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 16.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Text(
                    stringResource(R.string.app_name),
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = onOpenSettings) {
                    Icon(Icons.Filled.Settings, contentDescription = stringResource(R.string.settings_title))
                }
            }
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                label = { Text(stringResource(R.string.share_text_hint)) },
                minLines = 4,
                modifier = Modifier.fillMaxWidth(),
            )
            // 本地预解析提示：识别到视频站链接 → 平台徽章 + URL；有内容但没识别出 → 明示
            if (preview != null) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.padding(top = 12.dp),
                ) {
                    PlatformBadge(preview.platform)
                    Text(
                        preview.url,
                        fontSize = 12.sp,
                        maxLines = 1,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                }
            } else if (text.isNotBlank()) {
                Text(
                    "未识别到 B 站 / YouTube 视频链接",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(top = 12.dp),
                )
            }
            Spacer(Modifier.height(16.dp))
            Button(
                onClick = ::submit,
                enabled = text.isNotBlank() && !submitting,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(48.dp),
            ) {
                if (submitting) {
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.size(8.dp))
                }
                Text(stringResource(R.string.submit_collect))
            }
        }
    }
}
