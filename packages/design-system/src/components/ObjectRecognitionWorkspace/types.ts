import type { VisualAnalysisProps } from "../VisualAnalysis";
import type { ImageGridItem } from "../ImagePicker/ImageGrid";
export type ObservedObject = {
	classId: number;
	label: string;
	confidence: number;
	box: [number, number, number, number];
};
export type RecognitionItem = {
	id: string;
	name: string;
	mime: string;
	state:
		| "queued"
		| "starting"
		| "running"
		| "cancelling"
		| "completed"
		| "failed"
		| "cancelled";
	canRecheck?: boolean;
	captureSave?: "queued" | "saved" | "failed" | "unconfirmed";
	progress: unknown;
	errorCode: string | null;
	result:
		| {
				kind: "image";
				width: number;
				height: number;
				objects: ObservedObject[];
		  }
		| {
				kind: "video";
				video: { width: number; height: number };
				frames: { timestampSeconds: number; objects: ObservedObject[] }[];
		  }
		| null;
};
export type ObjectRecognitionWorkspaceProps = VisualAnalysisProps & {
	items: RecognitionItem[];
	frameIndex?: number;
	onFrame?: (index: number) => void;
	selectedId?: string;
	mediaUrl?: string;
	captureSaveStatus?: "queued" | "saved" | "failed" | "unconfirmed";
	captureSaveCanResume?: boolean;
	onCaptureSaveRecheck?: () => void;
	onCaptureSaveResume?: () => void;
	libraryImages?: readonly ImageGridItem[];
	libraryLoading?: boolean;
	libraryError?: string;
	onLibraryRefresh?: () => void;
	onLibrarySelect?: (id: string) => void;
	onLibraryDelete?: (id: string) => Promise<boolean>;
	busy?: boolean;
	message?: string;
	error?: string;
	configured: boolean;
	credentialSource?: "dedicated" | "larm";
	sharedCredentialAvailable?: boolean;
	hasEndpoint?: boolean;
	onCredentialSourceChange?: (source: "dedicated" | "larm") => void;
	/** `origin` is how the file was taken; `handoffId` when it answers the conversation's capture request. */
	onFile?: (
		file: File,
		context: { origin: "camera" | "screen" | "file"; handoffId?: string },
	) => Promise<void>;
	/** The conversation's request to take a still now (the user agreed by voice). */
	handoff?: { id: string; source: "camera" | "screen"; question: string };
	onHandoffCancel?: (id: string) => void;
	onSelect?: (id: string) => void;
	onCancel?: (id: string) => void;
	onRefresh?: () => void;
	onRecheck?: (id: string) => void;
	onRemove?: (id: string) => void;
	/** Attaches the still and its detections to the chat input (not sent). */
	onIncorporate?: (id: string) => void;
};
