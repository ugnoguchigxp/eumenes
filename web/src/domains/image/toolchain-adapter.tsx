import { useQueryClient } from "@tanstack/react-query";
import {
	definitionRequests,
	parseDefinition,
} from "@eumenes/artifact-ui/contracts";
import { useEffect, useRef } from "react";
import { formatResourceUri } from "../../../../api/domains/resources/contracts";
import {
	createLiveScreen,
	type WebArtifactAdapter,
} from "../toolchain-artifacts/registry";
import { queryRoots } from "../../queryKeys";
import { focusImageElement } from "./focus";
import { imageStudioSource, useImageRuntime } from "./use-image-runtime";

export const IMAGE_SCREEN_ADAPTER_REF = "adapter:image-screen@1";

/** What the mounted image screen shows, read through the latest render. */
type ImageScreen = {
	ids: ReadonlySet<string>;
	shownId: string | undefined;
	visible: boolean;
	show(imageId: string): void;
};
const live = createLiveScreen<{ read(): ImageScreen }>();

/** Registered presentation with the existing authenticated image operations. */
export const imageScreenWebAdapter: WebArtifactAdapter = {
	adapterRef: IMAGE_SCREEN_ADAPTER_REF,
	useArtifact({ client, artifact, targetRef, setTargetRef, visible }) {
		const cache = useQueryClient();
		const definition = artifact.variants.find(
			(v) => v.id === artifact.defaultVariant,
		)?.definition;
		const request = definition
			? definitionRequests(parseDefinition(JSON.stringify(definition))).find(
					(r) => r.view === "image-workspace",
				)
			: undefined;
		const { runtime, loading, error } = useImageRuntime(
			client,
			"main",
			undefined,
			request?.view === "image-workspace"
				? request.creationOptions?.defaults
				: undefined,
			targetRef,
		);
		const resource = runtime.snapshot[imageStudioSource];
		const screen: ImageScreen = {
			ids: new Set(resource.images.map((image) => image.id)),
			shownId: resource.selectedId,
			visible,
			show: (imageId) => setTargetRef(imageId),
		};
		const latest = useRef(screen);
		useEffect(() => {
			latest.current = screen;
		});
		useEffect(() => live.attach({ read: () => latest.current }), []);
		return {
			phase: error
				? { kind: "error", message: "画像の情報を取得できませんでした。" }
				: loading
					? { kind: "loading" }
					: { kind: "ready" },
			snapshot: runtime.snapshot,
			targetOf: () => undefined,
			local: (_binding, event) => runtime.dispatch(event),
			settled: () => {},
			refresh: () => {
				void cache.invalidateQueries({ queryKey: [queryRoots.image] });
			},
		};
	},
	async focus(imageId) {
		const known = await live.waitFor((handle) =>
			handle.read().ids.has(imageId),
		);
		if (!known) return false;
		const screen = live.current()?.read();
		if (screen && screen.shownId !== imageId) screen.show(imageId);
		// The item exists; marking it is best effort while the screen draws it.
		await focusImageElement(imageId);
		return true;
	},
	viewing() {
		const screen = live.current()?.read();
		return screen?.visible && screen.shownId
			? formatResourceUri("image", screen.shownId)
			: null;
	},
};
