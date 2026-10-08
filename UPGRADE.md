# AuroraTV 升级说明（v0.4.0）

> 本版是 v0.3.0 之后的一轮对抗审查结果。v0.3.0 见本文档第二节，v0.2.0 见下半部分。

## 零、【最严重】上一轮的 CI 其实是失败的 —— 锁文件不跨平台

v0.3.0 我加了 `verify`（typecheck/test/lint）+ `deploy` 两阶段 CI，并报告「已推送、已验证」。
**但那次 CI 的 `deploy` 作业是失败的**（run `37763591289`）：

```
verify  ✓ 34s
deploy  ✗ 27s
  Error: Cannot find native binding. npm has a bug related to optional dependencies
         (https://github.com/npm/cli/issues/4828)
  Error: Cannot find module '@ast-grep/napi-linux-x64-gnu'
```

**根因**：`package-lock.json` 是在 **Windows** 上生成的，而 npm 会把「`os`/`cpu` 与当前平台
不匹配」的可选依赖**从锁文件里裁掉**。于是锁文件里只有：

| 包 | 锁文件里有的平台 | 缺的 |
| --- | --- | --- |
| `@ast-grep/napi`（OpenNext 用它改写产物） | `win32-x64-msvc` | 其余 8 个，含 `linux-x64-gnu` |
| `@next/swc` | `win32-x64-msvc` | 其余 7 个，含 `linux-x64-gnu` |
| `@img/sharp` | `win32-x64` | 其余 |

CI 跑在 `ubuntu-latest` 且用 `npm ci`，而 `npm ci` **只装锁文件里有的东西**，
于是 Linux 原生二进制一个都没装，`opennextjs-cloudflare build` 在加载
`@ast-grep/napi` 时直接抛 `MODULE_NOT_FOUND`。

**为什么 `verify` 却是绿的**：typecheck / test / lint 都不需要原生二进制，
只有真正要产出部署包的 `deploy` 才需要 —— 失败被两个作业的边界挡住了。
这也是「加了 CI 闸门」反而掩盖问题的一次典型：**闸门只保护它覆盖到的那部分**。

**修复**：把 CI 必需的原生二进制提升为**根级 `optionalDependencies`**：

```json
"optionalDependencies": {
  "@ast-grep/napi-linux-arm64-gnu": "0.40.5",
  "@ast-grep/napi-linux-x64-gnu": "0.40.5",
  "@next/swc-linux-arm64-gnu": "15.5.27",
  "@next/swc-linux-x64-gnu": "15.5.27"
}
```

根级声明的可选依赖会被完整写进锁文件，而 `os`/`cpu` 门控保证**各平台只装自己那一份**
（Linux 装 linux，Windows 装 win32，互不干扰）。这是 npm/cli#4828 的标准绕法，
比「把 `npm ci` 换成 `npm install`」更好：**保住了锁文件的确定性**。

> 版本号需要与 `next` / `@ast-grep/napi` 保持同步，升级这两个依赖时要一并改。
> 已在 `UPGRADE.md` 与 `README.md` 中标注。

**验证**：改动后锁文件只新增这 4 条、无任何删除；`npm ci --dry-run` 通过（锁文件与
`package.json` 同步）。

**CI 实测**：`e11910d` 推送后 run `37770701138` **全绿** ——
`verify ✓ 43s` / `deploy ✓ 1m4s`。**这是 `deploy` 作业第一次真正成功**，
即 Cloudflare Workers 真的部署上去了（v0.3.0 那次是失败的）。

**顺带消除一个同类隐患**：既然 `@next/swc-linux-*` 钉死在 `15.5.27`，
`next` 就不能再用 `^15.5.27` —— 否则 Next 发 `15.5.28` 后一次 `npm install` 会让
`next` 漂到 15.5.28 而 Linux 版 swc 停在 15.5.27，报
`Mismatching @next/swc version, expected 15.5.28, got 15.5.27`，
**且只在 Linux 上暴露**。现在 `next` / `eslint-config-next` / `@next/swc-linux-*`
统一为精确版本 `15.5.27`（提交 `f37e06d`）。

## 一、SSRF 只修了一半：`/api/img` 漏网

v0.3.0 修好了 `/api/stream` 的重定向绕过，**但 `/api/img` 还在用 `redirect: "follow"`**。
同一个漏洞、同一个成因，只是换了个文件：

```ts
upstream = await fetch(target, { headers: ..., redirect: "follow" });  // ← 旧代码
```

海报地址来自第三方采集接口的 `vod_pic` 字段，签名的确是合法的 —— 但只要那个图床 302 到
`http://169.254.169.254/latest/meta-data/`，校验就形同虚设。

**修复**：把守卫取流从 `stream/route.ts` 抽成 `proxy.ts` 里的 `guardedFetch()`，
两处共用。**只修一个调用点、不抽公共实现，正是这次漏网的根因** —— 所以这次直接消除重复。

## 二、`isSafeUpstream()` 的 IPv6 绕过

旧实现是**字符串前缀比对**：

```ts
if (host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return false;
```

