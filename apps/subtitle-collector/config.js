// 扩展侧配置：服务端地址 + WS 握手 token。
// token 必须与服务端 config.js 预置 token 一致（见 Task 3 Step 3 server.ts hello 校验）。
// 部署/分发前请改成随机串，勿提交默认值到公开仓库。
export const SERVER_URL = "ws://127.0.0.1:21527/ext";
export const PING_URL = "http://127.0.0.1:21527/ping";
export const TOKEN = "change-me-collector-token";
