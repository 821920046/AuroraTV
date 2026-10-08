// ============================================================================
// IP 字面量判定（零 import）
// ----------------------------------------------------------------------------
// 【为什么单独抽出来】
// 同一份「这个地址能不能代理」的判定，现在有两个使用方：
//   1) proxy.ts 的 isSafeUpstream —— 校验用户提交的 URL 字面量；
//   2) dnsguard.ts 的 DoH 预解析 —— 校验域名解析出来的 A / AAAA 记录。
// 上一轮的教训摆在那里：/api/stream 修了、/api/img 漏了，就是因为同一个判定
// 被写了两份。这里只留一份实现，两边 import 同一个函数。
//
// 本模块不 import 任何东西，因此可以被 Node 的测试运行器直接加载。
// ============================================================================

/**
 * IPv4 是否属于「公网可路由」。
 * 与 WHATWG URL 解析器配合：`http://0x7f000001/`、`http://2130706433/`、
 * `http://0177.0.0.1/` 这类八进制/十六进制/整数写法都会被规范化成点分十进制，
 * 因此这里只需处理点分十进制。
 */
export function isPublicIpv4(a: number, b: number): boolean {
	if (a === 0 || a === 10 || a === 127) return false; // 未指定 / 私网 / 回环
	if (a === 169 && b === 254) return false; // 链路本地，含云元数据 169.254.169.254
	if (a === 172 && b >= 16 && b <= 31) return false; // 私网
	if (a === 192 && b === 168) return false; // 私网
	if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
	if (a === 192 && b === 0) return false; // 192.0.0.0/24 协议保留
	if (a === 198 && (b === 18 || b === 19)) return false; // 基准测试
	if (a >= 224) return false; // 组播 / 保留 / 广播
	return true;
}

/**
 * 把 IPv6 字面量（不含方括号）解析成 8 个 16 位分组。
 *
 * 【为什么必须按位解析，而不是正则匹配字符串】
 * `http://[::ffff:127.0.0.1]/` 会被 WHATWG URL 解析器规范化成 `[::ffff:7f00:1]`。
 * 旧实现只比对 `::1` / `fc00::/7` / `fe80::` 三个字符串前缀，
 * `::ffff:7f00:1` 一个都不命中 —— 于是「回环地址」被判定为安全，
 * 重定向到内网也就绕过了整层 SSRF 防护。按位展开后这类地址无从隐藏。
 */
export function parseIpv6(host: string): number[] | null {
	const h = host.split("%")[0]; // 去掉 zone id（fe80::1%eth0）
	const halves = h.split("::");
	if (halves.length > 2) return null;

	const parseParts = (parts: string[]): number[] | null => {
		const out: number[] = [];
		for (const p of parts) {
			if (/^\d{1,3}(\.\d{1,3}){3}$/.test(p)) {
				// 尾部内嵌的 IPv4（::ffff:127.0.0.1）
				const v4 = p.split(".").map(Number);
				if (v4.some((n) => n > 255)) return null;
				out.push(((v4[0] << 8) | v4[1]) & 0xffff, ((v4[2] << 8) | v4[3]) & 0xffff);
				continue;
			}
			if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
			out.push(parseInt(p, 16));
		}
		return out;
	};

	const head = parseParts(halves[0] ? halves[0].split(":") : []);
	const tail = parseParts(halves.length === 2 && halves[1] ? halves[1].split(":") : []);
	if (!head || !tail) return null;
	if (halves.length === 1) return head.length === 8 ? head : null;
	const fill = 8 - head.length - tail.length;
	if (fill < 0) return null;
	return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/** IPv6 是否属于「不可路由到公网」的地址段。解析失败一律视为危险。 */
export function isBlockedIpv6(host: string): boolean {
	const g = parseIpv6(host);
	if (!g) return true;
	const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);

	if (zero(0, 8)) return true; // :: 未指定
	if (zero(0, 7) && g[7] === 1) return true; // ::1 回环
	// IPv4 映射 ::ffff:0:0/96 与 IPv4 兼容 ::/96（已废弃）—— 一律由内嵌的 v4 决定。
	// `::` 与 `::1` 已在上面被拦截，不会走到这里。
	// 内嵌 v4 的前两段落在 g[6]：高字节 = 第一段，低字节 = 第二段。
	if (zero(0, 5) && (g[5] === 0xffff || g[5] === 0)) {
		return !isPublicIpv4(g[6] >> 8, g[6] & 0xff);
	}
	if ((g[0] & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
	if ((g[0] & 0xffc0) === 0xfe80) return true; // 链路本地 fe80::/10
	if ((g[0] & 0xff00) === 0xff00) return true; // 组播 ff00::/8
	if (g[0] === 0x64 && g[1] === 0xff9b) return true; // NAT64 64:ff9b::/96
	if (g[0] === 0x2001 && g[1] === 0x0000) return true; // Teredo 2001::/32
	if (g[0] === 0x2002) return !isPublicIpv4(g[1] >> 8, g[1] & 0xff); // 6to4 内嵌 v4
	return false;
}

/** 点分十进制 IPv4 字面量 -> 四段数字；不是合法 IPv4 则返回 null。 */
export function parseIpv4(host: string): number[] | null {
	const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!m) return null;
	const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
	return o.some((n) => n > 255) ? null : o;
}

/** 主机名是否是 IP 字面量（含 IPv6，不含方括号）。 */
export function isIpLiteralHost(host: string): boolean {
	const h = host.replace(/^\[|\]$/g, "");
	if (h.includes(":")) return true; // 主机名不允许出现冒号
	return parseIpv4(h) !== null;
}

/**
 * 判断 IP 字面量是否属于「不可代理」的地址。
 *
 * 返回值是三态，这个区分很关键：
 *   true  —— 明确危险（回环 / 私网 / 云元数据 …）
 *   false —— 明确安全（公网可路由）
 *   null  —— **这不是一个 IP 字面量**（域名，或格式错误的 IP）
 *
 * 调用方对 null 的处理必须不同：URL 校验时 null 表示「交给 DNS 那层」；
 * 而 DNS 记录校验时 null 表示「解析出来的东西根本不是 IP」，属于异常，应当拒绝。
 */
export function blockedIpLiteral(host: string): boolean | null {
	const h = host.replace(/^\[|\]$/g, "");
	if (h.includes(":")) return isBlockedIpv6(h);
	const v4 = parseIpv4(h);
	if (v4) return !isPublicIpv4(v4[0], v4[1]);
	// 形如 a.b.c.d 但某段超出 255：不是合法 IPv4，也不该被当成普通域名放过去。
	// （WHATWG URL 对这种输入会退化成「域名」，随后解析必然失败，但显式拒绝更清楚。）
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
	return null;
}
