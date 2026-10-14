export type OcrLine = { text: string; confidence: number; polygon: [number,number][] };
export type OcrRecord = {
	id: string; name: string; mime: string;
	state: "queued" | "starting" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
	progress: unknown; errorCode: string | null; canRecheck?: boolean;
	result: { kind: "image"; width: number; height: number; text: string; lines: OcrLine[] } |
		{ kind: "video"; video: { width: number; height: number }; frames: { timestampSeconds: number; text: string; lines: OcrLine[] }[] } | null;
};
export type OcrWorkspaceProps = {
	items: OcrRecord[]; selectedId?: string; mediaUrl?: string; thumbnails?: Record<string, string>;
	frameIndex: number; selectedLines: number[];
	busy?: boolean; recording?: boolean; configured: boolean; connectionRevision: number; baseUrl: string | null;
	error?: string; message?: string;
	onFile?: (file: File) => Promise<void>;
	onSelect?: (id: string) => void;
	onFrame?: (index: number) => void;
	onLine?: (index: number) => void;
	onRefresh?: () => void;
	onCancel?: (id: string) => void;
	onRecheck?: (id: string) => void;
	onRemove?: (id: string) => void;
	onIncorporate?: (id: string, frameIndex?: number, lineIndexes?: number[]) => void;
	onCopy?: (text: string) => void;
	onConfigure?: (baseUrl: string) => void;
	onRecordingChange?: (recording: boolean) => void;
	onThumbnailNeeded?: (id: string) => void;
};
export const stateLabels: Record<OcrRecord["state"], string> = {
	queued: "準備中", starting: "受付確認中", running: "解析中", cancelling: "取消確認中",
	completed: "完了", failed: "失敗", cancelled: "中止",
};
export const canRemove = (item: OcrRecord) => ["completed", "failed", "cancelled"].includes(item.state);
