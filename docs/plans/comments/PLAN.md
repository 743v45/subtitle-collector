# B 站评论完整分析树 — 实施设计(PLAN)

> 落盘位置:`docs/plans/comments/PLAN.md`(本文档即其内容,评审后原样落盘)。
> 措辞红线:本项目是**字幕**系统;评论(comment)是 2026-10-03 新增的数据类型,与**弹幕(danmaku)**无关,全文严禁混用。
> 政策属性:**评论采集是 2026-10-03 用户现场指令放行的新能力,与 2026-08-29 抖音全量解冻同类,属一次性解冻**——不改变 CLAUDE.md §6 采集侧冻结政策本身,除本文档明确范围外,其余采集侧能力维持冻结。
> 输入:四份调研(A: B 站评论 API 文档;B: 项目现状;C: 真实 API 实测;D: 消费链路)。调研基线:分支 `bili-comment-analysis-tree`,HEAD `824a063`。
> 时间口径声明:库内时间列一律毫秒 epoch(项目惯例);唯一例外 `comments.ctime_s` 保存 B 站原值 **unix 秒**(列名显式 `_s` 后缀,防 SQL 使用者把秒当毫秒与 *_at 列混算;保真原则,DDL 注释显眼标注)。

---

## 0. 决策摘要

| # | 决策 | 结论 | 一句话理由 |
|---|---|---|---|
| D1 | 根评论遍历接口 | `/x/v2/reply/wbi/main`(wbi 签名 + 游标),全量/增量遍历一律 mode=2 时间序(倒序最新在前) | 实测旧接口 `/x/v2/reply` pn≥2 全归零空壳、实质只服务热度首页,不可遍历(调研 C §6);mode=3 热度分随点赞实时变动,翻页期间条目位移可整条跳过(漏采且无感知),时间序页间重复由幂等 upsert 无害吸收 |
| D2 | 楼中楼接口 | `/x/v2/reply/reply`,ps 固定 20 | 实测健康,`page.count` 分页语义清晰;ps=49 被静默钳 20,直接用 20 免歧义 |
| D3 | 表主键 | 代理主键 `id INTEGER PK AUTOINCREMENT` + `UNIQUE(rpid_str)` | 对齐全库 11 张表的既定风格;change_log(entity_id INTEGER)兼容;rpid_str 唯一索引天然承载幂等 upsert |
| D4 | 写库通路 | 宿主 CLI 直连 B 站采集 → server HTTP `POST /api/comments/ingest` 写库 | 「CLI 永不写库」纪律([db.ts:1-2](apps/collector-server/src/cli/db.ts#L1));asr backfill 同款分工先例([asr-bili.ts:5](apps/collector-server/src/cli/asr-bili.ts#L5) + `/api/asr/submit`) |
| D5 | 增量水位 | 根评论按 `ctime_s` 水位(mode=2 时间序);楼中楼按根行 `rcount` 增长触发重翻(仅本轮见到的根);老根增长靠 `--refresh-roots`(like 降序 top-N)显式重翻 | 无官方 delta 接口;ctime_s 水位比 rpid 水位稳(rpid 与时间非严格线性,调研 A §6);老根不在时间序窗口内,增量轮默认不追老楼新回复(§4.2) |
| D6 | 删除建模 | 单列 `missing_since`(仅根评论参与、仅完整轮置值):置值=至少缺席一轮完整全量;`last_seen_at < missing_since`=确认缺失 | 不物理删;连续两轮(均完整轮)缺席才确认,B 站深分页假阴性容忍(调研 A §6) |
| D7 | 导出形态 | 扁平+边内嵌(每条自带 root/parent/dialog 字段,按根分组)+ manifest 摘要 + `comments/<BV>.md` 正文;不出嵌套 JSON | 评论天然两层(根+楼中楼平铺),嵌套树收益低;行式形态与 videos/*.txt 同哲学;库本身是结构化 source of truth |
| D8 | BV→aid | 不实现 bv2av 算法;`videos.extra.aid` 优先,缺失走 `view?bvid=` 回查 | 少一份算法维护;view 响应的 `stat.reply` 本来就要做总数哨兵对账(回查先例 [asr.ts:83-90](apps/collector-server/src/cli/commands/asr.ts#L83)) |

---

## 1. 目标与范围

### 1.1 目标

把单个 B 站视频的评论区(根评论 + 楼中楼全量)采集成**完整分析树**入库:

1. **结构完整**:rpid / parent / root / dialog 关联关系一致,可还原「谁回复谁」的对话链;
2. **元数据完整**:点赞数、发布时间、IP 属地、用户快照(member)、UP 主互动(up_action / is_up)、状态位(state / invisible / folded)、置顶(pin_kind);
3. **可增量**:重复采集 = 新评论补抓(ctime_s 水位)+ 老根元数据刷新与老楼追新(`--refresh-roots` 按库内 like 降序 top-N 根重翻)+ 删除对账(missing 两轮确认);
4. **可校验**:入库后自检(root 缺失 / parent 悬空 / rcount 对账 / 重复 rpid),统计输出覆盖率;
5. **可消费**:export bundle 增补评论原料(manifest 摘要 + 正文 md),分析会话可直接回答「观众怎么看」类问题。

### 1.2 范围内

- B 站**视频稿件**评论区(`type=1`,`oid=aid`);单视频全量采集与增量重采;
- 新表 `comments`(collector-server)+ 迁移 v20 + server ingest/count/verify 端点 + CLI `comments collect/tree/verify`;
- export bundle 评论导出 + ANALYZE.md 模板增补;
- 文档同步(SKILL.md / help / README,见 §9.3)。

### 1.3 范围外(显式排除,与抖音条目的边界写法对齐)

- 专栏(type=12)/ 动态(17)/ 直播(8)等其他评论区类型;
- 评论**写操作**(点赞/回复/删除)——采集链路只读;
- web 展示(VideoDetail 评论树渲染)——挂点已探明(统计卡 `stat.reply` 处 + `/api/videos/:source/:vid/*` 子资源路由先例),登记入 `docs/plans/consumption-loop.md` 推迟项,疼了再做;
- `stats` 命令组的评论维度聚合(verify 统计已覆盖首轮需求);
- YouTube / 抖音评论(平台接口签名成本不同,不在本次解冻范围);
- gaia 验证码自动化(见 §8,人工验证即停)。

### 1.4 政策属性(必须随文档落盘保留)

评论采集属**消费端分析数据源增强**:分析产物(观点汇总)当前只有 UP 主单声道,评论区是观众侧反应的第一手数据源,是「观点汇总含分歧与共识」模板的天然增强。2026-10-03 用户现场指令解冻,与抖音 2026-08-29 解冻同性质:**一次性、不构成对冻结政策本身修改**;README 条目翻转时按抖音先例格式注明授权出处(§9.3)。

---

## 2. B 站评论数据模型(以实测为准)

### 2.1 接口选择论证

| 用途 | 选定 | 落选及原因 |
|---|---|---|
| 根评论全量 | `GET /x/v2/reply/wbi/main?type=1&oid={aid}&mode={3\|2}&pagination_str={...}&plat=1&web_location=1315875&w_rid&wts` | 旧 `/x/v2/reply`:实测(2026-10-03,调研 C §6)sort=0 时间序 pn=1 即归零空壳、pn≥2 归零、ps=49 硬报 -400——**实质只服务 pn=1 热度首页,不可遍历**;`/x/v2/reply/main`(无 wbi)文档已划删除线弃用 |
| 楼中楼全量 | `GET /x/v2/reply/reply?type=1&oid={aid}&root={rpid}&pn={n}&ps=20&sort=0` | 无替代(主接口内嵌 `replies` 预览实测只截 3 条且选择算法不明,完整性不可依赖) |
| 置顶 | 并入 wbi/main 首页响应 `data.top.{admin,upper,vote}` | 不单调置顶接口(-509 风控码在册,无增量价值) |
| 总数哨兵 | `GET /x/web-interface/view?bvid=` → `data.stat.reply` | 与 `videos.extra.stat.reply` 同源同键(R5 键名对齐先例);`/x/v2/reply/count` 不单独接(三口径存在缓存差,不强求一致,只做 ±容忍对账) |
| 单条刷新 | 不接(`/x/v2/reply/info` 已弃用) | like 刷新走楼中楼重翻顺带完成,不引入弃用接口依赖 |

**对话树接口 `/x/v2/reply/dialog/cursor` 本期不接**:实测楼中楼内部已拍平为两层(根 + 楼内平铺,互复靠 parent +「回复 @」前缀表达,调研 C §4),`/reply/reply` 按 ctime 全量翻页已拿全楼内条目,dialog 接口无增量信息。

### 2.2 分页机制

**主列表(wbi/main,游标式)**:
- 首页:`pagination_str = {"offset":""}`;后续页:`JSON.stringify({ offset: <上响应 data.cursor.pagination_reply.next_offset 原文> })`(**消费后即弃,不自行构造**。spike 实测 2026-10-04,附录 A:next_offset 是**不透明 base64 protobuf 串**——镜像文档 `{type:1,data:{pn:n}}` / `{type:3,direction:2,Data:{cursor:n}}` 两形态均已过时;且裸串直塞 pagination_str 报 -400,必须包 `{"offset":...}` 一层。串内可解出会话 token 与剩余计数,但**禁止解码/重组**,当黑盒 token 用);
- 判停:`data.cursor.is_end === true` 或 `pagination_reply.next_offset` 缺失;连续 2 页 rows 空 → 判停(mode 下游标每页变化但内容恒空是删除/软过滤已知形态,既有护栏拦不住,空转烧配额诱发风控,见 §4.4);
- `data.cursor.all_count` 作规模哨兵(与 view 的 `stat.reply` 对账,容忍口径差;伪完整轮守卫与根数哨兵均以此为参照,§3.3/§5.1 R9);
- 排序:全量与增量遍历一律 `mode=2` 时间序(实测恒为最新在前,与 web「最新评论」形态一致;`direction` 参数 URL / offset JSON 两处携带均无可见效果,**不携带**,附录 A 裁定②)。不用 `mode=3` 热度序遍历——热度分随点赞实时变动,翻页期间条目位移可整条跳过(漏采且无感知);时间序翻页只会因新增评论产生页间重复,幂等 upsert 无害吸收。`mode=3` 仅作首页热评快照(`--sort hot` 显式选择:首页按 mode=3 取快照、条目照常入库,遍历仍走 mode=2)。

**楼中楼(reply/reply,页码式)**:`pn` 从 1 递增,`ps=20`(实测硬上限);判停:`data.page.count` > 0 时 `已取条数 >= data.page.count`;count 缺失或 0 时改用「当页 `replies` 空 + 连续 2 空页」判停(防首页即停);`sort=0` 时间升序(实测健康)。

### 2.3 字段字典(响应 → 入库映射)

评论条目根评论与楼中楼同构。**五个 ID 一律取 `*_str`**——防御对象是 rpid / root / parent / dialog / mid 五类(都有 `*_str` 形态;rpid 已 3.2e11、mid 已 3.5e15,逼近 2^53,JS double 现在无损但必须防未来越线)。例外:`data.upper.mid` 响应中**无 `*_str` 形态**,is_up 由服务端以 `String(upper_mid)` 直读比较(见 is_up 行):

| 响应字段 | 入库列 | 处理规则 |
|---|---|---|
| `rpid_str` | `rpid_str`(UNIQUE) | 树节点主键 |
| `root_str` | `root_rpid` | 根评论='0';楼中楼恒指所在楼根 |
| `parent_str` | `parent_rpid` | 根='0';直回根=根 rpid;回楼内条目=被回复条 rpid |
| `dialog_str` | `dialog_rpid` | 直回根=**自身 rpid**(B 站为免渲染「回复 @根作者」);回楼内条目=被回复条 rpid |
| `mid_str` | `mid_str` | 评论者 mid |
| `member` | `member`(JSON 快照)+ `uname`(冗余列) | 整体快照存 JSON;uname 提一级供列表/正文渲染免拆包;重采整体替换 |
| `content.message` | `message` | 正文原文(含 `[doge]` 表情码、@文本、换行);检索与正文渲染主列 |
| `content` | `content`(JSON) | 整体存(emote/jump_url/pictures/at_name_to_mid/max_line) |
| `like` | `like_count` | 列名避开 SQL 关键字 LIKE |
| `rcount` | `rcount` | 当前**可见**楼中楼数(对账分母的 fallback 来源,实时分母是楼中楼接口 `page.count`,§4.5) |
| `count` | `reply_total` | 历史楼中楼总数(含已删/隐藏,实测可 > rcount:7 vs 8) |
| `ctime` | `ctime_s`(**秒**) | B 站原值 unix 秒;列名显式 `_s` 后缀防与毫秒 *_at 列混算;消费展示时 ×1000 |
| `reply_control.location` | `ip_location` | 解析「IP属地：天津」→ `天津`(按 `/[:：]/` 切末段;**正则必须含全角冒号 U+FF1A,spike 实测线上格式是全角「：」,纯 ASCII 版切不开**);**需登录态 cookie**,匿名实测缺失为 NULL |
| `state` | `state` | 0 正常 / 17 阿瓦隆隐藏(仅自己可见);非零皆异常 |
| `invisible` | `invisible` | boolean(spike 实测 `false`,非 0/1;入库归一 0/1) |
| `folder.is_folded` | `folded` | 该评论自身被折叠(spike 实测 boolean `false`,非 0/1)。不用 `has_folded`——其语义是「该评论存在被折叠的子回复」,OR 归一会把有折叠子回复的正常评论误标 folded=1,导出大面积误标 [已折叠]、折叠率信号失真 |
| `up_action.like` | `up_like` | UP 主觉得很赞(权威字段) |
| `up_action.reply` | `up_reply` | UP 主已回复 |
| `data.upper.mid`(主接口顶层,**无 `*_str` 形态**) | `is_up` | 服务端 upsert 时算:`String(upper_mid) === mid_str`(数值已 3.5e15 逼近 2^53,`String()` 直读防御) |
| `attr` / `floor` / `fansgrade` / `action` / `assist` | 不入库 | attr 语义未解明(文档标注「某属性位?」)、floor 本评论区无、action 是登录态个人操作匿名恒 0 |
| `replies`(内嵌预览) | 一并 upsert | 实测截 3 条且选择不明;入库无害且真实,完整性由楼中楼专翻兜底,对账以专翻为准 |
| `dynamic_id_str` / `note_cvid_str` / `track_info` | 不入库 | 关联动态/笔记,本期无消费场景 |

### 2.4 root / parent / dialog 还原回复链的精确规则

实测对照(调研 C §3,10 样本点):

| 情形 | root | parent | dialog |
|---|---|---|---|
| 根评论 | `'0'` | `'0'` | `'0'` |
| 楼中楼直接回复根 | 楼根 rpid | 楼根 rpid | **自身 rpid** |
| 楼中楼回复楼内条目 Y | 楼根 rpid | Y.rpid | Y.rpid |

还原规则(伪代码):

```
树结构边(parent 还原严格树):
  parent_rpid == '0'              → 顶层节点(根评论)
  parent_rpid != '0'              → 挂到 parent_rpid 节点下

对话对象(dialog 还原「回复 @谁」):
  dialog_rpid == 自身 rpid        → 回复的是根评论作者,展示「回复 @<根作者>」可省略
  dialog_rpid != 自身 rpid        → 回复 dialog_rpid 条目作者,展示「回复 @<dialog 作者>」

三级互复场景(A 根,B 回 A,C/D 回 B):
  B: root=A, parent=A, dialog=B(自身)
  C: root=A, parent=B, dialog=B
  D: root=A, parent=B, dialog=B
  → C 与 D 从三元组无法区分各自回复对象(都是 B);树结构无歧义(parent 定位),
    「具体在跟谁说话」的更细归属本期不追(dialog 已是 B 站产品给出的全部信息)。
```

**边界处理**:

| 边界 | 规则 |
|---|---|
| 父评论被删(楼内孩子健在) | 孩子行保留,`parent_rpid` 原值不动 → 校验器报 `dangling_parent`;树展示时悬空条目上提到楼根下,标注「回复对象已删除」 |
| 根评论被删(整楼悬空) | 楼中楼行保留,`root_rpid` 原值不动 → 校验器报 `orphan_floor`(root 缺失);根行走 missing 两轮确认流程,不连坐删孩子 |
| 折叠条目 | `folded=1` 照常入库,导出正文标注 `[已折叠]` |
| 阿瓦隆隐藏 | `state=17` 照常入库(匿名采集视角下它与正常条目同形,值来自响应),导出正文标注 `[仅自己可见]` |
| 评论区关闭 | `wbi/main` 返回 code 12002 → 归一为 `comments_disabled` 正常终态,回执 `total=0`,不报错不重试 |
| dialog 悬空(dialog 指向的条目既不在库也非自身) | 校验器 `dangling_dialog` 软警告(不阻断),展示时省略「回复 @」前缀 |

### 2.5 置顶 / 热评 / UP 互动的建模归属

- **置顶**:wbi/main 首页 `data.top.{admin,upper,vote}` 三类,映射 `pin_kind = 'admin'|'upper'|'vote'`(置顶条目本身按普通评论 upsert,pin_kind 是附加属性;每轮采集先清后打,见 §3.3)。置顶条目与主列表 rows 重复出现时幂等吸收(同 rpid_str upsert),pin_kind 以 pins 打值为准;置顶不在列表时由 pins 条目本体并入 upsert 兜底(§4.3)。旧接口 `data.upper.top` 不用(接口已换代)。`card_label`「妙评」等运营标签本期不入库(响应里出现时透传进 content JSON 兜底,不建列)。
- **热评**:不单独建模——热度序就是 `mode=3` 首页 `rows` 的排列本身(spike 实测 2026-10-04:wbi/main 响应无 `data.hots` 键,该键属旧接口形态),条目本体必在主列表中;分析用 `like_count` 排序即可还原「热评」语义。
- **UP 互动**:三列承载——`up_like`/`up_reply`(每条评论自带的权威字段)+ `is_up`(评论者即 UP 主,`String(data.upper.mid)==mid_str`);`upper.mid` 随 ingest 请求传入服务端计算(§4.1)。

---

## 3. DB 设计

### 3.1 DDL 草案(可直接贴入 [schema.sql](apps/collector-server/src/db/schema.sql) 末尾,风格对齐现有表)

```sql
-- B 站评论(2026-10-03 用户现场指令一次性解冻,与 2026-08-29 抖音同类;措辞:评论 comment,非弹幕)。
-- 两层树:根评论(root_rpid='0')+ 楼中楼平铺(parent 指向楼内被回复条、root 恒指楼根);
-- dialog 是「回复 @」对话指向(直回根时=自身 rpid,B 站为免渲染「回复 @根作者」)。
-- 五个 ID 一律存 *_str(rpid/root/parent/dialog/mid 都有 *_str;rpid 已 3.2e11、mid 已 3.5e15,逼近 2^53)。
-- upper.mid 无 *_str 形态,is_up 由服务端 String(upper_mid) 直读比较。
-- 幂等 upsert:UNIQUE(rpid_str);重采更新观测列(like/状态/快照),保留首采列(first_seen_at 等)。
-- 删除不物理删:全量重采(仅根评论、仅完整轮,见 missing 对账守卫)连续两轮未见才确认
-- ——missing_since 置值=至少缺席一轮完整全量;
-- last_seen_at < missing_since = 确认缺失(见 db/comments.ts missing 对账)。
-- 时间口径:ctime_s 是 B 站原值 unix 秒(保真,列名 _s 后缀防与毫秒列混算);其余 *_at 列毫秒 epoch(全库惯例)。
CREATE TABLE IF NOT EXISTS comments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  rpid_str       TEXT NOT NULL,
  video_id       INTEGER NOT NULL REFERENCES videos(id),
  root_rpid      TEXT NOT NULL DEFAULT '0',
  parent_rpid    TEXT NOT NULL DEFAULT '0',
  dialog_rpid    TEXT NOT NULL DEFAULT '0',
  is_root        INTEGER NOT NULL DEFAULT 1,  -- root_rpid='0' 冗余派生列(根列表索引前缀/统计免 CASE)
  mid_str        TEXT,
  uname          TEXT,                        -- member 快照冗余列(渲染免拆 JSON)
  member         TEXT,                        -- member 对象 JSON 快照(重采整体替换)
  message        TEXT,                        -- content.message 原文(检索列)
  content        TEXT,                        -- content 对象 JSON(emote/jump_url/pictures/@)
  like_count     INTEGER NOT NULL DEFAULT 0,  -- 点赞数(避 SQL 关键字 LIKE;重采更新)
  rcount         INTEGER NOT NULL DEFAULT 0,  -- 当前可见楼中楼数(根评论;对账分母 fallback,实时分母=page.count §4.5)
  reply_total    INTEGER NOT NULL DEFAULT 0,  -- B 站 count 字段:历史楼中楼总数(含已删,可>rcount)
  ctime_s        INTEGER,                     -- 发布时间,B 站原值 unix 秒!(列名显式 _s 后缀,防当毫秒与 *_at 混算)
  ip_location    TEXT,                        -- reply_control.location 解析(需登录态 cookie)
  state          INTEGER NOT NULL DEFAULT 0,  -- 0 正常 / 17 阿瓦隆隐藏(仅自己可见)
  invisible      INTEGER NOT NULL DEFAULT 0,
  folded         INTEGER NOT NULL DEFAULT 0,  -- folder.is_folded(该评论自身被折叠;has_folded=「有折叠子回复」不并入)
  up_like        INTEGER NOT NULL DEFAULT 0,  -- up_action.like(UP 觉得很赞)
  up_reply       INTEGER NOT NULL DEFAULT 0,  -- up_action.reply(UP 已回复)
  is_up          INTEGER NOT NULL DEFAULT 0,  -- 评论者==UP 主(String(upper_mid)==mid_str,服务端算)
  pin_kind       TEXT,                        -- 置顶:'admin'|'upper'|'vote';NULL 非置顶(每轮先清后打)
  first_seen_at  INTEGER NOT NULL,            -- 首采时刻(毫秒;upsert 保留)
  last_seen_at   INTEGER NOT NULL,            -- 最近一次在响应中见到(毫秒;missing 判定基准)
  first_page     INTEGER,                     -- 首采时主列表页序(仅根评论;诊断用)
  first_sort     TEXT,                        -- 首采排序 'hot'|'time'|'floor'(诊断)
  batch_id       TEXT,                        -- 首采批次 uuid(crypto.randomUUID(),node:crypto 零新增依赖;同轮所有行同值;重采不动)
  missing_since  INTEGER                      -- 首次缺席完整全量轮的扫描起始时刻(毫秒;仅根评论参与、仅完整轮置值);NULL=在库正常
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_rpid ON comments(rpid_str);
CREATE INDEX IF NOT EXISTS idx_comments_video ON comments(video_id, is_root, like_count DESC);
CREATE INDEX IF NOT EXISTS idx_comments_root ON comments(root_rpid);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_rpid);
```

### 3.2 迁移(v20)

纯 `CREATE TABLE/INDEX IF NOT EXISTS`,学 v13 幂等步骤模板([migrate.ts:178-189](apps/collector-server/src/db/migrate.ts#L178)),无 CHECK 重建问题。`MIGRATIONS` 账本追加(当前最新 v19,[migrate.ts:280-302](apps/collector-server/src/db/migrate.ts#L280)):

```ts
{
  version: 20,
  note: 'comments 表新建(2026-10-03 评论采集解冻):B 站视频评论完整分析树,两层(根+楼中楼平铺),UNIQUE(rpid_str) 幂等 upsert,missing_since 单列删除确认语义。双写 schema.sql;新库全量重放安全(CREATE IF NOT EXISTS)',
  statements: [ /* 与 §3.1 DDL 完全一致,双写防漂移 */ ],
},
```

双写纪律:schema.sql 与 v20 statements 逐字一致(全库惯例);[migrate.test.ts](apps/collector-server/src/db/migrate.test.ts) 的「新库重放 + 旧行为」断言模式照跑。

### 3.3 幂等 upsert 语义

`db/comments.ts` 导出 `upsertComments(db, videoId, upperMid, replies, opts)`,单事务批量:

```
对每条 reply(rpid_str 为键):
  存在(SELECT idx_comments_rpid 命中)→ UPDATE:
    更新列:like_count, rcount, reply_total, state, invisible, folded,
            up_like, up_reply, is_up(按本请求 upper_mid 重算),
            mid_str, uname, member, message, content, ip_location, ctime_s,
            last_seen_at = opts.fetched_at
    保留列:id, video_id, first_seen_at, first_page, first_sort, batch_id,
            pin_kind(upsert 不写;置顶唯由 full 轮 clearAndSetPins 先清后打承担,
            增量轮天然保留,§3.3 置顶清打段),
            root_rpid/parent_rpid/dialog_rpid(关联三元组理论上不变,不改写——
            防御性保留首采值,避免上游异常形态污染已还原的树;
            例外:若库内现值违反 R0 而本轮新值自洽,以新值修正并打 [store] 修正日志,
            不自洽脏数据不固化,§5.1 R0)
  不存在 → INSERT 全列(first_seen_at = last_seen_at = fetched_at,
            first_page/first_sort/batch_id = 本轮值)
