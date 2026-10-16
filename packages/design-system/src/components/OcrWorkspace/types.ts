export type OcrLine = {
	text: string;
	confidence: number;
	polygon: [number, number][];
};
export type OcrRecord = {
	id: string;
	name: string;
	mime: string;
	revision: number;
	state:
		| "queued"
		| "starting"
		| "running"
		| "cancelling"
		| "completed"
		| "failed"
		| "cancelled";
	progress: unknown;
	errorCode: string | null;
	canRecheck?: boolean;
	result:
		| {
				kind: "image";
				width: number;
				height: number;
				text: string;
				lines: OcrLine[];
		  }
		| {
				kind: "video";
				video: { width: number; height: number };
				frames: { timestampSeconds: number; text: string; lines: OcrLine[] }[];
		  }
		| null;
};
export type OcrCorrection = {
	id: string;
	sourceId: string;
	frameIndex: number | null;
	sourceRevision: number;
	state:
		| "queued"
		| "running"
		| "cancelling"
		| "cancelled"
		| "completed"
		| "failed";
	errorCode: string | null;
	createdAt: number;
	result: {
		blocks: Array<
			| {
					kind: "paragraph";
					text: string;
					evidence: {
						lineIndexes: number[];
						region?: [number, number, number, number];
					};
					uncertain: boolean;
					uncertainty?: string;
			  }
			| {
					kind: "table";
					rows: number;
					columns: number;
					evidence: {
						lineIndexes: number[];
						region?: [number, number, number, number];
					};
					uncertain: boolean;
					uncertainty?: string;
					cells: Array<{
						row: number;
						column: number;
						rowSpan: number;
						columnSpan: number;
						text: string;
						evidence: {
							lineIndexes: number[];
							region?: [number, number, number, number];
						};
						uncertain: boolean;
						uncertainty?: string;
					}>;
			  }
		>;
		excludedLines: Array<{ index: number; reason: string }>;
	} | null;
};
export type OcrWorkspaceProps = {
	items: OcrRecord[];
	selectedId?: string;
	mediaUrl?: string;
	thumbnails?: Record<string, string>;
	frameIndex: number;
	selectedLines: number[];
	highlightRegion?: [number, number, number, number];
	busy?: boolean;
	recording?: boolean;
	configured: boolean;
	connectionRevision: number;
	baseUrl: string | null;
	error?: string;
	message?: string;
	corrections?: OcrCorrection[];
	correctionSelectedId?: string;
	correctionPreferredId?: string | null;
	correctionPreferenceRevision?: number;
	correctionHasMore?: boolean;
	correctionLoading?: boolean;
	onFile?: (file: File) => Promise<void>;
	onSelect?: (id: string) => void;
	onFrame?: (index: number) => void;
	onLine?: (index: number) => void;
	onRefresh?: () => void;
	onCancel?: (id: string) => void;
	onRecheck?: (id: string) => void;
	onRemove?: (id: string) => void;
	onIncorporate?: (
		id: string,
		frameIndex?: number,
		lineIndexes?: number[],
	) => void;
	onCopy?: (text: string) => void;
	onConfigure?: (baseUrl: string) => void;
	onRecordingChange?: (recording: boolean) => void;
	onThumbnailNeeded?: (id: string) => void;
	onCorrectionStart?: (id: string) => void;
	onCorrectionSelect?: (id: string, candidateId: string) => void;
	onCorrectionCancel?: (id: string, candidateId: string) => void;
	onCorrectionPrefer?: (id: string, candidateId: string) => void;
	onCorrectionOriginal?: (id: string) => void;
	onCorrectionIncorporate?: (id: string, candidateId: string) => void;
	onCorrectionMore?: (id: string) => void;
	onCorrectionEvidence?: (
		id: string,
		candidateId: string,
		blockIndex: number,
		row?: number,
		column?: number,
	) => void;
};
export const stateLabels: Record<OcrRecord["state"], string> = {
	queued: "準備中",
	starting: "受付確認中",
	running: "解析中",
	cancelling: "取消確認中",
	completed: "完了",
	failed: "失敗",
	cancelled: "中止",
};
export const canRemove = (item: OcrRecord) =>
	["completed", "failed", "cancelled"].includes(item.state);
