import { useEffect, useMemo, useRef, useState } from "react";
import {
	healthLabels,
	type SceneStatus,
	type SpatialItem,
	type SpatialState,
} from "./contracts";
import { initialSpatialItems } from "./initial-items";
import {
	defaultSpatialOptions,
	normalizeOptions,
	type SpatialOptions,
} from "./options";
import "./style.css";

type SceneModule = typeof import("./controller/scene");
type ModelModule = typeof import("./models");
let sceneModule:
	| Promise<
			readonly [
				SceneModule,
				Awaited<ReturnType<ModelModule["loadSpatialModels"]>>,
			]
	  >
	| undefined;
function loadScene() {
	sceneModule ??= Promise.all([
		import("./controller/scene"),
		import("./models").then((m) => m.loadSpatialModels()),
	]).catch((error: unknown) => {
		sceneModule = undefined;
		throw error;
	});
	return sceneModule;
}

/** State acquisition is outside this component. Supplied item states are the only telemetry input. */
export function SpatialBackground({
	active,
	items = initialSpatialItems,
	options: input = defaultSpatialOptions,
	standalone = false,
}: {
	active: boolean;
	items?: readonly SpatialItem[];
	options?: Partial<SpatialOptions>;
	standalone?: boolean;
}) {
	const settings = useMemo(() => normalizeOptions(input), [input]);
	const host = useRef<HTMLButtonElement>(null);
	const scene = useRef<ReturnType<SceneModule["createSpatialScene"]> | null>(
		null,
	);
	const [status, setStatus] = useState<SceneStatus | "loading">("loading");
	const [retry, setRetry] = useState(0);
	const [selected, setSelected] = useState<string | null>(null);
	const [demoOverrides, setDemoOverrides] = useState<
		Record<string, Partial<SpatialState>>
	>({});
	const displayItems = useMemo(
		() =>
			items.map((item) =>
				settings.demoEnabled
					? {
							...item,
							state: {
								health: settings.demoHealth,
								activity: settings.demoActivity,
								stale: settings.demoStale,
								utilization: settings.demoUtilization / 100,
								strength: settings.demoStrength / 100,
								...demoOverrides[item.id],
								source: "demo" as const,
							},
						}
					: item,
			),
		[items, settings, demoOverrides],
	);
	const latest = useRef({ items: displayItems, settings, selected });
	useEffect(() => {
		latest.current = { items: displayItems, settings, selected };
	}, [displayItems, settings, selected]);
	useEffect(() => {
		scene.current?.setItems(displayItems);
	}, [displayItems]);
	useEffect(() => {
		scene.current?.setOptions(settings);
	}, [settings]);
	useEffect(() => {
		scene.current?.select(selected);
	}, [selected]);
	useEffect(() => {
		if (selected && !items.some((item) => item.id === selected))
			queueMicrotask(() => setSelected(null));
	}, [items, selected]);
	useEffect(() => {
		if (!active || !host.current) return;
		const element = host.current;
		let cancelled = false;
		void loadScene()
			.then(([{ createSpatialScene }, models]) => {
				if (cancelled) return;
				scene.current = createSpatialScene(element, latest.current.items, {
					models,
					settings: latest.current.settings,
					onStatus: (next) => {
						if (!cancelled) setStatus(next);
					},
				});
				scene.current.select(latest.current.selected);
			})
			.catch(() => {
				if (!cancelled) setStatus("failed");
			});
		return () => {
			cancelled = true;
			scene.current?.dispose();
			scene.current = null;
		};
	}, [active, retry]);
	const selection = displayItems.find((item) => item.id === selected);
	const override = (next: Partial<SpatialState>) => {
		if (selection)
			setDemoOverrides((current) => ({
				...current,
				[selection.id]: { ...current[selection.id], ...next },
			}));
	};
	return (
		<div className={standalone ? "spatial-preview" : "spatial-container"}>
			<button
				type="button"
				ref={host}
				className="spatial-background"
				data-background-state={active ? status : "inactive"}
				data-model-count={displayItems.length}
				aria-hidden={!standalone}
				tabIndex={standalone ? 0 : -1}
				aria-label={
					standalone
						? "Spatialのモデルプレビュー。クリックか矢印キーで選択、Escで全体へ戻る"
						: undefined
				}
				onClick={(event) => {
					if (!standalone) return;
					const rect = event.currentTarget.getBoundingClientRect();
					const hit = scene.current?.hitTest(
						event.clientX - rect.left,
						event.clientY - rect.top,
					);
					setSelected(hit && hit !== selected ? hit : null);
				}}
				onKeyDown={(event) => {
					if (!standalone) return;
					if (
						["ArrowLeft", "ArrowRight", "Enter", " ", "Escape"].includes(
							event.key,
						)
					)
						event.preventDefault();
					if (event.key === "Escape") setSelected(null);
					else if (event.key === "Enter" || event.key === " ")
						setSelected(selected ? null : (displayItems[0]?.id ?? null));
					else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
						const index = Math.max(
							0,
							displayItems.findIndex((item) => item.id === selected),
						);
						setSelected(
							displayItems[
								(index +
									(event.key === "ArrowLeft" ? -1 : 1) +
									displayItems.length) %
									displayItems.length
							]?.id ?? null,
						);
					}
				}}
			/>
			{active && (
				<div className="spatial-background-controls">
					{selected && (
						<button type="button" onClick={() => setSelected(null)}>
							全体に戻る
						</button>
					)}
					{status === "failed" && (
						<div className="spatial-background-error">
							<output>背景を表示できません。状態一覧は確認できます。</output>
							<button
								type="button"
								onClick={() => {
									setStatus("loading");
									setRetry((value) => value + 1);
								}}
							>
								再表示
							</button>
						</div>
					)}
					{((standalone && selected) || status === "failed") && (
						<section
							className="spatial-background-summary"
							aria-label="Spatialの状態"
						>
							<h2>状態一覧</h2>
							<p>
								{settings.demoEnabled
									? "デモ値での状態プレビュー"
									: items === initialSpatialItems
										? "展示モデル · 実測取得前"
										: "入力された状態を表示"}
							</p>
							<ul>
								{displayItems.map((item) => (
									<li key={item.id}>
										<button
											type="button"
											aria-pressed={selected === item.id}
											onClick={() =>
												setSelected(selected === item.id ? null : item.id)
											}
										>
											{item.label}：{healthLabels[item.state.health]}
											{item.state.stale ? "（情報が古い）" : ""}
										</button>
									</li>
								))}
							</ul>
							{selection && (
								<div className="spatial-selection-detail">
									<output>選択中：{selection.label}</output>
									<p>
										活動：
										{
											{ idle: "待機", starting: "準備中", working: "処理中" }[
												selection.state.activity
											]
										}
										<br />
										利用率：
										{selection.state.utilization === undefined
											? "未取得"
											: Math.round(selection.state.utilization * 100) + "%"}
									</p>
									{settings.demoEnabled && (
										<fieldset>
											<legend>このモデルのデモ値</legend>
											<label>
												health
												<select
													aria-label="health"
													value={selection.state.health}
													onChange={(e) =>
														override({
															health: e.target.value as SpatialState["health"],
														})
													}
												>
													{Object.entries(healthLabels).map(([key, label]) => (
														<option key={key} value={key}>
															{label}
														</option>
													))}
												</select>
											</label>
											<label>
												活動
												<select
													value={selection.state.activity}
													onChange={(e) =>
														override({
															activity: e.target
																.value as SpatialState["activity"],
														})
													}
												>
													<option value="idle">待機</option>
													<option value="starting">準備中</option>
													<option value="working">処理中</option>
												</select>
											</label>
											<label>
												利用率
												<input
													type="range"
													min="0"
													max="100"
													value={(selection.state.utilization ?? 0) * 100}
													onChange={(e) =>
														override({
															utilization: Number(e.target.value) / 100,
														})
													}
												/>
											</label>
											<button
												type="button"
												onClick={() =>
													setDemoOverrides((current) => {
														const next = { ...current };
														delete next[selection.id];
														return next;
													})
												}
											>
												共通のデモ値に戻す
											</button>
										</fieldset>
									)}
								</div>
							)}
						</section>
					)}
				</div>
			)}
		</div>
	);
}