返回 { inserted, updated }
```

**置顶清打**:每轮 ingest,若请求带 `pins` 数组,先 `UPDATE comments SET pin_kind=NULL WHERE video_id=? AND pin_kind IS NOT NULL`,再按 pins 打值(置顶撤销/换条目自然生效)。仅 full 轮携带 pins;incremental 轮不发 pins、不动 pin_kind(置顶撤销/更换在下次 full 轮生效,可接受)。

**missing 对账**(仅全量轮,请求带 `full_scan: true` + `scan_start`;**仅根评论参与**——楼中楼可达性依附根:根被删后楼中楼结构性不可达,若对楼层也做 missing 判定,整楼孩子会在两轮后被误判「确认缺失」而从导出消失,与 §3.4 不丢弃策略直接矛盾):

**完整轮守卫**(三条,任一不满足则本轮视同 partial,`full_scan: false`):
1. 仅**完整轮**才允许触发 full_scan 对账:主列表翻到 `is_end`,且未触发风控终止 / 空页可疑判停;partial 轮照常 ingest 数据但 `full_scan: false`(不更新 missing 水位);
2. 伪完整轮守卫(判定时点=楼中楼翻全后):`is_end=true` 但 `本轮库内活跃评论总行数(根+楼,扣除确认缺失)× 1.2 < max(all_count, stat.reply)` → 判 suspicious(疑似风控软过滤截断),该轮视同 partial,不触发对账,回执 `partial_reason:"suspicious_truncation"`;**口径注**:all_count/stat.reply 是评论总量口径(根+楼),不得与根数直比——否则对任何有楼视频恒触发(与 R9 同口径,§5.1;2026-10-04 C1 实现时修正);
3. 确认缺失(≥2 轮)必须两轮都是完整轮——候选置值轮与「仍未再见」的比对轮缺一不可,partial 轮不参与计数。

```sql
-- 首次缺席 → 置候选(仅根评论)
UPDATE comments SET missing_since = :scan_start
 WHERE video_id = :video_id AND is_root = 1 AND missing_since IS NULL AND last_seen_at < :scan_start;
