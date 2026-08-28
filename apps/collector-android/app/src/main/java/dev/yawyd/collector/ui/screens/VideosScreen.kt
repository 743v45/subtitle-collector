package dev.yawyd.collector.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import dev.yawyd.collector.AppContainer
import dev.yawyd.collector.R
import dev.yawyd.collector.data.VideoListItem
import dev.yawyd.collector.ui.components.ErrorBox
import dev.yawyd.collector.ui.components.formatDuration
import dev.yawyd.collector.ui.components.formatMillis
import kotlinx.coroutines.launch

// 视频库搜索：关键词 + 平台过滤 + 滚动到底自动加载下一页（web 视频列表的移动子集，
// 其余 20 维筛选后续按需加）。空态区分「未搜索/无结果」。
@Composable
fun VideosScreen(container: AppContainer, onOpenVideo: (String, String) -> Unit) {
    val scope = rememberCoroutineScope()
    var query by remember { mutableStateOf("") }
    var activeQuery by remember { mutableStateOf("") }
    var source by remember { mutableStateOf("") }
    var searched by remember { mutableStateOf(false) }
    var items by remember { mutableStateOf<List<VideoListItem>>(emptyList()) }
    var total by remember { mutableStateOf(0) }
    var page by remember { mutableStateOf(1) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun load(reset: Boolean) {
        if (loading) return
        val p = if (reset) 1 else page + 1
        loading = true
        scope.launch {
            try {
                val r = container.api.listVideos(
                    q = activeQuery.ifBlank { null },
                    source = source.ifBlank { null },
                    page = p,
                    size = PAGE_SIZE,
                )
                items = if (reset) r.items else items + r.items
                total = r.total
                page = p
                searched = true
                error = null
            } catch (e: Exception) {
                error = e.message
            } finally {
                loading = false
            }
        }
    }

    val listState = rememberLazyListState()
    val shouldLoadMore by remember {
        derivedStateOf {
            val last = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: -1
            last >= items.lastIndex - 4 && items.size < total && !loading && searched
        }
    }
    LaunchedEffect(shouldLoadMore) { if (shouldLoadMore) load(false) }
    // 平台切换：已搜过则按新平台重搜
    LaunchedEffect(source) { if (searched) load(true) }

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            label = { Text(stringResource(R.string.search_videos)) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = {
                activeQuery = query
                load(true)
            }),
            modifier = Modifier.fillMaxWidth(),
        )
        SourceFilterRow(selected = source, onSelect = { source = it })
        VideoListBody(
            error = error,
            searched = searched,
            loading = loading,
            items = items,
            total = total,
            listState = listState,
            onOpenVideo = onOpenVideo,
        )
    }
}

@Composable
private fun SourceFilterRow(selected: String, onSelect: (String) -> Unit) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.padding(vertical = 8.dp),
    ) {
        listOf("" to "全部", "bilibili" to "B站", "youtube" to "YouTube").forEach { (v, label) ->
            FilterChip(selected = selected == v, onClick = { onSelect(v) }, label = { Text(label) })
        }
    }
}

@Composable
private fun VideoListBody(
    error: String?,
    searched: Boolean,
    loading: Boolean,
    items: List<VideoListItem>,
    total: Int,
    listState: LazyListState,
    onOpenVideo: (String, String) -> Unit,
) {
    when {
        error != null -> ErrorBox(error)
        !searched -> Hint("输入关键词回车搜索视频库")
        items.isEmpty() && !loading -> Hint("无匹配结果")
        else -> LazyColumn(state = listState, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(items, key = { it.id }) { v ->
                VideoRow(v) { onOpenVideo(v.source, v.source_vid) }
            }
            if (loading) {
                item {
                    Row(
                        Modifier.fillMaxWidth().padding(12.dp),
                        horizontalArrangement = Arrangement.Center,
                    ) {
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    }
                }
            }
            if (!loading && items.size < total) {
                item { Hint("上滑加载更多（${items.size}/$total）") }
            }
        }
    }
}

@Composable
private fun Hint(text: String) {
    Text(
        text,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        fontSize = 13.sp,
        modifier = Modifier.padding(16.dp),
    )
}

@Composable
private fun VideoRow(v: VideoListItem, onClick: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 6.dp),
    ) {
        AsyncImage(
            model = v.pic,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = Modifier
                .size(width = 110.dp, height = 62.dp)
                .background(Color(0xFFE0E0E0), RoundedCornerShape(4.dp)),
        )
        Spacer(Modifier.width(10.dp))
        Column {
            Text(
                v.title,
                fontWeight = FontWeight.Medium,
                fontSize = 14.sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                listOfNotNull(
                    v.creator_name,
                    formatDuration(v.duration),
                    "${v.track_count}轨",
                ).joinToString(" · "),
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 2.dp),
            )
            Text(
                // 发布时间缺省回落入库时间（老数据 published_at 可能为 0/null）
                formatMillis(
                    v.published_at?.takeIf { it > 0 }
                        ?: v.first_seen_at.takeIf { it > 0 },
                ),
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

private const val PAGE_SIZE = 20
