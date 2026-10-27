import type { BrowserWorkspaceResource } from "@eumenes/artifact-ui/contracts";
import type {
	BrowserCaptureData,
	BrowserConnectionData,
	BrowserHistoryDetailData,
	BrowserHistorySummaryData,
	BrowserReplayData,
	BrowserSourceData,
	BrowserTabData,
} from "./contracts";

/** A cheap numeric digest of the shown state, so the revision changes whenever it does. */
function revisionOf(value: unknown): number {
	const text = JSON.stringify(value);
	let hash = 5381;
	for (let i = 0; i < text.length; i += 1)
		hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
	return hash;
}

/** The domain's end reasons, in the words the screen part knows. Others show its generic line. */
const endReasons: Record<string, string> = {
	user: "user_disconnected",
	backend_restart: "backend_stopped",
};

function connectionOf(c: BrowserConnectionData) {
	const state = c.state === "failed" ? "disconnected" : c.state;
	return {
		state: state as "disconnected" | "connecting" | "connected",
		...(state === "disconnected" && c.endReason
			? { endReason: endReasons[c.endReason] ?? c.endReason }
			: {}),
	};
}

function availabilityOf(c: BrowserConnectionData) {
	// While Brave waits for the user to pick a tab the screen explains it itself.
	if (c.availability.available || c.state === "connecting")
		return { available: true } as const;
	return { available: false, reason: c.availability.reason } as const;
}

/** A blocked tab is one the host stopped for safety: it is shown as such and cannot be switched to. */
const tabStatusOf = (status: BrowserTabData["status"]) =>
	status === "busy" || status === "blocked" ? status : ("open" as const);

const tabOf = (t: BrowserTabData) => ({
	tabRef: t.tabRef,
	title: t.title,
	url: t.url,
	active: t.active,
	status: tabStatusOf(t.status),
	...(t.currentTaskLabel ? { currentTaskLabel: t.currentTaskLabel } : {}),
});

const captureOf = (c: BrowserCaptureData) => ({
	captureId: c.captureId,
	range: c.range,
	capturedAt: c.capturedAt,
	width: c.width,
	height: c.height,
	bytes: c.bytes,
	reductionPercent: c.reductionPercent,
	state: c.state,
	...(c.errorLabel ? { errorLabel: c.errorLabel } : {}),
});

const replayOf = (r: BrowserReplayData) => ({
	replayId: r.replayId,
	historyId: r.historyId,
	state: r.state,
	...(r.errorLabel ? { errorLabel: r.errorLabel } : {}),
	startedAt: r.startedAt,
	...(r.endedAt !== null ? { endedAt: r.endedAt } : {}),
});

/** The `browser` resource: closed tabs are history, not choices, so they are not listed. */
export function browserResource(input: {
	data: BrowserSourceData | undefined;
	tabs: readonly BrowserTabData[] | undefined;
	executablePath: string | undefined;
	suggestedExecutablePath: string | undefined;
	pickedExecutable?: BrowserWorkspaceResource["pickedExecutable"];
	canBrowseExecutable?: boolean;
	bridge?: BrowserWorkspaceResource["bridge"];
	histories?: readonly BrowserHistorySummaryData[];
	/** The history whose detail modal is open, with its detail once read. */
	selectedHistoryId?: string;
	historyDetail?: BrowserHistoryDetailData;
	historyDetailError?: string;
	conversationId?: string;
	loading: boolean;
	error: string | undefined;
}): BrowserWorkspaceResource {
	const { data } = input;
	const content = {
		kind: "browser" as const,
		bridge: input.bridge,
		availability: data
			? availabilityOf(data.connection)
			: ({ available: false, reason: "browser_disconnected" } as const),
		connection: data
			? connectionOf(data.connection)
			: { state: "disconnected" as const },
		executablePath: input.executablePath,
		suggestedExecutablePath: input.suggestedExecutablePath,
		pickedExecutable: input.pickedExecutable,
		canBrowseExecutable: input.canBrowseExecutable ?? false,
		tabs: (input.tabs ?? data?.tabs ?? [])
			.filter((t) => t.status !== "closed")
			.map(tabOf),
		tasks: (data?.tasks ?? [])
			.filter(
				(t) =>
					!t.conversationId ||
					t.conversationId === (input.conversationId ?? "main"),
			)
			.map((t) => ({
				taskId: t.taskId,
				phase: t.phase,
				conversationId: t.conversationId,
				continuedFrom: t.continuedFrom,
				...(t.history ? { history: t.history } : {}),
				script: t.script,
				operations: t.operations,
				...(t.errorLabel ? { errorLabel: t.errorLabel } : {}),
				requestSummary: t.requestSummary,
				state: t.state,
				...(t.resultSummary ? { resultSummary: t.resultSummary } : {}),
			})),
		captures: (data?.captures ?? []).map(captureOf),
		histories: input.histories ?? [],
		replays: (data?.replays ?? []).map(replayOf),
		selectedHistoryId: input.selectedHistoryId,
		historyDetail: input.historyDetail,
		historyDetailError: input.historyDetailError,
		loading: input.loading,
		error: input.error,
	};
	return { ...content, revision: revisionOf(content) };
}
