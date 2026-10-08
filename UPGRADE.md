# AuroraTV 升级说明（v0.4.4）

> 本版聚焦**观看体验**：播不了的时候自动换片源，以及不再每次重置你的倍速。
> 另附一节说明片源这件事本身。前三版偏后端与安全，见下方 v0.4.3 / v0.4.2 / v0.4.1。

## 【v0.4.4】观看体验：自动换源 + 记住你的播放偏好

### 一、播不了的时候，自动换一个片源

**病因。** 搜索结果会把同一部片在多个源上的副本合并进 `alts`，播放页也有「换源」按钮。
但**播放失败时不会自动用它** —— 代理线路和直连线路都挂掉后就直接显示失败页，
用户得自己意识到「哦，还能换源」，再手动去点。

而片源质量参差是这类项目的常态：「点开播不了」里面，相当一部分本来换个源就好了。

**修复。** `Player` 新增 `onExhausted(currentTime)` 回调。两条候选线路都失败时，
先问外层「还有没有没试过的片源」：

- 有 → 换源重试，播放器**保持 loading 状态**，不显示失败页；
- 没有 → 才显示失败页。

「不显示失败页」这一点是刻意的：否则用户会看到失败页一闪，紧接着画面又出来了，
观感比多等一秒差得多。

两个必须处理的细节：

1. **防死循环。** 用 `triedRef` 按 `vod_id` 记录已尝试过的源。
   否则 A 源失败换 B 源、B 源失败又换回 A 源，用户看到的是播放器无限重试 ——
   比直接报错还糟。换了一部片（`vod_id` 变了）就重置。
2. **续播。** 回调带上传失败那一刻的 `currentTime`。
   看到第 30 分钟突然断流、换源后却从片头开始，比直接报错更让人恼火。
   播了不到 5 秒就失败的例外 —— 那说明还没真正看到内容，从头开始更合理。

失败过的源仍会被 `report(false)` 降低健康分（既有机制），所以换源绕开过的源会逐渐被排到后面。

### 二、倍速 / 音量不再每次重置

追剧的人几乎都会固定一个倍速。旧版每次切集、每次刷新都回到 1x ——
一集剧要手动调十几次。这是观看体验里最容易被忽略、但发生频率最高的摩擦点。

现在倍速 / 音量 / 静音持久化到 `localStorage`。三个实现上的注意点：

- **逐项校验读出来的值**：`localStorage` 是用户可改的，脏数据不能让播放器崩掉；
- **恢复必须放在 effect 里，且排在「挂载媒体」之前**。先把 muted 设好，
  媒体那边的 `tryPlay()` 才拿得到正确的初始状态 —— 上次静音的用户能直接自动播放，
  不会被浏览器自动播放策略拦下。也不能拿 `localStorage` 当 `useState` 初始值：
  `Player` 会被 SSR 渲染一次，那样会造成 hydration 前后不一致；
- **倍速是元素属性**，重挂媒体后必须重新应用，否则每切一集都会悄悄回到 1x。

### 三、片源这件事本身

顺带说清楚，因为这大概是被问得最多的一个问题。

本项目的片源来自 **MacCMS（苹果CMS）采集接口**（`?ac=detail`）。这个生态里的公开采集站
绝大多数传播的是未授权影视内容，**本项目不会去搜集、也不会附带这类地址**。

想稳定、可控地用起来，可行的是这几条：

1. **自建 MacCMS** —— 苹果CMS 本身是开源软件，接自己的内容；
2. **接自有媒体库** —— Jellyfin / Emby 这类自建库，把播放地址以 m3u8 暴露出来；
3. **已有合法来源** —— 你自己有权限的流地址。

后台的「导入片源」接受标准 MacCMS 接口地址。导入后 `/api/cron/health` 会定期测活，
按成功率与延迟打分，坏源自动降权或停用。

所以「源的质量」这件事，项目能做的是**把可用的那部分筛出来、排到前面、坏了自动绕开**，
而不是凭空变出内容 —— 本版做的自动换源，正是这条链路上最后、也最直接的一环。

### 四、验证

| 闸门 | 结果 |
| --- | --- |
| `tsc --noEmit` | ✅ |
| `npm test` | ✅ 109 项 |
| `next lint` | ✅ 0 warning |
| `next build` | ✅ 无警告 |

---

# AuroraTV 升级说明（v0.4.3）

