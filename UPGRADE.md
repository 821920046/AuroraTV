# AuroraTV 升级说明（v0.3.0）

> v0.2.0 的流代理升级见本文档下半部分。以下为 v0.3.0 的修复。

## 一、`npm ci` 装不上：依赖冲突被 `--legacy-peer-deps` 掩盖

**现象**：在干净环境（CI、新克隆）执行 `npm ci` 或 `npm install` 直接失败：

```
npm error Conflicting peer dependency: @cloudflare/workers-types@5.20261008.1
npm error   peerOptional @cloudflare/workers-types@"^5.20261006.1" from wrangler@4.148.0
npm error   peer wrangler@"^4.125.0" from @opennextjs/cloudflare@1.20.9
```

**根因**：`@cloudflare/workers-types` 锁在 `^4.x`，而 `wrangler ^4` 的最新版要求 `^5.x`。

**为什么一直没被发现**：CI 用的是 `npm install --legacy-peer-deps`——这个开关让 npm 忽略 peer 冲突，
于是「装不上」被降级成一条 warning。加上仓库**没有 `package-lock.json`**，
每次 CI 解析出的依赖树都可能不同，问题只会更隐蔽。

**修复**：把 `@cloudflare/workers-types` 升到 `^5.20261006.1`，提交 `package-lock.json`，
CI 改用 `npm ci`，并**移除 `--legacy-peer-deps`**。

## 二、构建闸门被关掉，类型错误静默进生产

`next.config.mjs` 里曾写着：

```js
typescript: { ignoreBuildErrors: true },
eslint: { ignoreDuringBuilds: true },
```

这是为了绕开**真实存在的类型错误**（不是误报）。根因是 `@cloudflare/workers-types` 把全局
`Response.json()` 重载为 `Promise<unknown>`，于是下面这种写法类型不匹配：

```ts
fetch("/api/home").then((r) => r.json()).then((d: { movies?: Item[] }) => { ... })
//                                 ^^^^^^ unknown 不能赋给具体类型
```

正确做法是**显式断言**而不是给参数加注解：

```ts
.then((raw) => { const d = raw as { movies?: Item[]; tv?: Item[] }; ... })
```

已修复 `src/app/page.tsx` 与 `src/app/live/page.tsx` 两处，随后**移除两个 ignore 开关**，
并把 `typecheck` / `test` / `lint` 加进 CI 作为部署前置闸门。

## 三、SSRF：签名校验被重定向绕过

`/api/stream` 的签名只绑定「发起请求的那个 URL」，但取流时用的是 `redirect: "follow"`。
这意味着一个**通过了全部校验的公网地址**，只要 302 跳到 `http://169.254.169.254/…`
（云元数据）或 `http://127.0.0.1/…`，就能把 `isSafeUpstream()` 整个绕过去。

**修复**：改为 `redirect: "manual"`，手动跟随重定向，**每一跳都重新做地址校验**，
并限制最多 3 跳。顺带修正了一处相关问题：跳转后 Referer 必须按当前域名重新生成，
否则部分防盗链会拒绝。

## 四、其他

- **`env.d.ts` / `.dev.vars.example` 补上 `STREAM_SECRET`**。
  `lib/proxy.ts` 一直在读它，但两处声明都没有——`.dev.vars.example` 里没有，
  部署者不会知道要配这个变量，于是代理签名静默退化成「用 PASSWORD 甚至内置默认值」。
- **`TokenMinter` 去掉构造函数参数属性**（`constructor(private x: T)`）。
  那是不可擦除语法，会让 Node 的 strip-only 模式无法加载该模块，直接后果是**没法单测**。
- **新增 22 项零依赖单测**（`src/lib/proxy.test.mts`，用 Node 内置 test runner，不引入任何框架），
  覆盖 SSRF 地址矩阵、HMAC 令牌往返/过期/篡改/前缀绑定、m3u8 的 `URI="..."` 改写。
- **修复 lint 问题**：`<a>` 内链改用 `next/link`；`<img>` 的 eslint-disable 注释位置错误
  （注释在 `return (` 上方，管不到下一行的 `<img>`，等于没生效）；`Player.tsx` 快捷键 effect 补全依赖。
