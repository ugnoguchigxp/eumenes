import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { BrowserService } from "../../domains/browser";
import type { HandlerDefinition, QueueService } from "../../domains/queue";
import { getLogger } from "../../infrastructure/logger";

const log = getLogger("browser");

/**
 * What an accepted operation does to the browser once it has committed. The domain's connection
 * and tab calls talk to Brave and cannot run inside the writer transaction, so the adapter queues
 * the call in the same transaction as the receipt; a rolled-back operation queues nothing.
 */
export type BrowserEffect =
	| { kind: "connect" }
	| { kind: "disconnect" }
	| { kind: "tab_open"; url: string }
	| { kind: "tab_focus"; tabRef: string }
	| { kind: "tab_close"; tabRef: string }
	| { kind: "abort_capture"; captureId: string }
	| { kind: "abort_task"; taskId: string };

const payload = z.object({
	effect: z.discriminatedUnion("kind", [
		z.strictObject({ kind: z.literal("connect") }),
		z.strictObject({ kind: z.literal("disconnect") }),
		z.strictObject({ kind: z.literal("tab_open"), url: z.string().max(2048) }),
		z.strictObject({ kind: z.literal("tab_focus"), tabRef: z.uuid() }),
		z.strictObject({ kind: z.literal("tab_close"), tabRef: z.uuid() }),
		z.strictObject({ kind: z.literal("abort_capture"), captureId: z.uuid() }),
		z.strictObject({ kind: z.literal("abort_task"), taskId: z.uuid() }),
	]),
	owner: z.string().min(1).max(120),
 strict: z.boolean().optional(),
});
type Payload = z.infer<typeof payload>;

/** A queued effect older than this is stale: the user's intent is gone, and the queue expires it unrun. */
export const EFFECT_MAX_AGE_MS = 60_000;
const KIND = "browser.control.run";

export function registerBrowserEffects(deps: {
	queue: QueueService;
	service: BrowserService;
}) {
	const handler: HandlerDefinition<Payload, Payload, true> = {
		kind: KIND,
		payloadVersions: [1],
		schema: payload,
		recovery: "replay_safe",
		resourceKey: "browser.control",
		prepareInTransaction: (_db, claim) => ({
			status: "ready",
			input: claim.payload,
		}),
		async execute(input) {
			const { effect, owner } = input;
			try {
				switch (effect.kind) {
					case "connect":
						await deps.service.connect();
						break;
					case "disconnect":
						await deps.service.disconnect();
						break;
					case "tab_open":
						await deps.service.openTab(owner, null, effect.url);
						break;
					case "tab_focus":
						await deps.service.focusTab(owner, null, effect.tabRef);
						break;
					case "tab_close":
						await deps.service.closeTab(owner, null, effect.tabRef);
						break;
					case "abort_capture":
						deps.service.abortCapture(effect.captureId);
						break;
					case "abort_task":
						deps.service.abortTask(effect.taskId);
						break;
				}
			} catch (error) {
				// The screen shows the result in the tab list; only a safe code is logged.
				const code =
					error instanceof Error && /^[a-z][a-z0-9_]*$/.test(error.message)
						? error.message
						: "browser_effect_failed";
				log.warn("browser.effect_failed", { kind: effect.kind, reason: code });
 if (input.strict) throw new Error(code);
			}
			return true;
		},
		classify: () => "fail",
		settleInTransaction: () => "applied",
		cancelInTransaction: () => undefined,
	};
	deps.queue.registerHandler(handler);
	return {
		statusInTransaction(db: Database, operationId: string) {
 const separator = operationId.indexOf(":");
 const action = operationId.slice(0, separator), id = operationId.slice(separator + 1);
 const kind = ({ "tab.open": "tab_open", "tab.focus": "tab_focus", "tab.close": "tab_close", connect: "connect", disconnect: "disconnect" } as Record<string, string>)[action];
 if (!kind) return null;
 return deps.queue.findByDedupeInTransaction(db, "browser", KIND, `${kind}:${id}`);
 },
		enqueueInTransaction(
			db: Database,
			requestId: string,
			owner: string,
			/** When the request was issued; the same for every replay of it. */
			issuedAt: string,
			effect: BrowserEffect,
 strict = false,
		) {
			const issued = Date.parse(issuedAt);
			deps.queue.enqueueInTransaction(db, {
				scope: "browser",
				kind: KIND,
				dedupeKey: `${effect.kind}:${requestId}`,
				payload: { effect, owner, strict } satisfies Payload,
				// Not part of the job's identity, so a replay with another stamp is still the same job.
				deadlineAtMs:
					(Number.isFinite(issued) ? issued : Date.now()) + EFFECT_MAX_AGE_MS,
				lane: "interactive",
				resourceKey: "browser.control",
				maxAttempts: 1,
			});
		},
	};
}
export type BrowserEffects = ReturnType<typeof registerBrowserEffects>;
