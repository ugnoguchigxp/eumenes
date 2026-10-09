import {
	ArtifactRenderer,
	compileArtifact,
	compileLang,
	viewRegistry,
	type View,
} from "@eumenes/artifact-ui";
import "@eumenes/artifact-ui/styles";
import {
	Button,
	Textarea,
	Tabs,
	TabsList,
	TabsTrigger,
	TabsContent,
} from "@eumenes/design-system";
import {
	useEffect,
	useId,
	useState,
	useSyncExternalStore,
	type CSSProperties,
} from "react";
import { createShowcaseFixture } from "../../../domains/artifact";

import { DesignTokenEditor } from "./DesignTokenEditor";
import {
	designThemes,
	themeLabels,
	themeTone,
	radiusPresets,
	resolveDesignTokens,
	designTokenAliases,
	type DesignTokenOverrides,
} from "../../../domains/artifact/designTokens";

const sources: Record<View, string> = {
	components: "c1",
	"generated-image": "g1",
	question: "q1",
	form: "f1",
	memory: "m1",
	settings: "s1",
};
const sample = (view: View) => JSON.stringify({ view, source: sources[view] });
const examples: Record<View, { description: string }> = {
	components: {
		description:
			"文字を入力して「試す」を押すと、受け取った内容を確認できます。",
	},
	"generated-image": {
		description:
			"サンプル画像の待機・完成・失敗を試せます。完成後は拡大・ダウンロードができます。",
	},
	question: {
		description:
			"回答を選んで送信し、受付後の表示を確認できます。自由回答や期限切れも試せます。",
	},
	form: {
		description: "必須項目を入力して送信すると、受け取った内容が表示されます。",
	},
	memory: {
		description:
			"試用の情報を訂正・選択できます。実際のメモリー保存や会話への反映は行いません。",
	},
	settings: {
		description:
			"選んだテーマをプレビューで確認し、設定値の保存を試せます。アプリの表示や音声は変更しません。",
	},
};
const actionLabels = {
	"demo-click": "入力の確認",
	answer: "回答の送信",
	submit: "フォームの送信",
	"memory-correct": "情報の訂正",
	"memory-select": "情報の選択",
	"settings-save": "試用設定の保存",
};
const statusLabels = {
	pending: "処理中",
	accepted: "完了",
	rejected: "失敗",
	conflict: "再確認が必要",
	duplicate: "受付済み",
};
export function ArtifactShowcase() {
	const [fixture] = useState(createShowcaseFixture);
	const prefix = useId();
	const state = useSyncExternalStore(fixture.subscribe, fixture.getSnapshot);
	const [draft, setDraft] = useState(sample("components"));
	const [compiled, setCompiled] = useState(() =>
		compileArtifact(sample("components"), state.resources),
	);
	const [mode, setMode] = useState<"json" | "lang">("json");
	const [error, setError] = useState("");
	const [initialTheme] = useState(() => {
		const current = document.documentElement.dataset.theme ?? "light";
		return designThemes.includes(current) ? current : "light";
	});
	const [theme, setTheme] = useState(initialTheme);
	const [width, setWidth] = useState("full");
	const [density, setDensity] = useState("comfortable");
	const [radius, setRadius] = useState("0.5rem");
	const [tablet, setTablet] = useState(false);
	const [tokenOverrides, setTokenOverrides] = useState<DesignTokenOverrides>(
		{},
	);
	const tokenValues = resolveDesignTokens({
		theme,
		density,
		radius,
		tablet,
		overrides: tokenOverrides,
	});
	const previewStyle = {
		...tokenValues,
		...designTokenAliases,
		colorScheme: themeTone(theme),
	} as CSSProperties;
	const currentRadius = tokenValues["--radius"]!;
	const [resetKey, setResetKey] = useState(0);
	const view = compiled.request.view;
	const source = compiled.request.source ?? `inline-${view}`;
	const operations = state.operations.filter(
		(operation) => operation.source === source,
	);
	const image = state.resources.g1;
	useEffect(() => () => fixture.dispose(), [fixture]);
	function apply(input = draft, inputMode = mode) {
		try {
			const result =
				inputMode === "json"
					? compileArtifact(input, state.resources)
					: compileLang(input, state.resources);
			fixture.ensureInline(result.request);
			setCompiled(result);
			setError("");
		} catch {
			setError(
				"定義を表示できません。登録された view・source と入力形式を確認してください。",
			);
		}
	}
	function choose(view: View) {
		const json = sample(view);
		setMode("json");
		setDraft(json);
		apply(json, "json");
	}
	return (
		<Tabs
			value={compiled.request.view}
			onValueChange={(value) => choose(value as View)}
			asChild
		>
			<section className="aui-showcase" aria-label="UIショーケース">
				<header className="aui-showcase-header">
					<h2>UIショーケース</h2>
					<span className="aui-showcase-note">この画面だけの試用</span>
				</header>
				<TabsList aria-label="表示サンプル" className="aui-sample-tabs">
					{Object.entries(viewRegistry).map(([view, entry]) => (
						<TabsTrigger
							key={view}
							value={view}
							aria-label={entry.label}
							title={entry.label}
						>
							{entry.label}
						</TabsTrigger>
					))}
				</TabsList>
				<p className="aui-description">{examples[view].description}</p>
				<div className="aui-row aui-controls">
					<label>
						表示テーマ
						<select
							aria-label="プレビューのテーマ"
							value={theme}
							onChange={(e) => setTheme(e.target.value)}
							disabled={
								view === "settings" &&
								operations.some((operation) => operation.status === "pending")
							}
						>
							{designThemes.map((name) => (
								<option key={name} value={name}>
									{themeLabels[name] ?? name}
								</option>
							))}
						</select>
					</label>
					<label>
						幅
						<select
							aria-label="プレビューの幅"
							value={width}
							onChange={(e) => setWidth(e.target.value)}
						>
							<option value="full">全幅</option>
							<option value="narrow">320px</option>
						</select>
					</label>
					<label>
						密度
						<select
							aria-label="表示の密度"
							value={density}
							onChange={(e) => setDensity(e.target.value)}
						>
							<option value="comfortable">標準</option>
							<option value="compact">コンパクト</option>
							<option value="spacious">ゆったり</option>
						</select>
					</label>
					<label>
						角の丸み
						<select
							aria-label="角の丸み"
							value={currentRadius}
							onChange={(e) => {
								setRadius(e.target.value);
								setTokenOverrides(({ "--radius": _radius, ...rest }) => rest);
							}}
						>
							{radiusPresets.map((value) => (
								<option key={value} value={value}>
									{value === "0rem" ? "なし" : value}
								</option>
							))}
							{!radiusPresets.includes(currentRadius) && (
								<option value={currentRadius}>{currentRadius}（個別）</option>
							)}
						</select>
					</label>
					<label>
						タッチ操作
						<select
							aria-label="タッチ操作"
							value={String(tablet)}
							onChange={(e) => setTablet(e.target.value === "true")}
						>
							<option value="false">通常</option>
							<option value="true">44px以上</option>
						</select>
					</label>
				</div>
				<DesignTokenEditor
					values={tokenValues}
					overrides={tokenOverrides}
					onChange={(name, value) =>
						setTokenOverrides((current) => {
							const next = { ...current };
							if (value === undefined) delete next[name];
							else next[name] = value;
							return next;
						})
					}
					onReset={() => {
						setTokenOverrides({});
						setTheme(initialTheme);
						setDensity("comfortable");
						setRadius("0.5rem");
						setTablet(false);
					}}
				/>
				<div className="aui-row aui-sample-actions">
					{view === "generated-image" && (
						<>
							<Button
								onClick={fixture.startImage}
								disabled={
									image?.kind === "generated-image" &&
									image.status === "running"
								}
							>
								サンプル生成を開始
							</Button>
							{image?.kind === "generated-image" &&
								image.status === "running" && (
									<Button
										variant="secondary"
										onClick={() => fixture.imageState("cancelled")}
									>
										生成を取消
									</Button>
								)}
						</>
					)}
					<Button
						variant="ghost"
						disabled={operations.some(
							(operation) => operation.status === "pending",
						)}
						onClick={() => {
							fixture.resetSource(source);
							setResetKey((k) => k + 1);
						}}
					>
						このサンプルを初期化
					</Button>
				</div>
				<TabsContent
					value={compiled.request.view}
					className={`aui-preview ${themeTone(theme) === "dark" ? "dark" : ""}`}
					style={previewStyle}
					data-tablet-mode={tablet}
					data-theme={theme}
					data-density={density}
					data-width={width}
					aria-label="プレビュー"
				>
					<ArtifactRenderer
						key={resetKey}
						lang={compiled.lang}
						runtime={{
							snapshot: state.resources,
							dispatch: fixture.dispatch,
							previewTheme: themeTone(theme),
						}}
					/>
				</TabsContent>
				<details>
					<summary>開発用の確認</summary>
					<div className="aui-stack aui-inspector">
						<details className="aui-definition">
							<summary>定義を編集</summary>
							<div className="aui-stack">
								<label>
									定義の形式
									<select
										aria-label="定義の形式"
										value={mode}
										onChange={(e) => {
											const next = e.target.value as "json" | "lang";
											setMode(next);
											setDraft(
												next === "json"
													? JSON.stringify(compiled.request)
													: compiled.lang,
											);
										}}
									>
										<option value="json">短い JSON</option>
										<option value="lang">
											OpenUI Lang（登録した表示のみ）
										</option>
									</select>
								</label>
								<label htmlFor={`${prefix}-definition`}>
									UIの定義
									<Textarea
										id={`${prefix}-definition`}
										aria-label="UIの定義"
										className="aui-code"
										rows={4}
										value={draft}
										onChange={(e) => setDraft(e.target.value)}
										maxLength={20000}
									/>
								</label>
								<div className="aui-row">
									<Button onClick={() => apply()}>定義を表示</Button>
									<span>{new TextEncoder().encode(draft).length} bytes</span>
								</div>
								{error && <p role="alert">{error}</p>}
								<details>
									<summary>変換後の OpenUI Lang</summary>
									<pre>{compiled.lang}</pre>
								</details>
							</div>
						</details>
						<details>
							<summary>試用条件を変更</summary>
							<div className="aui-stack aui-fixture-controls">
								{view === "generated-image" && (
									<div className="aui-row">
										<label>
											画像の完成まで
											<select
												aria-label="画像の完成まで"
												value={state.delayMs}
												onChange={(e) =>
													fixture.configure({ delayMs: Number(e.target.value) })
												}
											>
												<option value="500">0.5秒</option>
												<option value="60000">1分</option>
											</select>
										</label>
										<Button
											variant="secondary"
											onClick={() => fixture.imageState("succeeded")}
										>
											画像を完成
										</Button>
										<Button
											variant="secondary"
											onClick={() => fixture.imageState("failed")}
										>
											生成失敗
										</Button>
										<Button
											variant="secondary"
											onClick={() => fixture.imageState("succeeded", true)}
										>
											画像読込失敗
										</Button>
									</div>
								)}
								<div className="aui-row">
									{view === "question" && source === "q1" && (
										<>
											<Button
												variant="secondary"
												onClick={() => fixture.questionMode(true)}
											>
												自由回答に変更
											</Button>
											<Button
												variant="secondary"
												onClick={() => fixture.questionMode(false)}
											>
												選択回答に変更
											</Button>
											<Button
												variant="secondary"
												onClick={fixture.expireQuestion}
											>
												質問を期限切れにする
											</Button>
										</>
									)}
									{view !== "generated-image" && (
										<>
											<Button variant="secondary" onClick={fixture.refresh}>
												参照データを更新
											</Button>
											<Button
												variant="secondary"
												aria-pressed={state.failNext}
												onClick={() =>
													fixture.configure({ failNext: !state.failNext })
												}
											>
												次の送信を失敗させる
											</Button>
										</>
									)}
									<Button
										variant="secondary"
										onClick={() => {
											fixture.reset();
											setResetKey((k) => k + 1);
											choose("components");
										}}
									>
										試用データを初期化
									</Button>
								</div>
							</div>
						</details>
						<details>
							<summary>参照データ</summary>
							<pre aria-label="参照データ">
								{JSON.stringify(state.resources, null, 2)}
							</pre>
						</details>
						<details>
							<summary>操作履歴（{operations.length}件）</summary>
							<p className="aui-showcase-note">
								表示中のサンプルへの送信結果です。入力中の変更は含みません。
							</p>
							<ol className="aui-events" aria-label="操作イベント">
								{operations.map((operation) => (
									<li key={operation.id} data-status={operation.status}>
										<strong>{actionLabels[operation.action]}</strong>
										<span>{statusLabels[operation.status]}</span>
										<p>{operation.message}</p>
									</li>
								))}
							</ol>
							{operations.length === 0 && (
								<p>
									まだ操作はありません。プレビューで送信または「試す」を押すと、結果が表示されます。
								</p>
							)}
							<details>
								<summary>内部イベント</summary>
								<pre>
									{state.events.length
										? state.events.join("\n")
										: "内部イベントはありません"}
								</pre>
							</details>
						</details>
					</div>
				</details>
			</section>
		</Tabs>
	);
}