> 本版处理的是 v0.4.1 收尾时列出的三条「已知未解决项」：限流、SSRF 的 DNS 预解析、
> 以及 `/api/play` 一次回传全集地址。界面重构见下方 v0.4.2。

## 【v0.4.3】限流 / SSRF 加固 / 播放接口瘦身

### 一、限流：为什么最终落在了应用层

**病因。** 上一版明确写了「未做速率限制」，并且建议站长自己去 Cloudflare 控制台配规则。
这个建议本身没错，但它有一个结构性问题：**它是运维动作，不是代码保证**。
换一个部署环境、换一个账号、或者站长只是没看到这句话，这层防护就凭空消失了 ——
仓库本身不携带任何防护能力。

**为什么不能直接用 KV / D1 计数。** 这是本次最关键的取舍：

| 存储 | 免费额度 | 能否用于限流 |
| --- | --- | --- |
| KV | 1000 次**写**/天 | ❌ 限流是「每请求写一次」的负载，一分钟就烧光额度，还会连带拖死正常缓存写入 |
| D1 | 10 万行写/天 | ❌ 同样扛不住，且每次计数多一次跨区往返 |
| Cache API | 免费、不限次数、同 colo 延迟极低 | ✅ 唯一合适的选择 |

**实现。** `src/lib/ratelimit.ts`，固定窗口计数器，只依赖 Cache API 的 `match` / `put`。

必须说清楚它的局限，否则很容易被误当成精确配额：

1. **按 colo 隔离** —— 同一个攻击者被调度到 10 个 colo，就相当于有 10 倍额度；
2. **读-改-写有竞态** —— N 个并发请求可能读到同一个计数值，实际放行数略高于限额；
3. **cache 条目可能被提前驱逐** —— 计数归零，限流暂时失效。

三点方向一致：**宁可漏放，不可误杀**。所以所有阈值都留了数倍余量，定位是「挡住单点脚本刷」，
不是计费。**精确边缘限流仍然建议去控制台配 Rate Limiting Rules，那是唯一在 Worker 之前生效的一层。**

**阈值怎么定的。** 这里有一个非常容易踩的坑：`/api/stream` 和 `/api/img` 不是「人操作级」频率。

- `/api/stream` 是**分片级**流量：6 秒一片 ≈ 10 次/分钟，2 秒一片 ≈ 30 次/分钟，seek 预加载还会突发；
- `/api/img` 一个搜索页会**并发加载上百张海报**。

按「操作次数」给这两个端点定阈值会直接误杀正常用户。最终规则：

| 端点 | 限额（每分钟） | 依据 |
| --- | --- | --- |
| `/api/stream` | 600 | 正常单用户 <30，留 20 倍余量 |
| `/api/img` | 600 | 单页最多并发 120 张，留 5 倍 |
| `/api/sources` | 120 | 每次播放上报 1~2 次 |
| `/api/live/*` | 120 | 切台频率低于点播 |
| `/api/play` | 80 | 切集 / 换源 |
| `/api/detail` | 60 | — |
| `/api/search` | 40 | 最贵的端点：一次扇出到 8 个上游 |
| `/api/home` | 40 | 有边缘缓存，回源极少 |

**两个顺序上的决定：**

- `/api/stream` 与 `/api/img` 的限流放在 **HMAC 校验之后**。无效令牌在上一行就被 403 挡掉了，
  消耗可忽略；要约束的是「合法但过量」的流量 —— 那才是真正打到上游、烧 Worker CPU 的部分。
- 其余端点放在**参数校验之后、任何上游调用之前**。限流的意义就是不让请求走到 `fetchJson`。

**可用性优先。** Cache API 不存在（本地 dev / 非 Cloudflare 运行时）或读写抛异常时，一律放行。
限流组件故障绝不能把站点变成不可用 —— 与 `lib/cache.ts` 的容错原则一致。

**统一 429。** 有 8 个端点要接限流，各写一份 429 必然出现「有的带 `retry-after` 有的不带」——
这正是 v0.4.0 里 `/api/stream` 修了、`/api/img` 漏掉的老毛病。所以抽成 `rateLimitedResponse()`，
`retry-after` 用 RFC 9110 标准头。

### 二、SSRF：端口白名单 + DNS 预解析

**先说结论上的诚实：DNS 预解析在 Cloudflare Workers 上的收益，比在传统服务器上小得多。**

