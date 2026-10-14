import type { WebArtifactAdapter } from "../toolchain-artifacts/registry";
import { useRecognitionRuntime } from "./use-recognition-runtime";

export const OBJECT_RECOGNITION_SCREEN_ADAPTER_REF =
	"adapter:object-recognition-screen@1";

/** Registered view with the existing authenticated media and recognition operations. */
export const objectRecognitionScreenWebAdapter: WebArtifactAdapter = {
	adapterRef: OBJECT_RECOGNITION_SCREEN_ADAPTER_REF,
	useArtifact({ client }) {
		const { runtime, loading, refresh } = useRecognitionRuntime(client);
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