-- 本轮重新见到 → 恢复(仅根评论)
UPDATE comments SET missing_since = NULL
 WHERE video_id = :video_id AND is_root = 1 AND last_seen_at >= :scan_start;
```

语义:`missing_since IS NOT NULL` = 至少缺席一轮完整全量;`last_seen_at < missing_since` = 置值后仍未再见到 = **确认缺失(≥2 轮,两轮均完整轮)**。单列承载两档,校验器分别报告(§5.1 R7,仅统计根)。

### 3.4 孤儿评论(根被删)与树完整性策略

- **不级联删除**:根确认缺失(missing 确认)不删楼中楼孩子——孩子是独立真实评论,`root_rpid` 原值保留即可定位其所属历史楼层;
- 校验器把「根确认缺失 + 孩子健在」报为 `orphan_floor_rows`(§5.1 R7),导出正文将其归组到「根已删除」虚拟分组,不丢弃;
- 不引入外键 ON DELETE(videos 行删除不在系统能力内,无级联场景;对齐全库 `REFERENCES x(id)` 无 ON DELETE 的写法)。

---

## 4. 采集设计

### 4.1 通路与写库决策

```
collector-cli comments collect(宿主 CLI 进程)
  ├─ 读:server HTTP  GET /api/videos/bilibili/<bvid>   → video_id + extra.aid(+ title)
  │        extra.aid 缺失 → 宿主直连 GET view?bvid= 回查 aid + stat.reply(D8)
  ├─ 采:B 站直连(宿主进程内,复用 asr-net.ts 网络层 + wbi.ts 签名 + cookie 通路)
  └─ 写:server HTTP  POST /api/comments/ingest        → upsert 入生产库
```

「server 不直连平台」分工不变:直连只发生在宿主 CLI 进程内([asr-bili.ts:5](apps/collector-server/src/cli/asr-bili.ts#L5) 注释同款定性)。写库必须走 server(生产库在 docker volume,宿主无文件;[cli/db.ts:1-2](apps/collector-server/src/cli/db.ts#L1)「CLI 永不写库」)。

**ingest 端点**(新建 [http/comments.ts](apps/collector-server/src/http/comments.ts),对齐 [http/asr.ts](apps/collector-server/src/http/asr.ts) 模式):

```
POST /api/comments/ingest   (Bearer 鉴权,同既有端点)
{
  "bvid": "BV1KmHb6JEFS",
  "oid": "117373419915771",          // aid,type 恒 1
  "upper_mid": "3493260618106936",   // 主接口 data.upper.mid
  "fetched_at": 1727913600000,       // 毫秒
  "batch_id": "…",                   // crypto.randomUUID()(node:crypto,零新增依赖;禁引入 uuid npm 包)
  "sort": "time",                    // 本轮主列表排序(mode=2 时间序;'hot'=仅首页快照场景,§2.2)
  "page": 3,                         // 本批所处主列表页序(仅根评论批)
  "full_scan": false,                // 全量轮 true(触发 missing 对账)
  "scan_start": 1727913600000,       // 全量轮扫描起始毫秒
  "pins": [{"rpid_str": "...", "kind": "upper"}],
  "replies": [ /* §2.3 映射前的原始条目子集:五 ID *_str(rpid/root/parent/dialog/mid)/member/content/like/count/rcount/
                  ctime/state/invisible/folder/up_action/reply_control(服务端解析归一,
                  CLI 只砍不用的顶层键以控传输体量) */ ]
}
→ 200 { ok: true, video_id: 42, inserted: 57, updated: 0 }
→ 404 { ok: false, error: "video not found: bilibili/BV1..." }   // 评论挂在 videos.id,先采视频
→ 400 { ok: false, error: "replies: [...] required" }