Worker 跑在 Cloudflare 边缘网络里，网络边界天然隔离了 RFC1918 内网 ——
它根本路由不到用户的自建内网，也够不到云厂商的 `169.254.169.254` 元数据服务。
传统 SSRF 最致命的那条路径在这里本来就是断的。

所以这一层是**纵深防御**，不是主要防线。它的价值在于：万一运行时策略变化、
或者这个项目被部署到别的平台，防护不会凭空消失。

**改动一：端口白名单（零成本、收益明确）。**

旧实现不限制端口，等于允许用代理探测内网任意端口的开放状态。现在只放行
`80 / 443 / 8080 / 8443`（空字符串代表 URL 规范化后的默认端口）。
用白名单而不是黑名单的理由很简单：危险端口有 65535 个，穷举必然漏。

**改动二：DoH 预解析（`src/lib/dnsguard.ts`）。**

`isSafeUpstream()` 只能校验「URL 里写的东西」。`https://evil.example.com/x` 这个字符串
本身完全合法，但它的 A 记录可以指向 `127.0.0.1` —— 这就是 DNS rebinding，只能真的解析一次。

Workers 没有暴露 DNS 解析 API，所以用 Cloudflare 自己的 1.1.1.1 DoH JSON 接口。
每次查询是一次子请求，因此**缓存是必需的而非优化**：

- **isolate 内存缓存**（5 分钟）—— 命中后零成本；
- **边缘缓存**（5 分钟）—— 跨 isolate 共享；
- **并发去重** —— 这一条同样是必需的：一个搜索页并发加载上百张海报，它们绝大多数来自
  同一个图床 host。缓存未命中时若不去重，会在几十毫秒内对同一个域名打出上百次 DoH 查询。
  合并后同一时刻每个 host 最多 1 次真实查询。

**fail-open，以及为什么。** DoH 查询失败时**放行**，但打日志、且**不写边缘缓存**
（否则一次抖动会被缓存 5 分钟，把故障悄悄藏起来）。理由：

1. 如上所述，Workers 的网络边界已经承担了主要防线；
2. fail-closed 意味着 DoH 的任何抖动都会让**全站播放**立刻挂掉 ——
   用一个真实且高频的可用性事故，去换一个在本平台上本就很难被利用的漏洞；
3. `isSafeUpstream` 的静态检查始终生效，不会因为这里放行而整体失守。

**顺带做的一件事：抽公共模块。** IP 判定现在有两个使用方（URL 字面量校验、DNS 记录校验），
所以抽到了 `src/lib/ipaddr.ts`，两边 import 同一份实现。上一轮的教训是
`/api/stream` 修了、`/api/img` 漏了 —— 根因就是同一个判定被写了两份。

`proxy.ts` 仍然保持「只 import 同目录零依赖模块」，所以 `proxy.test.mts` 照旧能被 Node 直接加载。
`guardedFetch()` 新增可注入的 `verifyHost`，**默认启用**；单测必须显式传 `null` 关掉它，
否则每个用例都会真的去查一次外网。

### 三、`/api/play`：先修缓存，再谈瘦身

**原本以为的问题是「返回全集地址」，读代码后发现更严重的问题：这个端点根本没有缓存。**

```ts
const detail = await fetchDetail(sources, sourceId, vodId);  // 每次调用都打上游
```

也就是说，用户每切一集就重新请求一次上游详情接口。一部 40 集的剧从头看到尾 =
**40 次上游请求**，慢，而且极易触发上游限流。这比响应体大小严重得多。

**修复一：复用 `/api/detail` 的缓存键。** 切集命中缓存后零上游请求。
刻意用 `persist=false`（只写边缘缓存，不写 KV）——`/api/play` 是最高频入口，
用它当持久化层会把 KV 那 1000 次/天的写额度烧光。

**修复二：只为「当前这一集」签发地址。** `episodes[]` 现在只回名字：

```diff
- episodes: [{ name, url, proxy, prefer }, ...]   // 100 集 = 200 个 URL，轻松上 100KB
+ url: "…", proxy: "…", prefer: "proxy",          // 只有当前集
+ episodes: [{ name: "第1集" }, …]
```

前端切集时带 `ep` 重新请求，命中上面的缓存 —— 代价只是一次边缘缓存读，比传 100KB 划算得多。
顺带也解决了「把所有线路的签名令牌一次性全发给客户端」。

**前端配套改动：**

