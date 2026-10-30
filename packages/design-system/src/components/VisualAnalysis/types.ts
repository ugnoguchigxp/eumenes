export type VisualAnalysisTask =
	| "describe"
	| "referring"
	| "detection"
	| "count_box"
	| "segmentation"
	| "matting"
	| "ocr"
	| "ocr_grounding";
export type VisualAnalysisOptions = {
	task: VisualAnalysisTask;
	query: string | string[];
};
export type VisualAnalysisRecord = {
	id: string;
	sourceId: string;
	sourceRevision: number;
	frameIndex: number | null;
	createdAt: number;
	state:
		| "queued"
		| "starting"
		| "running"
		| "completed"
		| "failed"
		| "cancelling"
		| "cancelled";
	options: VisualAnalysisOptions;
	errorCode: string | null;
	releaseConfirmed: boolean | null;
	stopObservation?: { status: "observing" | "cold" | "unconfirmed" };
	waitingMs: number | null;
	inferenceMs: number | null;
	elapsedMs: number | null;
	result: {
		model: string;
		modelRevision: string;
		task: VisualAnalysisTask;
		response: string;
		truncated: boolean;
		count?: number;
		image: { width: number; height: number };
		detections: {
			label: string;
			box: [number, number, number, number];
			text?: string;
		}[];
		masks: { detectionIndex: number; mode: "binary" | "alpha" }[];
		timings: { totalMs: number };
		execution: {
			device: string;
			backend: string;
			dtype: string;
			decoderDtype: string | null;
			inputTokens?: number;
			outputTokens: number;
			visualTokens: number;
		};
	} | null;
};
export type VisualAnalysisProps = {
	analysisScope?: string;
	analysisAvailable?: boolean;
	analysisOpen?: boolean;
	analysisRecords?: VisualAnalysisRecord[];
	analysis?: VisualAnalysisRecord;
	analysisImageUrl?: string;
	analysisMaskUrls?: string[];
	analysisError?: string;
	analysisPending?: boolean;
	onAnalysisOpen?: () => void;
	onAnalysisRun?: (options: VisualAnalysisOptions) => void;
	onAnalysisCancel?: () => void;
	onAnalysisSelect?: (id: string) => void;
};
