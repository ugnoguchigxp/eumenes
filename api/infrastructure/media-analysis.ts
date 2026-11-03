import type { Database } from "bun:sqlite";
import type { imageForInput } from "./media-image";

/** Borrowed-connection storage contract; source authorization and all SQL stay with the owner. */
export type MediaAnalysisRow = {
	id: string;
	source_id: string;
	owner: string;
	conversation_id: string;
	frame_key: number;
	record_json: string;
	input_json: string;
	job_id: string | null;
	connection_id: string | null;
};
export type MediaAnalysisStorage<R, I> = {
	scope: string;
	row(db: Database, id: string): MediaAnalysisRow | null;
	rows(db: Database, sourceId: string): MediaAnalysisRow[];
	allRows(db: Database, sourceId: string): MediaAnalysisRow[];
	pending(db: Database): MediaAnalysisRow[];
	record(row: MediaAnalysisRow): R;
	update(db: Database, row: MediaAnalysisRow, change: Partial<R>): R;
	valid(db: Database, row: MediaAnalysisRow): boolean;
	source(
		db: Database,
		owner: string,
		id: string,
	): {
		bytes: Uint8Array;
		conversationId: string;
		revision: number;
		digest: string;
		frame(index?: number): number | null;
	};
	sourceBytes(db: Database, id: string): Uint8Array;
	insert(db: Database, record: R, owner: string, input: I): void;
	setJob(db: Database, id: string, jobId: string): void;
	setConnection(db: Database, id: string, connectionId: string): void;
	deleteSource(db: Database, sourceId: string): void;
};
export type MediaAnalyses<R, I> = {
	recover(): Promise<void>;
	create(owner: string, sourceId: string, input: I): Promise<R>;
	list(
		owner: string,
		sourceId: string,
		conversationId: string,
		frameIndex?: number,
	): R[];
	get(owner: string, sourceId: string, id: string, conversationId: string): R;
	cancel(
		owner: string,
		sourceId: string,
		id: string,
		conversationId: string,
	): Promise<R>;
	image(
		owner: string,
		sourceId: string,
		id: string,
		conversationId: string,
		signal: AbortSignal,
	): ReturnType<typeof imageForInput>;
	removeInTransaction(db: Database, sourceId: string): string[];
};
export type MediaAnalysisFactory<R, I> = (
	storage: MediaAnalysisStorage<R, I>,
) => MediaAnalyses<R, I>;
