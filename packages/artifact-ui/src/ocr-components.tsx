import {
	OcrMedia,
	OcrPanel,
	type OcrWorkspaceProps,
} from "@eumenes/design-system";
import type { ArtifactRequest } from "./contracts";
import { useAction } from "./components";
import { useArtifactRuntime } from "./runtime";
export type OcrResource = Omit<
	OcrWorkspaceProps,
	| "onFile"
	| "onSelect"
	| "onFrame"
	| "onLine"
	| "onRefresh"
	| "onCancel"
	| "onRecheck"
	| "onRemove"
	| "onIncorporate"
	| "onCopy"
	| "onConfigure"
	| "onRecordingChange"
	| "onThumbnailNeeded"
	| "message"
> & { kind: "ocr-workspace"; revision: number };
function useOcrProps(request: ArtifactRequest): OcrWorkspaceProps {
	const action = useAction(request);
	const runtime = useArtifactRuntime();
	const resource = action.resource as OcrResource;
	return {
		...resource,
		busy: resource.busy || action.pending,
		message: action.message,
		onFile: async (file) => {
			if (!runtime.uploadFile) throw new Error("input_unavailable");
			const receipt = await runtime.uploadFile(action.source, file);
			if (receipt.status !== "accepted") throw new Error(receipt.message);
		},
		onSelect: (id) => {
			void action.send("ocr-select", { id });
		},
		onFrame: (index) => {
			void action.send("ocr-frame", { index: String(index) });
		},
		onLine: (index) => {
			void action.send("ocr-line", { index: String(index) });
		},
		onRefresh: () => {
			void action.send("ocr-refresh", {});
		},
		onCancel: (id) => {
			void action.send("ocr-cancel", { id });
		},
		onRecheck: (id) => {
			void action.send("ocr-recheck", { id });
		},
		onRemove: (id) => {
			void action.send("ocr-remove", { id });
		},
		onConfigure: (baseUrl) => {
			void action.send("ocr-configure", { baseUrl });
		},
		onRecordingChange: (recording) => {
			void action.send("ocr-recording", { recording });
		},
		onThumbnailNeeded: (id) => {
			void runtime
				.dispatch({
					id: crypto.randomUUID(),
					source: action.source,
					revision: resource.revision,
					action: "ocr-thumbnail",
					values: { id },
				})
				.catch(() => {});
		},
		onCopy: (text) => {
			void navigator.clipboard.writeText(text);
		},
		onIncorporate: (id, frameIndex, lineIndexes) => {
			void action.send("ocr-incorporate", {
				id,
				frameIndex: frameIndex === undefined ? "" : String(frameIndex),
				lineIndexes: lineIndexes?.join(",") ?? "",
			});
		},
	};
}
export function OcrMediaView({ request }: { request: ArtifactRequest }) {
	return <OcrMedia {...useOcrProps(request)} />;
}
export function OcrPanelView({ request }: { request: ArtifactRequest }) {
	return <OcrPanel {...useOcrProps(request)} />;
}