- **`tsconfig.json` 排除 `auroratv/`**：仓库里残留的旧副本会被 `include: ["**/*.ts"]` 通配到，
  污染类型检查（会报出一堆与本工程无关的错误）。
- **`.gitignore` 补全** `*.tsbuildinfo`、`*.zip`、`auroratv/`。
- **修正 README**：原文仍写着「绝不代理视频流」，与已经落地的 `/api/stream` 直接矛盾，会误导部署者。

## 五、验证结果

| 闸门 | 结果 |
| --- | --- |
| `npm ci`（干净环境，不带 `--legacy-peer-deps`） | ✅ 通过 |
| `npm run typecheck` | ✅ 无错误 |
| `npm test` | ✅ 22/22 通过 |
| `npm run lint` | ✅ 0 error / 0 warning |
| `next build` + `opennextjs-cloudflare build` | ✅ 产出 `.open-next/worker.js` |

---

# AuroraTV 升级说明（v0.2.0）

## 一、病因：为什么「点播放没反应」

浏览器要播成一条 HLS 流，硬性条件有三条，缺一不可：

1. **混合内容**：站点是 `https`（Workers 强制 HTTPS），采集站返回的播放地址大量是 `http://` → 浏览器直接拦截，连请求都发不出去。
2. **CORS**：桌面 Chromium 没有原生 HLS，必须用 hls.js + MSE，靠 XHR 拉 `m3u8` 和每个 `ts` 分片；采集站 CDN 基本不带 `Access-Control-Allow-Origin` → 致命错误。
3. **防盗链**：不少 CDN 校验 `Referer` / `User-Agent`，浏览器发出的请求头无法伪造 → 403。

旧代码在多处注释里写着一条自我设限的架构铁律：**「只返回可供客户端【直连】的播放地址，绝不中转视频流」**。在浏览器环境里，这条铁律和上面三条物理约束是互斥的 —— 于是项目只能靠 `webOnly` 过滤、`cors` 探测、引导用户装 VLC / 下载 `.strm` 来回避，而 `Player.tsx` 一检测到 `http` 地址就直接渲染失败页（`willBlock`），**连一次尝试都没有**。这才是「点播放没反应」的真正病因，不是片源挂了。

放大问题的还有 4 处：

- 盲目的 8 秒 `failTimer`，只有 `playing` 事件能清除，慢源/缓冲中的源被误杀；
- hls.js 报错后没有任何 `startLoad()` / `recoverMediaError()` 恢复；
- `/api/play` 返回了 `episodes`，前端从来不渲染，只能看第一集；
- 搜索 `dedupe()` 按 `title:year` 直接丢弃重复项，主源一挂就彻底没得换。

## 二、解法：同源签名代理

新增 `/api/stream`（视频）与 `/api/img`（海报/台标）：

- 一律走 Worker 同源 `https` → 混合内容消失；
- 响应统一补 `Access-Control-Allow-Origin` → CORS 消失；
- 上游请求补 `User-Agent` + `Referer`（用上游自己的域名）→ 大部分防盗链消失；
- `m3u8` 会被解析改写：子清单、分片、`#EXT-X-KEY` / `#EXT-X-MAP` / `#EXT-X-MEDIA` 里的 `URI="..."` 全部改写成代理地址，否则加密流和 fMP4 会漏网；
- 分片透传 `Range`，可正常拖进度；直播清单 `no-store`，点播分片 `max-age=600`。

**防滥用**：每个代理地址带 HMAC-SHA256 签名，签名绑定「URL 目录前缀 + 过期时间（12h）」，因此一条播放列表只需签一次（500 个分片也只做 1 次 HMAC）；同时有 SSRF 黑名单（回环、私网、CGNAT、链路本地、云元数据、非 http(s) 协议一律拒绝）。密钥取 `STREAM_SECRET` → `CRON_SECRET` → `PASSWORD`。

## 三、完整改动清单