GET /api/comments/count?bvid=   (Bearer 鉴权;读端点,读 GET/写 POST 惯例)
→ 200 { ok: true, rows: 1893, roots: 95, max_ctime_s: 1727913600 }   // 评论行数/根数/最大发布时间秒(仅根——楼追新 ctime 不抬水位,防增量首页即判停)
→ 200 { ok: true, rows: 0, roots: 0, max_ctime_s: null }             // 视频在库但未采过评论(非 404)
→ 404 { ok: false, error: "video not found: bilibili/BV1..." }
// 模式判定(auto 按 rows 分流)与增量水位(max_ctime_s)都依赖它(§4.3 步 0)
```

### 4.2 CLI 参数表(`comments collect`)

| 参数 | 默认 | 说明 |
|---|---|---|
| `--bvid <BV>` | 与 `--aid` 至少其一 | B 站视频 BV 号;先查 server 已入库视频。与 `--aid` 同给时交叉校验(见 `--aid` 行) |
| `--aid <n>` | — | av 号直给。与 `--bvid` 同给时交叉校验:与库内 `extra.aid` 或 view 回查结果不一致 → ARGS 退 2;单给 `--aid` 时:`GET view?aid=` 回查 bvid + stat.reply,再按 bvid 走库定位(查不到报 `video_not_found`) |
| `--mode <auto\|full\|incremental>` | `auto` | `full`=时间序全量游标遍历+missing 对账;`incremental`=时间序追新+本轮所见根 rcount 增长楼重翻(老根靠 `--refresh-roots`);`auto`=该视频库内 0 行→full,否则 incremental |
| `--sort <hot\|time>` | `time` | 主列表排序,仅 full 下可 hot/time 二选,默认 time(mode=2 时间序遍历);`hot`=仅首页按 mode=3 取热评快照(条目照常入库),遍历仍走时间序——热度序遍历已废弃(位移漏采,§2.2)。与 `--mode` 冲突时以 `--mode` 语义为准 |
| `--max-pages <n>` | `0`(不限) | 主列表页数上限(小样本试跑 / 控时长;0=以游标判停为准) |
| `--max-floor-pages <n>` | `0`(不限) | 单楼翻页上限,默认 0=不限:热门视频千层楼常见,400 条/楼兜底会静默截断正常内容;死循环防护已由 page.count 判停+空页判停+打转护栏覆盖。显式设值触顶 → 回执 `partial:true` + `partial_reason:"floor_pages_cap"`,mismatch 明细注记 truncation(§4.4) |
| `--refresh-roots <n>` | `0` | 增量轮附带:按库内 like_count 降序取 top-N 根强制重翻其楼中楼全部页(顺带刷新根与楼内 like_count、补抓新楼中楼)。语义边界:默认 0 时增量轮**不追老楼新回复**(老根不在时间序窗口内,无实时 rcount 可比)——显式设计决策;推荐日常增量 `--refresh-roots 50` |
| `--max-requests <n>` | `600` | 单轮请求总量预算(B 站无官方限速数值,以事前预算防 -412 IP 级升级风控与日累计失控);超预算 → 判停 partial + `partial_reason:"request_budget"`(§4.4/§8.1) |
| `--bvid-file <path>` | — | 批量采集:每行一个 BV,进程内串行 + 视频间 5s 固定间隔;任一视频失败不阻断后续,回执 per-video 数组报告(代码化批量入口,防会话内易失编排;与 `--bvid`/`--aid` 互斥) |
| `--dry-run` | off | 拉取与解析照跑、日志照打,不调 ingest;回执 `dry_run:true`,store 段改为 `would_requests/rows` 计数 |
| `--cookie-file <path>` | `$COLLECTOR_BILI_COOKIE_FILE` | Cookie 文件(文本原样作 Cookie 头;**必配**,缺失 ARGS 退 2——wbi/main 签名需 nav 取 key,实测匿名 nav 恒 -101,早失败优于半途失败;错误信息附 `scripts/bili-cookie-from-chrome.mjs` 指引) |
| `--page-interval-ms <n>` | `2000` | 页间隔基数(实际 ±30% 抖动 1400–2600ms,见 §8.1) |
| `--batch-size <n>` | `200` | 每次 ingest 请求携带的条数上限 |

### 4.3 采集编排伪代码

```
collect(bvid, mode, ...):
  # 0. 定位
  video = serverGetVideo(bilibili, bvid)            # 无 → NOT_FOUND 退 5,提示先采视频
  aid = video.extra.aid ?? view(bvid).aid           # 回查顺手拿 stat.reply 哨兵
  cookie = loadCookie()                             # 必配(§4.2)
  wbiKeys = nav(cookie) → extractKeysFromNav        # 进程内缓存(跨视频复用,asr 先例)
  cnt = GET /api/comments/count?bvid=               # { rows, roots, max_ctime_s }(§4.1,随 C2 端点)
  if mode == auto: mode = (cnt.rows == 0) ? full : incremental

  # 1. 根评论遍历(全量/增量一律 mode=2 时间序,§2.2)
  if mode == full:
    cursor = {"offset": ""}; page = 0; emptyPages = 0
    loop:
      page++; q = encWbi({type:1, oid:aid, mode:2, plat:1, web_location:1315875,
                          pagination_str: JSON.stringify(cursor)}, keys)
      r = fetchBiliJson(`https://api.bilibili.com/x/v2/reply/wbi/main?${q}`)
      [fetch] 日志(§4.7) → replyDiag(r)
      if r.code == 12002 → comments_disabled 正常终态 break
      rows = parseMain(r.data)                       # [parse] 命中计数
      if rows 空: emptyPages++; if emptyPages >= 2 → partial 判停 break
        # empty_pages_suspicious:游标在动但内容恒空(删除/软过滤已知形态),空转烧配额,§4.4
      else: emptyPages = 0
      pins = parseTop(r.data.top)                    # 首页一次
      buffer.push(...topEntries)                     # 置顶条目本体并入 upsert(否则置顶不在列表时
                                                     #  首轮不入库、pin_kind 指向空,§2.5)
      buffer.push(...rows, ...rows[].replies 预览一并)
      flush(buffer, batch_size)                      # [store] 分批 ingest(page=page)
      cursor = { offset: r.data.cursor.pagination_reply.next_offset }   # 原文透传包裹,附录 A 裁定①
      if !cursor || r.data.cursor.is_end || (--max-pages 达到) break
    # 伪完整轮守卫(楼中楼翻全后):活跃总行数×1.2 < max(all_count, stat.reply)
    #   → suspicious_truncation,该轮视同 partial(§3.3)
    complete = is_end_reached && !risk_abort && !suspicious_truncation
    if complete: ingest({full_scan: true, scan_start: 起始时刻, pins})   # missing 对账(仅根)
    else:        ingest({full_scan: false})          # partial 轮不发 missing 对账(§3.3 守卫)
  else:
    watermark = cnt.max_ctime_s                       # 增量水位(unix 秒;rows==0 不该走 incremental)
    cursor = {"offset": ""}; page = 0; emptyPages = 0
    loop:
      page++; q = encWbi({... mode:2, pagination_str: cursor ...})
      rows = parseMain(...); buffer.push(...)
      flush(...)
      if rows 空: emptyPages++; if emptyPages >= 2 → partial 判停 break   # 同上(§4.4)
      if rows 非空 && min(rows[].ctime_s) <= watermark → break    # 命中水位
      if !next_offset || is_end → break
    # direction 已裁定不携带(spike 2026-10-04,附录 A 裁定②):mode=2 恒最新在前,
    # 水位判停逻辑不变,无回退分支。
    # incremental 轮不发 pins、不动 pin_kind(置顶撤销/更换在下次 full 轮生效,§3.3)

  # 2. 楼中楼翻全(根评论行,含本轮新抓)
  roots = buffer 中 is_root 行 + (incremental 时)本轮 buffer 中 rcount > 库内已采楼数的根
          # 仅新根/本轮见到的根参与增长判定;老根增长靠 refresh-roots(§4.2),
          # 增量轮默认不追老楼新回复(老根不在时间序窗口内)
  for root in roots:
    if incremental && root.rcount <= serverFloorCount(root.rpid_str) && !被 refresh-roots 选中:
        continue                                     # 楼无增长,跳过
    floorPage(root, pn=1..):                        # §4.5
      rows = parseFloor(...)
      buffer.push(...rows); flush(...)
      判停见 §4.4(count>0: got>=page.count;count 缺失/0: 当页空+连续 2 空页;
                   显式 --max-floor-pages 触顶 → floor_pages_cap)

  # 3. refresh-roots(增量轮附带,默认 0 不跑)
  for root in serverTopLikeRoots(bvid, n): floorPage(root, 1..)
          # serverTopLikeRoots = 库内 like_count 降序 top-N;强制翻,同上循环

  # 4. 收尾
  verify = GET /api/comments/verify?bvid=(只读校验查询;读 GET/写 POST 惯例,verify 无副作用)
           → collect 回执内嵌 verify 结果,C4 消费
  emitResult(回执 §4.8)
```

### 4.4 翻页终止条件表

| 循环 | 正常判停 | 上限保护 | 异常判停 |
|---|---|---|---|
| 主列表 full | `cursor.is_end===true` 或 `pagination_reply.next_offset` 缺失 | `--max-pages` | code 12002(关评,正常终态)/ 风控三档退避后仍失败(终止,部分数据已入库)/ 连续 2 页 rows 空(`partial_reason:"empty_pages_suspicious"`)。凡非 is_end 终止均为 partial 轮,**不发 missing 对账(ingest `full_scan:false`,§3.3)** |
| 主列表 incremental | 页内 `min(ctime_s) <= 水位` | 同上 | 同上(含连续 2 空页判停,该轮视同 partial) |
| 楼中楼 | `count>0`:`got >= data.page.count`;count 缺失/0:当页 rows 空 + 连续 2 空页(防首页即停) | `--max-floor-pages`(默认 0 不限;显式设值触顶 → `partial_reason:"floor_pages_cap"`,mismatch 注记 truncation) | 风控/网络同上 |
| 全局 | — | 请求预算 `--max-requests`(默认 600)超 → 判停 partial + `partial_reason:"request_budget"`(事前预算,§8.1);单轮 ingest 请求失败 ≥3 次连败 → 终止,回执 `partial:true` | fetch 网络层异常复用 fetchBiliJson 归一 |

防打转护栏:主列表游标若连续 2 页 `next_offset` 相同 → 视为服务端异常,终止并 `[fetch]` 报告游标值(日志可观察优先于猜测)。mode=2 链实测游标逐页变化(内嵌剩余计数递减),护栏安全;注意 mode=3 的 token 恒定是设计使然(实测同 token 重复发送持续出新页),护栏只对 mode=2 遍历生效(附录 A.2)。

### 4.5 楼中楼翻全算法

```
floorPage(root, pn):
  url = /x/v2/reply/reply?type=1&oid={aid}&root={root.rpid_str}&pn={pn}&ps=20&sort=0
  r = fetchBiliJson(url)                       # 无 wbi 要求,直连即可;带 cookie 保字段全
  [fetch] floor root=... pn=... http=200 code=0 rows=N page_count=M
  data.page.count = 该楼可见二级评论数(对账分母;缺失或 0 → 不用 got>=count 判停,
                    改「当页 rows 空 + 连续 2 空页」判停,防首页即停)
  got += rows.length
  判停见 §4.4
