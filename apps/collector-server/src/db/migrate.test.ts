// migrate 幂等测试：验证 categories 表创建 + creators 两列追加（schema.sql + runMigrations 双轨）。
// 用 :memory: 库跑 migrate（执行 schema.sql）+ runMigrations（ALTER 旧库补列），第二次不报错。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate, runMigrations } from './migrate.js';

test('migrate + runMigrations 幂等：跑两次不报错且字段存在', () => {
  const db = new Database(':memory:');
  migrate(db);
  runMigrations(db);
  // 第二次（模拟旧库已加列场景）
  runMigrations(db);

  // categories 表存在
  const cats = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='categories'").get();
  assert.ok(cats, 'categories 表应被创建');

  // creators 两列存在
  const cols = db.prepare("PRAGMA table_info(creators)").all() as Array<{ name: string }>;
  const names = cols.map((c) => c.name);
  assert.ok(names.includes('category_agent_id'), 'creators.category_agent_id 应存在');
  assert.ok(names.includes('category_human_id'), 'creators.category_human_id 应存在');

  // videos.paid 列存在（schema.sql 新建库 + runMigrations 旧库补列双轨）
  const vcols = db.prepare("PRAGMA table_info(videos)").all() as Array<{ name: string }>;
  assert.ok(vcols.map((c) => c.name).includes('paid'), 'videos.paid 应存在');
});
