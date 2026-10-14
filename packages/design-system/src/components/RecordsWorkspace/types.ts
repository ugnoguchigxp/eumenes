export type RecordRow = {
	id: string;
	label: string;
	cells?: Record<string, string>;
	summary: string[];
	details: { label: string; value: string }[];
	table?: { title: string; columns: string[]; rows: string[][] };
};
export type SavedProcedure = {
	id: string;
	label: string;
	url?: string;
	description: string;
	status: string;
	enabled: boolean;
	cells?: Record<string, string>;
};
export type RecordsTab = {
	id: string;
	label: string;
	description?: string;
	rows: RecordRow[];
	loading?: boolean;
	error?: string;
	page?: RecordsPage;
	columns?: { id: string; label: string }[];
	procedures?: SavedProcedure[];
	proceduresLoading?: boolean;
	proceduresError?: string;
	proceduresPage?: RecordsPage;
};
export type RecordsWorkspaceProps = {
	title?: string;
	compact?: boolean;
	tabs: RecordsTab[];
	busy?: boolean;
	message?: string;
	dataDescription: string[];
	dataError?: string;
	onRefresh: () => void;
	onQuery: (tableId: string, query: TableQuery) => void;
	onProcedureState: (id: string, enabled: boolean) => void;
	onProcedureDelete: (id: string) => void;
	onDownload: () => void;
};
import type { TableQuery } from "../ServerDataTable";
export type RecordsPage = { query: TableQuery; total: number };
