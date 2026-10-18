import { useEffect, useState } from "react";
import {
	BrowserWorkspace,
	type BrowserWorkspaceProps,
} from "@eumenes/design-system";
import type { ArtifactRequest } from "./contracts";
import { useAction } from "./components";
import { useArtifactRuntime, type ArtifactRuntime } from "./runtime";

/** What the host supplies for the browser screen; operations come from dispatch. */
export type BrowserWorkspaceResource = Pick<
	BrowserWorkspaceProps,
	| "availability"
	| "connection"
	| "executablePath"
	| "tabs"
	| "tasks"
	| "captures"
	| "loading"
	| "error"
> & { kind: "browser"; revision: number };

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** A capture image is read through the authenticated host, from this one path shape only. */
const contentPath = (captureId: string) =>
	IDENTIFIER.test(captureId)
		? `/api/browser/captures/${captureId}/content`
		: undefined;

/** The selected capture's image as an object URL; revoked when it changes or the screen goes. */
function useCaptureImage(
	runtime: ArtifactRuntime,
	captureId: string | undefined,
) {
	const [state, setState] = useState<{
		id?: string;
		url?: string;
		error?: string;
	}>({});
	const fetchMedia = runtime.fetchMedia;
	useEffect(() => {
		const path = captureId && contentPath(captureId);
		if (!captureId || !path || !fetchMedia) return;
		let live = true;
		let created: string | undefined;
		fetchMedia(path)
			.then((blob) => {
				created = URL.createObjectURL(blob);
				if (live) setState({ id: captureId, url: created });
				else URL.revokeObjectURL(created);
			})
			.catch(() => {
				if (live)
					setState({ id: captureId, error: "画像を読み込めませんでした。" });
			});
		return () => {
			live = false;
			if (created) URL.revokeObjectURL(created);
		};
	}, [captureId, fetchMedia]);
	return state.id === captureId ? state : {};
}

/** The screen part is presentational; this view supplies its data, events and the image fetch. */
export function BrowserWorkspaceView({
	request,
}: {
	request: ArtifactRequest;
}) {
	const action = useAction(request);
	const resource = action.resource;
	if (resource?.kind !== "browser") return null;
	return (
		<BrowserWorkspaceBody
			resource={resource}
			action={action}
			title={request.title}
		/>
	);
}

function BrowserWorkspaceBody({
	resource,
	action,
	title,
}: {
	resource: BrowserWorkspaceResource;
	action: ReturnType<typeof useAction>;
	title?: string;
}) {
	const runtime = useArtifactRuntime();
	const [selected, setSelected] = useState<string>();
	const ready = resource.captures.find(
		(c) => c.captureId === selected && c.state === "local_ready",
	);
	const image = useCaptureImage(runtime, ready?.captureId);
	const [downloadError, setDownloadError] = useState<string>();
	const send = (name: Parameters<typeof action.send>[0], values = {}) => {
		void action.send(name, values);
	};
	function download(captureId: string) {
		const path = contentPath(captureId);
		if (!path || !runtime.fetchMedia) return;
		setDownloadError(undefined);
		runtime
			.fetchMedia(path)
			.then((blob) => {
				const url = URL.createObjectURL(blob);
				const link = document.createElement("a");
				link.href = url;
				link.download = `capture-${captureId}.webp`;
				link.click();
				setTimeout(() => URL.revokeObjectURL(url), 1000);
			})
			.catch(() => setDownloadError("画像をダウンロードできませんでした。"));
	}
	return (
		<BrowserWorkspace
			title={title}
			availability={resource.availability}
			connection={resource.connection}
			executablePath={resource.executablePath}
			tabs={resource.tabs}
			tasks={resource.tasks}
			captures={resource.captures}
			selectedCaptureId={ready?.captureId}
			previewSrc={image.url}
			pending={action.pending}
			loading={resource.loading}
			error={resource.error ?? image.error ?? downloadError}
			message={action.message}
			onConnect={() => send("browser-connect")}
			onDisconnect={() => send("browser-disconnect")}
			onSaveExecutablePath={(path) => send("browser-save-path", { path })}
			onOpenUrl={(url) => send("browser-open-url", { url })}
			onFocusTab={(tabRef) => send("browser-focus-tab", { tabRef })}
			onCloseTab={(tabRef) => send("browser-close-tab", { tabRef })}
			onSelectCapture={setSelected}
			onDownloadCapture={download}
			onCancelTask={(taskId) => send("browser-cancel-task", { taskId })}
			onCancelCapture={(captureId) =>
				send("browser-cancel-capture", { captureId })
			}
		/>
	);
}