```

`count`(reply_total,历史含删)只入库不对账;对账分母统一为楼中楼接口 `data.page.count`(实时权威)——`rcount` 是库内快照(来自主列表响应,可缓存陈旧),仅作 count 缺失/0 时的 fallback 并在 mismatch 明细注记分母来源。实测同一楼 count=8 > rcount=7,拿历史总数当分母会把正常楼永远判为「未抓全」。实采 > 分母时缺口 clamp 为 0 并计 `overshoot`(双来源:楼中楼专翻 + 主列表预览,重复条目幂等吸收但计数可暂时超)。

### 4.6 限速 / 退避 / 错误码处置

| 项 | 处置 |
|---|---|
| 页间隔 | `--page-interval-ms` 2000ms 基数,每页实际 `2000 × (1 + random(-0.3..0.3))` ms(1400–2600ms 抖动,下限不破自引 MediaCrawler 1.0s 基线);主列表与楼中楼同规格 |
| 风控退避 | 复用 `withRiskRetry`([asr-net.ts:31-43](apps/collector-server/src/cli/asr-net.ts#L31)),三档 30s/120s/300s;标签 `[comments]`。事实基线:现网 `isRiskControl`([asr-bili.ts:66-68](apps/collector-server/src/cli/asr-bili.ts#L66))只认 HTTP 412 与 `bili_-412`,`parseBiliJson` 把 -352/-799/-509 归入兜底分支 `bili_<code>`(risk=false),`withRiskRetry` 对 -352 一次都不退避——本期扩展 `isRiskControl` 识别 `bili_-352 / bili_-799 / bili_-509`(对 ASR 链路是行为超集、无回归;`asr-bili.test.ts` 补三个分类用例) |
| code -352 | 风控校验失败(UA/cookie buvid 缺失;签名错误是 -403 特有码,不写进 -352 语义防误导排查)——退避重试;三档后失败则终止本轮,回执 `partial:true` + 失败页码,stderr 给排查顺序(签名→UA/Referer→cookie buvid3/SESSDATA 有效性,§8.4);**不做 gaia 自动化** |
| code -403 | wbi 签名错误特有码(评论 main 接口)→ **不退避**,直接强刷 wbi keys(nav 重取,key 每日更替)重试一次;再失败终止 |
| code -412 / HTTP 412 | IP 级拦截 → 退避;三档后失败终止,stderr 明示「换网络环境/降频后再跑」 |
| code -101 | 需登录 → cookie 失效(SESSDATA ~1 个月有效期),stderr 指引 `node scripts/bili-cookie-from-chrome.mjs --refresh` 重取 cookie;终止 |
| code -799/-509 | 频率超限 → 经 `withRiskRetry` 统一三档退避(isRiskControl 扩展后),不再单独实现翻倍逻辑;三档后失败终止 |
| code 12002 | 评论区已关闭 → 正常终态(§2.4) |
| HTTP 非 2xx / 畸形体 | fetchBiliJson 已归一(fetch_error/解析分类),不裸抛 |

### 4.7 观察性日志设计(CLAUDE.md §9 逐条落地)

全部走 stderr(复用 `logInfo`,`-q` 抑制);`[step]` 前缀;任何失败必带响应特征,禁止「解析失败(反爬?)」式盲报。格式样例:

```
[comments] BV1KmHb6JEFS aid=117373419915771(来源=extra.aid) mode=full sort=time cookie=~/Local/collector-secrets/bili-cookie.txt
[fetch] main page=1 http=200 code=0 bytes=48211 roots=20 previews=37 top=upper all_count=1893 is_end=false
[parse] main page=1 根评论 20/20 member 20/20 content 20/20 ctime 20/20 like 20/20 | 预览 37/37 | emote=5 pics=0
[store] batch#1 → POST /api/comments/ingest inserted=57 updated=0(累计 57/0,请求数 1)
[fetch] main page=2 http=200 code=0 bytes=45012 roots=20 previews=41 top=- all_count=1893 is_end=false
[floor] root=315853861041 rcount=7 count=8 → 翻页中
[fetch] floor root=315853861041 pn=1 http=200 code=0 rows=7 page_count=7
[store] batch#10 → inserted=93 updated=0(累计 1893/0,请求数 10)
[verify] roots=95 floors=1798 orphan_floor=0 dangling_parent=0 dangling_dialog=2 rcount_mismatch=3 coverage=0.987
[comments] 完成:总 1893(根 95 + 楼 1798,置顶 1 计入根)B 站请求 116(nav 1 + main 5 + floor 110)耗时 3m52s 页均 2.0s
```

**`replyDiag(data)` 页面特征函数**(对位 [youtube-collect-videos.mjs](scripts/youtube-collect-videos.mjs) 的 `pageDiag`,任何「内容不符预期」失败必带):

```
replyDiag(data) →
  `diag keys=[${Object.keys(data).sort().join(',')}]`
  + ` page=${JSON.stringify(data.page ?? null)}`          // 归零空壳特征:全 0 + replies null
  + ` replies=${Array.isArray(data.replies) ? data.replies.length : String(data.replies)}`
  + ` cursor=${data.cursor ? `is_end=${data.cursor.is_end},all_count=${data.cursor.all_count}` : 'null'}`
  + ` voucher=${data.v_voucher ? 'present(风控凭证!)' : '-'}`
```

分步标签与输入输出计数对照 §9 三要素:`[fetch]`=HTTP 状态与响应特征(bytes/code/形态键集);`[parse]`=结构命中计数(字段命中率 x/total,命中率 <100% 时附带缺失样本 rpid 列表 ≤5 个);`[store]`=每步输入输出计数(inserted/updated/累计)。`[filter]` 对位物是楼中楼跳过判定:`[floor] skip root=... rcount=7 已采=7(无增长)`。

### 4.8 断点续采与幂等

- **行级幂等**:`UNIQUE(rpid_str)` upsert,任何时刻重跑安全(重复条目变 UPDATE);
- **中途失败**:已 flush 的批次已入库,重跑按 mode 语义续——full 重跑=重来一遍(全量幂等吸收);incremental 重跑=水位未变时追同一批新评论(幂等吸收);
- **无断点文件**:评论单视频一轮 10 分钟量级(§8.1:典型 8-9 分钟,最坏 20 分钟+),不做游标持久化(复杂度不划算);批间 flush 已保证丢失面 ≤ 一个 batch(200 条的拉取,约 10 页);
- **回执**(stdout,机器可读):

```json
{
  "ok": true, "dry_run": false, "partial": false,
  "video": { "bvid": "BV1KmHb6JEFS", "aid": 117373419915771, "title": "…" },
  "mode": "full", "sort": "time",
  "pages": { "main": 5, "floor": 110 },
  "fetched": { "roots": 95, "floors": 1798, "previews": 137, "pins": 1, "total": 1893 },
  "store": { "inserted": 1893, "updated": 0, "requests": 10 },
  "bili_requests": 116, "elapsed_ms": 232000,
  "missing": { "candidates": 0, "confirmed": 0 },
  "verify": { "coverage": 0.987, "rcount_mismatch": 3, "orphan_floor": 0, "dangling_parent": 0 },
  "stat_reply": { "view": 1893, "all_count": 1893 }
}
```

示例口径自洽:total = roots + floors = 1893(置顶计入 roots,pins 单列不加和;预览不计 total);pages.main = ceil(roots/20);store.inserted(full 首采)= total;store.requests = ceil(total/batch-size);bili_requests = nav 1 + main 5 + floor 110(Σceil(rcount/20));耗时 = bili_requests × 页均间隔 2s ≈ 3m52s。`partial:true` 时附 `partial_reason`,取值:`"suspicious_truncation"`(§3.3)/ `"empty_pages_suspicious"`(§4.4)/ `"request_budget"`(§4.2)/ `"floor_pages_cap"`(§4.2);风控三档退避尽终止亦为 partial(失败页码见 [fetch] 日志)。

### 4.9 wbi/main 连通性 spike(落地第一步,C0)

实测(调研 C)基于旧接口;`/x/v2/reply/wbi/main` 的 `pagination_str` 内部结构(`type=1/data:{pn}` vs `type=3/Data:{cursor}` 大小写)取自文档冻结版镜像,未实机验证。**C0 spike(人工,1 个视频 2-3 页)**:cookie 就绪后 curl/node 直跑 wbi/main 首页 + 翻一页,核对清单:① `cursor.pagination_reply.next_offset` 原文与 mode=2 的 offset 形态(direction 是否携带于 offset JSON 内部而非 URL 参数——wbi/main 参数表无此项,§4.3 回退分支依赖此结论);② 置顶条目是否在主列表 rows 中重复出现(影响 buffer 并入的幂等预期,§2.5);③ >2 层对话链上 dialog 的指向(被回复条 vs 对话链头——§2.4 渲染规则的实证;若为链头语义,§2.4「回复 @」展示规则按实测修正);④ `data.upper.mid` 的 JS 类型(number|string——数值已 3.5e15 逼近 2^53,is_up 计算须 String() 直读防御,§2.3)。结论回填本文档附录「Spike 实录」(对齐 `docs/plans/douyin/spike-findings.md` 模式)。三级 fallback(逐级降):① 镜像文档结构不符 → 抓 Chrome DevTools 里 web 真实请求的 pagination_str 照抄;② wbi/main 整体不通 → 退回旧接口 `sort=2&pn` 深翻(实测归零,基本不可能,仅登记);③ 扩展 navigate 页面上下文取数(抖音 R1 先例,成本最高,最后手段)。

---

## 5. 树完整性与校验

### 5.1 校验规则(实现在 `db/comments.ts` 的 `verifyTree(db, videoId)`,纯 SQL+JS 可测)

| # | 规则 | 判定 | 级别 |
|---|---|---|---|
| R0 | 关联三元组自洽 | 根行要求 `is_root=1 AND root_rpid='0' AND parent_rpid='0'`;楼行要求 `root_rpid!='0' AND is_root=0` | error(计 triple_inconsistent) |
| R1 | root 缺失 | 非根行 `root_rpid!='0'` 且库内无该 rpid 行 | error(计 orphan_floor) |
| R2 | parent 悬空 | `parent_rpid!='0'` 且无对应行 | error(计 dangling_parent) |
| R3 | dialog 悬空 | `dialog_rpid!='0'` 且 `!=自身 rpid` 且无对应行 | warn(dangling_dialog) |
| R4 | rcount 对账 | 每根:实采楼数 vs 分母=楼中楼接口 `data.page.count`(实时权威;缺失/0 时 fallback 根行 `rcount`,mismatch 明细注记分母来源);缺口 = max(0, 分母−实采),实采>分母 clamp 为 0 并计 overshoot | 缺项列表(取 top 10 样本,注记分母来源)+ 汇总 coverage |
| R5 | 字段自洽 | `reply_total < rcount` 的行(历史总数 < 可见数,必是异常) | warn |
| R6 | 重复 rpid | `COUNT(*)` vs `COUNT(DISTINCT rpid_str)`(UNIQUE 约束下恒等,防御性断言) | error(恒 0,触发即库损坏) |
| R7 | missing 分档 | `missing_since IS NOT NULL` 计数(candidates,仅根评论);其中 `last_seen_at < missing_since` 计数(confirmed,即 ≥2 轮缺席,两轮均须完整轮) | info |
| R8 | 时序异常 | 楼中楼行 `ctime_s < 根行 ctime_s`(回复早于根) | warn |
| R9 | 总量哨兵 | 库内活跃评论行数(全部行扣除确认缺失根)vs `max(all_count, view stat.reply)`,相对偏差 >10% | warn(计 root_count_gap);注:all_count/stat.reply 为评论总量口径(根+楼),不与根数直比(2026-10-04 C1 修正,原「活跃根数」口径对有楼视频恒报警) |

R9 存在理由:coverage 只覆盖已见根、检不出「整条漏根」(翻页位移/软过滤),根数哨兵以总量对账补这个盲区。

### 5.2 校验入口

1. `comments verify --bvid <BV>` 子命令:DB 只读(走 `openDbOrEmit`,并**把 comments 组加入 [db.ts:29-42](apps/collector-server/src/cli/db.ts#L29) 的 DB-only 警告组**,显式 `--server` 时提示走快照);建议 `--format json`(嵌套回执 table 形态不可读)。
2. `collect` 收尾自动跑(经 server 端点 `GET /api/comments/verify?bvid=` 只读查询——全仓读 GET/写 POST 惯例,verify 无副作用),结果内嵌回执 `verify` 段。

### 5.3 统计输出(verify 回执)

```json
{
  "ok": true, "bvid": "BV1…",
  "counts": { "roots": 95, "floors": 1798, "total": 1893, "pins": 1,
               "missing_candidates": 0, "missing_confirmed": 0 },
  "integrity": { "orphan_floor": 0, "dangling_parent": 0, "dangling_dialog": 2,
                  "rcount_mismatch": 3, "rcount_mismatch_samples": ["315…(缺 2,分母=page.count)", "…(缺 1,分母=rcount fallback)"],
                  "time_anomaly": 0, "dup_rpid": 0, "triple_inconsistent": 0,
                  "root_count_gap": 0, "overshoot": 0 },
  "depth": { "max": 3, "histogram": { "1": 1502, "2": 280, "3": 16 } },
  "like": { "p50": 1, "p90": 12, "p99": 210, "max": 917, "zero_pct": 0.41 },
  "coverage": { "floor_covered": 1798, "floor_expected": 1821, "ratio": 0.987 },
  "up": { "up_replied": 23, "up_liked": 41, "is_up_rows": 3 },
  "ip": { "known_pct": 0.93, "top": [["上海", 210], ["北京", 187]] }
}
```

树深度按 parent 链算(楼内互复链可 >2);coverage = Σ min(实采, 分母) / Σ 分母(分母 = 楼中楼接口 page.count,缺失/0 时 fallback 根行 rcount;分母 ≤0 的楼不计入分子分母)。

---

## 6. 消费端

### 6.1 导出格式论证与推荐

| 方案 | 优点 | 缺点 |
|---|---|---|
| A. 嵌套 JSON 树 | 结构直观、无重复外键 | 深嵌套难流式/逐行处理;分析会话要剥壳;md 转换需遍历;体量虚大(每层重复容器) |
| B. 扁平节点表 + 独立边表 | 关系精确、图分析友好 | 消费方必须自行 join 两张表才见树,分析会话成本高;边表对本数据是冗余(边已在 parent 字段里) |
| **C. 扁平数组 + 边内嵌(推荐)** | 每条自带 root/parent/dialog,边即字段、无需边表;行式结构与人读正文、videos/*.txt 同哲学;按 root 分组即得两层树 | 树形不「一眼可见」——由 md 正文承担人读树形,json 承担机器口径 |

**推荐 C**:评论实测仅两层(根 + 楼中楼平铺,调研 C §4),嵌套收益趋零;且库本身是结构化 source of truth(§0 D7),bundle 里再放一份完整 JSON 违背「manifest 摘要 + 人读正文」的原料包定位。**导出物 = manifest 摘要字段 + `comments/<BV号>.md` 正文,两件**。

### 6.2 manifest 新字段([bundle.ts](apps/collector-server/src/cli/bundle.ts) `BundleVideoEntry` 增补,对齐 `view?: number` 省略哲学)

```ts
export interface BundleCommentsMeta {
  file: string;              // "comments/<BV号>.md" 相对 bundle 根
  roots: number;             // 根评论数(含置顶)
  total: number;             // 总条数(根+楼中楼)
  coverage: number;          // 楼中楼覆盖率 0-1(§5.3 口径)
  like_top: number;          // 最高赞数
  last_collected_at: number; // MAX(last_seen_at) 毫秒
}
// BundleVideoEntry 增: comments?: BundleCommentsMeta   ← 库内 0 评论时省略字段,'comments' in v 判别
```

实现要点:批量 IN 查询防 N+1(对齐 `videoExtrasByVideoIds` 先例 [bundle.ts:185-215](apps/collector-server/src/cli/bundle.ts#L185));统计一次 GROUP BY 算全量视频。存量 bundle 不回填(历史原料忠实性,consumption-loop 定案口径)。

### 6.3 `comments/<BV号>.md` 正文格式

```markdown
# 评论区 · 霸凌の意志
> BV1KmHb6JEFS · 采集 2026-10-03 · 共 1893 条(根 95 / 楼中楼 1798,覆盖率 98.7%,最高赞 917)
> 根评论按点赞降序;楼中楼组内按时间。`[已折叠]` `[仅自己可见]` 为平台状态标注。

