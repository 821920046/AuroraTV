"use client";
import { useEffect, useState } from "react";

type SourceItem = {
	id: string;
	name: string;
	api: string;
	detail?: string;
	weight?: number;
	enabled?: boolean;
	score?: number | null;
};

export default function Admin() {
	const [sources, setSources] = useState<SourceItem[]>([]);
	const [msg, setMsg] = useState("");
	const [busy, setBusy] = useState(false);

	const [name, setName] = useState("");
	const [api, setApi] = useState("");
	const [detail, setDetail] = useState("");
	const [weight, setWeight] = useState("1");

	const [subUrl, setSubUrl] = useState("");
	const [subText, setSubText] = useState("");

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

	useEffect(() => {
		load();
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

	return (
		<>
			<header className="site-header">
				{/* eslint-disable-next-line @next/next/no-img-element */}
				<img className="logo-badge" src="/logo.png" alt="AuroraTV" />
				<span className="wordmark">AuroraTV</span>
				<div className="header-spacer" />
				<a className="header-link" href="/">返回首页</a>
			</header>

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
					<h2>已配置片源（{sources.length}）</h2>
					{sources.length === 0 ? (
						<p className="admin-hint">还没有任何片源。用上面的「导入」或「添加」加入你自己获取的合法源。</p>
					) : (
						<table className="admin-table">
							<thead>
								<tr>
									<th>名称</th>
									<th>API</th>
									<th>评分</th>
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

				<footer className="site-footer">AuroraTV · 片源由站长自行管理，请确保拥有合法授权</footer>
			</main>
		</>
	);
}
