import type { WebArtifactAdapter } from "../toolchain-artifacts/registry";
import { useOcrRuntime } from "./use-ocr-runtime";
export const OCR_ADAPTER_REF = "adapter:ocr@1";
export const ocrWebAdapter: WebArtifactAdapter = {
	adapterRef: OCR_ADAPTER_REF,
	useArtifact({ client }) {
		const { runtime, loading, refresh } = useOcrRuntime(client);
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
};
