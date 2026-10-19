# 分得清

合租和旅行用的 AA 账本。纯静态前端，可选接入 Supabase。

## 本地运行与测试

```bash
npm run dev                      # http://localhost:5173
npm test                         # 结算算法单元测试（无外部依赖）
# 以下两项需要 NODE_PATH 指向含 playwright-core 和 @electric-sql/pglite 的 node_modules
NODE_PATH=... npm run test:sql   # 在 PGlite 里跑 schema.sql 和 migrations/
NODE_PATH=... npm run test:e2e -- [线上地址]   # 端到端测试 + 截图
```

## 接入云端（Supabase）

1. 在 Supabase SQL Editor 中整段运行 `supabase/schema.sql`。
2. 在 `site/js/config.js` 中填写 Project URL 和 **anon public** key。不要填 service_role key。
3. 运行 `netlify deploy --prod --dir site --no-build`。