## 【赞 917】@用户A · IP属地:上海 · 2026-09-30 · UP主已回复
正文……

- 【赞 19】@用户B · IP属地:广东:回复内容……
  - 【赞 5】@用户C 回复 @用户B:……
- 【赞 4】@用户D:……

## 【赞 585】@用户E · ……
……

## 根已删除的楼层(2 条)
- 【赞 1】@用户F:……(父评论已删除)
```

规则:根分组按 `like_count` 降序(高赞优先供分析);组内按 ctime_s 升序;缩进层级按 parent 链(≤3 层,更深拍平并保留「回复 @」前缀);`state=17`→`[仅自己可见]`,`folded=1`→`[已折叠]`;`missing` 确认行不出(不在库);UP 主发的评论(`is_up=1`)在昵称后加 `(UP主)` 标注。

### 6.4 ANALYZE.md 模板增补([analyze-template.ts](apps/collector-server/src/cli/analyze-template.ts),单一事实源)

- **盲区模型第四类**:「评论区盲区——manifest 无 `comments` 字段 = 该视频未采评论(评论区关闭/未采集);有 `comments` 但 `coverage < 1` = 部分楼中楼缺失,对账清单在 comments verify 可查」;
- 观点汇总模板增可选段:「评论区共识信号(如已导出评论):高赞评论与 UP 观点的呼应/对立;注意评论区样本偏差(粉丝向/情绪向)」;
- 出处格式约定:`> 来源: <视频标题> 评论区 @<用户>`。

### 6.5 评论维度能回答的分析问题

- 观点汇总的**群众侧**:UP 说 X,高赞评论买不买账(共识/分歧第二数据源);
- 争论结构:dialog 链长分布 → 哪些话题在吵架;`up_reply`/`up_like` → UP 主下场互动的位置;
- 受众画像:IP 属地分布、member 等级分布、ctime 直方图(发布即热 vs 长尾);
- 内容质量信号:`state=17` 阿瓦隆隐藏率、折叠率 → 评论区管控强度;
- 面试题库/理念整理:评论区补充面经、纠错、粉丝实践反馈。

`export bundle` 不加新 flag:评论有则随视频导出(与 `subtitle: null` 哲学一致——数据在库就进原料);体量担忧不成立(100 视频 × 2000 条 × ~100B ≈ 20MB md,可接受)。

---

## 7. 测试计划(collector-server 口径:c8 node --test --import tsx,全中文测试名 + 注释三档 + 覆盖率锁定 + 回归纪律)

### 7.1 测试文件与用例清单

| 文件 | 层 | 核心用例 |
|---|---|---|
| `src/cli/bili-comments.test.ts` | 解析纯函数 | parseMain 正常/归零空壳/关评 12002/风控 voucher 形态;parseReplyRow 五 ID 取 \*_str、location 解析、folder 归一(is_folded 为准,has_folded 不并入)、预览条目标记;parseTop 三类置顶;replyDiag 输出含 keys/page/replies/voucher;游标推进(next_offset 透传/缺失判停) |
| `src/cli/asr-bili.test.ts`(增补) | 解析分类 | isRiskControl 风险码超集三分类用例:`bili_-352` / `bili_-799` / `bili_-509` 扩展后均判风控(现网只认 HTTP 412/`bili_-412`;对 ASR 链路行为超集、无回归) |
| `src/cli/commands/comments.test.ts` | 编排纯函数(mock fetchImpl + mock ServerClient,asr 双依赖注入先例) | 模式判定(0 行→full / >0 行→incremental);full 游标循环判停(is_end/next_offset 缺失/max-pages);incremental 水位判停(min(ctime_s)≤水位);cursor 包裹透传 `{"offset": next_offset}` 形态(附录 A 裁定①);连续 2 空页判停(empty_pages_suspicious,full/incremental 各一);请求预算耗尽判停(request_budget);伪完整轮守卫(活跃总行数×1.2 < max(all_count, stat.reply) → full_scan:false,判定时点楼中楼翻全后);楼中楼 rcount 增长判定与 skip 日志;分批 flush(batch-size);风控三档后 partial;refresh-roots 选取(like 降序 top-N);回执结构 |
| `src/cli/commands/comments.cli.test.ts` | 子进程装配(execFile 真 CLI,stats.cli 同构) | `--help` 自描述含全部选项;`--bvid` 与 `--aid` 双缺 → ARGS 退 2;`--bvid` 与 `--aid` 不一致退 2;cookie 缺失 → ARGS 退 2 且错误含 cookie 通路指引;`--mode` 非法值退 2;dry-run 回执 `dry_run:true`;bvid-file 批量(失败不阻断,per-video 回执);`--server` 显式时 verify/tree 出「只读本地 --db」警告 |
| `src/db/comments.test.ts` | db 层(:memory: 库 + migrate 种子) | upsert 幂等(同 rpid 二次:like 更新、first_seen_at/batch_id 保留);关联三元组防御性保留(R0 违例→新值自洽修正路径);pin 先清后打(仅 full 轮携带 pins);missing 对账四态(NULL→候选→确认→恢复,仅根/仅完整轮);verifyTree R0-R9 各造一个违例夹具;索引存在性(EXPLAIN 或 sqlite_master 断言,advanced.test.ts 先例) |
| `src/http/comments.test.ts` | HTTP 端点 | ingest 正常 200(inserted/updated);body 校验 400(缺 replies/缺 bvid);video 不存在 404;full_scan 触发 missing 对账;批量事务原子性(中途约束错全回滚);count 端点 200/404/0 行(rows/roots/max_ctime_s);verify GET 只读 200 |

### 7.2 覆盖率影响评估

- 新增源文件 5 个(`db/comments.ts`、`http/comments.ts`、`cli/bili-comments.ts`、`cli/commands/comments.ts`、bundle 增量)全部纳入 c8 `--include 'src/**/*.ts'` 现有口径,**无新豁免登记**;
- 锁定线 98/93/99/98([RULES.md §2](docs/quality/RULES.md)):解析/db/http 层纯逻辑高覆盖;唯一天然低覆盖点是 `withRiskRetry` 的真实等待(mock sleep 注入,asr-net.test.ts 先例已解);
- 网络层复用 asr-net + isRiskControl 小幅扩展(风险码超集,无回归),不拉低;风险点是 `commands/comments.ts` 若把编排写成大泥球会撞 400 行/复杂度 15 硬门——编排循环体本身抽纯函数(`nextMainPageArgs` / `shouldStopMain` / `shouldStopFloor`),保持文件 <400 行(超出就照 asr 三拆再拆 `comments-run.ts`)。

### 7.3 回归纪律用例示例(bug 修复 commit 必须带「失败→通过」)

- 例:楼中楼对账分母口径错误(误用 `reply_total` 历史总数而非 `page.count` 实时分母)导致正常楼永远判缺 → 回归用例「page.count=7(根行 rcount=7)全量翻齐 7 条时 verify.coverage 必须 =1.0」(修复前失败,修复后通过);
- 例:直回根条目 dialog==自身被误判 dangling → 「直回根条目不产生 dangling_dialog」用例。

### 7.4 验收场景与测试轮次

Gherkin 验收文档:`docs/quality/acceptance/comments-collect.md`(文档式中文场景 + 标注映射测试文件,格式对齐 [main-pipeline.md](docs/quality/acceptance/main-pipeline.md) 先例)。首批场景:

1. 全量采集入库(根+楼中楼两层、置顶、member 快照)→ 映射 `commands/comments.test.ts` + `db/comments.test.ts`;
2. 幂等重采(同 rpid 二次 upsert,first_seen_at/batch_id 保留)→ 映射 `db/comments.test.ts`;
3. missing 两轮确认(候选→确认→恢复;仅根评论、仅完整轮)→ 映射 `db/comments.test.ts`;
4. 风控 partial 不污染水位(三档退避尽 → partial:true、ingest `full_scan:false`、不触发对账)→ 映射 `commands/comments.test.ts`;
5. 树校验五类违例(orphan_floor / dangling_parent / dangling_dialog / rcount_mismatch / triple_inconsistent)→ 映射 `db/comments.test.ts`。

测试轮次记录表(随验收文档内嵌,RULES §5;首行占位):

| 轮次 | 命令 | 结果 |
|---|---|---|
| 待首次 pnpm qa | — | 结果回填 |

---

## 8. 风控与合规

### 8.1 频率参数

| 参数 | 值 | 依据 |
|---|---|---|
| 页间隔 | 2000ms ± 30% 抖动(1400–2600ms) | 社区实践 ≥1s/页(MediaCrawler crawl_interval=1.0);旧方案下限 750ms 会跌破该基线(自我矛盾),故取 2s ±30% |
| 请求预算 | 单轮 `--max-requests` 默认 600(主列表+楼中楼合计,事前预算) | B 站无官方限速数值;防 -412 IP 级升级风控与日累计失控 |
| 单视频全量成本 | 5000 评论视频(根 250-500、楼 4500-4750)≈ 主列表 13-25 页 + 楼中楼 225-240 页 ≈ 240-265 请求 × 均值 2s ≈ 8-9 分钟;最坏(抖动上限 2.6s + 一次 -352 三档退避 30+120+300s)≈ 20-22 分钟 | 可接受;`--max-pages` 供小样本 |
| 批量多视频 | `--bvid-file` 串行,视频间 5s 固定间隔(代码化,防会话内易失编排;失败不阻断,回执 per-video 数组) | 规模化前先单视频跑顺 |
| 失败熔断 | 同视频连续 3 次 ingest 失败 / 风控三档退避尽 → 终止本轮 | 防雪上加霜 |

### 8.2 cookie 通路(复用,零新增)

`--cookie-file` / `$COLLECTOR_BILI_COOKIE_FILE` 读文件原文作 Cookie 头(逐行对齐 [asr.ts:242-251](apps/collector-server/src/cli/commands/asr.ts#L242));来源 `scripts/bili-cookie-from-chrome.mjs`(CDP 取 HttpOnly SESSDATA,写 `~/Local/collector-secrets/bili-cookie.txt` 600;SESSDATA ~1 个月有效期,`--refresh` 重取)。cookie 内自带 buvid3/buvid4(真实 Chrome 快照),不实现 `getbuvid` 独立通路。硬要求理由:wbi/main 签名前置 nav 取 key,实测匿名 nav 恒 -101([asr.ts:73-79](apps/collector-server/src/cli/commands/asr.ts#L73));同时 IP 属地字段文档标注需登录态。

### 8.3 wbi 签名(零新增代码)

[wbi.ts](apps/collector-server/src/cli/wbi.ts) 全套现成:`MIXIN_KEY_ENC_TAB` 重排 + `getMixinKey` + `encWbi`(字典序 + `!'()*` 过滤 + MD5)+ `extractKeysFromNav`,测试向量与扩展同源防漂移。评论场景只需新加一个参数拼装:`encWbi({type:1, oid, mode, plat:1, web_location:1315875, pagination_str}, img, sub)`。key 每日更替 → 进程内缓存(asr 先例)+ **-403 时强刷一次重试**(§4.6;-403 是签名错误特有码,刷新是唯一正确动作,不退避干等)。

