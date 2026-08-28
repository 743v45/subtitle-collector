package dev.yawyd.collector.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

// ── 任务状态中文映射与配色（对齐 web 任务卡口径；limited=字幕受限终态可重试）──
fun statusLabel(status: String): String = when (status) {
    "pending" -> "排队中"
    "dispatched" -> "采集中"
    "succeeded" -> "成功"
    "failed" -> "失败"
    "limited" -> "受限"
    else -> status
}

fun statusColor(status: String): Color = when (status) {
    "pending" -> Color(0xFF9E9E9E)
    "dispatched" -> Color(0xFF1E88E5)
    "succeeded" -> Color(0xFF43A047)
    "failed" -> Color(0xFFE53935)
    "limited" -> Color(0xFFFB8C00)
    else -> Color(0xFF9E9E9E)
}

@Composable
private fun Badge(label: String, color: Color) {
    Box(
        Modifier
            .background(color.copy(alpha = 0.14f), RoundedCornerShape(50))
            .padding(horizontal = 8.dp, vertical = 2.dp),
    ) {
        Text(label, color = color, fontSize = 11.sp, fontWeight = FontWeight.Medium)
    }
}

@Composable
fun StatusBadge(status: String) = Badge(statusLabel(status), statusColor(status))

@Composable
fun PlatformBadge(source: String) = when (source) {
    "bilibili" -> Badge("B站", Color(0xFF00A1D6))
    "youtube" -> Badge("YT", Color(0xFFE62117))
    else -> Badge(source, Color(0xFF9E9E9E))
}

private val TS_FMT: DateTimeFormatter = DateTimeFormatter.ofPattern("MM-dd HH:mm")

/** 毫秒时间戳 → 「MM-dd HH:mm」（本地时区；空/0 返回空串） */
fun formatMillis(ts: Long?): String =
    ts?.takeIf { it > 0 }?.let { TS_FMT.format(Instant.ofEpochMilli(it).atZone(ZoneId.systemDefault())) }
        ?: ""

/** 秒 → 「m:ss」/「h:mm:ss」（空/null 返回 — ） */
fun formatDuration(seconds: Long?): String {
    val s = seconds?.takeIf { it > 0 } ?: return "—"
    val h = s / 3600
    val m = (s % 3600) / 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s % 60) else "%d:%02d".format(m, s % 60)
}

/** 字幕行起始秒 → 「[mm:ss]」时间码（超 1 小时升 [h:mm:ss]） */
fun formatTimecode(from: Double): String {
    val total = from.toLong()
    val h = total / 3600
    return if (h > 0) {
        "[%d:%02d:%02d]".format(h, (total % 3600) / 60, total % 60)
    } else {
        "[%02d:%02d]".format(total / 60, total % 60)
    }
}

@Composable
fun ErrorBox(message: String, onRetry: (() -> Unit)? = null) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier
            .fillMaxWidth()
            .padding(16.dp),
    ) {
        Text("加载失败：$message", color = MaterialTheme.colorScheme.error, fontSize = 13.sp)
        if (onRetry != null) {
            Button(onClick = onRetry, modifier = Modifier.padding(top = 8.dp)) { Text("重试") }
        }
    }
}
