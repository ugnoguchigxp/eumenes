import type { Database } from "bun:sqlite";
import type {
	AdapterOrigin,
	AdapterResult,
	DomainAdapter,
	InputAdapter,
} from "../../domains/tool-runtime";
import {
	DEFAULT_TIMER_SCOPE,
	timerReceiptDigest,
	timerReceiptSchema,
	type TimerReceipt,
	type TimerOrigin,
	type TimersService,
} from "../../domains/timers";
import { projectTimerResult } from "./timer-result-context";

export const TIMER_ADAPTER_REF = "adapter:timers@1";
const SETUP = "query:timers.setup@1";
const CURRENT = "query:timers.current@1";
const QUESTION = "query:timers.question@1";
const HMS = "input:timer-hms@1";

/** Domain result schemas this adapter registers for `domain:` refs. */
export const timerDomainSchemas = {
	"domain:timers.receipt@1": timerReceiptSchema,
} as const;

/**
 * The existing time fields (hours, minutes, seconds as text) to `durationSeconds`. Only
 * non-negative whole numbers; the operation schema then checks 1 second to 24 hours.
 */
const timerHms: InputAdapter = (raw) => {
	const errors: Array<{ field: string; message: string }> = [];
	const parts = (["hours", "minutes", "seconds"] as const).map((field) => {
		const value = raw[field];
		if (typeof value !== "string" || !/^\d{1,5}$/.test(value.trim())) {
			errors.push({ field, message: "0以上の整数で入力してください" });
			return 0;
		}
		return Number(value.trim());
	});
	if (errors.length) return { ok: false, errors };
	return {
		ok: true,
		value: { durationSeconds: parts[0]! * 3600 + parts[1]! * 60 + parts[2]! },
	};
};

const STATE_LABEL: Record<string, string> = {
	active: "動作中",
	paused: "一時停止",
	elapsed: "時間切れ",
	cancelled: "取消済み",
};

type Interactions = {
	/** An open question of a toolchain interaction, as the question source shows it. */
	questionInTransaction(
		tx: Database,
		interactionId: string,
	): { revision: number; data: unknown } | null;
};

/** What the timer adapter offers, without a timers service (bundle checks, evaluation). */
export const describeTimerAdapter = () => ({
	owner: "timers",
	operations: new Map([
		[
			"timers.start",
			{ inputSchemaRef: "builtin:timerStart", effect: "write" as const },
		],
		[
			"timers.list-with-receipt",
			{ inputSchemaRef: "builtin:timerList", effect: "read" as const },
		],
		[
			"timers.cancel",
			{ inputSchemaRef: "builtin:timerCancel", effect: "write" as const },
		],
		[
			"timers.pause",
			{ inputSchemaRef: "builtin:timerCancel", effect: "write" as const },
		],
		[
			"timers.resume",
			{ inputSchemaRef: "builtin:timerCancel", effect: "write" as const },
		],
	]),
	queries: new Set([SETUP, CURRENT, QUESTION]),
	inputAdapters: new Map([[HMS, timerHms]]),
	projections: new Set(["projection:timer-result@1"]),
	availability: "availability:timers@1",
});

/**
 * The typed timer adapter: every timer operation goes through the timers domain's existing
 * public transaction operations, so its clock, receipts, scheduler, revision and scope stay the
 * only source of truth. The conversation and UI action hosts both execute through it.
 */
