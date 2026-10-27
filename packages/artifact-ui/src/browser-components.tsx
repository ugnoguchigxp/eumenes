import { useEffect, useState } from "react";
import {
	BrowserSettings,
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
	| "suggestedExecutablePath"
	| "pickedExecutable"
	| "canBrowseExecutable"
	| "tabs"
	| "tasks"
	| "captures"
	| "histories"
	| "replays"
	| "selectedHistoryId"
	| "historyDetail"
	| "historyDetailError"
	| "loading"
	| "error"
	| "focus"
> & {
	kind: "browser";
	revision: number;
	bridge?: {
		revision: number;
		enabled: boolean;
		configured: boolean;
		available: boolean;
	};
};

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
			settings={request.view === "browser-settings"}
		/>
	);
}

export const BrowserSettingsView = BrowserWorkspaceView;

function BrowserWorkspaceBody({
	settings,
	resource,
	action,
	title,
}: {
	settings?: boolean;
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
	const Content = settings ? BrowserSettings : BrowserWorkspace;
	return (
		<Content
			title={title}
			bridge={resource.bridge}
			{...(settings ? {} : { focus: resource.focus })}
			onOpenBrowser={() => send("browser-open-workspace")}
			onOpenSettings={() => send("browser-settings")}
			onSaveBridge={(input) =>
				action.send("browser-bridge-save", {
					token: input.token,
					enabled: input.enabled,
					clear: input.clear,
					expectedRevision: String(input.expectedRevision),
				})
			}
			availability={resource.availability}
			connection={resource.connection}
			executablePath={resource.executablePath}
			suggestedExecutablePath={resource.suggestedExecutablePath}
			pickedExecutable={resource.pickedExecutable}
			canBrowseExecutable={resource.canBrowseExecutable}
			onBrowseExecutablePath={() => send("browser-browse-path")}
			tabs={resource.tabs}
			tasks={resource.tasks}
			captures={resource.captures}
			histories={resource.histories}
			replays={resource.replays}
			selectedHistoryId={resource.selectedHistoryId}
			historyDetail={resource.historyDetail}
			historyDetailError={resource.historyDetailError}
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
			onSelectHistory={(historyId) =>
				send("browser-select-history", { historyId: historyId ?? "" })
			}
			onDeleteHistory={(historyId, expectedRevision) =>
				send("browser-delete-history", {
					historyId,
					expectedRevision: String(expectedRevision),
				})
			}
			onReplayHistory={(historyId, expectedRevision, values) =>
				send("browser-replay-history", {
					historyId,
					expectedRevision: String(expectedRevision),
					...Object.fromEntries(
						Object.entries(values).map(([name, value]) => [
							`var.${name}`,
							value,
						]),
					),
				})
			}
			onCancelReplay={(replayId) => send("browser-cancel-replay", { replayId })}
			onDownloadCapture={download}
			onCancelTask={(taskId) => send("browser-cancel-task", { taskId })}
			onCancelCapture={(captureId) =>
				send("browser-cancel-capture", { captureId })
			}
		/>
	);
}
