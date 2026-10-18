import { useEffect, useRef, useState } from "react";
import { ApiError } from "../../../../client/transport";
import { GlbTooLargeError, type Model3dApi } from "./api";
import type { GlbBackground, GlbScene } from "./glb-scene";
import "./Model3dViewer.css";

type Loaded = { assetId: string; error?: string };

function failure(cause: unknown) {
	if (cause instanceof GlbTooLargeError)
		return "ファイルが大きすぎるため表示できません（64 MiB まで）。";
	if (cause instanceof ApiError && cause.status === 404)
		return "3Dモデルが見つかりません。";
	return "3Dモデルを読み込めませんでした。";
}

/**
 * Shows one GLB read through the authenticated API (never a URL with a credential). The scene
 * module loads on first use, and its GPU resources are released when the asset changes or the
 * viewer unmounts.
 */
export function Model3dViewer({
	assetId,
	api,
}: {
	assetId: string;
	api: Model3dApi;
}) {
	const frame = useRef<HTMLDivElement>(null);
	const scene = useRef<GlbScene | null>(null);
	const [dark, setDark] = useState(false);
	const background = useRef<GlbBackground>("light");
	const [loaded, setLoaded] = useState<Loaded>();
	useEffect(() => {
		const abort = new AbortController();
		let disposed = false;
		let created: GlbScene | undefined;
		void (async () => {
			try {
				const [{ createGlbScene }, bytes] = await Promise.all([
					import("./glb-scene"),
					api.assetContent(assetId, abort.signal),
				]);
				if (disposed || !frame.current) return;
				created = createGlbScene(frame.current, background.current);
				scene.current = created;
				await created.show(bytes);
				if (!disposed) setLoaded({ assetId });
			} catch (cause) {
				if (!disposed) setLoaded({ assetId, error: failure(cause) });
			}
		})();
		return () => {
			disposed = true;
			abort.abort();
			created?.dispose();
			scene.current = null;
		};
	}, [assetId, api]);
	const current = loaded?.assetId === assetId ? loaded : undefined;
	const toggle = () => {
		const next = !dark;
		background.current = next ? "dark" : "light";
		setDark(next);
		scene.current?.setBackground(background.current);
	};
	return (
		<section
			className="model3d-viewer-host"
			aria-label="3Dモデルの表示"
			data-background={dark ? "dark" : "light"}
		>
			<div ref={frame} className="model3d-viewer-frame" />
			{!current && (
				<output className="model3d-viewer-status">読み込んでいます</output>
			)}
			{current?.error && (
				<p className="model3d-viewer-status" role="alert">
					{current.error}
				</p>
			)}
			<div className="model3d-viewer-tools">
				<small>ドラッグで回転、ホイールやピンチで拡大・縮小</small>
				<button type="button" onClick={() => scene.current?.reset()}>
					視点をリセット
				</button>
				<button type="button" aria-pressed={dark} onClick={toggle}>
					背景を{dark ? "明るく" : "暗く"}する
				</button>
			</div>
		</section>
	);
}
