package dev.yawyd.collector

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.collectAsState
import dev.yawyd.collector.ui.AppNav
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.util.concurrent.atomic.AtomicInteger

/** 分享待处理事件（自增 id 保证「同一链接分享两次」也能各触发一次导航——StateFlow 同值不重发） */
data class ShareEvent(val id: Int, val text: String)

class MainActivity : ComponentActivity() {

    private val pendingShare = MutableStateFlow<ShareEvent?>(null)
    private val shareCounter = AtomicInteger()
    val shareText: StateFlow<ShareEvent?> = pendingShare

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        consumeShare(intent)
        setContent {
            val container = (application as CollectorApp).container
            AppNav(
                container = container,
                shareEvent = shareText.collectAsState().value,
                onShareConsumed = { pendingShare.value = null },
            )
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        consumeShare(intent)
    }

    private fun consumeShare(intent: Intent?) {
        val text = intent?.getStringExtra(EXTRA_SHARE_TEXT)
        if (!text.isNullOrBlank()) {
            pendingShare.value = ShareEvent(shareCounter.incrementAndGet(), text)
        }
    }

    companion object {
        const val EXTRA_SHARE_TEXT = "share_text"
    }
}
