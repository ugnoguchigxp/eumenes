export type UsageQuery = {
	start: string;
	end: string;
	service: "all" | "live" | "codex";
	model: string;
	connectionId: string;
	pageIndex: number;
};
export type UsageSummary = {
	count: number;
	liveCount: number;
	codexCount: number;
	seconds: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadTokens: number | null;
	cacheCreationTokens: number | null;
	reasoningTokens: number | null;
	estimate: string | null;
	reportedUsd: number | null;
	unconfirmed: number;
	missing: number;
	cacheMissing: number;
	unpriced: number;
	active: number;
};
export type UsageRow = {
	id: string;
	service: "live" | "codex";
	model: string | null;
	requestedModel: string | null;
	connectionName: string | null;
	connectionId: string | null;
	started: string;
	ended: string | null;
	status: string;
	role: string | null;
	seconds: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadTokens: number | null;
	cacheCreationTokens: number | null;
	reasoningTokens: number | null;
	confirmed: boolean;
	test: boolean;
	estimate: string | null;
	rateId: string | null;
	reportedUsd: number | null;
};
export type UsageRate = {
	id: string;
	model: string;
	amount: string;
	effectiveFrom: string;
	source: string;
	checkedAt: string;
};
export type UsageRateDraft = {
	model: string;
	amount: string;
	effectiveFrom: string;
	source: string;
};
export type UsageDashboardData = {
	ongoing?: Array<{
		id: string;
		model: string | null;
		startedAt: string;
		seconds: number | null;
		outsidePeriod: boolean;
	}>;
	revision: number;
	asOf: string;
	query: UsageQuery;
	timezone: string;
	summary: UsageSummary;
	daily: Array<UsageSummary & { date: string }>;
	groups: Array<
		UsageSummary & {
			service: "live" | "codex";
			model: string | null;
			connectionName: string | null;
			role: string | null;
		}
	>;
	rows: UsageRow[];
	total: number;
	pageSize: number;
	models: string[];
	liveModels: string[];
	currentCodexModel: string;
	connections: Array<{ id: string; name: string }>;
	rates: UsageRate[];
};
export type UsageDashboardProps = {
	data: UsageDashboardData;
	busy?: boolean;
	message?: string;
	title?: string;
	onQuery(query: UsageQuery): void;
	onRefresh(): void;
	onRateSave(draft: UsageRateDraft): Promise<boolean>;
};
