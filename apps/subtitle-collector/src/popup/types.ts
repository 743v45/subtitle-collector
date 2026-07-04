// 对应 GET ${API_BASE}/api/videos/bilibili/<bvid> 的响应结构。
// video.extra 在服务端可能存为 JSON 字符串，前端 parseExtra 兜底解析。
export interface CollectedStat {
  view?: number | null;
  like?: number | null;
  coin?: number | null;
  fav?: number | null;
  share?: number | null;
  // stat.danmaku = 该视频收到的弹幕条数（B 站公开统计字段），非本项目采集的弹幕内容
  danmaku?: number | null;
}

export interface CollectedExtra {
  tname?: string;
  pages?: unknown[];
  stat?: CollectedStat;
  tags?: { tag_name: string }[];
}

export interface CollectedVideo {
  updated_at?: string | null;
  extra?: string | CollectedExtra | null;
}

export interface CollectedResponse {
  ok: boolean;
  video?: CollectedVideo;
  tracks?: unknown[];
}

// 对应 GET https://api.bilibili.com/x/web-interface/nav 的响应结构。
export interface BiliNavResponse {
  code: number;
  data?: { isLogin?: boolean; uname?: string };
}
