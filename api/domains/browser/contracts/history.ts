import { z } from "zod";
import type { Effect } from "./index";

export const HISTORY_REQUEST_CHARS = 400;
export const HISTORY_VARIABLES = 5;
export const HISTORY_STEPS = 12;
export const HISTORY_ACTIONS = 40;
export const HISTORY_CODE_CHARS = 1000;
/** Chained tasks (continued after an approval) whose operations one history gathers. */
export const HISTORY_CHAIN = 3;
export const HISTORY_LIST_LIMIT = 100;
/** The REFERENCE's catalog: how many histories and how much of each. */
export const CATALOG_LIMIT = 12;
export const CATALOG_TITLE_CHARS = 60;
export const CATALOG_REQUEST_CHARS = 80;
export const CATALOG_STEPS = 6;
export const CATALOG_STEP_CHARS = 40;
export const SOURCE_CHARS = 24_000;
/** Written in place of a value the user allowed once; the value itself is never kept. */
export const REDACTED_VALUE = "<許可を得て入力した値>";

export const variableNamePattern = /^[a-z][a-zA-Z0-9]{0,30}$/;

export const historyKinds = [
	"navigate",
	"back",
	"tab_new",
	"tab_select",
	"tab_close",
	"click",
	"hover",
	"type",
	"select",
	"press",
	"wait",
	"capture",
] as const;
export type HistoryKind = (typeof historyKinds)[number];

export const historyDelete = z.strictObject({
	historyId: z.uuid(),
	expectedRevision: z.number().int().min(0),
});
export type HistoryDelete = z.infer<typeof historyDelete>;

export type HistoryVariable = { name: string; label: string };
/** Where a variable was typed: the page's origin, the purpose and the element as the model described it. */
export type HistorySlot = { origin: string; purpose: string; element: string };
export type StoredVariable = HistoryVariable & { slots: HistorySlot[] };
export type HistoryStep = { label: string; expectation: string };

export type HistoryAction = {
	seq: number;
	kind: HistoryKind;
	stepLabel?: string;
	element?: string;
	url?: string;
	variable?: string;
	value?: string;
	purpose?: string;
	effect?: Effect;
	place?: string;
	code?: string;
};

export type HistorySummary = {
	historyId: string;
	revision: number;
	title: string;
	request: string;
	place: string;
	variables: HistoryVariable[];
	stepCount: number;
	runCount: number;
	failureCount: number;
	lastOutcome: "completed" | "failed";
	hasCommit: boolean;
	lastUsedAt: number;
	createdAt: number;
	updatedAt: number;
	/** Whether the list's 再生 can run it; the detail adds the code. */
	replay: Pick<HistoryReplay, "blocked" | "blockedLabel">;
};
/**
 * What a replay of the history would run: `code` is exactly the lines placed in the wrapper, in order and
 * whole. `blocked` is the code a start would be refused with for reasons that do not depend on the values.
 */
export type HistoryReplay = {
	code: string;
	blocked: "replay_incomplete" | "replay_code_rejected" | null;
	blockedLabel: string | null;
};
export type HistoryDetail = HistorySummary & {
	steps: HistoryStep[];
	actions: HistoryAction[];
	source: string;
	replay: HistoryReplay;
};

/** What the page operator sees of the histories in REFERENCE (bounded). */
export type HistoryCatalogEntry = {
	historyId: string;
	title: string;
	request: string;
	place: string;
	variables: HistoryVariable[];
	steps: string[];
	runs: number;
	lastOutcome: "completed" | "failed";
	lastUsed: string;
};
/** What `browser.page.history` returns for one history. */
export type HistoryForOperator = {
	historyId: string;
	revision: number;
	title: string;
	request: string;
	variables: HistoryVariable[];
	steps: HistoryStep[];
	actions: (Omit<HistoryAction, "stepLabel"> & { step?: string })[];
};
