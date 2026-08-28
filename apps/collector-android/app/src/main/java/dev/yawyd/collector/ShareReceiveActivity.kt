package dev.yawyd.collector

import android.app.Activity
import android.content.Intent
import android.os.Bundle

// 系统分享接收跳板：把 ACTION_SEND 的 EXTRA_TEXT 原文交给 MainActivity 进确认页，自身立即退场。
// 不做任何解析（server 才是解析权威）；无 UI 全透明。
class ShareReceiveActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val text = intent?.takeIf { it.action == Intent.ACTION_SEND }
            ?.getStringExtra(Intent.EXTRA_TEXT).orEmpty()
        val launch = Intent(this, MainActivity::class.java)
            .setFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP,
            )
            .putExtra(MainActivity.EXTRA_SHARE_TEXT, text)
        startActivity(launch)
        finish()
    }
}