而 WHATWG URL 解析器会把 `http://[::ffff:127.0.0.1]/` **规范化**成 `[::ffff:7f00:1]` ——
三个分支一个都不命中，于是**回环地址被判定为安全**。这是一条完整的 SSRF 通路，
而且它连重定向都不需要，直接把内网地址塞进 `u` 参数即可。

**修复**：改为**按位解析** IPv6（展开 `::` 得到 8 个 16 位分组），再按网段判断。
现在能拦下 IPv4 映射/兼容地址（`::ffff:7f00:1`、`::7f00:1`）、`::`、组播 `ff00::/8`、
NAT64 `64:ff9b::/96`、Teredo `2001::/32`、6to4 `2002::/16` 里内嵌的内网 v4，
以及带 zone id 的链路本地地址。**解析失败一律视为危险**（fail-closed）。

## 三、`/api/img` 无体积上限，等于开放图床

海报 URL 来自第三方接口。上游被投毒或返回一个超大「图片」时，旧实现会把整个响应体
**原样回传并写进边缘缓存**，等于给攻击者一个免费 CDN。

**修复**：8MB 上限，两道闸门 ——
1. `content-length` 预检，超限直接 413，连流都不开；
2. `TransformStream` 逐块计数兜底（分块传输根本不带 `content-length`，只靠预检拦不住）。

> 预检这里有个坑：写成 `Number.isFinite(n) && n > MAX` 的话，伪造 `Content-Length: 1e999`
> 会得到 `Infinity`，被 `isFinite` 判为「非法头」从而**跳过预检**。改成直接比较大小。

## 四、`/api/img` 盲传 `content-length` 会把图片截断

旧代码把上游的 `content-length` 直接透传。但 Cloudflare Workers 的 `fetch` 会
**自动解压 gzip/br 并移除 `content-encoding`**，而 `content-length` 仍是**压缩前**的长度。
浏览器按旧长度读取 → 图片裂一半。

**修复**：不再透传 `content-length`，交给运行时按实际字节决定（分块传输没有任何副作用）。

## 五、搜索缓存不随片源集合失效

缓存键是 `makeCacheKey("search", kw, { v: 2 })` —— 只有一个人工维护的版本号。
站长导入 / 删除 / 启停片源后，用户仍会命中 **30 分钟前**的旧结果，
表现为「后台明明加了源，前台却搜不到」。

**修复**：缓存键加入**启用片源集合的指纹**（排序后的 `id:weight` 拼接）。
集合一变键就变，不需要人工改版本号。

## 六、`Player`：「重试」按钮在 hls.js 路径下是空操作

失败后点「重试」不生效。原因有两层：

1. `retry()` 只做了 `setCandIdx(0)`，而 `candIdx` **本来就是 0** → React 不重渲染 → 挂载媒体的 effect 不重跑；
2. HLS 走的是 `hls.js` 分支，**从不设置 `video.src`**，所以那个「手动设 src」的兜底代码对它完全无效。

**修复**：新增 `reloadKey` 并加入 effect 依赖，每次重试强制重挂媒体，两条路径都能真正重试。

## 七、手动换线路被算进了片源健康评分

`switchLine()` 里写 `reportedRef.current = true` 想表达「手动换线不计入统计」，
但这个 ref 在挂载 effect 里会被立刻重置为 `false` —— 意图失效，
用户手动切到一条更差的线路并播放成功，会**抬高那个源的健康评分**。

**修复**：改用独立的 `manualRef`，由挂载 effect 读取后清除，跨渲染周期生效。

## 八、验证结果

| 闸门 | 结果 |
| --- | --- |
| `npm ci --dry-run`（锁文件与 `package.json` 同步） | ✅ 通过 |
| `npm run typecheck` | ✅ 无错误 |
| `npm test` | ✅ 36/36 通过（v0.3.0 为 22 项） |
| `npm run lint` | ✅ 0 error / 0 warning |
| `next build` | ✅ 编译成功，9/9 静态页生成 |
| `opennextjs-cloudflare build` | ✅ 产出 `.open-next/worker.js` + 完整 bundle |

部署产物已用「在本轮新代码里独有的字符串」反向核对（`blocked redirect target`、
`image too large`、`img proxy rejected`、`too many redirects`），确认 bundle 里跑的
确实是当前源码，而不是旧产物。

> **构建环境备注（仅本地，与 CI 无关）**：在 Windows + 受限沙箱下 `next build`
> 会在 `.next` 的清理与 `trace` 文件创建上被拦（`SAFE_DELETE_BULK_CONFIRM_REQUIRED` /
> `EPERM`）。绕过方式是先 `mkdir -p .next && : > .next/trace` 再构建。
> CI（`ubuntu-latest`）无此问题。

新增的 14 项单测集中在两处**安全核心**：

- **IPv6 地址矩阵**：IPv4 映射/兼容回环、`::`、组播、NAT64、Teredo、6to4 内嵌内网，
  同时断言公网 IPv6 与「映射的是公网 v4」必须放行（防止把防护写成误杀）。
- **`guardedFetch` 重定向逐跳校验**：注入假 fetch，断言「危险地址**一次都不会被真正请求**」
  （只断言返回错误是不够的 —— 必须证明请求没发出去），以及相对 Location、跳数上限、
  缺 Location、按跳重建请求头、`opaqueredirect` 兜底。

---

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
