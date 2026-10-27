# ia-adapter —— Internet Archive → MacCMS 适配器

把 [Internet Archive](https://archive.org) 的**公共版权影片**翻译成 AuroraTV 点播侧认识的
MacCMS 协议，让你能把它作为一个普通片源加进后台。

```text
AuroraTV 后台 ──MacCMS──▶ 本 Worker ──REST──▶ archive.org
```

## 为什么需要它

AuroraTV 的点播侧只说 MacCMS（`?ac=detail&wd=` / `?ac=detail&ids=` / `?ac=list`），
而 Internet Archive 讲的是 `advancedsearch.php` + `metadata/{id}` 那一套。
协议不匹配，所以需要一层翻译。

**这个适配器不改变 AuroraTV 的「不附带片源」立场** —— 它不内含任何站点清单，
只是连到一个非营利数字档案馆的公开接口。收录哪些合集由你在 `wrangler.toml` 里决定。

## 部署

```bash
cd workers/ia-adapter
npx wrangler deploy
```

免费额度内：每次请求最多 1 次上游调用（只有点开某部片才拉 metadata），
上游响应按 TTL 缓存（搜索 5 分钟 / 列表 1 小时 / metadata 24 小时）。

## 接进 AuroraTV

部署后拿到地址（形如 `https://auroratv-ia-adapter.<你的子域>.workers.dev`），
到 AuroraTV 的 `/admin` 添加片源：

```text
名称：公共版权影片
接口：https://auroratv-ia-adapter.<你的子域>.workers.dev/api.php/provide/vod
```

路径无所谓 —— Worker 不校验路径，只读查询参数。写成 `/api.php/provide/vod`
只是为了跟 MacCMS 惯例一致、看着亲切。

然后 `/api/cron/health` 会自动把它纳入探活，搜索结果里就会出现这些片子。

## 默认收录什么，以及为什么

实测过五个合集的头部内容（按下载量排序看前几条）：

| 合集 | 条目数 | 头部内容 | 结论 |
| --- | --- | --- | --- |
| `silent_films` | 3,522 | 《歌剧魅影》1925、《海底两万里》1916、《卡里加里博士》1919、卓别林《当铺》、《战舰波将金号》1925 | ✅ **默认只开这个** |
| `SciFi_Horror` | 950 | 《House on Haunted Hill》1959，但也混了 exploitation 片 | ⚠️ 可开，但先自己看头 |
| `short_films` | 3,137 | 头部就是色情 exploitation 片（"stag film" 等） | ❌ **绝不能开** |
| `prelinger` | 10,461 | 《About Bananas》1935 这类科教/工业片 | ❌ 不是给人看的 |
| `feature_films` | 28,528 | 各语言版《耶稣传》 | ❌ 噪声极大 |

**Internet Archive 没有内容分级过滤。** 加合集前请自己去
`https://archive.org/advancedsearch.php?q=mediatype:movies+AND+collection:<合集名>&sort[]=downloads+desc&rows=10&output=json`
看看头部是什么，再决定开不开。

改 `wrangler.toml` 里的 `IA_COLLECTIONS`：

```toml
IA_COLLECTIONS = "经典电影:silent_films,恐怖影片:SciFi_Horror"
```

格式是 `显示名:合集id`，逗号分隔。显示名会变成 AuroraTV 里的 `type_name`，
所以**必须含「电影 / 影片 / 片」之一**才会被算进首页的「电影」行。

## 文件挑选策略

从 `metadata.files` 里挑一个浏览器能播的：

```
512Kb MPEG4 / h.264  >  256Kb MPEG4  >  其它可播格式（按体积取最大）  >  Ogg Video 兜底
```

- `MPEG4` / `h.264` 是 archive.org 的标准派生档，`<video>` 直接吃。
- **刻意不收 `MPEG2`** —— 实测那是上传的原片（`house_on_haunted_hill.mp4`
  844MB / 640x480），体积大且 MPEG-2 在浏览器里不可靠。
- 单文件上限 2GB，防某些合集的 4K 重制版把带宽吃穿。
- `Ogg Video` 只在没有可播格式时兜底 —— Safari 播不了 ogv。

## 请求配额与缓存

| 端点 | 上游请求数 | 缓存 TTL |
| --- | --- | --- |
| `?ac=list`（cron 体检打这个） | 1 | 1 小时 |
| `?ac=detail&t=&pg=`（首页热播） | 1 | 1 小时 |
| `?ac=detail&wd=`（搜索） | 每合集 1 次 | 5 分钟 |
| `?ac=detail&ids=`（点开某部片） | 1 次 metadata | 24 小时 |

缓存用 Cache API，键是合成 host + 编码后的上游 URL（与主站 `src/lib/cache.ts`
同一套理由：Cloudflare 边缘缓存键含查询串，直接拿上游 URL 当键会遇到规范化差异）。
响应体**读完才 put**，否则缓存里会留下空壳。

## 已知限制

1. **视频直链未端到端验证**。沙箱网络到不了 `archive.org/download/...`（463MB 二进制），
   所以「能播」这一步是推出来的：`/api/stream` 完整支持 Range 透传且无体积上限，
   `download/{id}/{file}` 是 archive.org 的标准下载路径。
   **部署后请立刻点开一部片验证**，这是唯一没实测的一环。
2. **MP4 不走边缘缓存**。`/api/stream` 只对 `.ts|.m4s|.aac|.key` 分片写
   `cacheEverything`，MP4 是单个大对象，每次 seek 都要重新回源。
   自用可接受，人多了要先算带宽。
3. **CORS 探测会跳过这个源**。体检的 `probeCors` 要从 `?ac=detail&pg=1` 里
   找个样本播放地址，而列表端点刻意不带 `vod_play_url`（带了就要为 24 个条目
   各拉一次 metadata）。取不到样本时它返回 null 并跳过，不写库、无害。
4. **内容全是老片**。`silent_films` 是 1920 年代前后 + 部分中期电影。
   它的价值是 100% 合法、永不掉线，不是内容新。
5. **没有内容过滤**。见上一节，加合集前自己看头。

## 测试

```bash
npm test
```

38 项单测覆盖纯逻辑：合集解析、文件挑选（含 `MPEG2` 排除与 `h.264` 识别）、
搜索词清洗、URL 编码、行映射、metadata 容错。用 Node 内置 test runner，零额外依赖。

**关于搜索词清洗**：AuroraTV 把用户输入原样透传，而 Internet Archive 的查询语法里
`: ( ) " + - && || ! [ ] { } ~ * ? \` 都有特殊含义。不清洗的话，用户敲一个 `foo)`
就能让这个源静默返回空——表现为「公共版权搜不到、别的源能搜到」，极难排查。
所以 `sanitizeKeyword()` 只保留字母、数字、空格、连字符、下划线（含 CJK），限长 100。
