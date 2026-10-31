import { useEffect, useMemo, useRef, useState } from "react";
import {
	type SceneStatus,
	type SpatialItem,
	type SpatialState,
} from "./contracts";
import { initialSpatialItems } from "./initial-items";
import { SpatialDetail } from "./SpatialDetail";
import {
	defaultSpatialOptions,
	normalizeOptions,
	type SpatialOptions,
} from "./options";
import "./style.css";
import { statusColor, statusLabel, statusLegend } from "./status";

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
	interactive = false,
}: {
	active: boolean;
	/** Background mode: the chat is hidden, so objects take clicks and show details. */
	interactive?: boolean;
	items?: readonly SpatialItem[];
	options?: Partial<SpatialOptions>;
}) {
	const settings = useMemo(() => normalizeOptions(input), [input]);
	const host = useRef<HTMLDivElement>(null);
	const detail = useRef<HTMLElement>(null);
	const scene = useRef<ReturnType<SceneModule["createSpatialScene"]> | null>(
		null,
	);
	const [status, setStatus] = useState<SceneStatus | "loading">("loading");
	const [retry, setRetry] = useState(0);
	const [selected, setSelected] = useState<string | null>(null);
	const [hovered, setHovered] = useState<{
		id: string;
		x: number;
		y: number;
	} | null>(null);
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
	useEffect(() => {
		if (!interactive) queueMicrotask(() => setSelected(null));
	}, [interactive]);
	useEffect(() => {
		const element = host.current;
		if (!active || !interactive || !element) return;
		let frame = 0;
		let pointer: { x: number; y: number } | null = null;
		const hover = () => {
			frame = 0;
			if (!pointer) return;
			const id = scene.current?.pick(pointer.x, pointer.y) ?? null;
			const rect = element.getBoundingClientRect();
			setHovered(
				id ? { id, x: pointer.x - rect.left, y: pointer.y - rect.top } : null,
			);
		};
		const move = (event: PointerEvent) => {
			if (event.pointerType === "touch") return;
			pointer = { x: event.clientX, y: event.clientY };
			frame ||= requestAnimationFrame(hover);
		};
		const leave = () => {
			pointer = null;
			cancelAnimationFrame(frame);
			frame = 0;
			setHovered(null);
		};
		// Empty space returns to the overview; another object moves the selection.
		const click = (event: MouseEvent) =>
			setSelected(scene.current?.pick(event.clientX, event.clientY) ?? null);
		element.addEventListener("pointermove", move);
		element.addEventListener("pointerleave", leave);
		element.addEventListener("click", click);
		return () => {
			element.removeEventListener("pointermove", move);
			element.removeEventListener("pointerleave", leave);
			element.removeEventListener("click", click);
			leave();
		};
	}, [active, interactive]);
	useEffect(() => {
		if (!interactive || !selected) return;
		// Menus and dialogs that hold focus keep their own Escape.
		const escape = (event: KeyboardEvent) => {
			const focus = document.activeElement;
			if (
				event.key === "Escape" &&
				!event.defaultPrevented &&
				(!focus || focus === document.body || detail.current?.contains(focus))
			)
				setSelected(null);
		};
		document.addEventListener("keydown", escape);
		return () => document.removeEventListener("keydown", escape);
	}, [interactive, selected]);
	const selection = displayItems.find((item) => item.id === selected);
	const hoveredItem =
		interactive && hovered
			? displayItems.find((item) => item.id === hovered.id)
			: undefined;
	const demo =
		settings.demoEnabled && selection
			? {
					override: (next: Partial<SpatialState>) =>
						setDemoOverrides((current) => ({
							...current,
							[selection.id]: { ...current[selection.id], ...next },
						})),
					reset: () =>
						setDemoOverrides((current) => {
							const next = { ...current };
							delete next[selection.id];
							return next;
						}),
				}
			: undefined;
	return (
		<div className="spatial-container">
			<div
				ref={host}
				className="spatial-background"
				data-background-state={active ? status : "inactive"}
				data-model-count={displayItems.length}
				data-interactive={interactive || undefined}
				data-pointer={hoveredItem ? "item" : undefined}
				aria-hidden
			/>
			{active && hoveredItem && hovered && (
				<div
					className="spatial-hover-label"
					style={{
						left: hovered.x + 14,
						top: hovered.y + 14,
						color: statusColor(hoveredItem.state),
					}}
					aria-hidden="true"
				>
					{hoveredItem.label} · {statusLabel(hoveredItem.state)}
				</div>
			)}
			{active && interactive && selection && status !== "failed" && (
				<aside
					ref={detail}
					className="spatial-detail"
					aria-label={`${selection.label}の詳細`}
				>
					<header>
						<h2>{selection.label}</h2>
						<button
							type="button"
							aria-label="詳細を閉じる"
							title="詳細を閉じる"
							onClick={() => setSelected(null)}
						>
							×
						</button>
					</header>
					<SpatialDetail item={selection} demo={demo} />
				</aside>
			)}
			{active && (
				<div className="spatial-background-controls">
					{selected && !interactive && (
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
					{status === "failed" && (
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
											{item.label}：{statusLabel(item.state)}
											{item.state.stale ? "（情報が古い）" : ""}
										</button>
									</li>
								))}
							</ul>
							{selection && (
								<div className="spatial-selection-detail">
									<output>選択中：{selection.label}</output>
									<SpatialDetail item={selection} demo={demo} />
								</div>
							)}
						</section>
					)}
				</div>
			)}
			{active && interactive && (
				<div className="spatial-status-legend" aria-label="状態色の凡例">
					{statusLegend.map(([label, color]) => (
						<span key={label} style={{ color }}>
							<i aria-hidden="true" />
							{label}
						</span>
					))}
				</div>
			)}
		</div>
	);
}
