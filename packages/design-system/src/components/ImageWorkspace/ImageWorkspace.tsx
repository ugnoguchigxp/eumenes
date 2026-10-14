import { useState } from "react";
import { ImageIcon, Grid2X2 } from "lucide-react";
import { Button } from "../Button";
import { FullscreenDialog } from "../FullscreenDialog";
import { ImageCreationForm } from "./ImageCreationForm";
import { ImageGallery } from "./ImageGallery";
import { ImagePreview } from "./ImagePreview";
import type { ImageWorkspaceProps } from "./types";
export type {
	ImageWorkspaceProps,
	ImagePromptValues,
	WorkspaceImage,
} from "./types";
import "./ImageWorkspace.css";
/** Presentation state stays local. The host supplies business state and approved operations. */
export function ImageWorkspace(props: ImageWorkspaceProps) {
	const [viewDraft, setView] = useState({
		identity: props.identity,
		view: props.initialTab ?? "create",
	});
	const view =
		viewDraft.identity === props.identity
			? viewDraft.view
			: (props.initialTab ?? "create");
	const changeView = (next: "create" | "history") =>
		setView({ identity: props.identity, view: next });
	const selected = props.images.find((image) => image.id === props.selectedId);
	const content = (
		<section
			className="image-workspace"
			aria-label="画像生成"
			data-view={view}
			data-presentation={props.presentation ?? "embedded"}
		>
			<header className="image-workspace-header">
				<h2>
					{view === "history" ? "生成画像一覧" : (props.title ?? "画像生成")}
				</h2>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => changeView(view === "create" ? "history" : "create")}
				>
					{view === "create" ? (
						<Grid2X2 aria-hidden="true" />
					) : (
						<ImageIcon aria-hidden="true" />
					)}
					{view === "create" ? "画像一覧" : "画像生成"}
				</Button>
			</header>
			<div className="image-workspace-body">
				<div className="image-workspace-create" hidden={view !== "create"}>
					<ImagePreview
						image={selected}
						status={props.status}
						title={props.statusTitle}
						description={props.statusDescription}
						onCancel={props.canCancel ? props.onCancel : undefined}
						pending={props.pending}
					/>
					<ImageCreationForm
						initialValues={props.defaults}
						creationOptions={props.creationOptions}
						busy={props.busy}
						pending={props.pending}
						onGenerate={props.onGenerate}
					/>
				</div>
				<div className="image-workspace-history" hidden={view !== "history"}>
					<ImageGallery
						images={props.images}
						selectedId={props.selectedId}
						loading={props.loading}
						pending={props.pending}
						error={props.error}
						onRefresh={props.onRefresh}
						onSelect={props.onSelect}
						onDelete={props.onDelete}
					/>
				</div>
			</div>
			{props.message && (
				<output className="image-workspace-feedback" aria-live="polite">
					{props.message}
				</output>
			)}
		</section>
	);
	return props.presentation === "fullscreen" ? (
		<FullscreenDialog
			open
			title={view === "history" ? "生成画像一覧" : "画像生成"}
			closeLabel="画像スタジオを閉じる"
			onOpenChange={(open) => {
				if (!open) props.onClose?.();
			}}
		>
			{content}
		</FullscreenDialog>
	) : (
		content
	);
}
