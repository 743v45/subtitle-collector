# 调研:fireredasr-ui 接口能力(2026-08-29,agent: fireredasr-capability)

> 原文来自调研 agent 报告,落盘防上下文压缩丢失。项目位置 `~/Local/fireredasr-ui`(独立 git 仓,git 最新 a09a8a2)。

## 架构

常驻 dispatcher(`0.0.0.0:5079`,waitress 8 线程)+ 按需启停 worker 子进程(stdin/stdout JSON-RPC)+ SQLite 队列/缓存。M4 实测 RTF 0.2。

## HTTP 接口清单(dispatcher.py)

| 端点 | 方法 | 位置 |
|---|---|---|
| `/v1/audio/transcriptions` | POST | dispatcher.py:183-212(OpenAI 兼容同步) |
| `/v1/tasks` | POST | dispatcher.py:131-142(异步入队) |
| `/v1/tasks/{id}` | GET | dispatcher.py:145-156(轮询) |
| `/v1/tasks/{id}` | DELETE | dispatcher.py:177-180(取消,仅 queued) |
| `/v1/status` | GET | dispatcher.py:164-174(队列/worker/最近20条) |
| `/` | GET | dispatcher.py:159-161(调度面板 HTML) |

请求参数(两 POST 一致,multipart):`file` 必填、`response_format`(同步默认 json,/v1/tasks 默认 srt)、`model`(AED 默认|LLM,其他静默回退 AED)。**language/prompt/temperature/batch_size 完全不被读取**。

响应:
- `verbose_json` → `{"text":"全文. 拼接","segments":[{"id":1,"start":0.0,"end":2.5,"text":"…"}]}`,start/end 秒
- `json` → `{"text":"…"}`
- 其他(含 `srt`!)→ text/plain 纯文本。**⚠️ srt 实际不输出 SRT 格式**(老 app.py 的 SRT 拼接没迁移)
- 错误 → 500 `{"code":1,"error"}`;轮询超时 `{"code":1,"error":"timeout"}`
- `GET /v1/tasks/{id}` 恒返回 segments,另含 position/error

curl:
```bash
curl -s http://127.0.0.1:5079/v1/audio/transcriptions \
  -F file=@video.mp4 -F model=AED -F response_format=verbose_json
# 异步批量:
curl -s http://127.0.0.1:5079/v1/tasks -F file=@a.mp3 -F response_format=verbose_json  # → {task_id,status,position}
curl -s http://127.0.0.1:5079/v1/tasks/<id>
```

## 输入形态

- 只吃 multipart 文件上传(无 URL/base64/JSON body)
- **视频文件直接上传可用**:内部 `ffmpeg -y -i raw -ac 1 -ar 16000 -c:a pcm_s16le -f wav`(dispatcher.py:246-247)——mp4/mkv/webm 免预抽音轨
- 上传原件存 static/tmp/raw-*,转写完自动清理

## 时间戳与分段

- faster-whisper Silero VAD(asr_core.py:64-85):threshold 0.5/neg 0.35/min_silence 250ms/speech_pad 200ms/**max_speech_duration_s=30**
- <30s 音频整条一段;段结构 {id,start,end(秒),text};空段剔除
- 无词级时间戳;无说话人分离

## 并发/队列

- 严格串行:SQLite FIFO → 单调度线程 → 单 worker 逐个转写
- worker 空闲 180s 自动关;冷启动 ~30s 加载模型(ready 等待上限 120s)
- 长视频整条转 16k wav(全量磁盘)→ VAD → batch=8;30min 音频约 6min
- `worker.task_timeout=1800s` 只限同步 HTTP 等待(超时返回 500 但任务继续跑,/v1/tasks/{id} 仍可取)
- ⚠️ 队列无看门狗(worker 挂死阻塞全队列);config `max_retries` 死配置无代码使用
- 同步端点占 waitress 8 线程之一;批量走 /v1/tasks

## 配置(config.yaml)

`server.host=0.0.0.0/port=5079`、`worker.idle_timeout=180/task_timeout=1800`、`cache.ttl=86400/cleanup_interval=600`、`asr.default_model=AED`。模型路径硬编码 `{ROOT}/pretrained_models/FireRedASR-{AED|LLM}-L`。batch=8 硬编码。**无 auth**(0.0.0.0 + caddy 明文 `http://asr.work.taevas.host`)。缓存 sha256+model,TTL 1 天。

## 对 subtitle-collector 的结论

**「视频→音轨→转写→cues」现状能力 = 上传任意媒体文件 → verbose_json 段级时间戳,完全够用。**

| 缺口 | 处置 |
|---|---|
| URL 直投不存在 | **消费端自下载再上传(推荐,上游零改动)**;抖音解析/UA/Referer 是消费端能力域。若未来要上游支持:POST 端点加 `url` form 参数分支(流式下载到 TMP_DIR 带 UA/Referer/超时/大小上限)+ requirements 加 requests |
| srt 格式退化 | 消费端拿 verbose_json segments 自拼(subtitle-collector 反正要转 cues) |
| 无 auth | 内网自用暂不动;要加 ~10 行 Bearer 装饰器 |
| 单段≤30s 偏粗 | 消费端按标点再切(asr backfill 已有 segmentsToCues) |
| 队列无看门狗 | 暂不动 |

**决策(T1 grilling 采纳):上游零改动路线。** subtitle-collector 侧:douyin 视频由消费端下载 mp4 → multipart 上传 → verbose_json → segmentsToCues 自拼。配置复用现有 `--asr-url`(默认 http://127.0.0.1:5079)。
