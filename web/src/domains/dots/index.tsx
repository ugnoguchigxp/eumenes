import "./style.css";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { EumenesClient } from "../../../../client";
import { ConnectionEditor, ProjectEditor } from "./configuration";
import { PackageEditor } from "./packages";
import { TaskPanel } from "./tasks";
export function DotsPanel({ client }: { client: EumenesClient }) {
	const q = useQuery({
		queryKey: ["dots", client.identity],
		queryFn: () => client.dotsConfiguration(),
		retry: false,
		refetchInterval: 5000,
	});
	const packs = useQuery({
		queryKey: ["dots-packages", client.identity],
		queryFn: () => client.dotsPackages(),
		retry: false,
	});
	const [error, setError] = useState(""),
		[token, setToken] = useState<string | null>(null),
		[connection, setConnection] = useState(""),
		[project, setProject] = useState("");
	const [busy, setBusy] = useState(false);
	async function save(fn: () => Promise<unknown>) {
		setBusy(true);
		setError("");
		try {
			await fn();
			await Promise.all([q.refetch(), packs.refetch()]);
		} catch {
			setError(
				"保存を確認できませんでした。最新の設定を読み直してから再度保存してください。",
			);
		} finally {
			setBusy(false);
		}
	}
	const data = q.data;
	if (!data)
		return (
			<output>
				{q.isError
					? "接続設定を取得できませんでした。"
					: "接続設定を読み込み中…"}
				<button onClick={() => void q.refetch()}>読み直す</button>
			</output>
		);
	const c = data.connections.find((c) => c.id === connection),
		p = data.projects.find((p) => p.ref === project);
	return (
		<div className="dots-settings">
			<p>
				登録したプロジェクトへ作業を委任し、Session・質問・結果を確認できます。接続先が
				dots に登録され、受信が有効になってから作業が始まります。
			</p>
			<output>{error}</output>
			{token && (
				<div>
					<p>
						この接続専用のローカルトークンです。この表示を閉じると再表示できません。
					</p>
					<input
						aria-label="接続専用トークン"
						type="password"
						readOnly
						value={token}
					/>
					<button onClick={() => void navigator.clipboard.writeText(token)}>
						コピー
					</button>
					<button onClick={() => setToken(null)}>表示を閉じる</button>
				</div>
			)}
			<section>
				<h3>dotsへの接続</h3>
				<select
					aria-label="編集する接続"
					value={connection}
					onChange={(e) => setConnection(e.target.value)}
				>
					<option value="">新しい接続</option>
					{data.connections.map((c) => (
						<option key={c.id} value={c.id}>
							{c.title}
						</option>
					))}
				</select>
				{c && (
					<p>
						受信登録：
						{data.events.find((e) => e.connectionRef === c.id)?.subscribed
							? "有効"
							: "未登録または期限切れ"}{" "}
						· 接続先 /mcp/dots/{c.id}
					</p>
				)}
				<ConnectionEditor
					key={`${c?.id}:${c?.revision}`}
					value={c}
					busy={busy}
					save={(v) =>
						save(async () => {
							const r = await client.configureDotsConnection(v);
							setToken(r.localToken);
							setConnection(r.connection.id);
						})
					}
				/>
			</section>
			<section>
				<h3>作業するプロジェクト</h3>
				<select
					aria-label="編集するプロジェクト"
					value={project}
					onChange={(e) => setProject(e.target.value)}
				>
					<option value="">新しいプロジェクト</option>
					{data.projects.map((p) => (
						<option key={p.ref} value={p.ref}>
							{p.title}
						</option>
					))}
				</select>
				<ProjectEditor
					key={`${p?.ref}:${p?.revision}`}
					value={p}
					connections={data.connections}
					packages={packs.data?.items ?? []}
					busy={busy}
					save={(v) =>
						save(async () => {
							const r = await client.configureDotsProject(v);
							setProject(r.ref);
						})
					}
				/>
			</section>
			<PackageEditor
				client={client}
				items={packs.data?.items ?? []}
				save={save}
				busy={busy}
			/>
			<TaskPanel
				client={client}
				projects={data.projects.filter(
					(p) =>
						p.enabled &&
						data.connections.some((c) => c.id === p.connectionRef && c.enabled),
				)}
			/>
		</div>
	);
}
