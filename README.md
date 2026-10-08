# AuroraTV

基于 **MoonTVPlus（MIT）** 魔改的影视聚合与播放系统，面向 **Cloudflare 免费额度** 设计：OpenNext on Workers + D1 + KV/Cache API。

> 本项目不存储任何视频资源，仅聚合第三方片源。是否合法由部署者自行承担。请只接入有合法授权的源。

## ✨ 特性

- **API 网关**：Next.js Route Handlers，运行在 Cloudflare Workers 上。
- **同源流代理**：`/api/stream` 把采集站的 `http` 地址、缺失 CORS、Referer/UA 防盗链三大问题一次性解决——HLS 之所以在浏览器里放不出来，根因就在这三条，详见 [`UPGRADE.md`](./UPGRADE.md)。所有代理地址带 **HMAC-SHA256 签名**（绑定 URL 前缀 + 有效期），并做 SSRF 防护。
- **多源聚合 + 换源**：搜索结果按标题合并，同名影片保留为 `alts` 备选，播放器可一键换源。
- **播放 Fallback**：双候选线路（代理 / 直连）自动降级；hls.js 错误分类恢复（网络 → `startLoad`，解码 → `recoverMediaError`）；「有无进展」看门狗而非固定超时。
- **缓存**：Cache API 优先 + KV 兜底，刻意避开免费 KV「1000 写/天」瓶颈。
- **源健康检测**：独立调度 Worker + Cron；服务端探活与客户端播放上报共同参与评分，连续失败自动停用、恢复后自动启用。
- **直播电视**：接入 M3U 播放列表，频道入库 D1，Cron 定时摄取与探活择优。
- **站长鉴权**：Basic Auth 中间件保护全站（代理路由改用 HMAC 鉴权，以便外部播放器可用）。
- **界面**：三个页面（`/` 点播、`/live` 直播、`/admin` 管理）共用一套设计令牌与统一导航；
  深色主题、手机/平板/桌面三档响应式、支持键盘导航与 `prefers-reduced-motion`。
  样式集中在 `src/app/globals.css`（纯 CSS + CSS 变量，无 UI 框架依赖）。

## 📁 目录结构

```text
auroratv/
├─ src/
│  ├─ app/
│  │  ├─ api/
│  │  │  ├─ search/route.ts       # 多源聚合搜索（同名合并为 alts）
│  │  │  ├─ detail/route.ts       # 详情
│  │  │  ├─ play/route.ts         # 解析播放地址（返回代理/直连双候选 + 全部线路）
│  │  │  ├─ stream/route.ts       # 视频流代理（m3u8 改写 / Range 透传）
│  │  │  ├─ img/route.ts          # 图片代理（海报/台标）
│  │  │  ├─ home/route.ts         # 首页聚合
│  │  │  ├─ sources/route.ts      # 源健康列表 / 播放成败上报
│  │  │  ├─ live/                 # 直播 channels / play / epg
│  │  │  ├─ admin/                # 后台：sources / live / import
│  │  │  └─ cron/                 # health / live 定时任务
│  │  ├─ admin/page.tsx           # 片源与直播订阅管理
│  │  ├─ live/page.tsx            # 直播频道 UI
│  │  ├─ page.tsx                 # 搜索 + 播放 UI
│  │  └─ globals.css
│  ├─ components/                 # SiteHeader.tsx / Player.tsx / LiveAdmin.tsx
│  ├─ lib/
│  │  ├─ proxy.ts                 # 签名铸造/校验、SSRF 防护、m3u8 改写
│  │  ├─ http.ts                  # 统一超时/重试/伪装请求头/容错 JSON
│  │  ├─ aggregator.ts            # 多源并发与解析
│  │  ├─ live.ts                  # 直播：M3U 解析/入库/探活/EPG
│  │  ├─ health.ts                # 探活 + 自动停用/恢复 + CORS 探测
│  │  ├─ cache.ts / db.ts / sources.ts / scoring.ts
│  │  └─ *.test.mts               # 零依赖单测（Node 内置 test runner）
│  └─ middleware.ts               # 站长 Basic Auth + 安全响应头
├─ workers/scheduler/             # 独立 Cron 调度 Worker
├─ migrations/                    # 0001 ~ 0007
└─ .github/workflows/deploy.yml   # 先验证后部署
```

## 🚀 部署步骤

### 1. 准备

```bash
npm ci                           # 有锁文件，安装结果可复现
cp .dev.vars.example .dev.vars   # 填入本地开发变量
```

### 2. 创建 Cloudflare 资源

```bash
npx wrangler kv namespace create AURORA_KV     # 可选，跨节点兜底缓存
npx wrangler d1 create auroratv-db
```

把返回的 id 填入 `wrangler.toml`。

### 3. 初始化数据库

```bash
npm run db:migrate          # 本地
npm run db:migrate:remote   # 线上
```

### 4. 配置源

在 `/admin` 页添加片源，或直接编辑 `src/lib/sources.ts`（MacCMS / 苹果CMS vod 接口）。

