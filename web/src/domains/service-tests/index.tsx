import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, type EumenesClient } from "../../../../client";
import {
	kindLabels,
	healthLabels,
	phaseLabels,
	testErrorLabel,
	type ServiceRun,
	type ServiceTarget,
	type StartTest,
} from "../../../../api/domains/service-tests/contracts";
import { Button } from "../../design-system";
import "./style.css";
import { queryRoots } from "../../queryKeys";

const samples: Record<string, string> = {
	llm: "こんにちは。自己紹介を一文でお願いします。",
	tts: "こんにちは。音声の確認です。",
	asr: "無音サンプル",
	embedding: "猫が窓辺で眠っています。",
	decision: "こんにちは。",
	image: "朝の光が入る静かな書斎。木の机と観葉植物。",
	music: "穏やかな朝に合う、ピアノの短いインストゥルメンタル。",
};
function Result({
	client,
	run,
	onRetry,
}: {
	client: EumenesClient;
	run?: ServiceRun;
	onRetry: (id: string) => void;
}) {
	const [url, setUrl] = useState<string>();
	const [error, setError] = useState("");
	useEffect(() => {
		if (!run?.previewAvailable || !run.mime) return;
		const controller = new AbortController();
		let objectUrl: string | undefined;
		void client
			.serviceArtifact(run.id, controller.signal)
			.then((blob) => {
				if (controller.signal.aborted) return;
				objectUrl = URL.createObjectURL(blob);
				setUrl(objectUrl);
			})
			.catch(() => {
				if (!controller.signal.aborted)
					setError("結果の読み込みに失敗しました。");
			});
		return () => {
			controller.abort();
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [client, run?.id, run?.previewAvailable, run?.mime, run?.ended]);
	if (!run)
		return (
			<div className="test-empty">
				<span aria-hidden="true">◇</span>
				<p>ここに結果が表示されます</p>
				<small>サンプルで簡単に動作を確認できます。</small>
			</div>
		);
	return (
		<div className="test-result" aria-live="polite">
			<p className={`test-status test-${run.status}`}>
				{phaseLabels[run.phase] ?? run.phase}
			</p>
			{run.progress !== undefined && run.status === "running" && (
				<progress max={1} value={run.progress} aria-label="生成の進捗" />
			)}
			{run.error && <p role="alert">{testErrorLabel(run.error)}</p>}
			{run.text && <pre>{run.text}</pre>}
			{run.actualModel && run.actualModel !== run.model && (
				<p className="hint">
					実行モデル：{run.actualModel}
					<br />
					一覧名：{run.model}
				</p>
			)}
			{error && <p role="alert">{error}</p>}
			{url && (
				<>
					{run.mime?.startsWith("image/") ? (
						<a href={url} target="_blank" rel="noreferrer">
							<img src={url} alt="生成した画像" />
						</a>
					) : (
						<audio src={url} controls preload="metadata">
							<track
								kind="captions"
								srcLang="ja"
								label="読み上げ内容"
								src={`data:text/vtt,${encodeURIComponent("WEBVTT\n\n00:00:00.000 --> 00:10:00.000\n" + (run.text ?? ""))}`}
							/>
						</audio>
					)}
					<a
						className="test-download"
						href={url}
						download={`eumenes-${run.id}.${run.mime === "image/png" ? "png" : run.mime === "image/webp" ? "webp" : run.mime === "audio/mpeg" ? "mp3" : "wav"}`}
					>
						結果を保存
					</a>
				</>
			)}
			{run.status === "succeeded" && !run.previewAvailable && (
				<p>プレビューの保持期限が過ぎたか、サーバーが再起動しました。</p>
			)}
			{run.retryArtifact && !run.previewAvailable && (
				<Button variant="secondary" onClick={() => onRetry(run.id)}>
					結果だけ再取得
				</Button>
			)}
			<small>
				{new Date(run.created).toLocaleString("ja-JP")}
				{run.ended
					? ` · ${((run.ended - run.created) / 1000).toFixed(1)}秒`
					: ""}
			</small>
		</div>
	);
}
function TestForm({
	client,
	target,
	revision,
	disabled,
	onStart,
}: {
	client: EumenesClient;
	target: ServiceTarget;
	revision: number;
	disabled: boolean;
	onStart: (input: StartTest) => Promise<void>;
}) {
	const [text, setText] = useState(samples[target.kind] ?? "");
	const [comparison, setComparison] = useState("窓のそばで猫が寝ています。");
	const [voice, setVoice] = useState("");
	const [width, setWidth] = useState(512);
	const [height, setHeight] = useState(512);
	const [format, setFormat] = useState<"png" | "webp">("webp");
	const [duration, setDuration] = useState(10);
	const [upload, setUpload] = useState<{ id: string; name: string }>();
	const [uploading, setUploading] = useState(false);
	const [error, setError] = useState("");
	const generation = useRef(0);
	useEffect(
		() => () => {
			generation.current++;
		},
		[],
	);
	const input = (): StartTest["input"] => ({
		text,
		...(target.kind === "embedding" ? { comparison } : {}),
		...(target.kind === "tts" && voice ? { voice } : {}),
		...(target.kind === "image" ? { width, height, format } : {}),
		...(target.kind === "music" ? { durationSeconds: duration } : {}),
		...(target.kind === "asr" && upload ? { uploadId: upload.id } : {}),
	});
	return (
		<div className="test-input">
			<div className="test-section-title">
				<h3>入力</h3>
				<button
					type="button"
					className="test-link"
					disabled={disabled}
					onClick={() => {
						setText(samples[target.kind] ?? "");
						setUpload(undefined);
						setError("");
					}}
				>
					サンプルを入力
				</button>
			</div>
			{target.kind === "asr" ? (
				<>
					<label htmlFor="test-audio">音声ファイル（WAV・4 MBまで）</label>
					<input
						id="test-audio"
						type="file"
						accept=".wav,audio/wav"
						disabled={disabled || uploading}
						onChange={async (e) => {
							const file = e.target.files?.[0];
							if (!file) return;
							if (file.size > 4_000_000) {
								setError("4 MB以下のWAVファイルを選んでください。");
								return;
							}
							const g = ++generation.current;
							setUploading(true);
							setError("");
							try {
								const r = await client.uploadTestAudio(file);
								if (g === generation.current)
									setUpload({ ...r, name: file.name });
							} catch {
								if (g === generation.current)
									setError("WAVファイルを読み込めませんでした。");
							} finally {
								if (g === generation.current) setUploading(false);
							}
						}}
					/>
					<p className="hint">
						{upload
							? upload.name
							: "未選択なら1秒の無音サンプルで通信を確認します。文字起こしの品質は発話入りの音声で確認してください。"}
					</p>
				</>
			) : (
				<>
					<label htmlFor="test-text">
						{target.kind === "image"
							? "プロンプト"
							: target.kind === "music"
								? "曲の説明"
								: "文章"}
					</label>
					<textarea
						id="test-text"
						rows={5}
						maxLength={4096}
						value={text}
						disabled={disabled}
						onChange={(e) => setText(e.target.value)}
					/>
				</>
			)}
			{target.kind === "embedding" && (
				<>
					<label htmlFor="test-comparison">比較する文章</label>
					<textarea
						id="test-comparison"
						rows={3}
						value={comparison}
						maxLength={4096}
						disabled={disabled}
						onChange={(e) => setComparison(e.target.value)}
					/>
				</>
			)}
			{target.kind === "tts" && target.source === "larm" && (
				<>
					<label htmlFor="test-voice">声のID（空欄で既定の声）</label>
					<input
						id="test-voice"
						value={voice}
						maxLength={128}
						disabled={disabled}
						onChange={(e) => setVoice(e.target.value)}
					/>
				</>
			)}
			{target.kind === "image" && (
				<div className="test-options">
					{[
						{ label: "幅（px）", value: width, set: setWidth },
						{ label: "高さ（px）", value: height, set: setHeight },
					].map(({ label, value, set }) => (
						<label key={label}>
							{label}
							<input
								type="number"
								min={100}
								max={1280}
								step={1}
								value={value}
								disabled={disabled}
								onChange={(e) => set(Number(e.target.value))}
							/>
						</label>
					))}
					<label>
						形式
						<select
							value={format}
							disabled={disabled}
							onChange={(e) => setFormat(e.target.value as "png" | "webp")}
						>
							<option value="png">PNG</option>
							<option value="webp">WebP</option>
						</select>
					</label>
				</div>
			)}
			{target.kind === "music" && (
				<>
					<label htmlFor="test-duration">長さ（秒）</label>
					<select
						id="test-duration"
						disabled={disabled}
						value={duration}
						onChange={(e) => setDuration(Number(e.target.value))}
					>
						{[5, 10, 20, 30].map((n) => (
							<option key={n} value={n}>
								{n}秒
							</option>
						))}
					</select>
					<small>歌声なし・MP3で短い曲を生成します。</small>
				</>
			)}
			{target.kind === "decision" && (
				<small>入力が「挨拶」か「質問・依頼」かを判定します。</small>
			)}
			{error && <p role="alert">{error}</p>}
			<p className="hint">
				送信先：{target.source === "larm" ? "LARM" : target.name}
				{target.onDemand ? " · 実行時に起動します。" : ""}
			</p>
			<Button
				disabled={
					disabled ||
					uploading ||
					!text.trim() ||
					!target.testable ||
					(target.kind === "image" &&
						![width, height].every(
							(n) => Number.isInteger(n) && n >= 100 && n <= 1280,
						))
				}
				onClick={() =>
					void onStart({
						targetId: target.id,
						revision,
						requestKey: crypto.randomUUID(),
						input: input(),
					})
				}
			>
				▶{" "}
				{target.kind === "image"
					? "画像を生成"
					: target.kind === "music"
						? "楽曲を生成"
						: "簡単テストを実行"}
			</Button>
			{!target.testable && (
				<p className="hint">
					{testErrorLabel(target.reason ?? "unsupported_protocol")}
				</p>
			)}
		</div>
	);
}
export function ServiceTestsPanel({
	client,
	disabled = false,
}: {
	client: EumenesClient;
	disabled?: boolean;
}) {
	const cache = useQueryClient();
	const [selected, setSelected] = useState("");
	const [source, setSource] = useState("larm");
	const [search, setSearch] = useState("");
	const [all, setAll] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [showHealth, setShowHealth] = useState(false);
	const [historyId, setHistoryId] = useState<string>();
	const lock = useRef(false);
	const loaded = useRef(false);
	const catalog = useQuery({
		queryKey: [queryRoots.serviceCatalog, client.identity],
		queryFn: () => client.serviceCatalog(),
	});
	const runs = useQuery({
		queryKey: [queryRoots.serviceRuns, client.identity],
		queryFn: () => client.serviceRuns(),
	});
	async function act(fn: () => Promise<unknown>) {
		if (lock.current) return;
		lock.current = true;
		setBusy(true);
		setError("");
		try {
			await fn();
			await Promise.all([
				cache.invalidateQueries({
					queryKey: [queryRoots.serviceCatalog, client.identity],
				}),
				cache.invalidateQueries({
					queryKey: [queryRoots.serviceRuns, client.identity],
				}),
			]);
		} catch (e) {
			setError(
				testErrorLabel(
					e instanceof ApiError ? e.message : "network_unavailable",
				),
			);
		} finally {
			lock.current = false;
			setBusy(false);
		}
	}
	useEffect(() => {
		if (
			!loaded.current &&
			catalog.data &&
			!catalog.data.discoveredAt &&
			!disabled
		) {
			loaded.current = true;
			void act(() => client.refreshServiceCatalog());
		}
	});
	const targets = (catalog.data?.targets ?? []).filter(
		(t) =>
			t.source === source &&
			(all || t.primary) &&
			`${kindLabels[t.kind]} ${t.name} ${t.model}`
				.toLowerCase()
				.includes(search.toLowerCase()),
	);
	const target = targets.find((t) => t.id === selected) ?? targets[0];
	const active = runs.data?.find((r) => r.status === "running");
	const history = (runs.data ?? []).filter((r) => r.targetId === target?.id);
	const run = history.find((r) => r.id === historyId) ?? history[0];
	const diagnosis = runs.data?.find((r) => r.kind === "diagnostics");
	const stale = catalog.data?.stale ?? true;
	return (
		<div className="service-playground">
			<div className="test-toolbar">
				<div className="test-source">
					{[
						["larm", "LARM"],
						["cloud", "登録済みクラウド"],
					].map(([id, label]) => (
						<button
							type="button"
							key={id}
							aria-pressed={source === id}
							onClick={() => setSource(id!)}
						>
							{label}
						</button>
					))}
				</div>
				<div className="settings-actions">
					<Button
						variant="secondary"
						disabled={disabled || busy || !!active}
						onClick={() => void act(() => client.refreshServiceCatalog())}
					>
						一覧を更新
					</Button>
					<Button
						disabled={disabled || busy || !!active}
						onClick={() => {
							setShowHealth(true);
							void act(() => client.diagnoseServices());
						}}
					>
						自己診断
					</Button>
				</div>
			</div>
			<p className="hint">
				自己診断は接続型プロバイダを一時接続してHealthを確認します。画像・楽曲の生成は行いません。
			</p>
			{catalog.data?.discoveredAt && (
				<small className="hint">
					一覧取得：
					{new Date(catalog.data.discoveredAt).toLocaleString("ja-JP")}
					{stale ? " · 設定が変わりました。一覧を更新してください。" : ""}
				</small>
			)}
			{disabled && (
				<p className="settings-notice">
					設定に未適用の変更があります。「接続先」などで変更を適用すると試せます。
				</p>
			)}
			{error && (
				<p role="alert" className="settings-notice">
					{error}
				</p>
			)}
			{(catalog.error || runs.error) && (
				<p role="alert">
					情報を取得できませんでした。
					<button
						onClick={() => {
							void catalog.refetch();
							void runs.refetch();
						}}
					>
						再読み込み
					</button>
				</p>
			)}
			{!!catalog.data?.errors.length && (
				<details className="test-warning">
					<summary>一部の一覧を取得できませんでした</summary>
					{catalog.data.errors.map((e) => (
						<p key={e}>
							{e.split(":")[0]}：{testErrorLabel(e.split(": ")[1] ?? "")}
						</p>
					))}
				</details>
			)}
			{diagnosis && (
				<details
					open={showHealth}
					onToggle={(e) => setShowHealth(e.currentTarget.open)}
					className="test-health"
				>
					<summary>
						自己診断の結果 ·{" "}
						{diagnosis.status === "succeeded"
							? "診断完了"
							: (phaseLabels[diagnosis.phase] ?? diagnosis.phase)}
					</summary>
					<p>
						LARM本体：
						{diagnosis.controlHealthy === undefined
							? "確認中"
							: diagnosis.controlHealthy
								? "接続正常"
								: "確認できません"}{" "}
						{diagnosis.revision !== catalog.data?.revision
							? "（設定変更前の結果）"
							: ""}
					</p>
					<div className="test-health-grid">
						{diagnosis.health?.map((h) => (
							<div key={h.targetId}>
								<strong>{h.model}</strong>
								<span className={`health-${h.state}`}>
									{healthLabels[h.state]}
								</span>
								<small>{testErrorLabel(h.reason)}</small>
								<small>
									{new Date(h.checkedAt).toLocaleTimeString("ja-JP")}
								</small>
							</div>
						))}
					</div>
				</details>
			)}
			{active && (
				<div className="test-active" aria-live="polite">
					<span>
						{active.kind === "diagnostics" ? "自己診断" : active.model} ·{" "}
						{phaseLabels[active.phase] ?? active.phase}
					</span>
					<Button
						variant="secondary"
						disabled={busy || active.phase === "cancelling"}
						onClick={() => void act(() => client.cancelServiceTest(active.id))}
					>
						{active.kind === "image" ? "待機を終了" : "中止"}
					</Button>
					{active.kind === "image" && (
						<small>待機を終了しても生成が続く場合があります。</small>
					)}
				</div>
			)}
			<div className="test-workspace">
				<aside className="test-list" aria-label="サービス一覧">
					<input
						aria-label="サービスを検索"
						placeholder="サービスを検索"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
					/>
					<label className="test-all">
						<input
							type="checkbox"
							checked={all}
							onChange={(e) => setAll(e.target.checked)}
						/>
						全Profileを表示
					</label>
					{targets.map((t) => (
						<button
							type="button"
							key={t.id}
							aria-pressed={target?.id === t.id}
							onClick={() => {
								setSelected(t.id);
								setHistoryId(undefined);
							}}
						>
							<strong>{kindLabels[t.kind]}</strong>
							<span>{t.model}</span>
							<small>
								{t.onDemand
									? "実行時に起動"
									: t.testable
										? "個別に確認できます"
										: "試用未対応"}
							</small>
						</button>
					))}
					{!targets.length && (
						<p className="hint">該当するサービスはありません。</p>
					)}
				</aside>
				{target ? (
					<section className="test-detail" aria-label="サービスの試用">
						<header>
							<h3>{kindLabels[target.kind]}</h3>
							<p>{target.model}</p>
							<small>
								{target.source === "larm" ? "LARM" : target.name} ·{" "}
								{target.onDemand ? "実行時に起動" : "対象を固定して実行"}
							</small>
						</header>
						<div className="test-columns">
							<TestForm
								key={target.id}
								client={client}
								target={target}
								revision={catalog.data?.revision ?? 0}
								disabled={disabled || busy || !!active || stale}
								onStart={(input) =>
									act(async () => {
										setHistoryId(undefined);
										await client.startServiceTest(input);
									})
								}
							/>
							<section className="test-output">
								<h3>結果</h3>
								<Result
									key={`${run?.id}-${run?.ended}-${run?.previewAvailable}`}
									client={client}
									run={run}
									onRetry={(id) =>
										void act(() => client.retryServiceArtifact(id))
									}
								/>
								{run && run.revision !== catalog.data?.revision && (
									<p>設定変更前の結果です。</p>
								)}
							</section>
						</div>
						{!!history.length && (
							<details className="test-history">
								<summary>実行履歴（{history.length}件）</summary>
								{history.map((r) => (
									<button key={r.id} onClick={() => setHistoryId(r.id)}>
										{new Date(r.created).toLocaleString("ja-JP")} ·{" "}
										{phaseLabels[r.status] ?? r.status}
									</button>
								))}
							</details>
						)}
					</section>
				) : (
					<div className="test-empty">
						<p>
							{busy
								? "LARMから一覧を取得しています…"
								: "一覧を更新すると、利用できるサービスが表示されます。"}
						</p>
					</div>
				)}
			</div>
			<p className="hint test-footnote">
				試用は会話やメモリーに追加されません。入力とプレビューは最大30分保持します。必要な結果は保存してください。
			</p>
		</div>
	);
}
