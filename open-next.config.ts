import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// 最小配置即可部署。
// 如需启用 ISR 增量缓存，可引入官方 override，例如：
//   import kvIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/kv-incremental-cache";
//   export default defineCloudflareConfig({ incrementalCache: kvIncrementalCache });
// 具体导出路径以你安装的 @opennextjs/cloudflare 版本为准。
export default defineCloudflareConfig({});
