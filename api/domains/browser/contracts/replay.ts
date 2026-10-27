/** Replays of a saved history in the user's browser (spec browser-history-replay-design-2026-10-27). */

/** One replay runs this long at most; the screen's cancel ends it earlier. */
export const REPLAY_MS = 60_000;
/** How many replays the screen's workspace source lists, newest first. */
export const REPLAY_LIST_LIMIT = 10;

export const replayStates = [
	"running",
	"completed",
	"failed",
	"cancelled",
] as const;
export type ReplayState = (typeof replayStates)[number];

/** The history at the revision the screen showed, and one value for each variable it declares. */
export type ReplayStart = {
	historyId: string;
	expectedRevision: number;
	values: Record<string, string>;
};

export type ReplayView = {
	replayId: string;
	historyId: string;
	state: ReplayState;
	/** Set when the replay failed: a code of the closed list in spec §5.1. */
	errorCode: string | null;
	errorLabel: string | null;
	startedAt: number;
	endedAt: number | null;
};
