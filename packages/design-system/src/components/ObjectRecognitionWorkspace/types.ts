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
export type ObjectRecognitionWorkspaceProps = {
	items: RecognitionItem[];
	selectedId?: string;
	mediaUrl?: string;
	busy?: boolean;
	message?: string;
	error?: string;
	configured: boolean;
	credentialSource?: "dedicated" | "larm";
	sharedCredentialAvailable?: boolean;
	hasEndpoint?: boolean;
	onCredentialSourceChange?: (source: "dedicated" | "larm") => void;
	onFile?: (file: File) => Promise<void>;
	onSelect?: (id: string) => void;
	onCancel?: (id: string) => void;
	onRefresh?: () => void;
	onRecheck?: (id: string) => void;
	onRemove?: (id: string) => void;
	onIncorporate?: (id: string, frameIndex?: number) => void;
};
