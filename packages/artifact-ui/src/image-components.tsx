import {
	ImageWorkspace,
	ImageCreationForm,
	ImageGallery,
	ImagePreview,
	type ImageWorkspaceProps,
} from "@eumenes/design-system";
import type { ArtifactRequest } from "./contracts";
import { isSafeImageUrl } from "./contracts";
import { useAction } from "./components";
export type ImageWorkspaceResource = Omit<
	ImageWorkspaceProps,
	| "onGenerate"
	| "onCancel"
	| "onRefresh"
	| "onSelect"
	| "onDelete"
	| "onClose"
	| "pending"
	| "message"
	| "presentation"
	| "creationOptions"
> & { kind: "image-workspace"; revision: number };
function useImageActions(request: ArtifactRequest) {
	const action = useAction(request);
	const resource = action.resource as ImageWorkspaceResource;
	const images = resource.images.filter(
		(image) =>
			isSafeImageUrl(image.url) ||
			/^\/api\/images\/[a-zA-Z0-9][a-zA-Z0-9._-]*\/content$/.test(image.url),
	);
	return {
		...resource,
		images,
		pending: action.pending,
		message: action.message,
		onGenerate: (values: ImageWorkspaceProps["defaults"]) => {
			void action.send("image-generate", {
				prompt: values.prompt,
				...(values.model ? { model: values.model } : {}),
				width: String(values.width),
				height: String(values.height),
				format: values.format,
				seed: String(values.seed),
			});
		},
		onCancel: () => {
			void action.send("image-cancel", {});
		},
		onRefresh: () => {
			void action.send("image-refresh", {});
		},
		onSelect: (id: string) => {
			void action.send("image-select", { id });
		},
		onDelete: (id: string) => {
			void action.send("image-delete", { id });
		},
		onClose: () => {
			void action.send("image-close", {});
		},
	};
}
export function ImageWorkspaceView({ request }: { request: ArtifactRequest }) {
	const props = useImageActions(request);
	return (
		<ImageWorkspace
			{...props}
			creationOptions={
				request.view === "image-workspace" ? request.creationOptions : undefined
			}
			presentation={
				request.view === "image-workspace" ? request.presentation : "embedded"
			}
		/>
	);
}
export function ImageCreationView({ request }: { request: ArtifactRequest }) {
	const props = useImageActions(request);
	return (
		<ImageCreationForm
			initialValues={props.defaults}
			creationOptions={
				request.view === "image-workspace" ? request.creationOptions : undefined
			}
			busy={props.busy}
			pending={props.pending}
			onGenerate={props.onGenerate}
		/>
	);
}
export function ImageGalleryView({ request }: { request: ArtifactRequest }) {
	const props = useImageActions(request);
	return (
		<ImageGallery
			images={props.images}
			selectedId={props.selectedId}
			loading={props.loading}
			pending={props.pending}
			error={props.error}
			message={props.message}
			onRefresh={props.onRefresh}
			onSelect={props.onSelect}
			onDelete={props.onDelete}
		/>
	);
}
export function ImagePreviewView({ request }: { request: ArtifactRequest }) {
	const props = useImageActions(request);
	return (
		<ImagePreview
			image={props.images.find((image) => image.id === props.selectedId)}
			status={props.status}
			title={props.statusTitle}
			description={props.statusDescription}
			onCancel={props.canCancel ? props.onCancel : undefined}
			pending={props.pending}
		/>
	);
}
