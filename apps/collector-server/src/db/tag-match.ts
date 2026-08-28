// ── 视频筛选的标签族条件构建（六档：manual/batch/ai/system 关系表 + bili/season extra）──
// 自 advanced.ts 抽出（2026-08-29）：tag_source 独立筛选（档位存在性）并入后 buildVideoWhere
// 复杂度/行数恶化静态台账，沿 aggregate-tag.ts 抽出先例把标签族条件收敛为本模块。
// 措辞：字幕（subtitle），非弹幕。

// 标签相关筛选切片（advanced.ts VideoFilter 的子集；结构兼容免循环 import）
interface TagFilterSlice {
  tag?: string;          // 标签名模糊
  tags?: string[];       // 标签名精确（AND 语义）
  tag_source?: string[]; // 档位过滤（manual/batch/ai/system/bili/season 子集；省略=六档全查）
}

// 标签匹配 EXISTS 片段：一个标签名（精确 = 或模糊 LIKE）× 档位（tag_source 过滤）。
// bili 档查 extra json_each $.tags；season 档查 extra json_extract $.ugc_season.title（同为只读实时读）；
// manual/batch/ai/system 档查 video_tags 关系表（2026-08-26 纳入 system：no-subtitle 系统标经
// --tag no-subtitle 圈定是 ASR 兜底链路的入口，此前五档不含 system 导致系统标恒不可查）。OR 连接。
// tag_source 省略/含全部六档 → 各路都拼；只含 bili → 只 extra tags 路；只含 season → 只 season 路；只含关系档 → 只关系路。
export function tagMatchCond(name: string, mode: 'exact' | 'like', tagSource?: string[]): { cond: string; params: unknown[] } {
  const allSources = ['manual', 'batch', 'ai', 'system', 'bili', 'season'];
  const sources = tagSource?.length ? tagSource.filter((s) => allSources.includes(s)) : allSources;
  if (sources.length === 0) sources.push(...allSources);
  const op = mode === 'exact' ? '=' : 'LIKE';
  const val = mode === 'exact' ? name : `%${name}%`;
  const branches: string[] = [];
  const params: unknown[] = [];
  const relSources = sources.filter((s) => s !== 'bili' && s !== 'season');
  if (relSources.length > 0) {
    const placeholders = relSources.map(() => '?').join(',');
    branches.push(
      `EXISTS (SELECT 1 FROM video_tags vt JOIN tags t ON t.id = vt.tag_id WHERE vt.video_id = v.id AND t.name ${op} ? AND vt.source IN (${placeholders}))`,
    );
    params.push(val, ...relSources);
  }
  if (sources.includes('bili')) {
    branches.push(
      `EXISTS (SELECT 1 FROM json_each(v.extra, '$.tags') WHERE json_extract(json_each.value, '$.tag_name') ${op} ?)`,
    );
    params.push(val);
  }
  if (sources.includes('season')) {
    branches.push(
      `json_extract(v.extra, '$.ugc_season.title') ${op} ?`,
    );
    params.push(val);
  }
  if (branches.length === 0) return { cond: '0', params: [] }; // 无合法档 → 恒 false
  return { cond: `(${branches.join(' OR ')})`, params };
}

// 档位存在性条件：该视频在所选档位（任一）至少有一个标签——tag_source 单独出现（不带名）时的
// 独立过滤。此前 tag_source 只作 tag/tags 匹配的档位收窄，单独传被静默忽略（全量返回，
// 2026-08-29 修复）。空 tag_name 条目/空串 season 标题不算标签，对齐 enrichItems 的富化口径。
function tagSourceExistsCond(tagSource: string[]): { cond: string; params: unknown[] } {
  const allSources = ['manual', 'batch', 'ai', 'system', 'bili', 'season'];
  const sources = tagSource.filter((s) => allSources.includes(s));
  if (sources.length === 0) sources.push(...allSources); // 全非法 → 回落全档（对齐 tagMatchCond 容错）
  const branches: string[] = [];
  const params: unknown[] = [];
  const relSources = sources.filter((s) => s !== 'bili' && s !== 'season');
  if (relSources.length > 0) {
    const placeholders = relSources.map(() => '?').join(',');
    branches.push(`EXISTS (SELECT 1 FROM video_tags vt WHERE vt.video_id = v.id AND vt.source IN (${placeholders}))`);
    params.push(...relSources);
  }
  if (sources.includes('bili')) {
    // JSON 中 NULL != '' 为 NULL（假），无 tag_name 条目自然排除；extra 非法 JSON/无 $.tags → json_each 0 行
    branches.push(`EXISTS (SELECT 1 FROM json_each(v.extra, '$.tags') WHERE json_extract(json_each.value, '$.tag_name') != '')`);
  }
  if (sources.includes('season')) {
    branches.push(`COALESCE(json_extract(v.extra, '$.ugc_season.title'), '') != ''`);
  }
  return { cond: `(${branches.join(' OR ')})`, params };
}

// 标签族条件聚合：tag 模糊 + tags 精确 AND + tag_source 单独存在性（与精确匹配互斥不叠加）。
export function buildTagConds(f: TagFilterSlice): { conds: string[]; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (f.tag) {
    const { cond, params: p } = tagMatchCond(f.tag, 'like', f.tag_source);
    conds.push(cond);
    params.push(...p);
  }
  if (f.tags && f.tags.length > 0) {
    // 标签精确 AND：每个名字一个条件组
    for (const name of f.tags) {
      const { cond, params: p } = tagMatchCond(name, 'exact', f.tag_source);
      conds.push(cond);
      params.push(...p);
    }
  }
  if (f.tag_source?.length && !f.tag && !(f.tags && f.tags.length > 0)) {
    const { cond, params: p } = tagSourceExistsCond(f.tag_source);
    conds.push(cond);
    params.push(...p);
  }
  return { conds, params };
}
