import { Button } from "@eumenes/design-system";
import { useEffect, useRef, useState } from "react";
import type {
	CollectionFormField,
	CollectionResource,
	CollectionRow,
	CollectionRowAction,
} from "./collection-contracts";
import type { ArtifactRequest, Receipt } from "./contracts";
import { useArtifactRuntime } from "./runtime";

function date(value: string) {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0
		? new Date(parsed).toLocaleString("ja-JP")
		: value;
}

function Preview({ row }: { row: CollectionRow }) {
	const runtime = useArtifactRuntime();
	const media = row.media?.preview;
	const path = media?.path;
	const fetchMedia = runtime.fetchMedia;
	const [url, setUrl] = useState<string>();
	const [error, setError] = useState("");
	useEffect(() => {
		if (!path || !fetchMedia) return;
		let current = true;
		let objectUrl: string | undefined;
		void fetchMedia(path)
			.then((blob) => {
				if (!current) return;
				objectUrl = URL.createObjectURL(blob);
				setUrl(objectUrl);
			})
			.catch(() => {
				if (current) setError("結果の読み込みに失敗しました。");
			});
		return () => {
			current = false;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [path, fetchMedia]);
	if (!media) return null;
	return (
		<div className="aui-service-preview">
			{error && <p role="alert">{error}</p>}
			{url &&
				(media.mime.startsWith("image/") ? (
					<img src={url} alt="生成した画像" />
				) : (
					<audio src={url} controls preload="metadata">
						<track
							kind="captions"
							srcLang="ja"
							label="結果の文字起こし"
							src={`data:text/vtt,${encodeURIComponent(`WEBVTT\n\n00:00:00.000 --> 00:10:00.000\n${row.cells.text ?? ""}`)}`}
						/>
					</audio>
				))}
			{url && (
				<a
					href={url}
					download={`eumenes-${row.id}.${media.mime === "image/png" ? "png" : media.mime === "image/webp" ? "webp" : media.mime === "audio/mpeg" ? "mp3" : "wav"}`}
				>
					結果を保存
				</a>
			)}
		</div>
	);
}

function TestInput({
	row,
	source,
	busy,
	onReceipt,
}: {
	row: CollectionRow;
	source: string;
	busy: boolean;
	onReceipt: (receipt: Receipt) => void;
}) {
	const runtime = useArtifactRuntime();
	const start = row.actions.find((action) => action.actionId === "start");
	const fields = start?.form?.fields ?? [];
	const defaults = () =>
		Object.fromEntries(
			fields.map((field) => [
				field.id,
				field.id === "text"
					? (row.cells.sample ?? "")
					: (field.defaultValue ?? ""),
			]),
		);
	const [values, setValues] = useState<Record<string, string>>(defaults);
	const [uploadName, setUploadName] = useState("");
	const [uploading, setUploading] = useState(false);
	const [error, setError] = useState("");
	const [pending, setPending] = useState(false);
	const uploadGeneration = useRef(0);
	useEffect(
		() => () => {
			uploadGeneration.current++;
		},
		[],
	);
	const set = (id: string, value: string) =>
		setValues((old) => ({ ...old, [id]: value }));
	const renderInput = (field: CollectionFormField) => {
		const common = {
			id: `service-input-${field.id}`,
			disabled: busy || pending || uploading,
		};
		if (field.control === "upload")
			return (
				<>
					<input
						{...common}
						type="file"
						accept={field.accept}
						onChange={async (event) => {
							const file = event.target.files?.[0];
							if (!file) return;
							const generation = ++uploadGeneration.current;
							set(field.id, "");
							setUploadName("");
							setUploading(true);
							setError("");
							try {
								const result = await runtime.uploadFile?.(source, file);
								if (generation !== uploadGeneration.current) return;
								if (result?.status === "accepted" && result.value) {
									set(field.id, result.value);
									setUploadName(file.name);
								} else
									setError(
										result?.message || "WAVファイルを読み込めませんでした。",
									);
							} finally {
								if (generation === uploadGeneration.current)
									setUploading(false);
							}
						}}
					/>
					<small>{uploadName || field.help}</small>
				</>
			);
		if (field.control === "textarea")
			return (
				<textarea
					{...common}
					rows={field.id === "text" ? 5 : 3}
					maxLength={field.maxLength}
					value={values[field.id] ?? ""}
					onChange={(event) => set(field.id, event.target.value)}
				/>
			);
		if (field.control === "select")
			return (
				<select
					{...common}
					value={values[field.id] ?? ""}
					onChange={(event) => set(field.id, event.target.value)}
				>
					{field.options?.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
			);
		return (
			<input
				{...common}
				type={field.control === "number" ? "number" : "text"}
				value={values[field.id] ?? ""}
				maxLength={field.maxLength}
				onChange={(event) => set(field.id, event.target.value)}
			/>
		);
	};
	if (!start?.form) return <p>このサービスは個別に試せません。</p>;
	return (
		<form
			className="aui-service-input"
			aria-label="入力"
			onSubmit={async (event) => {
				event.preventDefault();
				setPending(true);
				try {
					const receipt = await runtime.dispatch({
						id: crypto.randomUUID(),
						source,
						revision: runtime.snapshot[source]!.revision,
						action: "collection-action",
						values: {
							actionId: start.actionId,
							rowId: row.id,
							guard: start.guard ?? "",
							...values,
						},
					});
					onReceipt(receipt);
				} catch {
					setError("操作に失敗しました。もう一度お試しください。");
				} finally {
					setPending(false);
				}
			}}
		>
			<div className="aui-service-input-heading">
				<h3>入力</h3>
				<button
					type="button"
					disabled={busy || pending}
					onClick={() => {
						setValues(defaults());
						uploadGeneration.current++;
						setUploading(false);
						setUploadName("");
						setError("");
					}}
				>
					サンプルを入力
				</button>
			</div>
			{fields.map((field) => (
				<label key={field.id} htmlFor={`service-input-${field.id}`}>
					{field.label}
					{renderInput(field)}
					{field.help && field.control !== "upload" && (
						<small>{field.help}</small>
					)}
				</label>
			))}
			{error && <p role="alert">{error}</p>}
			<small>
				送信先：{row.cells.source}{" "}
				{row.cells.onDemand === "はい" ? "· 実行時に起動します" : ""}
			</small>
			<Button type="submit" disabled={busy || pending || uploading}>
				{row.cells.kindCode === "image"
					? "画像を生成"
					: row.cells.kindCode === "music"
						? "楽曲を生成"
						: "▶ 簡単テストを実行"}
			</Button>
		</form>
	);
}

function TestResult({
	run,
	catalogRevision,
	onRetry,
}: {
	run?: CollectionRow;
	catalogRevision?: string;
	onRetry: (row: CollectionRow) => void;
}) {
	return (
		<section className="aui-service-output" aria-label="結果">
			<h3>結果</h3>
			{run ? (
				<div className="aui-service-result" aria-live="polite">
					<strong>{run.cells.statusLabel}</strong>
					{run.cells.progress !== "—" && run.cells.status === "running" && (
						<progress
							max={1}
							value={Number(run.cells.progress)}
							aria-label="生成の進捗"
						/>
					)}
					{run.cells.error !== "—" && <p role="alert">{run.cells.error}</p>}
					{run.cells.text !== "—" && <pre>{run.cells.text}</pre>}
					{run.cells.actualModel !== "—" &&
						run.cells.actualModel !== run.cells.model && (
							<p>
								実行モデル：{run.cells.actualModel}
								<br />
								一覧名：{run.cells.model}
							</p>
						)}
					<Preview key={run.id} row={run} />
					{run.cells.status === "succeeded" &&
						run.cells.previewAvailable === "いいえ" && (
							<p>プレビューの保持期限が過ぎたか、サーバーが再起動しました。</p>
						)}
					{run.cells.retryArtifact === "はい" && !run.media?.preview && (
						<Button variant="secondary" onClick={() => onRetry(run)}>
							結果だけ再取得
						</Button>
					)}
					<small>
						{date(run.cells.created ?? "")}
						{run.cells.ended !== "—"
							? ` · 終了 ${date(run.cells.ended ?? "")}`
							: ""}
					</small>
					{catalogRevision && run.cells.revision !== catalogRevision && (
						<small>設定変更前の結果です。</small>
					)}
				</div>
			) : (
				<div className="aui-service-empty">
					<span aria-hidden="true">◇</span>
					<p>ここに結果が表示されます</p>
					<small>サンプルで簡単に動作を確認できます。</small>
				</div>
			)}
		</section>
	);
}

export function ServiceTestWorkspaceView({
	request,
}: {
	request: ArtifactRequest;
}) {
	if (request.view !== "service-test-workspace") return null;
	return <ServiceTestWorkspace request={request} />;
}

function ServiceTestWorkspace({
	request,
}: {
	request: Extract<ArtifactRequest, { view: "service-test-workspace" }>;
}) {
	const runtime = useArtifactRuntime();
	const status = runtime.snapshot[request.statusSource] as CollectionResource;
	const catalog = runtime.snapshot[request.catalogSource] as CollectionResource;
	const runs = runtime.snapshot[request.runsSource] as CollectionResource;
	const health = runtime.snapshot[request.healthSource] as CollectionResource;
	const [source, setSource] = useState("larm");
	const [search, setSearch] = useState("");
	const [all, setAll] = useState(false);
	const [selectedId, setSelectedId] = useState("");
	const [historyId, setHistoryId] = useState("");
	const [showHealth, setShowHealth] = useState(false);
	const [message, setMessage] = useState("");
	const [working, setWorking] = useState(false);
	const info = status?.rows[0];
	const active = runs?.rows.find((row) => row.cells.status === "running");
	const targets = (catalog?.rows ?? []).filter(
		(row) =>
			row.cells.sourceCode === source &&
			(all || row.cells.primary === "はい") &&
			`${row.cells.kind} ${row.cells.name} ${row.cells.model}`
				.toLocaleLowerCase()
				.includes(search.toLocaleLowerCase()),
	);
	const selected = targets.find((row) => row.id === selectedId) ?? targets[0];
	const history = (runs?.rows ?? []).filter(
		(row) => row.cells.targetId === selected?.id,
	);
	const run = history.find((row) => row.id === historyId) ?? history[0];
	async function act(
		sourceId: string,
		action: CollectionRowAction,
		row: CollectionRow,
	) {
		setWorking(true);
		try {
			const receipt = await runtime.dispatch({
				id: crypto.randomUUID(),
				source: sourceId,
				revision: runtime.snapshot[sourceId]!.revision,
				action: "collection-action",
				values: {
					actionId: action.actionId,
					rowId: row.id,
					guard: action.guard ?? "",
				},
			});
			setMessage(receipt.message);
		} catch {
			setMessage("操作に失敗しました。もう一度お試しください。");
		} finally {
			setWorking(false);
		}
	}
	return (
		<section
			className="aui-service-workspace"
			aria-label={request.title ?? "動作確認"}
		>
			<header className="aui-service-header">
				<div>
					<small>SETTINGS / SERVICE TESTS</small>
					<h2>{request.title ?? "サービスを試す"}</h2>
					<p>プロバイダを選んで、入力と結果を確認できます。</p>
				</div>
				<div className="aui-service-header-actions">
					<Button
						variant="secondary"
						disabled={working || !!active || info?.cells.busy === "はい"}
						onClick={() => {
							const a = info?.actions.find((x) => x.actionId === "refresh");
							if (a && info) void act(request.statusSource, a, info);
						}}
					>
						一覧を更新
					</Button>
					<Button
						disabled={working || !!active || info?.cells.busy === "はい"}
						onClick={() => {
							setShowHealth(true);
							const a = info?.actions.find((x) => x.actionId === "diagnose");
							if (a && info) void act(request.statusSource, a, info);
						}}
					>
						自己診断
					</Button>
				</div>
			</header>
			<div className="aui-service-toolbar">
				<fieldset aria-label="接続先">
					{[
						["larm", "LARM"],
						["cloud", "登録済みクラウド"],
					].map(([id, label]) => (
						<button
							key={id}
							type="button"
							aria-pressed={source === id}
							onClick={() => {
								setSource(id ?? "larm");
								setSelectedId("");
								setHistoryId("");
							}}
						>
							{label}
						</button>
					))}
				</fieldset>
				<small>
					一覧取得：
					{info?.cells.discoveredAt && info.cells.discoveredAt !== "—"
						? info.cells.discoveredAt
						: "未取得"}{" "}
					{info?.cells.state === "更新が必要です"
						? "· 設定が変わりました。一覧を更新してください。"
						: ""}
				</small>
			</div>
			<p className="aui-service-guidance">
				自己診断は接続型プロバイダを一時接続してHealthを確認します。画像・楽曲の生成は行いません。
			</p>
			{info?.cells.errors && info.cells.errors !== "—" && (
				<p role="alert">{info.cells.errors}</p>
			)}
			{status?.error && <p role="alert">{status.error}</p>}
			{message && <output aria-live="polite">{message}</output>}
			{showHealth && (
				<details
					open
					className="aui-service-health"
					onToggle={(event) => setShowHealth(event.currentTarget.open)}
				>
					<summary>
						自己診断の結果 · {info?.cells.control ?? "未確認"}
						{info?.cells.diagnosisRevision !== "—" &&
						info?.cells.diagnosisRevision !== info?.cells.catalogRevision
							? "（設定変更前の結果）"
							: ""}
					</summary>
					<div>
						{(health?.rows ?? []).length ? (
							health.rows.map((row) => (
								<div key={row.id}>
									<strong>{row.cells.name}</strong>
									<span>{row.cells.state}</span>
									<small>{row.cells.reason}</small>
								</div>
							))
						) : (
							<p>まだ診断結果はありません。</p>
						)}
					</div>
				</details>
			)}
			{active && (
				<div className="aui-service-active" aria-live="polite">
					<span>
						{active.cells.model} · {active.cells.phase}
					</span>
					<Button
						variant="secondary"
						disabled={working}
						onClick={() => {
							const a = active.actions.find((x) => x.actionId === "cancel");
							if (a) void act(request.runsSource, a, active);
						}}
					>
						中止
					</Button>
				</div>
			)}
			<div className="aui-service-main">
				<aside className="aui-service-list" aria-label="サービス一覧">
					<input
						type="search"
						aria-label="サービスを検索"
						placeholder="サービスを検索"
						value={search}
						onChange={(event) => setSearch(event.target.value)}
					/>
					<label>
						<input
							type="checkbox"
							checked={all}
							onChange={(event) => setAll(event.target.checked)}
						/>
						全Profileを表示
					</label>
					<div>
						{targets.map((row) => (
							<button
								key={row.id}
								type="button"
								aria-pressed={selected?.id === row.id}
								onClick={() => {
									setSelectedId(row.id);
									setHistoryId("");
								}}
							>
								<strong>{row.cells.kind}</strong>
								<span>{row.cells.model}</span>
								<small>{row.cells.state}</small>
							</button>
						))}
						{targets.length === 0 && <p>該当するサービスはありません。</p>}
					</div>
				</aside>
				{selected ? (
					<section className="aui-service-detail" aria-label="サービスの試用">
						<header>
							<h3>{selected.cells.kind}</h3>
							<p>{selected.cells.model}</p>
							<small>
								{selected.cells.source} · {selected.cells.start}
							</small>
						</header>
						<div className="aui-service-columns">
							<TestInput
								key={selected.id}
								row={selected}
								source={request.catalogSource}
								busy={
									working ||
									!!active ||
									info?.cells.busy === "はい" ||
									info?.cells.state === "更新が必要です"
								}
								onReceipt={(receipt) => setMessage(receipt.message)}
							/>
							<TestResult
								run={run}
								catalogRevision={info?.cells.catalogRevision}
								onRetry={(row) => {
									const action = row.actions.find(
										(item) => item.actionId === "retry-artifact",
									);
									if (action) void act(request.runsSource, action, row);
								}}
							/>
						</div>
						{history.length > 0 && (
							<details className="aui-service-history">
								<summary>実行履歴（{history.length}件）</summary>
								{history.map((row) => (
									<button
										key={row.id}
										type="button"
										onClick={() => setHistoryId(row.id)}
									>
										{date(row.cells.created ?? "")} · {row.cells.statusLabel}
									</button>
								))}
							</details>
						)}
					</section>
				) : (
					<div className="aui-service-empty">
						<p>一覧を更新すると、利用できるサービスが表示されます。</p>
					</div>
				)}
			</div>
			<p className="aui-service-footnote">
				試用は会話やメモリーに追加されません。入力とプレビューは最大30分保持します。必要な結果は保存してください。
			</p>
		</section>
	);
}
