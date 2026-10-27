import { createContext, useContext, type ReactNode } from "react";
import type {
	ArtifactEvent,
	Receipt,
	Snapshot,
	TerminalConnection,
} from "./contracts";

export type ArtifactRuntime = {
	snapshot: Snapshot;
	/** Editor metadata only; a pending form or invalid field blocks the shared save. */
	setEditing?: (source: string, id: string, message: string | null) => void;
	/** Reads only a draft secret in memory, directly into a password input, never a snapshot. */
	readSecret?: (source: string, fieldId: string) => string | undefined;
	/** Transient File bridge for host-owned uploads; never serialized into saved JSON. */
	uploadFile?: (
		source: string,
		file: File,
		/** Domain-defined facts about the file (e.g. how a still was taken); never saved in JSON. */
		context?: Readonly<Record<string, string>>,
		signal?: AbortSignal,
	) => Promise<Receipt & { value?: string; canRetry?: boolean }>;
	dispatch: (event: ArtifactEvent) => Promise<Receipt>;
	/** Re-read this screen's registered sources after a failed read. */
	refresh?: () => void;
	/**
	 * Reads a media file the host allows (a same-origin `/api/` path, with the session's
	 * credentials) for a preview. The host refuses any other path.
	 */
	fetchMedia?: (path: string) => Promise<Blob>;
	/** Deletes only an image currently present in the host's authenticated library. */
	deleteLibraryImage?: (id: string) => Promise<boolean>;
	/**
	 * Advances when the host settles an earlier unsettled operation in the background. A
	 * pending/indeterminate message shown for an older epoch no longer applies.
	 */
	settledEpoch?: number;
	/** Theme controlled by the host's preview toolbar, when present. */
	previewTheme?: "light" | "dark";
	/**
	 * Views the host draws itself (e.g. the WebGL avatar preview, the 3D model viewer). The
	 * package never loads their renderer; without an entry the view says it is unavailable.
	 */
	hostViews?: {
		"image-picker-photos"?: (props: {
			onSelect: (image: {
				id: string;
				title: string;
				thumbnailUrl?: string;
			}) => void;
		}) => ReactNode;
		"avatar-motion-lab"?: () => ReactNode;
		"model3d-viewer"?: (props: { assetId: string }) => ReactNode;
		"model3d-thumbnail"?: (props: { assetId: string }) => ReactNode;
	};
	/**
	 * Connects one live PTY session of a terminal source (output stream, ordered input, resize).
	 * Called once per session run; the stream opens on subscribe and closes on unsubscribe.
	 */
	openTerminal?: (source: string, sessionId: string) => TerminalConnection;
};
export const ArtifactRuntimeContext = createContext<ArtifactRuntime | null>(
	null,
);
export function useArtifactRuntime() {
	const runtime = useContext(ArtifactRuntimeContext);
	if (!runtime) throw new Error("Artifact host が必要です");
	return runtime;
}
