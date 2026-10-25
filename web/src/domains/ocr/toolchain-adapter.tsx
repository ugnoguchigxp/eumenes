import { useEffect, useRef } from "react";
import { formatResourceUri } from "../../../../api/domains/resources/contracts";
import { focusWhenDrawn } from "../../components/domains/resource-focus";
import {
	createLiveScreen,
	type WebArtifactAdapter,
} from "../toolchain-artifacts/registry";
import { useOcrRuntime } from "./use-ocr-runtime";
export const OCR_ADAPTER_REF = "adapter:ocr@1";

/** What the mounted OCR screen holds, read through the latest render. */
type OcrScreen = {
	ids: ReadonlySet<string>;
	selectedId: string | undefined;
	visible: boolean;
	select(inputId: string): void;
};
const live = createLiveScreen<{ read(): OcrScreen }>();

/** The part of the screen showing the selected document: its source, else its result. */
const findShown = () =>
	document.querySelector<HTMLElement>(".ocr-media") ??
	document.querySelector<HTMLElement>(".ocr-panel");

export const ocrWebAdapter: WebArtifactAdapter = {
	adapterRef: OCR_ADAPTER_REF,
	useArtifact({ client, visible }) {
		const { runtime, loading, refresh, screen } = useOcrRuntime(client);
		const latest = useRef<OcrScreen>({ ...screen, visible });
		useEffect(() => {
			latest.current = { ...screen, visible };
		});
		useEffect(() => live.attach({ read: () => latest.current }), []);
		return {
			phase: loading ? { kind: "loading" } : { kind: "ready" },
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
	async focus(inputId) {
		const known = await live.waitFor((handle) =>
			handle.read().ids.has(inputId),
		);
		if (!known) return false;
		if (live.current()?.read().selectedId !== inputId)
			live.current()?.read().select(inputId);
		await live.waitFor((handle) => handle.read().selectedId === inputId);
		// The document exists; marking it is best effort while the screen draws it.
		await focusWhenDrawn(findShown);
		return true;
	},
	viewing() {
		const screen = live.current()?.read();
		return screen?.visible && screen.selectedId
			? formatResourceUri("document", screen.selectedId)
			: null;
	},
};
