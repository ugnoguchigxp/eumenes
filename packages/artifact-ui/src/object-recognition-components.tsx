import { visualAnalysisActions } from "./visual-analysis-actions";
import {
	ObjectRecognitionWorkspace,
	type ObjectRecognitionWorkspaceProps,
} from "@eumenes/design-system";
import type { ArtifactRequest } from "./contracts";
import { useAction } from "./components";
import { useArtifactRuntime } from "./runtime";
export type ObjectRecognitionResource = Omit<
	ObjectRecognitionWorkspaceProps,
	| "onAnalysisOpen"
	| "onAnalysisRun"
	| "onAnalysisCancel"
	| "onAnalysisSelect"
	| "onFile"
	| "onLibraryRefresh"
	| "onLibrarySelect"
	| "onLibraryDelete"
	| "onCaptureSaveRecheck"
	| "onCaptureSaveResume"
	| "onCredentialSourceChange"
	| "onCancel"
	| "onSelect"
	| "onFrame"
	| "onRefresh"
	| "onRecheck"
	| "onIncorporate"
	| "onHandoffCancel"
	| "onRemove"
	| "message"
> & { kind: "object-recognition-workspace"; revision: number };
export function ObjectRecognitionWorkspaceView({
	request,
}: {
	request: ArtifactRequest;
}) {
	const action = useAction(request);
	const runtime = useArtifactRuntime();
	const resource = action.resource as ObjectRecognitionResource;
	return (
		<ObjectRecognitionWorkspace
			{...resource}
			{...visualAnalysisActions(action, resource)}
			onFrame={(index) => {
				void action.send("recognition-frame", {
					id: resource.selectedId ?? "",
					index: String(index),
				});
			}}
			busy={resource.busy || action.pending}
			message={action.message}
			onLibraryDelete={runtime.deleteLibraryImage}
			onCaptureSaveRecheck={() => {
				void action.send("recognition-save-recheck", {
					id: resource.selectedId ?? "",
				});
			}}
			onCaptureSaveResume={() => {
				void action.send("recognition-save-resume", {
					id: resource.selectedId ?? "",
				});
			}}
			onLibraryRefresh={() => {
				void action.send("recognition-library-refresh", {});
			}}
			onLibrarySelect={(id) => {
				void action.send("recognition-library-select", { id });
			}}
			onCredentialSourceChange={(source) => {
				void action.send("recognition-credential-source", {
					credentialSource: source,
				});
			}}
			onFile={async (file, context) => {
				if (!runtime.uploadFile) throw new Error("input_unavailable");
				const receipt = await runtime.uploadFile(action.source, file, context);
				if (receipt.status !== "accepted") throw new Error(receipt.message);
			}}
			onSelect={(id) => {
				void action.send("recognition-select", { id });
			}}
			onCancel={(id) => {
				void action.send("recognition-cancel", { id });
			}}
			onRefresh={() => {
				void action.send("recognition-refresh", {});
			}}
			onRecheck={(id) => {
				void action.send("recognition-recheck", { id });
			}}
			onRemove={(id) => {
				void action.send("recognition-remove", { id });
			}}
			onIncorporate={(id) => {
				void action.send("recognition-incorporate", { id });
			}}
			onHandoffCancel={(id) => {
				void action.send("recognition-handoff-cancel", { id });
			}}
		/>
	);
}