### 5. 本地校验

```bash
npm run dev
npm run typecheck   # tsc --noEmit
npm test            # 纯函数与流代理单测（零额外依赖）
npm run lint
```

### 6. 部署

```bash
npm run cf:deploy
```

或推送到 `main`，由 GitHub Actions 先跑 `typecheck` + `test` + `lint`，全绿后才构建部署。
需在仓库 Settings → Secrets 配置 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`。

> **⚠️ 改依赖后请留意 `package.json` 的 `optionalDependencies`**
>
> 里面钉着 CI 必需的原生二进制（`@next/swc-linux-*`、`@ast-grep/napi-linux-*`）。
> 原因：npm 会把 `os`/`cpu` 不匹配当前平台的可选依赖**从锁文件里裁掉**
> （[npm/cli#4828](https://github.com/npm/cli/issues/4828)），在 Windows 上生成的锁文件
> 因此不含 Linux 二进制，而 CI 跑在 `ubuntu-latest` 且用 `npm ci` —— 只装锁文件里有的东西，
> 于是 `opennextjs-cloudflare build` 会以 `Cannot find module '@ast-grep/napi-linux-x64-gnu'` 失败。
> 提升为根级 `optionalDependencies` 后会被完整写进锁文件，`os`/`cpu` 门控保证各平台只装自己那份。
>
> **升级 `next` 时必须同时改三处**：`dependencies.next`、`devDependencies.eslint-config-next`
> 和这里的 `@next/swc-linux-*`，三者版本号必须完全一致（因此 `next` 用精确版本而非 `^`）。
> 只升 `next` 而漏掉 swc 钉版，会报 `Mismatching @next/swc version, expected X, got Y`，
> 且只在 Linux 上暴露。

### 7. 设置密钥

```bash
npx wrangler secret put USERNAME
npx wrangler secret put PASSWORD
npx wrangler secret put CRON_SECRET
npx wrangler secret put STREAM_SECRET   # 可选：流代理签名密钥，32+ 位随机串
```

> **不设 `STREAM_SECRET` 也是安全的**：首次访问时会自动生成一个 32 字节随机密钥，
> 存入 D1 的 `app_setting` 表（迁移 `0008_settings.sql`）并在 isolate 内复用。
> 优先级为 `STREAM_SECRET` → `CRON_SECRET` → D1 持久化密钥。
> 只有「前两者都没配 **且** D1 不可用」时，才会回退到源码里的公开常量 ——
> 那种状态下 `/api/stream`、`/api/img` 等于没有鉴权。
>
> 想知道当前用的是哪一种？访问 `GET /api/health`：
>
> ```json
> { "ok": true, "secret": { "source": "d1", "weak": false }, "db": true, "kv": true, "auth": true }
> ```
>
> `source` 为 `env` / `d1` / `fallback`，`weak: true` 即表示无防护状态（该接口只报状态，不回显密钥）。
>
> 注意 `PASSWORD` **不再**作为签名密钥：它是后台登录口令，熵低，且复用会导致
> 「改口令 = 所有已发出的播放链接立即失效」。职责分离。
>
> **升级提示**：v0.4.1 之前用 `PASSWORD` / 公开常量签发的播放链接会失效一次，
> 表现为「点播放 403，刷新页面即恢复」（各接口会重新签发）。想完全避免这次抖动，
> 部署前 `npx wrangler secret put STREAM_SECRET` 设一个固定值即可。

### 8. 部署调度 Worker

编辑 `workers/scheduler/wrangler.toml` 的 `TARGET_URL`（主站域名 + `/api/cron/health`，不带 scheme），然后：

```bash
cd workers/scheduler
npx wrangler secret put CRON_SECRET
npx wrangler deploy
```

## 🔌 主要 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/search?kw=` | 聚合搜索，同名影片合并为 `alts` |
| GET | `/api/detail?source=&id=` | 详情 |
| GET | `/api/play?source=&id=&ep=` | 播放地址。**只为当前集返回 `url` / `proxy` / `prefer`**，`episodes` 只含集名；切集需带 `ep` 重新请求（命中服务端详情缓存） |
| GET | `/api/stream?u=&t=` | 流代理，需 HMAC 签名 |
| GET | `/api/img?u=&t=` | 图片代理，需 HMAC 签名 |
| GET | `/api/home` | 首页聚合 |
| GET | `/api/live/channels` · `/api/live/play` · `/api/live/epg` | 直播 |
| GET/POST | `/api/sources` | 源健康列表 / 播放成败上报 |
| GET | `/api/cron/health` · `/api/cron/live` | 定时任务，需 `CRON_SECRET` |
| GET | `/api/health` | 部署自检（密钥来源、D1/KV/鉴权、限流存储、DNS 守卫状态），不回显密钥；配了 `USERNAME`/`PASSWORD` 时需 Basic Auth |

## 🛡️ 安全设计

- **流代理不开放**：每个代理地址都是 `exp.前缀.HMAC-SHA256`，签名绑定 URL 前缀与过期时间（默认 12h），
  因此一条 500 片的播放列表只需签一次；前缀不匹配 / 过期 / 篡改一律拒绝。