### 新增
| 文件 | 作用 |
| --- | --- |
| `src/lib/proxy.ts` | 签名铸造/校验、SSRF 防护、m3u8 改写、TokenMinter |
| `src/lib/http.ts` | 统一超时/重试/伪装请求头/容错 JSON 解析 |
| `src/app/api/stream/route.ts` | 视频流代理（含播放列表改写、Range 透传） |
| `src/app/api/img/route.ts` | 图片代理（边缘缓存 1 天） |
| `migrations/0006_play_stats.sql` | `play_stat` 表 + channel/EPG 索引 |

### 重写 / 修改
- **`src/components/Player.tsx`**：双候选线路（代理/直连）自动降级；hls.js 错误分类恢复（网络 → `startLoad`，解码 → `recoverMediaError`，清单拉不到 → 立刻换线路）；看门狗改为「有无进展」判定（16s 内 `readyState`/`buffered` 全无才判死）；25s 无进展的卡死检测；自动播放被拦时静音重试再提示点击；清晰度/倍速/画中画/全屏/上下集/键盘快捷键；失败页给出人话原因。
- **`src/app/api/play/route.ts`**：返回 `url` + `proxy` + `prefer` + 完整 `episodes` + 全部线路 `groups`；`prefer` 仅在 `cors===1` 且地址为 https 时才是 `direct`。改用全量源查询，避免搜索缓存里的旧源 404。
- **`src/app/api/search/route.ts`**：删除 `webOnly` 过滤（代理已让所有源可播），海报走代理；同名影片合并为 `alts` 而不是丢弃 → 前端可一键换源。
- **`src/app/api/home/route.ts`** / **`live/channels`** / **`live/play`**：海报、台标、直播流一律给代理地址。
- **`src/lib/aggregator.ts`**：修复 `seg.split("$")` 截断含 `$` 地址的解析 bug；HLS 优先打分；扇出 6→8、超时 3s→5s 并带一次重试；新增 `parseAllGroups`。
- **`src/app/api/sources/route.ts`** + 迁移 0006：播放成败上报从 KV 改写 D1（KV 免费版每天仅 1000 次写，逐次上报极易打爆，连带拖垮首页/搜索缓存写入），且成功也记，才能算真实成功率。
- **`src/app/page.tsx`**：剧集列表、线路切换、一键换源、观看进度记忆与续播、请求可中断、骨架屏。
- **`src/middleware.ts`**：`/api/stream`、`/api/img` 排除出 Basic Auth（它们有 HMAC 鉴权；否则 VLC/.strm 外部播放器会 401）；密码比较改为定长比较；补安全响应头。
- **`env.d.ts`** / **`.dev.vars.example`**：新增 `STREAM_SECRET`。
- **`package.json`**：新增 `npm run typecheck`。

## 四、部署步骤

```bash
# 1. 设置流代理签名密钥（强烈建议）
npx wrangler secret put STREAM_SECRET     # 输入一段 32+ 位随机串

# 2. 执行新迁移
npm run db:migrate:remote

# 3. 部署
npm install --legacy-peer-deps
npm run typecheck
npm run cf:deploy
```

本地开发时把 `STREAM_SECRET` 写进 `.dev.vars`。

## 五、必须知情的风险

1. **流量与合规**：视频流现在过 Worker。Cloudflare 服务条款 2.8 对「以 CDN 大量中转非 HTML 内容（尤其视频）」有限制，免费版长期大流量存在被限流/封号风险。若只自用，把 `USERNAME`/`PASSWORD` 设上、`STREAM_SECRET` 设强，就是最有效的自保。
2. **CPU / 子请求限制**：Workers 免费版单请求 50 个子请求、10ms CPU（付费 30s）。代理是流式透传，CPU 占用极低，但清单改写会消耗 CPU；超长清单（数千分片）建议用付费版。
3. **签名有效期 12 小时**：期间拿到地址的人可以重放。缩短 TTL 可降低风险（改 `DEFAULT_TOKEN_TTL`），代价是长剧连播中途需要重新取地址。
4. **DRM / 地区封锁的流仍然播不了** —— 这类是上游策略问题，任何代理都无法解决（除非出口 IP 在允许区域，而 Cloudflare 出口 IP 不可控）。
5. **未做联网构建验证**：升级环境无外网，`npm install` / `next build` 无法执行，代码为静态审查通过。首次部署请先跑 `npm run typecheck` 与 `npm run cf:preview`。