export function createTimerAdapter(
	timers: TimersService,
	options: { interactions?: () => Interactions | undefined } = {},
): DomainAdapter {
	const scope = timers.scope ?? DEFAULT_TIMER_SCOPE;
	function originOf(origin: AdapterOrigin, operationName: string): TimerOrigin {
		return origin.kind === "conversation"
			? {
					scope,
					conversationId: origin.conversationId,
					runId: origin.runId,
					messageId: origin.messageId,
					// One conversation run starts at most one timer.
					originKey:
						operationName === "timers.start" ? `${origin.runId}:timer:0` : null,
				}
			: {
					scope,
					conversationId: null,
					runId: null,
					messageId: null,
					originKey: null,
				};
	}
	function result(
		receipt: TimerReceipt,
		replay: boolean,
		conversation: boolean,
	): AdapterResult {
		const digest = timerReceiptDigest(receipt);
		const items = receipt.action === "listed" ? receipt.items : [receipt.timer];
		return {
			receipt,
			receiptRef: { owner: "timers", operationId: receipt.operationId, digest },
			resultRefs: items.map((timer) => ({
				owner: "timers",
				kind: "timer",
				id: timer.id,
				schemaRef: "domain:timers.receipt@1",
				revision: timer.revision,
			})),
			replay,
			...(conversation &&
			["started", "listed", "cancelled", "dismissed", "unchanged"].includes(
				receipt.action,
			)
				? { answerContext: projectTimerResult(receipt) }
				: {}),
		};
	}
	/** Conversation operations may only name timers the command sub-agent was shown. */
	function checkTarget(
		tx: Database,
		operationName: string,
		input: { timerId?: string; expectedRevision?: number },
	) {
		if (!input.timerId) return;
		const shown = timers.routeSnapshotInTransaction(tx).items;
		if (
			!shown.some(
				(item) =>
					item.id === input.timerId &&
					(operationName === "timers.list-with-receipt" ||
						item.revision === input.expectedRevision),
			)
		)
			throw new Error("timer_target_invalid");
	}
	return {
		ref: TIMER_ADAPTER_REF,
		describe: describeTimerAdapter,
		availableInTransaction: () => true,
		snapshotInTransaction: (tx) => timers.routeSnapshotInTransaction(tx),
		choicesInTransaction(tx, inputSchemaRef) {
			if (inputSchemaRef !== "builtin:timerTargetAnswer") return [];
			// The timers the command sub-agent would be shown; the ref is the timer id.
			return timers
				.routeSnapshotInTransaction(tx)
				.items.slice(0, 20)
				.map((item) => ({
					ref: item.id,
					label: `${item.label}（残り${item.remainingSeconds}秒・${STATE_LABEL[item.state] ?? item.state}）`,
				}));
		},
		invokeInTransaction(tx, request) {
			const input = request.input as {
				durationSeconds?: number;
				label?: string;
				timerId?: string;
				state?: "active" | "elapsed" | "cancelled";
				expectedRevision?: number;
			};
			const conversation = request.origin.kind === "conversation";
			if (conversation) checkTarget(tx, request.operationName, input);
			const stamp = {
				requestId: request.requestId,
				issuedAt: request.issuedAt,
			};
			const control = { ...stamp, expectedRevision: input.expectedRevision };
			let saved: { receipt: TimerReceipt; replay: boolean };
			switch (request.operationName) {
				case "timers.start":
					saved = timers.startInTransaction(
						tx,
						{
							...stamp,
							durationSeconds: input.durationSeconds,
							...(input.label ? { label: input.label } : {}),
						},
						originOf(request.origin, request.operationName),
					);
					break;
				case "timers.list-with-receipt":
					saved = timers.recordListOperationInTransaction(
						tx,
						{
							...stamp,
							...(input.timerId ? { timerId: input.timerId } : {}),
							...(input.state ? { state: input.state } : {}),
						},
						scope,
					);
					break;
				case "timers.cancel":
					saved = timers.cancelInTransaction(
						tx,
						control,
						scope,
						input.timerId ?? "",
					);
					break;
				case "timers.pause":
					saved = timers.pauseInTransaction(
						tx,
						control,
						scope,
						input.timerId ?? "",
					);
					break;
				case "timers.resume":
					saved = timers.resumeInTransaction(
						tx,
						control,
						scope,
						input.timerId ?? "",
					);
					break;
				default:
					throw new Error("capability_unavailable");
			}
			return result(saved.receipt, saved.replay, conversation);
		},
		readInTransaction(tx, operationId) {
			const row = timers.readReceiptInTransaction(tx, operationId);
			if (!row) return null;
			const projected = timers.projectReceiptInTransaction(tx, operationId);
			return {
				...result(projected as TimerReceipt, true, true),
				receiptRef: {
					owner: "timers",
					operationId: row.operationId,
					digest: row.receiptDigest,
				},
			};
		},
		sourceInTransaction(tx, query, targetRef) {
			if (query === SETUP) return { revision: 0, data: { state: "setup" } };
			if (query === CURRENT) {
				if (!targetRef) return null;
				const view = timers.viewInTransaction(tx, targetRef);
				return view ? { revision: view.timer.revision, data: view } : null;
			}
			if (query === QUESTION && targetRef)
				return (
					options.interactions?.()?.questionInTransaction(tx, targetRef) ?? null
				);
			return null;
		},
		targetInput(query, targetRef, revision) {
			return query === CURRENT
				? { timerId: targetRef, expectedRevision: revision }
				: {};
		},
		afterCommit: () => timers.notifyChanged(),
	};
}