### 8.4 失败路径可观察性逐条对照(CLAUDE.md §9)

| §9 要求 | 本设计落点 |
|---|---|
| HTTP 状态与响应特征 | `[fetch]` 每请求 http= code= bytes=(§4.7);`replyDiag` 形态摘要(键集/page/replies/voucher)任何形态异常必带 |
| 解析命中计数 | `[parse]` 字段命中率 x/total,命中率 <100% 附缺失样本 rpid ≤5 个 |
| 每步输入输出计数 | `[store]` inserted/updated/累计/请求数;`[floor] skip` 跳过判定带判定依据(rcount vs 已采) |
| 日志看不出先修日志 | replyDiag 先于任何风控猜测(§4.7);「归零空壳」「voucher present」「游标打转」三类特征显式命名 |
| 参考实现分步标签 | `[fetch]/[parse]/[store]/[verify]` 对位 youtube-collect-videos.mjs 的 `[fetch]/[parse]/[filter]` |

### 8.5 抓取行为合规边界

1. **只采公开数据**:评论区是未登录可读的公开内容(实测 10/10 匿名 code 0);不采「仅自己可见」之外的私有态,不做登录墙绕过;
2. **限速礼貌**:2s ±30% 抖动 + 单轮请求预算(§8.1)、夜间不跑大批量(编排层建议)、失败熔断;目标是「一个耐心的读者」而非并发爬虫;
3. **不自动化验证码**:gaia/v_voucher 流程**不走自动化**——触发即失败终止并如实报告(人工判断是否值得过验证),这与「不绕风控」一致;
4. **法律风险已知悉**:bilibili-API-collect 原仓库因 B 站律师函关停(调研 A §0);本项目定位个人研究工具、低频小规模(单视频、手触发),不建池化代理、不做账号矩阵;接口事实仅取自冻结版镜像作实现参考;
5. **数据最小化**:member 快照只服务分析昵称/等级画像,不建用户维度聚合表;不入库 action/assist 等登录态个人字段。

---

## 9. 落地步骤

### 9.1 commit 序列(每步可独立 qa;涉代码提交跑 `pnpm qa` 引用结果;server 改动先 `npx tsc --noEmit`)

| # | commit | 内容 | 验证 |
|---|---|---|---|
| C0 | 无 commit(spike) | §4.9 wbi/main 连通性 spike,结论回填本文档附录 | 人工;产物为 spike 实录段 |
| C1 | `feat(db): comments 表 v20 + upsert/missing/校验查询` | schema.sql DDL + migrate.ts v20 + `db/comments.ts` + `db/comments.test.ts` | `pnpm build` + turbo test;迁移测试旧行为/新库重放 |
| C2 | `feat(http): comments ingest/count/verify 端点(POST ingest;GET count、GET verify——读 GET/写 POST 惯例)` | `http/comments.ts` + server 路由注册(对齐 handleAsrHttp 挂接)+ `http/comments.test.ts`(ingest 200/400/404;count 200/404/0 行;verify 只读) | 端点测试;部署需 docker rebuild |
| C3 | `feat(cli): 评论响应解析纯函数(bili-comments)+ isRiskControl 风险码扩展` | `cli/bili-comments.ts` + 测试(可独立于 C2 并行)+ `cli/asr-bili.ts` isRiskControl 扩展(识别 bili_-352/-799/-509,风险码超集无回归)+ `cli/asr-bili.test.ts` 三分类用例 | 解析全形态测试 |
| C4 | `feat(cli): comments collect 全量/增量采集编排` | `cli/commands/comments.ts`(collect,含 `--bvid-file` 批量入口:串行+视频间 5s+失败不阻断 per-video 回执)+ main.ts 注册 + db.ts DB-only 警告组加 comments + 双测试文件 | CLI 测试;真实 cookie 手跑一视频 `--dry-run` → 小样本 `--max-pages 2` → 全量 |
| C5 | `feat(cli): comments tree/verify 树查看与校验` | commands/comments.ts 增 tree/verify 子命令 + db 查询函数 + 测试 | verify 回执对照 §5.3 |
| C6 | `feat(bundle): manifest comments 摘要 + comments/*.md 导出 + ANALYZE 模板增补` | bundle.ts 增补 + 批量查询防 N+1 + analyze-template.ts 盲区第四类 + bundle.test.ts 增补 | 全量 qa;出一个含评论主题的实测 bundle |
| C7 | `docs: 评论采集文档同步(SKILL/help/README/PLAN/验收)` | §9.3 全清单(含 Gherkin 验收文档 `docs/quality/acceptance/comments-collect.md`,§7.4)+ 本文档落盘 `docs/plans/comments/PLAN.md` | `verify-skill-sync` 过(qa 门) |

### 9.2 涉及文件清单

```
apps/collector-server/src/db/schema.sql                (+DDL,末尾追加)
apps/collector-server/src/db/migrate.ts                (+v20 步骤)
apps/collector-server/src/db/comments.ts               (新:upsert/missing/verify/树与统计查询)
apps/collector-server/src/db/comments.test.ts          (新)
apps/collector-server/src/http/comments.ts             (新:POST ingest + GET count/verify 端点)
apps/collector-server/src/http/comments.test.ts        (新)
apps/collector-server/src/cli/bili-comments.ts         (新:解析/游标/replyDiag 纯函数)
apps/collector-server/src/cli/bili-comments.test.ts    (新)
apps/collector-server/src/cli/asr-bili.ts              (增:isRiskControl 识别 bili_-352/-799/-509)
apps/collector-server/src/cli/asr-bili.test.ts         (增:三分类用例)
apps/collector-server/src/cli/commands/comments.ts     (新:collect/tree/verify)
apps/collector-server/src/cli/commands/comments.test.ts / comments.cli.test.ts (新)
apps/collector-server/src/cli/main.ts                  (命令注册 +2 行)
apps/collector-server/src/cli/db.ts                    (DB-only 警告组加 comments)
apps/collector-server/src/cli/bundle.ts                (BundleCommentsMeta + 导出)
apps/collector-server/src/cli/analyze-template.ts      (盲区第四类 + 评论区段)
apps/collector-server/src/cli/bundle.test.ts           (增补)
```

不涉扩展(subtitle-collector 零改动,**无需 bump manifest version**);server 走 docker rebuild 上生产。

注:`http/comments.ts` 内含三个端点(POST ingest / GET count / GET verify);`asr-bili.ts` 的 isRiskControl 扩展为风险码超集,对既有 ASR 链路无回归。

### 9.3 文档同步清单

