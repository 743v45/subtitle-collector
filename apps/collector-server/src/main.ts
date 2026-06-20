import { openDb, migrate } from './db/migrate.js';

const DB_PATH = process.env.COLLECTOR_DB_PATH ?? './bilibili-collector.db';
const PORT = Number(process.env.COLLECTOR_PORT ?? 21527);

const db = openDb(DB_PATH);
migrate(db);
console.log(`[collector-server] db ready at ${DB_PATH}`);
// WS + HTTP 在后续 task 接上
console.log(`[collector-server] placeholder on port ${PORT} (ws/http in next tasks)`);
