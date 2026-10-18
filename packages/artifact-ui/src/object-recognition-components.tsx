import {
	ObjectRecognitionWorkspace,
	type ObjectRecognitionWorkspaceProps,
} from "@eumenes/design-system";
import type { ArtifactRequest } from "./contracts";
import { useAction } from "./components";
import { useArtifactRuntime } from "./runtime";
export type ObjectRecognitionResource = Omit<
	ObjectRecognitionWorkspaceProps,
	| "onFile"
	| "onCredentialSourceChange"
	| "onCancel"
	| "onSelect"
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
			busy={resource.busy || action.pending}
			message={action.message}
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
