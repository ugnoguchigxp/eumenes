import { useEffect, useRef } from "react";
import { formatResourceUri } from "../../../../api/domains/resources/contracts";
import { focusWhenDrawn } from "../../components/domains/resource-focus";
import {
	createLiveScreen,
	type WebArtifactAdapter,
} from "../toolchain-artifacts/registry";
import { model3dApiFor } from "./api";
import { useModel3dRuntime } from "./use-model3d-runtime";

export const MODEL3D_ADAPTER_REF = "adapter:model3d@1";

/** What the mounted 3D model screen shows, read through the latest render. */
type Model3dScreen = {
	requestedId: string | undefined;
	loadedId: string | undefined;
	failedId: string | undefined;
	visible: boolean;
	select(assetId: string | undefined): void;
};
const live = createLiveScreen<{ read(): Model3dScreen }>();

/** The detail view of the shown model, once the screen has drawn it. */
const findDetail = () =>
	document.querySelector<HTMLElement>(".model3d-workspace .model3d-focus");

/** The 3D model screen: every action is local and goes through the authenticated model3d API. */
export const model3dWebAdapter: WebArtifactAdapter = {
	adapterRef: MODEL3D_ADAPTER_REF,
	useArtifact({ client, artifactRevisionId, visible }) {
		const { runtime, loading, error, refresh, selection } = useModel3dRuntime({
			client,
			api: model3dApiFor(client),
			artifactRevisionId,
			visible,
		});
		const screen: Model3dScreen = { ...selection, visible };
		const latest = useRef(screen);
		useEffect(() => {
			latest.current = screen;
		});
		useEffect(() => live.attach({ read: () => latest.current }), []);
		return {
			phase: error
				? { kind: "error", message: "3Dモデルの情報を取得できませんでした。" }
				: loading
					? { kind: "loading" }
					: { kind: "ready" },
			snapshot: runtime.snapshot,
			uploadFile: runtime.uploadFile,
			targetOf: () => undefined,
			local: (_binding, event) => runtime.dispatch(event),
			settled: () => {},
			refresh: () => {
				void refresh();
			},
		};
	},
	async focus(assetId) {
		const mounted = await live.waitFor((handle) => handle.read());
		if (!mounted) return false;
		mounted.select(assetId);
		const outcome = await live.waitFor((handle) => {
			const screen = handle.read();
			if (screen.requestedId !== assetId) return null;
			if (screen.loadedId === assetId) return "shown" as const;
			return screen.failedId === assetId ? ("missing" as const) : null;
		});
		if (outcome !== "shown") {
			live.current()?.read().select(undefined);
			return false;
		}
		// The model exists; marking it is best effort while the screen draws its detail.
		await focusWhenDrawn(findDetail);
		return true;
	},
	viewing() {
		const screen = live.current()?.read();
		return screen?.visible && screen.loadedId
			? formatResourceUri("model3d.asset", screen.loadedId)
			: null;
	},
};
