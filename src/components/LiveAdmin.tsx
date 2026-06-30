"use client";
import { useEffect, useState } from "react";

type LiveSource = { id: string; name: string; url: string; enabled?: boolean };

// 直播源管理：复用 /admin 页的样式（admin-card / pill / admin-table）。
export default function LiveAdmin() {
	const [sources, setSources] = useState<LiveSource[]>([]);
	const [channelCount, setChannelCount] = useState(0);
	const [msg, setMsg] = useState("");
	const [busy, setBusy] = useState(false);
	const [name, setName] = useState("");
	const [url, setUrl] = useState("");

	async function load() {
		try {
			const r = await fetch("/api/admin/live");
			const d = (await r.json()) as { sources?: LiveSource[]; channelCount?: number; msg?: string };
			setSources(d.sources ?? []);
			setChannelCount(d.channelCount ?? 0);
			if (!r.ok && d.msg) setMsg(d.msg);
		} catch {
			setMsg("加载直播源失败");
		}
	}

	useEffect(() => {
		load();
	}, []);

	async function add() {
		if (!name.trim() || !url.trim()) {
			setMsg("名称和 M3U 地址必填");
			return;
		}
		setBusy(true);
		try {
			const r = await fetch("/api/admin/live", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name, url }),
			});
			setMsg(r.ok ? "已添加：" + name : "添加失败");
			if (r.ok) {
				setName("");
				setUrl("");
				await load();
			}
		} finally {
			setBusy(false);
		}
	}

	async function toggle(s: LiveSource) {
		await fetch("/api/admin/live", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: s.id, enabled: !(s.enabled !== false) }),
		});
		await load();
	}

	async function remove(s: LiveSource) {
		await fetch("/api/admin/live?id=" + encodeURIComponent(s.id), { method: "DELETE" });
		await load();
	}

	async function ingest() {
		setBusy(true);
		setMsg("正在从订阅源摄取频道，可能需要几十秒…");
		try {
			const r = await fetch("/api/admin/live", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "ingest" }),
			});
			const d = (await r.json()) as { sources?: number; channels?: number; msg?: string };
			setMsg(
				r.ok
					? "摄取完成：" + (d.sources ?? 0) + " 个源 / " + (d.channels ?? 0) + " 个频道"
				: "摄取失败：" + (d.msg ?? r.status),
			);
			await load();
		} finally {
			setBusy(false);
		}
	}

	async function addRecommended() {
		setBusy(true);
		setMsg("正在添加推荐国内源…");
		try {
			const r = await fetch("/api/admin/live", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "add_recommended" }),
			});
			const d = (await r.json()) as { added?: number; msg?: string };
			setMsg(
				r.ok
					? "已添加 " + (d.added ?? 0) + " 个推荐国内源，请点「立即刷新频道」摄取"
					: "添加失败：" + (d.msg ?? r.status),
			);
			await load();
		} finally {
			setBusy(false);
		}
	}

	async function pruneToCnHk() {
		if (!confirm("只保留「国内 + 香港」频道，其余全部删除？")) return;
		setBusy(true);
		setMsg("正在清理非国内/香港频道…");
		try {
			const r = await fetch("/api/admin/live", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "prune" }),
			});
			const d = (await r.json()) as { deleted?: number; channelCount?: number; msg?: string };
			setMsg(
				r.ok
					? "已删除 " + (d.deleted ?? 0) + " 个非国内/香港频道，剩余 " + (d.channelCount ?? 0) + " 个"
					: "清理失败：" + (d.msg ?? r.status),
			);
			await load();
		} finally {
			setBusy(false);
		}
	}

	async function clearChannels() {
		if (!confirm("确定清空全部已摄取频道吗？下次摄取会重建。")) return;
		setBusy(true);
		try {
			const r = await fetch("/api/admin/live?channels=1", { method: "DELETE" });
			const d = (await r.json()) as { deleted?: number };
			setMsg("已清空 " + (d.deleted ?? 0) + " 个频道");
			await load();
		} finally {
			setBusy(false);
		}
	}

	return (
		<section className="admin-card">
			<div className="card-head">
				<h2>直播源管理（已摄取 {channelCount} 个频道）</h2>
				<div>
					<button className="pill on" onClick={ingest} disabled={busy}>
						{busy ? "处理中…" : "立即刷新频道"}
					</button>{" "}
					{channelCount > 0 && (
						<button className="pill on" onClick={pruneToCnHk} disabled={busy}>
							只留国内/香港
						</button>
					)}{" "}
					{channelCount > 0 && (
						<button className="pill danger" onClick={clearChannels} disabled={busy}>
							清空频道
						</button>
					)}
				</div>
			</div>
			<p className="admin-hint">
				添加 M3U/M3U8 播放列表订阅，或点「一键添加推荐国内源」（vbskycn / 范明明 / YanG /
				iptv-org 等国内常用直连源，整表入库不做地区过滤）。添加后点「立即刷新频道」摄取，即可在
				「直播」页观看。部分源为 IPv6 专用，无 IPv6 网络优先用 vbskycn IPv4 源。
			</p>
			{msg && <div className="admin-msg">{msg}</div>}
			<div className="field-row">
				<div className="field">
					<label>名称</label>
					<input className="admin-input" value={name} onChange={(e) => setName(e.target.value)} />
				</div>
				<div className="field field-wide">
					<label>M3U 地址</label>
					<input
						className="admin-input"
						value={url}
						onChange={(e) => setUrl(e.target.value)}
						placeholder="https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8"
					/>
				</div>
			</div>
			<button className="search-btn" onClick={add} disabled={busy}>
				添加订阅源
			</button>{" "}
			<button className="pill on" onClick={addRecommended} disabled={busy}>
				一键添加推荐国内源
			</button>

			{sources.length > 0 && (
				<table className="admin-table live-admin-table">
					<thead>
						<tr>
							<th>名称</th>
							<th>M3U</th>
							<th>状态</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{sources.map((s) => (
							<tr key={s.id}>
								<td>{s.name}</td>
								<td className="api-cell">{s.url}</td>
								<td>
									<button
										className={"pill " + (s.enabled !== false ? "on" : "off")}
										onClick={() => toggle(s)}
									>
										{s.enabled !== false ? "启用" : "停用"}
									</button>
								</td>
								<td>
									<button className="pill danger" onClick={() => remove(s)}>
										删除
									</button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</section>
	);
}
