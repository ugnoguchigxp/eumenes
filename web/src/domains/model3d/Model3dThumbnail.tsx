import { useEffect, useRef, useState } from "react";
import type { Model3dApi } from "./api";
import type { GlbScene } from "./glb-scene";
import { createThumbnailQueue, type ThumbnailState } from "./thumbnail-queue";
import "./Model3dThumbnail.css";

const queues = new WeakMap<
	Model3dApi,
	ReturnType<typeof createThumbnailQueue>
>();
function queueFor(api: Model3dApi) {
	const existing = queues.get(api);
	if (existing) return existing;
	let renderer: GlbScene | undefined;
	const queue = createThumbnailQueue({
		load: (id, signal) => api.assetContent(id, signal),
		async render(bytes) {
			if (!renderer) {
				const { createGlbScene } = await import("./glb-scene");
				// 256px square is enough for the grid; only one GLB is retained during capture.
				renderer = createGlbScene(document.createElement("div"), "dark", 256);
			}
			try {
				await renderer.show(bytes);
				return await renderer.capture();
			} finally {
				renderer.clear();
			}
		},
		dispose() {
			renderer?.dispose();
			renderer = undefined;
		},
	});
	queues.set(api, queue);
	return queue;
}

/** Only visible cards acquire a thumbnail. Hidden panes unmount these host views. */
export function Model3dThumbnail({
	assetId,
	api,
}: {
	assetId: string;
	api: Model3dApi;
}) {
	const frame = useRef<HTMLSpanElement>(null);
	const [visible, setVisible] = useState(
		() => typeof IntersectionObserver === "undefined",
	);
	const [attempt, setAttempt] = useState(0);
	const [result, setResult] = useState<{ id: string; state: ThumbnailState }>();
	useEffect(() => {
		const element = frame.current;
		if (!element) return;
		if (typeof IntersectionObserver === "undefined") {
			return;
		}
		const observer = new IntersectionObserver(([entry]) =>
			setVisible(!!entry?.isIntersecting),
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	useEffect(() => {
		if (!visible) return;
		let active = true;
		const release = queueFor(api).request(assetId, (state) => {
			if (active) setResult({ id: assetId, state });
		});
		return () => {
			active = false;
			release();
		};
	}, [api, assetId, visible, attempt]);
	const state = visible && result?.id === assetId ? result.state : undefined;
	return (
		<span ref={frame} className="model3d-thumbnail">
			{state?.status === "ready" ? (
				<img src={state.url} alt="" />
			) : state?.status === "error" ? (
				<span>
					<span>サムネイルを読み込めませんでした。</span>
					<button
						type="button"
						onClick={() => setAttempt((value) => value + 1)}
					>
						サムネイルを再読み込み
					</button>
				</span>
			) : (
				<span aria-label="モデルのサムネイルを読み込み中">3D</span>
			)}
		</span>
	);
}