- 切集不能再本地改状态了（`setPlay({...play, ep: next})`），必须真的去取一次新地址；
- 新增 `pendingEp`：切集要走一次网络，而 `play.ep` 要等数据回来才变 ——
  没有它，用户点了第 5 集却看到第 3 集还亮着；
- 切集时**不再显示骨架屏**：保留当前播放器直到新地址到达，否则每换一集画面都闪一下。

### 四、`/api/health` 现在会报告这两层防护的状态

```
rate_limit: { storage: "cache-api" | "none", rules: {...}, note: "…" }
dns_guard:  { mode: "doh", fail_mode: "open", note: "…" }
```

`storage` 尤其重要：Cache API 不可用时限流会**静默放行**，这种状态必须能被看见。

### 五、验证

| 闸门 | 结果 |
| --- | --- |
| `tsc --noEmit` | ✅ |
| `npm test` | ✅ **109 项**（v0.4.2 为 52，本次新增 57） |
| `next lint` | ✅ 0 warning |
| `next build` | ✅ 无警告 |

新增测试覆盖：限流的三态判定与脏计数、跨窗口重置、不同 IP / 端点互不串键、
Cache 故障时放行、`stream`/`img` 额度必须显著高于操作级端点（把「误杀正常播放」这个坑锁进断言）；
IP 判定的三态语义与 IPv6 按位解析；DNS 守卫的公网放行 / 内网拒绝 / CNAME 不被误判 /
fail-open / 缓存命中 / 并发去重；端口白名单；`verifyHost` 逐跳调用且在发请求前拦下。

### 六、仍未解决

- **精确边缘限流**：应用层这层是兜底，真正的配额仍需在 Cloudflare 控制台配 Rate Limiting Rules。
- **DNS rebinding 的窗口期**：DoH 解析与实际 `fetch` 解析之间存在时间差，
  攻击者控制的 DNS 可以「对 DoH 返回公网、对 fetch 返回内网」。这是 DoH 预解析的固有局限，
  只有运行时的 egress 策略能根治。
- **代理签名在有效期内可重放**：缩短 `DEFAULT_TOKEN_TTL` 可降低风险。

---

# AuroraTV 升级说明（v0.4.2）

> 本版是**界面与布局**的一轮重构。前两版偏后端与安全，见下方 v0.4.1 / v0.4.0 各节。

## 【v0.4.2】界面重构：从「能看」到「像样」

### 一、首页根本没有导航

`src/app/page.tsx` 里没有 `<header>`。直播页和管理页各自手写了一份一模一样的
header JSX，首页却一份都没有 —— 结果是**首页没有任何入口能进直播页或管理页**，
只能手敲 URL。而且两份副本已经不一致了：管理页写「返回首页」，直播页写「点播 / 管理」。

抽成 `src/components/SiteHeader.tsx`：品牌 + 分段式导航（`usePathname` 高亮当前页）
+ `aria-current="page"`。三处共用。

### 二、海报卡片被内缩了 16px（最容易被忽略的视觉缺陷）

`.card` 是 `<button>`，但旧 CSS 只覆盖了 `border-radius / overflow / background / border`，
**没有重置全局 `button { padding: 10px 16px }`**。于是每张卡片的左右各多出 16px 内边距，
海报不是通铺的 —— 看起来像「框里套框」，而不是海报墙。

```css
.card {
  padding: 0;          /* 关键：清掉全局 button 的 padding */
  text-align: left;    /* button 默认居中，会让标题看起来怪 */
}
```

### 三、CSS 是「一层层追加」长出来的，已经自相矛盾

| 问题 | 后果 |
| --- | --- |
| `.player-frame` 定义了**两次**（旧第 241 行 / 第 715 行） | 后者静默覆盖前者，改前面那份毫无效果 |
| `.hero h1` 与 `.wordmark` 抢同一个元素 | 首页 `<h1 class="wordmark">` 同时命中两条规则，字号靠源码顺序决定 |
| 颜色/间距全是魔法数字，同类值有 6 种写法 | 改一处必然漏一处 |

这一版把设计决策收敛成令牌（`--s-1..12` 间距刻度、`--r-sm/md/lg/full` 圆角、
`--border / --panel / --brand-*` 颜色、`--z-*` 层级、`--ease / --dur` 动效），
再按令牌重写规则。所有既有类名保持不变，`Player` / `admin` / `LiveAdmin` 无需改动。

