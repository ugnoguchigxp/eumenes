import { useEffect, useRef, useState } from "react";
import { healthLabels, type SceneStatus, type SpatialItem } from "./contracts";
import { initialSpatialItems } from "./initial-items";
import "./style.css";

type SceneModule = typeof import("./controller/scene");
let sceneModule: Promise<SceneModule> | undefined;
function loadScene() {
	sceneModule ??= import("./controller/scene").catch((error: unknown) => {
		sceneModule = undefined;
		throw error;
	});
	return sceneModule;
}

export function SpatialBackground({
	active,
	items = initialSpatialItems,
}: {
	active: boolean;
	items?: readonly SpatialItem[];
}) {
	const host = useRef<HTMLDivElement>(null);
	const scene = useRef<ReturnType<SceneModule["createSpatialScene"]> | null>(
		null,
	);
	const latestItems = useRef(items);
	const latestSelection = useRef<string | null>(null);
	const [status, setStatus] = useState<SceneStatus | "loading">("loading");
	const [retry, setRetry] = useState(0);
	const [details, setDetails] = useState(false);
	const [selected, setSelected] = useState<string | null>(null);
	useEffect(() => {
		latestItems.current = items;
		scene.current?.setItems(items);
	}, [items]);
	useEffect(() => {
		latestSelection.current = selected;
		scene.current?.select(selected);
	}, [selected]);
	useEffect(() => {
		if (!active || !host.current) return;
		const element = host.current;
		let cancelled = false;
		void loadScene()
			.then(({ createSpatialScene }) => {
				if (cancelled) return;
				scene.current = createSpatialScene(element, latestItems.current, {
					onStatus: (next) => {
						if (!cancelled) setStatus(next);
					},
				});
				scene.current.select(latestSelection.current);
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
	const selection = items.find((item) => item.id === selected);
	return (
		<>
			<div
				ref={host}
				className="spatial-background"
				data-background-state={active ? status : "inactive"}
				aria-hidden="true"
			/>
			{active && (
				<div className="spatial-background-controls">
					<button
						type="button"
						aria-expanded={details}
						onClick={() => setDetails(!details)}
					>
						{details ? "状態一覧を閉じる" : "状態を見る"}
					</button>
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
					{details && (
						<section
							className="spatial-background-summary"
							aria-label="Spatialの状態"
						>
							<h2>状態一覧</h2>
							<ul>
								{items.map((item) => (
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
							{selection && <output>選択中：{selection.label}</output>}
						</section>
					)}
				</div>
			)}
		</>
	);
}
