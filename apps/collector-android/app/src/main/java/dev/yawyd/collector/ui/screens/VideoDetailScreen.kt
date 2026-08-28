package dev.yawyd.collector.ui.screens

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AssistChip
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.yawyd.collector.AppContainer
import dev.yawyd.collector.data.SubtitleLine
import dev.yawyd.collector.data.TrackInfo
import dev.yawyd.collector.data.VideoDetailData
import dev.yawyd.collector.data.VideoInfo
import dev.yawyd.collector.ui.components.ErrorBox
import dev.yawyd.collector.ui.components.formatDuration
import dev.yawyd.collector.ui.components.formatMillis
import dev.yawyd.collector.ui.components.formatTimecode

// 视频详情：元信息 + 轨道/版本切换（默认版本预选，其余点 chip 切换）+ 字幕正文（[mm:ss] 行）。
// 原站外链走系统浏览器。
@Composable
fun VideoDetailScreen(container: AppContainer, source: String, vid: String, onBack: () -> Unit) {
    var detail by remember { mutableStateOf<VideoDetailData?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var selectedVersion by remember { mutableStateOf<Long?>(null) }
    var lines by remember { mutableStateOf<List<SubtitleLine>?>(null) }
    var linesError by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(source, vid) {
        try {
            detail = container.api.getVideo(source, vid)
            error = null
        } catch (e: Exception) {
            error = e.message
        }
    }
    // 默认版本：is_default 优先，否则首轨首版本
    LaunchedEffect(detail) {
        if (selectedVersion == null) {
            val all = detail?.tracks.orEmpty().flatMap { it.versions }
            selectedVersion = (all.firstOrNull { it.is_default } ?: all.firstOrNull())?.id
        }
    }
    LaunchedEffect(selectedVersion) {
        val id = selectedVersion ?: return@LaunchedEffect
        try {
            lines = container.api.getVersion(id).payload.body
            linesError = null
        } catch (e: Exception) {
            linesError = e.message
        }
    }

    Column(Modifier.fillMaxSize()) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
            }
            Text(
                detail?.video?.title ?: vid,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        when {
            error != null -> ErrorBox(error!!)
            detail == null -> HintText("加载中…")
            else -> DetailBody(
                detail = detail!!,
                source = source,
                vid = vid,
                selectedVersion = selectedVersion,
                onSelectVersion = { selectedVersion = it },
                lines = lines,
                linesError = linesError,
            )
        }
    }
}

@Composable
private fun DetailBody(
    detail: VideoDetailData,
    source: String,
    vid: String,
    selectedVersion: Long?,
    onSelectVersion: (Long) -> Unit,
    lines: List<SubtitleLine>?,
    linesError: String?,
) {
    Column(Modifier.fillMaxSize()) {
        VideoMetaHeader(detail.video, source, vid)
        Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
            if (detail.tracks.isEmpty()) {
                HintText("该视频暂无字幕轨")
            } else {
                TrackSection(detail.tracks, selectedVersion, onSelectVersion)
            }
        }
        SubtitleSection(lines, linesError, Modifier.weight(1f))
    }
}

@Composable
private fun VideoMetaHeader(video: VideoInfo, source: String, vid: String) {
    val context = LocalContext.current
    Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(video.title, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Text(
            listOfNotNull(
                video.creator_name?.let { "UP：$it" },
                formatDuration(video.duration),
                formatMillis(video.published_at),
                video.source_vid,
            ).joinToString(" · "),
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        val siteUrl = if (source == "bilibili") {
            "https://www.bilibili.com/video/$vid"
        } else {
            "https://www.youtube.com/watch?v=$vid"
        }
        AssistChip(
            onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(siteUrl))) },
            label = { Text("在原站打开 ↗") },
        )
    }
}

@Composable
private fun TrackSection(tracks: List<TrackInfo>, selectedVersion: Long?, onSelect: (Long) -> Unit) {
    tracks.forEach { track ->
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                track.lan_doc ?: track.lan ?: "未知语言",
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
            )
            Row(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                modifier = Modifier.horizontalScroll(rememberScrollState()),
            ) {
                track.versions.forEach { ver ->
                    FilterChip(
                        selected = selectedVersion == ver.id,
                        onClick = { onSelect(ver.id) },
                        label = { Text(versionLabel(ver), fontSize = 11.sp) },
                    )
                }
            }
        }
    }
}

private fun versionLabel(ver: dev.yawyd.collector.data.VersionInfo): String = buildString {
    append(formatMillis(ver.captured_at))
    if (ver.is_default) append(" ★")
    if (ver.origin.isNotBlank()) append(" · ${ver.origin}")
}

@Composable
private fun SubtitleSection(lines: List<SubtitleLine>?, linesError: String?, modifier: Modifier) {
    when {
        linesError != null -> ErrorBox(linesError)
        lines == null -> HintText("字幕加载中…")
        lines.isEmpty() -> HintText("该版本字幕为空")
        else -> LazyColumn(modifier) {
            items(lines) { line ->
                SubtitleRow(line)
            }
            item { Spacer(Modifier.padding(bottom = 16.dp)) }
        }
    }
}

@Composable
private fun SubtitleRow(line: SubtitleLine) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 3.dp)) {
        Text(
            formatTimecode(line.from),
            fontSize = 12.sp,
            fontFamily = FontFamily.Monospace,
            color = MaterialTheme.colorScheme.primary,
        )
        Spacer(Modifier.width(8.dp))
        Text(line.content, fontSize = 14.sp)
    }
}

@Composable
private fun HintText(text: String) {
    Text(
        text,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        fontSize = 13.sp,
        modifier = Modifier.padding(16.dp),
    )
}