### 四、搜索之后，hero 还占着半屏

首页 hero 是 56px 上边距 + 40px 大标题 + 28px 搜索框。用户搜完之后，
搜索结果被推到折叠线以下 —— 必须滚动才能看到自己刚搜的东西。

改成可收缩：结果出现时给 hero 加 `.is-compact`（标题降到 20px、副标题隐藏、
上下边距减半），搜索框仍然是页面焦点，但结果立刻可见。

### 五、其余布局与可用性改动

| 位置 | 旧 | 新 |
| --- | --- | --- |
| 首页「继续观看」 | 一排纯文字胶囊（`chip`） | 带海报缩略图 + **观看进度条**的横向卡片；手机 1 列 / 平板 2 列 / 桌面 3 列 |
| 剧集列表 | 塞进 `.chips`（flex-wrap），50 集以上变成一大坨胶囊 + 固定 220px 滚动 | `.ep-grid` 等宽网格 + 当前集高亮 + **自动把当前集滚进视野**（仅在不可见时才滚） |
| 播放区 | 只显示了标题和简介 | 补上从接口取回却**从未渲染**的 `year / area / actor`，加海报与「第 N / M 集」标签 |
| 卡片信息 | 单行截断（长片名信息全丢） | 片名两行截断；右上角角标显示更新状态，左上角显示「N 源」 |
| 播放器控件 | `flex-wrap` + `.header-spacer` 在窄屏占满一行，把「上一集」推到新行右侧 | 窄屏隐藏 spacer，控件自然回流 |
| 管理表格 | 窄屏把整页撑出横向滚动条 | `.table-scroll` 容器内横向滚动 |
| 直播分组 | 换行成好几排，把频道网格挤下去 | ≤900px 切成单行横向滚动，桌面仍换行（全部可见） |
| 容器宽度 | 首页 1200px、其他页 1080px，切页时内容左右跳动 | 统一到 `--page-max` |
| 骨架屏 | 内联 `height: 240`，与实际海报比例不一致 | 用真实比例（`aspect-ratio`）与真实结构 |

### 六、Logo 每页白拉 1.6 MB

`public/logo.png` 是 **1254×1254 / 1647 KB**，而它只显示在 34px 的徽标里
（移动端 30px）。每打开一个页面都要下载这 1.6 MB。

按「显示尺寸 × 3 倍 DPI」压到 128×128：**1647 KB → 27.6 KB（-98.3%）**，
并给 `<img>` 补上 `width`/`height` 消除布局位移（CLS）。
`src/app/icon.png` 同步从 512 降到 180（iOS 主屏图标标准尺寸）。

### 七、无障碍：之前完全没有覆盖

- **`:focus-visible`**：旧版一条都没有 —— Tab 键用户根本看不到焦点在哪。
- **`prefers-reduced-motion`**：持续漂移的背景光晕、hover 位移、shimmer 骨架
  对前庭功能敏感的用户不友好，现在统一降为 0.01ms。
- **`aria-*`**：导航 `aria-current`、chip 用 `aria-pressed`、搜索结果 `aria-live`、
  剧集当前集 `aria-current`、装饰性元素 `aria-hidden`。
- **语义修正**：剧集按钮一度被我写成 `role="listitem"`，那会**覆盖掉 button 角色**，
  读屏会念成「列表项」而不是「按钮」—— 已去掉。

### 八、响应式

- 断点从「只有一档 640px」扩到 **900 / 640 / 380** 三档。
- `min-height: 100vh` → 补 `100dvh`：移动端地址栏收起/展开时 100vh 会跳变。
- 卡片列宽改用 `clamp()`：`repeat(auto-fill, minmax(clamp(104px, 21vw, 158px), 1fr))`，
  一个声明覆盖全部宽度，不再需要 media query 里再写一遍 `minmax`（旧版就是因此漏掉对齐的）。
- 超窄屏（≤380px）搜索框与按钮改为上下排。

### 九、验证

