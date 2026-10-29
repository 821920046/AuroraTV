"use client";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import SiteHeader from "@/components/SiteHeader";

type SourceItem = {
	id: string;
	name: string;
	api: string;
	detail?: string;
	weight?: number;
	enabled?: boolean;
	score?: number | null;
	success_rate?: number | null;
	auto_disabled?: number;
	fail_streak?: number;
	last_ok_at?: number | null;
	cors?: number | null;
	/** 最近 7 天真实播放成功率 0..1；null = 没有样本 */
	play_rate?: number | null;
	/** 播放上报样本量，太少时 play_rate 不可当真 */
	play_samples?: number | null;
};

/** 直播订阅源：一条 M3U 地址就是一条订阅，摄取后展开成 channel 表里的频道 */
type LiveSourceItem = {
	id: string;
	name: string;
	url: string;
	enabled?: boolean;
};

/** 后端内置的推荐订阅源。不含 keepAll 等摄取细节，那是服务端的事 */
type RecommendedSource = {
	id: string;
	name: string;
	url: string;
};

export default function Admin() {
	const [sources, setSources] = useState<SourceItem[]>([]);
	const [msg, setMsg] = useState("");
	const [busy, setBusy] = useState(false);
	const fileRef = useRef<HTMLInputElement>(null);

	const [name, setName] = useState("");
	const [api, setApi] = useState("");
	const [detail, setDetail] = useState("");
	const [weight, setWeight] = useState("1");

	const [subUrl, setSubUrl] = useState("");
	const [subText, setSubText] = useState("");

	// ---- 直播订阅源 ----
	const [liveSources, setLiveSources] = useState<LiveSourceItem[]>([]);
	const [liveCount, setLiveCount] = useState(0);
	const [liveMsg, setLiveMsg] = useState("");
	const [liveBusy, setLiveBusy] = useState(false);
	const [liveName, setLiveName] = useState("");
	const [liveUrl, setLiveUrl] = useState("");
	const [recommended, setRecommended] = useState<RecommendedSource[]>([]);

	async function load() {
		try {
			const r = await fetch("/api/admin/sources");
			const data = (await r.json()) as { sources?: SourceItem[]; msg?: string };
			setSources(data.sources ?? []);
			if (!r.ok && data.msg) setMsg(data.msg);
		} catch {
			setMsg("加载片源列表失败");
		}
	}

	async function loadLive() {
		try {
			const r = await fetch("/api/admin/live");
			const d = (await r.json()) as {
				sources?: LiveSourceItem[];
				channelCount?: number;
				recommended?: RecommendedSource[];
				msg?: string;
			};
			setLiveSources(d.sources ?? []);
			setLiveCount(d.channelCount ?? 0);
			setRecommended(d.recommended ?? []);
			if (!r.ok && d.msg) setLiveMsg(d.msg);
		} catch {
			setLiveMsg("加载直播源失败");
		}
	}

	useEffect(() => {
		load();
		loadLive();
	}, []);

	async function addSource() {
		if (!name.trim() || !api.trim()) {
			setMsg("名称和 API 地址必填");
			return;
		}
		setBusy(true);
		try {
			const r = await fetch("/api/admin/sources", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name, api, detail: detail || undefined, weight: Number(weight) || 1 }),
			});
			const d = (await r.json()) as { msg?: string };
			setMsg(r.ok ? "已添加: " + name : "添加失败: " + (d.msg ?? r.status));
			if (r.ok) {
				setName("");
				setApi("");
				setDetail("");
				setWeight("1");
				await load();
			}
		} finally {
			setBusy(false);
		}
	}

	// ---- 直播订阅源操作 ----
	// 直播侧的协议是「M3U 播放列表」而不是 MacCMS：一条订阅地址就是一份频道清单，
	// 摄取(ingest) 之后展开成 channel 表里的频道。增删订阅源不会动已入库的频道，
	// 要清理得单独点 prune 或清空 —— 所以下面把三个动作分开摆，避免误操作。
	async function livePost(body: Record<string, unknown>, okMsg: string) {
		setLiveBusy(true);
		setLiveMsg("处理中…");
		try {
			const r = await fetch("/api/admin/live", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			const d = (await r.json()) as {
				msg?: string;
				inserted?: number;
				updated?: number;
				deleted?: number;
			};
			if (!r.ok) {
				setLiveMsg("失败：" + (d.msg ?? r.status));
				return;
			}
			if (body.action === "ingest") {
				setLiveMsg(`摄取完成：新增 ${d.inserted ?? 0} 个频道，更新 ${d.updated ?? 0} 个`);
			} else if (body.action === "prune") {
				setLiveMsg(`已清理 ${d.deleted ?? 0} 个非白名单地区的频道`);
			} else {
				setLiveMsg(okMsg);
			}
			await loadLive();
		} catch {
			setLiveMsg("请求失败");
		} finally {
			setLiveBusy(false);
		}
	}

	async function addLiveSource() {
		if (!liveName.trim() || !liveUrl.trim()) {
			setLiveMsg("名称和 M3U 地址必填");
			return;
		}
		await livePost(
			{ name: liveName.trim(), url: liveUrl.trim() },
			"已添加订阅源 —— 还要点「立即摄取」才会真正拉取频道",
		);
		setLiveName("");
		setLiveUrl("");
	}

	/**
	 * 添加一个推荐源。
	 *
	 * 传 id 而不是让后端 slugify(name)：推荐源的 id 是固定的（如 cn_iptv_org），
	 * 用它才能和「已添加」的判断对上，也不会和 add_recommended 写出两条重复记录。
	 */
	async function addRecommended(r: RecommendedSource) {
		await livePost(
			{ id: r.id, name: r.name, url: r.url },
			`已添加「${r.name}」—— 记得点「立即摄取」才会拉频道`,
		);
	}

	async function liveToggle(s: LiveSourceItem) {
		setLiveBusy(true);
		try {
			await fetch("/api/admin/live", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: s.id, enabled: s.enabled === false }),
			});
			await loadLive();
		} finally {
			setLiveBusy(false);
		}
	}

	async function liveDelete(id: string) {
		setLiveBusy(true);
		try {
			const r = await fetch("/api/admin/live?id=" + encodeURIComponent(id), { method: "DELETE" });
			setLiveMsg(r.ok ? "已删除订阅源" : "删除失败");
			await loadLive();
		} finally {
			setLiveBusy(false);
		}
	}

	async function healthCheck() {
		setBusy(true);
		setMsg("正在体检片源（探活并自动停用失效源）…");
		try {
			const r = await fetch("/api/admin/sources", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "health_check" }),
			});
			const d = (await r.json()) as {
				checked?: number;
				disabled?: number;
				recovered?: number;
				msg?: string;
			};
			setMsg(
				r.ok
					? "体检完成：检测 " +
							(d.checked ?? 0) +
							" 个，自动停用 " +
							(d.disabled ?? 0) +
							" 个，恢复 " +
							(d.recovered ?? 0) +
							" 个"
					: "体检失败: " + (d.msg ?? r.status),
			);
			if (r.ok) await load();
		} finally {
			setBusy(false);
		}
	}

	async function corsCheck() {
		setBusy(true);
		setMsg("正在检测各源在网页内是否可播（读取跨域响应头）…");
		try {
			const r = await fetch("/api/admin/sources", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "cors_check" }),
			});
			const d = (await r.json()) as {
				checked?: number;
				playable?: number;
				blocked?: number;
				msg?: string;
			};
			setMsg(
				r.ok
					? "网页可播检测完成：检测 " +
							(d.checked ?? 0) +
							" 个，可在网页直接播 " +
							(d.playable ?? 0) +
							" 个，仅 VLC " +
							(d.blocked ?? 0) +
							" 个"
					: "检测失败: " + (d.msg ?? r.status),
			);
			if (r.ok) await load();
		} finally {
			setBusy(false);
		}
	}

	async function toggle(s: SourceItem) {
		await fetch("/api/admin/sources", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: s.id, enabled: !(s.enabled !== false) }),
		});
		await load();
	}

	async function remove(s: SourceItem) {
		await fetch("/api/admin/sources?id=" + encodeURIComponent(s.id), { method: "DELETE" });
		await load();
	}

	async function clearAll() {
		if (sources.length === 0) return;
		if (!confirm("确定要删除全部 " + sources.length + " 个片源吗？此操作不可恢复。")) return;
		setBusy(true);
		try {
			const r = await fetch("/api/admin/sources?all=1", { method: "DELETE" });
			const d = (await r.json()) as { deleted?: number; msg?: string };
			setMsg(r.ok ? "已清空 " + (d.deleted ?? 0) + " 个片源" : "清空失败: " + (d.msg ?? r.status));
			await load();
		} finally {
			setBusy(false);
		}
	}

	async function doImport() {
		if (!subUrl.trim() && !subText.trim()) {
			setMsg("请填写订阅 URL 或粘贴 JSON");
			return;
		}
		setBusy(true);
		try {
			const r = await fetch("/api/admin/import", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ url: subUrl || undefined, text: subText || undefined }),
			});
			const d = (await r.json()) as { imported?: number; msg?: string };
			setMsg(r.ok ? "成功导入 " + (d.imported ?? 0) + " 个片源" : "导入失败: " + (d.msg ?? r.status));
			if (r.ok) {
				setSubUrl("");
				setSubText("");
				await load();
			}
		} finally {
			setBusy(false);
		}
	}

	function exportBackup() {
		try {
			const payload = {
				app: "AuroraTV",
				version: 1,
				exportedAt: new Date().toISOString(),
				sources: sources.map((s) => ({
					id: s.id,
					name: s.name,
					api: s.api,
					detail: s.detail,
					weight: s.weight ?? 1,
					enabled: s.enabled !== false,
				})),
			};
			const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
			const a = document.createElement("a");
			a.href = URL.createObjectURL(blob);
			a.download = "auroratv-sources-" + new Date().toISOString().slice(0, 10) + ".json";
			a.click();
			URL.revokeObjectURL(a.href);
			setMsg("已导出 " + sources.length + " 个片源到备份文件");
		} catch {
			setMsg("导出失败");
		}
	}

	async function onPickBackup(e: ChangeEvent<HTMLInputElement>) {
		const file = e.target.files?.[0];
		e.target.value = "";
		if (!file) return;
		setBusy(true);
		setMsg("正在导入备份…");
		try {
			const text = await file.text();
			const r = await fetch("/api/admin/import", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text }),
			});
			const d = (await r.json()) as { imported?: number; msg?: string };
			setMsg(r.ok ? "成功导入 " + (d.imported ?? 0) + " 个片源" : "导入失败: " + (d.msg ?? r.status));
			if (r.ok) await load();
		} catch {
			setMsg("读取备份文件失败");
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<SiteHeader />

			<main className="container">
				<h1 className="admin-title">片源管理</h1>
				{msg && <div className="admin-msg">{msg}</div>}

				<section className="admin-card">
					<h2>批量导入 / 订阅</h2>
					<p className="admin-hint">
						支持 MoonTV / LunaTV 的 api_site 配置、KVideo 的源数组，以及 AuroraTV 自身格式。
					</p>
					<div className="field">
						<label>订阅 URL（返回 JSON 的地址）</label>
						<input
							className="admin-input"
							value={subUrl}
							onChange={(e) => setSubUrl(e.target.value)}
							placeholder="例如你自己的 sources.json 地址"
						/>
					</div>
					<div className="field">
						<label>或直接粘贴 JSON</label>
						<textarea
							className="admin-textarea"
							value={subText}
							onChange={(e) => setSubText(e.target.value)}
							rows={5}
							placeholder='[ { "name": "源名", "api": "https://.../api.php/provide/vod" } ]'
						/>
					</div>
					<button className="search-btn" onClick={doImport} disabled={busy}>
						{busy ? "处理中…" : "导入"}
					</button>
				</section>

				<section className="admin-card">
					<h2>备份与恢复</h2>
					<p className="admin-hint">
						把当前所有片源配置导出为 JSON 备份文件保存；换环境或重置后可一键导入恢复（按 id 覆盖，不会重复）。
					</p>
					<div className="head-actions">
						<button className="pill on" onClick={exportBackup} disabled={sources.length === 0}>
							导出备份（{sources.length}）
						</button>
						<button className="pill on" onClick={() => fileRef.current?.click()} disabled={busy}>
							一键导入备份
						</button>
						<input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={onPickBackup} />
					</div>
				</section>

				<section className="admin-card">
					<h2>添加单个片源</h2>
					<div className="field-row">
						<div className="field">
							<label>名称</label>
							<input className="admin-input" value={name} onChange={(e) => setName(e.target.value)} />
						</div>
						<div className="field">
							<label>权重</label>
							<input className="admin-input" value={weight} onChange={(e) => setWeight(e.target.value)} />
						</div>
					</div>
					<div className="field">
						<label>API 地址</label>
						<input
							className="admin-input"
							value={api}
							onChange={(e) => setApi(e.target.value)}
							placeholder="https://站点/api.php/provide/vod"
						/>
					</div>
					<div className="field">
						<label>详情根地址（可选）</label>
						<input className="admin-input" value={detail} onChange={(e) => setDetail(e.target.value)} />
					</div>
					<button className="search-btn" onClick={addSource} disabled={busy}>
						添加
					</button>
				</section>

				<section className="admin-card">
					<div className="card-head">
						<h2>已配置片源（{sources.length}）</h2>
						<div className="head-actions">
							<button className="pill on" onClick={healthCheck} disabled={busy}>
								{busy ? "处理中…" : "立即体检"}
							</button>
							<button className="pill on" onClick={corsCheck} disabled={busy}>
								{busy ? "处理中…" : "检测网页可播"}
							</button>
							{sources.length > 0 && (
								<button className="pill danger" onClick={clearAll} disabled={busy}>
									清空全部
								</button>
							)}
						</div>
					</div>
					<p className="admin-hint">
						「立即体检」会探测各源可用性：连续多轮无响应的源会被<b>自动停用</b>（状态显示“自动停用”），之后探测到恢复会自动重新启用；手动停用的源不受影响。定时任务每小时也会分批体检。
					</p>
					{sources.length === 0 ? (
						<p className="admin-hint">还没有任何片源。用上面的「导入」或「添加」加入你自己获取的合法源。</p>
					) : (
						/* 窄屏下表格横向滚动，而不是把整页撑出横向滚动条 */
						<div className="table-scroll">
							<table className="admin-table">
								<thead>
									<tr>
										<th>名称</th>
										<th>API</th>
										<th>评分</th>
										<th>播放成功率</th>
										<th>网页可播</th>
										<th>状态</th>
										<th />
									</tr>
								</thead>
								<tbody>
									{sources.map((s) => (
										<tr key={s.id}>
											<td>{s.name}</td>
											<td className="api-cell">{s.api}</td>
											<td>{s.score != null ? s.score.toFixed(2) : "—"}</td>
											<td title={
												s.play_samples
													? `最近 7 天 ${s.play_samples} 次播放上报`
													: "还没有播放上报，样本不足"
											}>
												{s.play_rate != null
													? Math.round(s.play_rate * 100) + "%"
													: "—"}
												{s.play_samples != null && s.play_samples < 5 ? (
													<span className="muted"> 样本少</span>
												) : null}
											</td>
											<td>{s.cors === 1 ? "🌐 可播" : s.cors === 0 ? "📋 仅VLC" : "—"}</td>
											<td>
												<button
													className={
														"pill " +
														(s.enabled !== false ? "on" : s.auto_disabled ? "auto" : "off")
													}
													onClick={() => toggle(s)}
													title={s.fail_streak ? "连续失败 " + s.fail_streak + " 轮" : undefined}
												>
													{s.enabled !== false ? "启用" : s.auto_disabled ? "自动停用" : "停用"}
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
						</div>
					)}
				</section>

				<section className="admin-card">
					<div className="card-head">
						<h2>直播订阅源（{liveSources.length}）</h2>
						<span className="muted">已入库频道 {liveCount} 个</span>
					</div>
					<p className="muted">
						直播侧吃的是 M3U 播放列表，不是 MacCMS。加完地址要点「立即摄取」才会真正拉频道。
						本项目只存频道元数据与可直连地址，不中转视频流。
					</p>

					<div className="field-row">
						<div className="field">
							<label>名称</label>
							<input
								className="admin-input"
								value={liveName}
								onChange={(e) => setLiveName(e.target.value)}
								placeholder="如 iptv-org 中国"
							/>
						</div>
						<div className="field">
							<label>M3U 地址</label>
							<input
								className="admin-input"
								value={liveUrl}
								onChange={(e) => setLiveUrl(e.target.value)}
								placeholder="https://iptv-org.github.io/iptv/countries/cn.m3u"
							/>
						</div>
					</div>

					<div className="field-row">
						<button className="search-btn" onClick={addLiveSource} disabled={liveBusy}>
							添加订阅源
						</button>
						<button
							className="pill"
							disabled={liveBusy}
							onClick={() => livePost({ action: "ingest" }, "摄取完成")}
						>
							立即摄取
						</button>
						<button
							className="pill"
							disabled={liveBusy}
							onClick={() => livePost({ action: "prune" }, "已清理")}
							title="只保留国内/香港地区的频道，删掉其余"
						>
							清理非白名单地区
						</button>
					</div>

					{recommended.length > 0 ? (
						<div className="field rec-field">
							<label>推荐源（逐个添加，不自动全加）</label>
							<div className="rec-list">
								{recommended.map((r) => {
									const added = liveSources.some((s) => s.id === r.id);
									return (
										<div className="rec-item" key={r.id}>
											<div className="rec-main">
												<span className="rec-name">{r.name}</span>
												<span className="muted rec-url">{r.url}</span>
											</div>
											<button
												className="pill"
												disabled={liveBusy || added}
												onClick={() => addRecommended(r)}
												title={added ? "这个源已经在列表里了" : "添加这条订阅"}
											>
												{added ? "已添加" : "添加"}
											</button>
										</div>
									);
								})}
							</div>
						</div>
					) : null}

					{liveMsg ? <p className="muted">{liveMsg}</p> : null}

					{liveSources.length > 0 ? (
						<div className="table-scroll">
							<table className="admin-table">
								<thead>
									<tr>
										<th>名称</th>
										<th>M3U 地址</th>
										<th>状态</th>
										<th />
									</tr>
								</thead>
								<tbody>
									{liveSources.map((s) => (
										<tr key={s.id}>
											<td>{s.name}</td>
											<td className="api-cell">{s.url}</td>
											<td>
												<button
													className={"pill " + (s.enabled !== false ? "on" : "off")}
													onClick={() => liveToggle(s)}
													disabled={liveBusy}
												>
													{s.enabled !== false ? "启用" : "停用"}
												</button>
											</td>
											<td>
												<button
													className="pill danger"
													onClick={() => liveDelete(s.id)}
													disabled={liveBusy}
												>
													删除
												</button>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					) : (
						<p className="muted">
							还没有订阅源。留空时直播页会用内置默认源（含 iptv-org 中国）。
						</p>
					)}
				</section>

				<footer className="site-footer">AuroraTV · 片源由站长自行管理，请确保拥有合法授权</footer>
			</main>
		</>
	);
}
