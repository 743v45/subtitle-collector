package dev.yawyd.collector.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
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
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.yawyd.collector.AppContainer
import dev.yawyd.collector.R
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

// server 连接配置：URL + token（DataStore 持久化）。「测试连接」先保存当前输入再 ping
//（保证测的是所见配置）；保存成功清栈回提交页。
@Composable
fun SettingsScreen(container: AppContainer, onSaved: () -> Unit, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    var url by remember { mutableStateOf("") }
    var token by remember { mutableStateOf("") }
    var loaded by remember { mutableStateOf(false) }
    var testing by remember { mutableStateOf(false) }
    var testOk by remember { mutableStateOf<Boolean?>(null) }
    var testMsg by remember { mutableStateOf("") }

    LaunchedEffect(Unit) {
        val cfg = container.settings.flow.first()
        url = cfg.url
        token = cfg.token
        loaded = true
    }

    fun test() {
        if (testing) return
        testing = true
        testOk = null
        scope.launch {
            container.settings.save(url, token)
            val ok = container.api.ping()
            testOk = ok
            testMsg = if (ok) "✓ 连接成功" else "连不上 server：检查地址/端口/是否同一局域网"
            testing = false
        }
    }

    fun save() {
        scope.launch {
            container.settings.save(url, token)
            onSaved()
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
            }
            Text(stringResource(R.string.settings_title), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        }
        if (loaded) {
            OutlinedTextField(
                value = url,
                onValueChange = { url = it },
                label = { Text(stringResource(R.string.server_url_label)) },
                placeholder = { Text(stringResource(R.string.server_url_hint)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = token,
                onValueChange = { token = it },
                label = { Text(stringResource(R.string.token_label)) },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                modifier = Modifier.fillMaxWidth(),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Button(onClick = ::test, enabled = !testing) { Text(stringResource(R.string.test_connection)) }
                Button(onClick = ::save, enabled = url.isNotBlank()) { Text(stringResource(R.string.save)) }
                if (testing) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
            }
            testOk?.let {
                Text(testMsg, color = if (it) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error, fontSize = 13.sp)
            }
            Text(
                "地址为 collector-server 的访问入口（局域网部署形如 http://192.168.x.x:21527）。"
                    + "Token 对应部署的 COLLECTOR_TOKEN：loopback 部署可不设；暴露部署（0.0.0.0）必设。"
                    + "「测试连接」会先保存当前输入再探测。",
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