- `npm run typecheck` ✅ / `npm run lint` ✅（0 warning）/ `npm test` ✅ 52 项
- `npx next build` ✅ 9/9 静态页
- **视觉自查**：用无头 Chrome 对同一套 CSS 分别以 1280px 与 390px 视口截图，
  逐块核对头部、卡片网格、播放器、剧集网格、直播频道墙、管理表格。
  过程中发现并修掉 3 个真实缺陷：
  1. 直播分组 chips 因 CSS 书写顺序（`.live-groups` 在 `.chips-scroll` 之后）导致
     `flex-wrap: wrap` 反压 `nowrap`，横向滚动失效；
  2. 「继续观看」缩略图里 18px 的兜底文案在 68px 宽内折成三行被裁断；
  3. 窄屏下「第 3 集 · 看到 00:12:30」被省略号吃掉 —— 改为手机单列布局。

> 截图工具踩坑记录：Windows 上无头 Chrome 的 `--window-size` 有 **~500px 最小宽度**，
> `--window-size=390` 实际渲染在 504px 视口再裁到 390px，会误判成「头部导航被切掉」。
> 正确做法是用 `<iframe width=390>` 隔离视口。已写进 `.workbuddy-ai/memory/MEMORY.md`。

---

> 以下为 **v0.4.1 及更早**的版本记录（后端 / 安全方向），保留以供回溯。

## 【v0.4.1】代理签名密钥：从「公开默认值」到「自动生成并持久化」

### 病因：一条谁都看得见的密钥

`/api/stream` 与 `/api/img` 在 `middleware.ts` 里被**排除在 Basic Auth 之外**：

```ts
matcher: ["/((?!_next/static|_next/image|favicon.ico|api/cron|api/stream|api/img).*)"],
```

这个排除是**必须的**——`<video>` 原生拉流、VLC、`.strm` 都不会带 `Authorization` 头。
于是这两个端点的**唯一防线就是 HMAC 签名**，而签名密钥来自这条回退链：

```ts
env.STREAM_SECRET || env.CRON_SECRET || env.PASSWORD || "auroratv-default-insecure-secret"
```

最后那一段是**写在源码里、公开可读的常量**。也就是说：任何一次没配 `STREAM_SECRET` 的部署，
其代理端点等价于**无鉴权**——攻击者拿这个常量自己铸令牌，就能把本站当开放代理用：
刷流量（吃你的免费额度、触发 Cloudflare 条款 2.8）、隐藏自己的真实 IP、绕过地区限制。
而部署者对此**完全无感知**：没有日志、没有告警、没有任何提示。

更糟的是，`proxy.ts` 的注释里写着「此时安全性较弱，**会在 `/api/health` 提示**」——
而全仓库根本**没有 `/api/health` 这个路由**。`isProxySecretWeak()` 也因此成了死代码，
除单测外零引用。这是一句典型的「假注释」：承诺了一个不存在的功能，读代码的人会因此以为有人管这件事。

### 修复

**没有采用「没配密钥就拒绝签发」的方案**——那会让「只配了 `PASSWORD` 的老部署」
升级后立刻播不了，属于破坏性变更。改为**首次访问时自动生成并持久化**：

| 顺序 | 来源 | 说明 |
| --- | --- | --- |
| 1 | `STREAM_SECRET` | 显式配置，最高优先级（不变） |
| 2 | `CRON_SECRET` | 兼容既有部署（不变） |
| 3 | **D1 `app_setting.proxy_secret`** | **新增**：32 字节 CSPRNG 随机值，首次访问生成后落库 |
| 4 | 公开常量 | 仅在「1、2 都没配 **且** D1 不可用」时兜底 |

新增文件 / 改动：

- **`migrations/0008_settings.sql`**：`app_setting(key TEXT PRIMARY KEY, value TEXT, created_at INTEGER)`。
- **`src/lib/db.ts`**：`getOrCreateSetting()` / `getOrCreatePersistedSecret()` / `randomSecret()`。
- **`src/lib/secret.ts`**（新）：`resolveProxySecret()`，负责 isolate 内缓存与优先级编排。
- **`src/lib/proxy.ts`**：新增 `INSECURE_DEFAULT_SECRET` / `getExplicitSecret()` / `pickSecret()`；
  `isProxySecretWeak()` 改为接收**已解析的密钥**；**删除 `getProxySecret()`**（不留死代码）。
- **`src/app/api/health/route.ts`**（新）：兑现那句注释，只报状态、不回显密钥。
- 7 处调用点（`home` / `play` / `search` / `img` / `stream` / `live/channels` / `live/play`）
  由 `new TokenMinter(getProxySecret(env))` 改为 `const { secret } = await resolveProxySecret(env)`。

### 三个容易写错的地方