| 文档 | 改动 |
|---|---|
| `docs/plans/comments/PLAN.md` | 本文档落盘(+C0 spike 实录附录) |
| [docs/skills/collector/SKILL.md](docs/skills/collector/SKILL.md) | 命令组速查表加两行(「通道」列拆开写,防 agent 调度走错通路):`comments collect | server HTTP + B 站直连 | 评论分析树采集(参数摘要)`;`comments tree/verify | DB 只读 | 树查看与校验(与 §5.2 DB-only 警告组一致)`;样例块加 `collector-cli comments collect --bvid <BV> --dry-run`(verify-skill-sync 会跑真 `--help` 比对,选项必须一致);references/playbooks.md 加「评论树采集→bundle 消费」工作流 |
| docs/help/`采集评论.md` | **新页**:cookie 准备 → dry-run → 全量 → verify → 增量;只写怎么用 |
| docs/help/INDEX.md | 采集组加新页行;分析组《分析工作流》描述若涉及则同步 |
| [docs/help/分析工作流.md](docs/help/分析工作流.md) | L46「评论采集不在数据源内(远期)」删除,改指《采集评论》与 bundle 评论段 |
| docs/help/`导出分析原料包.md` | 增 comments/ 目录与 manifest `comments` 字段说明 |
| docs/help/`采集模型.md` | 数据流总览增评论入口(宿主 CLI 直连型,与 asr backfill 同类) |
| [README.md](README.md) | L50 翻转,按抖音条目格式:`- ✅ **B 站评论分析树**(2026-10-03,用户现场指令一次性解冻):单视频全量采集(wbi 游标 + 楼中楼翻全,完整 root/parent/dialog 对话链)→ comments 表入库(增量重采:ctime_s 水位追新 + --refresh-roots like top-N 根重翻 + missing 两轮删除确认)→ CLI comments collect/tree/verify → bundle 导出评论原料(manifest 摘要 + comments/*.md);专栏/动态评论区、评论写操作、web 评论展示、其他平台评论不在本期范围` |
| docs/help/分析工作流.md | 解冻枚举段(L45 附近「其余采集侧能力维持冻结」枚举)补 2026-10-03 评论条目 |
| CLAUDE.md(项目级) | §6 Feature 列表纪律追加「2026-10-03 用户现场指令解冻(评论采集)」日期条目(格式仿抖音条目) |
| docs/quality/acceptance/comments-collect.md | 新增:Gherkin 验收场景(§7.4 五类)+ 测试轮次记录表(首行占位「待首次 pnpm qa,结果回填」) |
| docs/plans/consumption-loop.md | 推迟项登记:web 评论展示(挂点 VideoDetail 统计卡 + `/api/videos/:source/:vid/comments` 子路由先例) |

### 9.4 部署与收尾注意

- server 改动(C1/C2/C6)合并后 docker rebuild 才到生产;本地 `node --test` 不做类型检查,**先 `npx tsc --noEmit`**(memory: server tsc 门只在 docker build 跑);
- 生产库迁移 v20 由 server 启动自动执行(账本短路幂等);CLI/分析查生产仍走快照通道(`export-bundle.mjs` / VACUUM INTO);
- 首个实证主题:挑一个已入库、评论区活跃(1-2k 条)的视频全量采集 → verify coverage ≥0.98 → export bundle 出评论原料 → 一次真实分析会话用上评论区维度,闭环后把 README 条目里「覆盖率」实证数字回填;
- CLI 完整度反向登记:无绕过发生,不登记 `docs/plans/cli-completeness.md`。

---

## 附录:Spike 实录(2026-10-04)

C0 实测执行记录(§4.9 清单)。环境:宿主 node(tsx)直连 `api.bilibili.com`;UA 常规 Chrome/154 串 + `Referer: https://www.bilibili.com/video/<bv>/`;请求间隔 2.1–2.6s 抖动;cookie 以 `scripts/bili-cookie-from-chrome.mjs --refresh` 现取(已加载,键数 16,SESSDATA/buvid3/bili_jct 命中;**凭证值不落任何文档/日志**)。目标视频 BV1KmHb6JEFS(aid 117373419915771)。原始 JSON 样例与脚本:`/tmp/bili-comment-probe/`(`t1…f3*.json` + `derived-analysis.json` + `wbi-main-spike{,-batch2,-batch3}.mjs`;临时产物,不进仓库)。

### A.1 请求台账

| # | 请求 | 关键差异 | 结果 |
|---|---|---|---|
| nav | `/x/web-interface/nav` | 带 cookie | code 0 → wbi keys(img/sub 各 32 位) |
| view | `/x/web-interface/view?bvid=` | 匿名 | code 0,stat.reply=**2107**、pubdate=1791000000 |
| t1 | wbi/main 首页 | mode=3 + cookie | code 0,rows 20,is_end=false,all_count=2101,cursor.next=0,session_id 非空 |
| t2 | mode=3 翻页 | pagination_str=**裸串透传** next_offset | **code -400「请求错误」**——裸串不是合法 JSON,透传必须包裹 |
| t3 | mode=2 首页 | 无 direction | code 0,rows 20,**最新在前**(首条 ctime=1791048751,当日) |
| t4 | mode=2 首页 | direction=2 作 URL 参数 | code 0,首页 rows 与 t3 **逐条相同** |
| t5 | mode=2 首页 | direction 放 offset JSON 内部 | code 0,首页 rows 与 t3 **逐条相同** |
| F1 | mode=3 第 2 页 | `{"offset": next}` 包裹 | code 0,rows 20,与 t1 零重叠;**返回 next_offset 与所发 token 逐字节相同** |
| F2 | mode=2 第 2 页 | `{"offset": next}` 包裹 | code 0,rows 20,时序递减衔接(p1 末 1791045063 ≥ p2 首 1791044434),**页间重复 0**;游标内嵌剩余计数 1038→1014,真实推进 |
| F3 | 置顶补测 BV18Bam6eEBd(aid 117369712153855) | mode=2 首页(目标视频无置顶,top 全 null,故换视频) | code 0;top.upper 存在(rpid_str 315780563777,root/parent/dialog 全 '0'),**不在首页 rows 中** |
| F4 | mode=3 同 token 第三连发 | pagination_str 与 F1 完全相同 | code 0,**又出新 20 行**(p3∩p1=0,p3∩p2=0),token 仍恒定 |
| t7 | 匿名对照 | t1 同请求去 cookie | code **0**,rows 20,all_count=2101;rows 键集与 cookie 版一致(仅 location 值缺失、少 dynamic_id 键) |
| t8 | -403 复现 | w_rid 篡改一个字符 | HTTP 200 + code **-403**「访问权限不足」,41 字节空 data |

### A.2 实测结论

| 项 | 实测结论 |
|---|---|
| cursor 结构 | `data.cursor` 键集:`is_begin, prev, next, is_end, pagination_reply, session_id, mode, mode_text, all_count, support_mode, name`;`is_end` boolean、`all_count` number(2101→2104,分钟级实时增长) |
| next_offset 形态 | **不透明 base64 protobuf 串**(typeof string),如 mode=2:`CAESEDE4MzQwMzQzNDI2NjY3NTIaADIDCI4I`。手解仅作记录:field1=1,field2=ASCII 数字串(会话 token,匿名时缺省),尾场编码剩余计数(mode=2 首页内嵌 1038,F2 后 1014)。镜像文档 JSON 形态(`{type:1,data:{pn}}` / `{type:3,direction:2,Data:{cursor:n}}`)**均不存在**,大小写坑随之作废 |
| 透传方式 | 裸串直塞 → -400;**`JSON.stringify({offset: <原文>})` 包裹 → code 0**,mode=2/3 双序验证通过(附录裁定①) |
| mode=2 排序 | **恒为最新在前**(t3 无 direction / t4 URL / t5 offset 内三形态首页逐条相同;F2 翻页递减衔接零重复)。direction 两处携带均无可见效果;升序翻页不可用(direction=1 未测,亦无需求) |
| 置顶形态 | `data.top` 键恒为 `{admin, upper, vote}`(无置顶时三值皆 null,目标视频即如此);有置顶时(F3)条目为**与 rows 完全同构的标准评论对象**(32 键键集逐一相同,含 like/rcount/count/up_action/reply_control/mid_str);**实测置顶不在 mode=2 首页 rows 中**(in_rows=false) |
| `data.upper.mid` | typeof **number**(3493260618106936 ≈ 3.49e15,已在 2^53=9.007e15 的 39% 处)——`String()` 直读防御(§2.3 is_up 行)维持必要 |
| 匿名边界 | wbi/main **匿名 code 0 可读**(rows 20 全量返回,all_count 同值);差异仅 `reply_control.location` 为 null(§2.3「需登录态」成立)与 rows 无 dynamic_id 键;nav 匿名仍 -101(既有结论不变) |
| -403 语义 | w_rid 单字符篡改 → **code -403**「访问权限不足」(HTTP 200),「签名错误特有码」确认,§4.6「-403 不退避、强刷 keys 重试」成立 |
| mode=3 特性 | 同一 token 重复发送**持续出新页**(F1→F4 两连发皆全新 rows),token 恒定是服务端会话推进;§4.4 防打转护栏**只对 mode=2 链有意义**(mode=2 游标逐页变化);mode=3 仅作首页快照不受影响 |
| 总数口径 | all_count 与 view.stat.reply 为同一实时口径、各自缓存有分钟级时滞:01:36 all_count=2101 → 01:46 stat.reply=2107,活跃视频数分钟漂移 ±3;此前观察到的「~11% 差」(1884/1893 vs 2101)实为**一日自然增长**而非口径差;±容忍对账(§2.1/§2.2)维持,无须修正系数 |
| is_end 终态 | 未实测到(2101÷20≈106 页,spike 不翻到底);is_end===true / next_offset 缺失的判停语义按文档保留,C1 实装后由首个全量轮实证 |
| 未覆盖项 | §4.9 ③(>2 层对话链 dialog 指向)不在本轮清单,§2.4 规则维持调研 C 结论待 C1 实装数据复核;direction=1 行为未测(无需求) |

### A.3 三点最终裁定

1. **offset 透传方式**:`pagination_str = JSON.stringify({ offset: <next_offset 原文> })`。next_offset 是不透明 protobuf 串:不解码、不重组、不自行构造;裸串直塞报 -400。§4.3 伪代码 cursor 赋值与 §2.2 已同步为包裹形态。
2. **direction 位置**:**两处都不带**。URL 参数与 offset JSON 内部携带实测均无可见效果,mode=2 默认即最新在前(正是遍历所需);§4.3 的 direction 参数与「防御性回退分支」删除,§7.1 对应用例替换为包裹透传用例。
3. **top 重复性**:**不可依赖重复出现**——实测置顶不在 mode=2 首页 rows 中,故 §4.3「top 条目本体并入 buffer upsert」是置顶入库的**唯一**路径(非可有可无的兜底);条目与 rows 完全同构,解析器复用同一路径;若个别视频置顶重复出现于 rows,同 rpid upsert 幂等吸收,两形态皆闭环。

### A.4 正文已随实测修正处(最小改动)

| 正文位置 | 修正内容 |
|---|---|
| §2.2 分页机制 | next_offset 形态改为实测(protobuf 串 + `{"offset":...}` 包裹);镜像文档两 JSON 形态标注过时 |
| §2.2 排序 | direction=2 改为「实测恒最新在前,不携带 direction」 |
| §2.3 location 行 | **实测发现正文 bug**:切分正则原为 `/[::]/`(两个 ASCII 冒号 U+003A),线上格式是全角冒号「IP属地：天津」,纯 ASCII 版切不开 → 改 `/[:：]/`(含 U+FF1A)并留痕 |
| §2.3 invisible / folder 行 | 实测为 boolean(`false`),非 0/1;入库归一注记 |
| §2.5 热评 | wbi/main 响应无 `data.hots` 键,热度序即 mode=3 首页 rows 排列本身 |
| §4.3 伪代码 | 两处 encWbi 去 direction;cursor 赋值改包裹形态;「direction=2 防御性回退」注释段删除 |
| §4.4 防打转护栏 | 加注 mode=2 游标逐页变化(护栏安全)、mode=3 token 恒定属设计使然(护栏仅对 mode=2 生效) |
| §7.1 用例清单 | 「direction=2 回退分支」用例替换为「cursor 包裹透传形态」用例 |