- **SSRF 防护（两层，逐跳执行）**：
  第一层 `isSafeUpstream()` 做纯字符串判定——只允许公网 http(s) 与常见端口
  （`80/443/8080/8443`，用白名单而非穷举危险端口），拒绝回环、私网、CGNAT、链路本地、云元数据地址。
  IPv6 **按位解析**而非字符串前缀比对——`http://[::ffff:127.0.0.1]/` 会被 URL 解析器规范化成
  `[::ffff:7f00:1]`，只比对 `::1` 的写法会直接漏掉它。
  第二层 `verifyHost()` 用 DoH 真的解析一次域名，防 DNS rebinding（字符串合法但 A 记录指向内网）。
  取流时**手动跟随重定向并逐跳重新校验**——用 `redirect: "follow"` 的话，
  一个合法公网地址 302 到 `169.254.169.254` 就能绕过全部校验。
  `/api/stream` 与 `/api/img` 共用同一个 `guardedFetch()`，IP 判定共用 `lib/ipaddr.ts`，
  不存在「修了一个漏了另一个」。
- **应用层限流**：8 个 API 端点各有独立配额，固定窗口计数，只依赖免费的 Cache API
  （KV 只有 1000 写/天、D1 10 万行写/天，都扛不住「每请求写一次」的负载）。
  分片级端点（`/api/stream` 600/分、`/api/img` 600/分）的额度刻意远高于操作级端点
  （`/api/search` 40/分），否则会误杀正常播放。**Cache API 不可用时一律放行**——
  限流组件故障绝不能让站点不可用。这是兜底层，精确配额仍建议在 Cloudflare 控制台配
  Rate Limiting Rules（唯一在 Worker 之前生效的一层）。
- **图片代理有体积上限**（8MB）：海报地址来自第三方接口，不限体积等于开放图床。
  同时不透传上游 `content-length`——Workers 会自动解压并移除 `content-encoding`，
  长度对不上会让浏览器把图片截断。
- **口令比较定长**：Basic Auth 与 `CRON_SECRET` 均使用定长比较，避免时序侧信道。
- **代理签名密钥不可预测**：`/api/stream` 与 `/api/img` 被排除在 Basic Auth 之外
  （`<video>` 原生拉流、VLC 不会带 `Authorization` 头），HMAC 是它们唯一的防线。
  因此密钥不再有「源码里的公开默认值」这条常规路径——未配置时自动生成随机密钥并持久化到 D1。
  见下方「已知限制」第 1 条。
- **安全响应头**：`x-content-type-options` / `referrer-policy` / `x-frame-options` / `permissions-policy`。

## ⚠️ 已知限制

1. **限流是应用层兜底，不是精确配额**。已内置固定窗口限流（见安全设计），但 Cache API 按 colo 隔离、
   读-改-写有竞态、条目可能被提前驱逐，实际放行数会略高于限额——设计取向是「宁可漏放，不可误杀」。
   要精确配额请在 Cloudflare 控制台配 Rate Limiting Rules。
2. **`/api/cron/*` 仍兼容 `?secret=`**（为了不破坏已有部署），但该方式会把密钥写进访问日志，新部署请用 `Authorization: Bearer`。
3. **代理签名在有效期内可重放**。缩短 `DEFAULT_TOKEN_TTL` 可降低风险，代价是长剧连播中途需重新取地址。
4. **DRM / 地区封锁的流仍播不了**——属上游策略问题，任何代理都无法解决。
5. **DNS rebinding 仍有窗口期**。已加 DoH 预解析（见安全设计），但 DoH 解析与实际 `fetch` 解析
   之间存在时间差，攻击者控制的 DNS 可以「对 DoH 返回公网、对 fetch 返回内网」。
   这是 DoH 预解析的固有局限，只有运行时的 egress 策略能根治。
   另：DoH 查询失败时**放行**（fail-open）并打日志——Cloudflare Workers 的网络边界已隔离内网，
   用「全站播放不可用」去换一个在本平台上本就很难被利用的漏洞，不划算。
6. **中转视频流的合规风险**：Cloudflare 服务条款 2.8 对大量中转非 HTML 内容（尤其视频）有限制。
   自用请设好 `USERNAME`/`PASSWORD`/`STREAM_SECRET`，并控制使用规模。
7. **签名密钥的兜底状态需自查**：若 `AURORA_DB` 未绑定或迁移未执行，`/api/health` 会显示
   `secret.source = "fallback"`、`weak: true`。这不是错误状态（服务仍可用），但代理此时无鉴权。

## ⚠️ 合规与许可证

- 本项目基于 MoonTVPlus（MIT）魔改，**请保留原作者版权声明**（见 `LICENSE`）。
- 不要混入采用 CC BY-NC-SA 等禁商用协议的上游代码。
- 默认 `noindex`：不建议对聚合内容做公开 SEO 引流。

## 📜 许可证

MIT