**① 多 isolate 竞态 —— 不能「返回自己生成的值」。**
首次访问时多个 isolate 可能同时发现「没有值」并各自生成一份。若直接返回自己那份，
就会出现 A isolate 用密钥1 签发、B isolate 用密钥2 校验 → **随机 403，且极难排查**。
所以必须是「`INSERT ... ON CONFLICT(key) DO NOTHING` 之后再回读」：落库的那一份是唯一权威值。

```ts
const found = await db.prepare("SELECT value FROM app_setting WHERE key = ?1").bind(key).first();
if (found?.value) return found.value;
await db.prepare("INSERT INTO app_setting (...) VALUES (?1,?2,?3) ON CONFLICT(key) DO NOTHING")
        .bind(key, makeValue(), Date.now()).run();
const after = await db.prepare("SELECT value FROM app_setting WHERE key = ?1").bind(key).first();
return after?.value ?? null;   // 回读，而不是 return makeValue()
```

单测 `db.test.mts` 里专门有一条复现这个时序：让首次 SELECT 假装查不到，
但表里其实已有 `"winner"`，断言最终回读到的是 `"winner"` 而不是自己生成的 `"loser"`。

**② 不能缓存兜底态 —— 否则 D1 一次抖动就永久废掉 isolate。**
密钥是部署级常量，缓存到 isolate 结束是安全的；但 `fallback` 状态必须带过期时间，
否则一次 D1 读失败会让该 isolate **在整个生命周期内**都用公开常量。

**③ `PASSWORD` 必须从密钥链里去掉。**
它是 Basic Auth 登录口令：熵低（人手敲的短口令）、且复用会导致「改口令 = 所有已发出的播放链接
立即失效」——两件事的轮换周期完全不同。最关键的是，`PASSWORD` 泄漏后攻击者拿到的不只是后台，
还有「铸造任意代理令牌」的能力。签名只认专用密钥。

### 升级影响（一次性、可自愈）

升级后**已经发出的播放链接会全部失效一次**，表现为「点播放报 403，刷新页面就好」。原因：

- 以前用 `PASSWORD` 或公开常量签发的令牌，现在校验时用的是新的 D1 密钥 → 签名对不上；
- 但 `/api/play`、`/api/home`、`/api/search` 每次都会重新签发，用户刷新页面即可恢复。

也就是说：**不需要任何人工操作**，也没有数据迁移。若想完全避免这次抖动，
在部署前 `npx wrangler secret put STREAM_SECRET` 设一个固定值即可（那样就永远不依赖 D1 密钥）。

`migrations/0008_settings.sql` 由 CI 的 `wrangler d1 migrations apply --remote` 自动执行，
不需要手动跑。

### 验证

- `npm run typecheck` ✅ / `npm run lint` ✅（0 warning）
- `npm test` ✅ **52 项全过**（v0.4.0 为 36 项）：
  `proxy.test.mts` 38 项（原 36，密钥断言改写为 3 条新用例）+
  `db.test.mts` 5 项（含一条复现多 isolate 竞态的用例）+
  `secret.test.mts` 9 项（优先级 / 兜底 / 缓存）
- `npx next build` ✅ / `npx opennextjs-cloudflare build` ✅
- **CI run `37775407174` 全绿**：`verify ✓` / `deploy ✓ 1m2s`，
  其中 `Apply D1 migrations (remote) ✓` 说明 `app_setting` 表已在远程 D1 建好，
  Worker 已发布到 `https://auroratv.weiw55016.workers.dev`
- 反向核对：`proxy_secret`、`app_setting`、`ON CONFLICT(key) DO NOTHING`、
  `代理签名密钥回退到公开常量` 等新字符串确实出现在 `.open-next` 产物里
  （`server-functions/default/.next/server/chunks/*.js`），排除「本地改了但没打进包」

> 本机沙箱到 `*.workers.dev` 的出网被拦（代理返回 502 CONNECT），
> 因此**未能**在本地对线上 `/api/health` 做端到端断言。若要自查，部署后访问
> `GET https://<你的域名>/api/health`，正常应看到 `"secret":{"source":"d1","weak":false}`。

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
（**v0.4.1 已变更**：去掉 `PASSWORD`，并新增「首次访问自动生成随机密钥并持久化到 D1」这一环。见本文档第一节。）

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
# 1. 设置流代理签名密钥（可选，见 v0.4.1：不设也会自动生成并持久化）
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
