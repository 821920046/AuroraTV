# AuroraTV 

基于 **MoonTVPlus（MIT）** 魔改的影视聚合与播放系统，面向 **Cloudflare 免费额度** 设计：OpenNext on Workers + D1 + KV/Cache API。

>  本项目不存储任何视频资源，仅聚合第三方片源。是否合法由部署者自行承担。请只接入有合法授权的源。

## ✨ 特性

- **API 网关**：用 Next.js Route Handlers（`/api/search` `/api/detail` `/api/play` `/api/sources`），运行在 Workers 上。
- **缓存**：Cache API 优先 + KV 兜底，避开免费 KV “1000 写/天”瓶颈。
- **多源调度**：按源健康评分排序，扁平化并发 ≤ 子请求上限。
- **播放 Fallback**（客户端，零成本）：HLS → MP4 直链 → iframe → 切源。
- **源健康检测**：独立调度 Worker + Cron，定时写入 D1 评分。
- **站长鉴权**：Basic Auth  中间件保护全站。
- **绝不代理视频流**：Worker 只处理元数据与解析，视频字节由客户端直连。

## 📁 目录结构

```text
auroratv/
├─ src/
│  ├─ app/
│  │  ├─ api/
│  │  │  ├─ search/route.ts     # 多源聚合搜索
│  │  │  ├─ detail/route.ts     # 详情（写 KV 兜底）
│  │  │  ├─ play/route.ts       # 解析可直连播放地址
│  │  │  ├─ sources/route.ts    # 源健康列表 / 失败上报
│  │  │  └─ cron/health/route.ts# 源健康检测（需 secret）
│  │  ├─ layout.tsx
│  │  ├─ page.tsx              # 搜索 + 播放 UI
│  │  └─ globals.css
│  ├─ components/Player.tsx     # HLS Fallback 播放器
│  ├─ lib/
│  │  ├─ cache.ts              # Cache API + KV
│  │  ├─ aggregator.ts         # 多源扁平化 + 解析
│  │  ├─ sources.ts            # 源注册表（自行填入）
│  │  ├─ db.ts                 # D1 访问
│  │  └─ scoring.ts            # 源评分公式
│  └─ middleware.ts            # 站长 Basic Auth
├─ workers/scheduler/           # 独立 Cron 调度 Worker
├─ migrations/0001_init.sql
├─ wrangler.toml
├─ open-next.config.ts
├─ next.config.mjs
└─ .github/workflows/deploy.yml
```

## 🚀 部署步骤

### 1. 准备
```bash
npm install
cp .dev.vars.example .dev.vars   # 填入本地开发变量
```

### 2. 创建 Cloudflare 资源
```bash
npx wrangler kv namespace create AURORA_KV
npx wrangler d1 create auroratv-db
```
把返回的 id 填入 `wrangler.toml` 的 `<your-kv-namespace-id>` 与 `<your-d1-database-id>`。

### 3. 初始化数据库
```bash
npm run db:migrate           # 本地
npm run db:migrate:remote   # 线上
```

### 4. 配置源
编辑 `src/lib/sources.ts`，填入你有合法授权的片源（MacCMS / 苹果CMS vod 接口）。

### 5. 本地调试
```bash
npm run dev
```

### 6. 部署
```bash
npm run cf:deploy
```
或推送到 `main` 分支，由 GitHub Actions 自动部署。
需在仓库 Settings → Secrets 配置：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`。

### 7. 设置密钥与鉴权
```bash
npx wrangler secret put USERNAME
npx wrangler secret put PASSWORD
npx wrangler secret put CRON_SECRET
```

### 8. 部署调度 Worker（源健康检测）
编辑 `workers/scheduler/wrangler.toml` 的 `TARGET_URL`（主站域名 + `/api/cron/health`，不带 scheme），然后：
```bash
cd workers/scheduler
npx wrangler secret put CRON_SECRET
npx wrangler deploy
```

## ⚠️ 合规与许可证

- 本项目基于 MoonTVPlus（MIT）魔改，**请保留原作者版权声明**（见 `LICENSE`）。
- 不要混入采用 CC BY-NC-SA 等禁商用协议的上游代码。
- 默认 `noindex`：不建议对聚合内容做公开 SEO 引流。
- 严禁用 Worker 代理/中转真实视频流（违反 Cloudflare ToS 2.8，且会烧爆免费额度）。

## 📜 许可证

 MIT
