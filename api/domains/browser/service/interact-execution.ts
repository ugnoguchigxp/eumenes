import type { Database } from "bun:sqlite";
import type {
	AdapterCommand,
	HostCall,
	ObservationEnvelope,
	OperationResult,
} from "eumenes-interact";
import {
	assertQuoted,
	InputGrants,
	Refusal,
	type Executed,
	type ExecuteOptions,
	type PartExecutionPort,
} from "eumenes-interact/parts";
import {
	markOperationDispatched,
	recordOperationIntent,
	settleOperation,
} from "eumenes-interact/sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { InteractDriver, InteractMemory } from "../contracts/interact";
import type {
	CaptureFiles,
	DriverAction,
	HostResolver,
	ImageEncoder,
} from "../contracts/ports";
import { consumeApproval } from "../repository/approvals";
import {
	createInteractApproval,
	interactApprovalText,
} from "./interact-approval";
import {
	interactHash,
	interactIso,
	type InteractAuthority,
} from "./interact-authority";
import { createInteractCapture } from "./interact-capture";
import { createInteractObservations } from "./interact-observations";
import { urlVerdict } from "./policy";

export type InteractExecutionContext = {
	runId: string;
	owner: string;
	conversationId: string;
	generation: number;
	jobId: string;
	jobGeneration: number;
	signal: AbortSignal;
};
export type InteractExecutionDeps = {
	store: SqliteStore;
	authority: InteractAuthority;
	memory: InteractMemory;
	now: () => number;
	driver: InteractDriver;
	files: CaptureFiles;
	encoder: ImageEncoder;
	resolveHost: HostResolver;
	webOrigins: readonly string[];
};

/** Structural translation only. Unsupported platform actions remain refusals. */
function driverAction(c: AdapterCommand): DriverAction | null {
	switch (c.action) {
		case "browser.navigate":
			return { kind: "navigate", url: c.url };
		case "browser.back":
			return { kind: "back" };
		case "page.click":
			return { kind: "click", ref: c.targetRef, element: c.element };
		case "page.hover":
			return { kind: "hover", ref: c.targetRef, element: c.element };
		case "page.fill":
			return {
				kind: "type",
				ref: c.targetRef,
				element: c.element,
				text: c.text,
				submit: c.submit,
			};
		case "page.select":
			return {
				kind: "select",
				ref: c.targetRef,
				element: c.element,
				values: c.values,
			};
		case "page.press":
			return { kind: "press", key: c.key };
		case "page.wait":
			return {
				kind: "wait",
				text: c.text,
				textGone: c.textGone,
				seconds: c.seconds,
			};
		default:
			return null;
	}
}

/** One dedicated session, driven exclusively by the shared part executor. */
export function createInteractExecution(
	deps: InteractExecutionDeps,
	initial: InteractExecutionContext,
) {
	let ctx = initial;
	const grants = new InputGrants(deps.now, () => crypto.randomUUID());
	const policy = {
		now: deps.now,
		webOrigins: deps.webOrigins,
		resolveHost: deps.resolveHost,
		dnsCache: new Map(),
	};
	const check = (db: Database) => {
		ctx.signal.throwIfAborted();
		if (
			!deps.authority.current(
				db,
				ctx.runId,
				ctx.generation,
				ctx.jobId,
				ctx.jobGeneration,
			)
		)
			throw new Error("browser_interact_not_active");
	};
	const active = () => deps.store.read(check);
	const allowed = async (url: string) => {
		if (url === "about:blank") return;
		const v = await urlVerdict(policy, url);
		if (!v.ok) throw new Error(v.code);
	};

	const observations = createInteractObservations(
		deps,
		() => ctx,
		active,
		allowed,
	);
	const { list, observe, observed } = observations;
	const approval = createInteractApproval(deps, () => ctx, check);

	async function operate(
		call: Extract<HostCall, { kind: "operate" }>,
		options?: ExecuteOptions,
	): Promise<Executed> {
		const command = call.command;
		const translated = driverAction(command);
		if (!translated)
			return {
				kind: "outcome",
				outcome: { kind: "refused", code: "unsupported", retryable: false },
			};
		// A navigation the part declared as needing approval is always shown against a page: after a failed
		// operation the last observation is gone, so it is taken again rather than skipping the approval.
		const seen =
			command.action === "browser.navigate"
				? (observations.current() ??
					(call.declaredEffect === "navigation" ? null : await observe()))
				: observed(
						call.tabRef!,
						call.observationRef,
						"targetRef" in command ? command.targetRef : null,
					);
		if (command.action === "browser.navigate") await allowed(command.url);
		if (command.action === "page.fill") {
			if (call.inputProvenance?.kind === "request_quote")
				assertQuoted(
					command.text,
					call.inputProvenance.quote,
					deps.memory.request,
				);
			else if (call.inputProvenance?.kind === "grant") {
				// The value is bound to its site and to what it was approved for (eumenes-interact 0.1.2, R19).
				if (
					grants.use(
						call.inputProvenance.inputValueRef,
						seen?.url ?? "",
						options?.grantPurpose,
					) !== command.text
				)
					throw new Refusal("grant_mismatch", false);
			} else throw new Refusal("grant_source_mismatch", false);
		}
		let confirmed: Awaited<ReturnType<typeof approval>> = null;
		try {
			if (seen) confirmed = await approval(command, call.declaredEffect, seen);
		} catch (e) {
			if (e instanceof Refusal && e.code === "approval_required")
				return {
					kind: "outcome",
					outcome: {
						kind: "stop",
						code: e.code,
						text: interactApprovalText(command, seen!),
					},
				};
			throw e;
		}
		const operationId = crypto.randomUUID();
		await deps.store.write((db) => {
			check(db);
			if (confirmed) {
				if (!consumeApproval(db, confirmed.match, deps.now()))
					throw new Refusal("approval_required", false);
				db.query(
					"UPDATE browser_interact_runs SET approval_observation=NULL,approval_id=NULL WHERE run_id=?",
				).run(ctx.runId);
			}
			recordOperationIntent(db, ctx.owner, ctx.runId, {
				request: {
					operationId,
					sessionId: ctx.runId,
					generation: ctx.generation,
					observationRef: seen?.observationRef,
					command,
					declaredEffect: call.declaredEffect,
					...(confirmed ? { approvalRef: confirmed.ref } : {}),
				},
				inputDigest: `sha256:${interactHash(command)}`,
				nowIso: interactIso(deps.now()),
			});
			markOperationDispatched(
				db,
				ctx.owner,
				operationId,
				interactIso(deps.now()),
			);
		});
		// No await between this final saved-authority check and entering the driver.
		active();
		const returned = await deps.driver
			.act(translated, ctx.signal)
			.catch(() => ({
				ok: false as const,
				code: "transport_lost",
				dispatched: true,
			}));
		const result: OperationResult = {
			operationId,
			status: returned.ok
				? "confirmed"
				: returned.dispatched
					? "indeterminate"
					: "failed",
			retryable: false,
			...(returned.ok
				? { url: returned.url, title: returned.title }
				: { code: returned.code }),
		};
		await deps.store.write((db) =>
			settleOperation(db, ctx.owner, operationId, {
				status: result.status === "not_dispatched" ? "failed" : result.status,
				code: result.code,
				retryable: false,
				nowIso: interactIso(deps.now()),
			}),
		);
		active();
		if (result.status === "indeterminate")
			return {
				kind: "end",
				status: "indeterminate",
				code: "operation_outcome_unknown",
			};
		observations.invalidate();
		return {
			kind: "outcome",
			outcome: {
				kind: "operation",
				result,
				...(returned.ok ? { observation: await observe() } : {}),
			},
		};
	}

	const capture = createInteractCapture(deps, () => ctx, {
		active,
		check,
		observe,
		observed,
	});

	const port: PartExecutionPort = {
		attach: async () =>
			(await list()).find((t) => t.current)?.tabRef ??
			(() => {
				throw new Error("tab_lost");
			})(),
		// `recoverable` is never granted here: an unknown outcome always ends the run (HOST-CONTRACT duty 3).
		execute: (call, options) =>
			dispatchPart(call, {
				observe,
				operate: (c) => operate(c, options),
				list,
			}),
		// Read-only, and only for a ref of the tab's latest observation: whether a menu link has an href (R18).
		choices: async (tab, ref, target, offset, limit) => {
			observed(tab, ref, target);
			if (!deps.driver.readChoices) throw new Refusal("unsupported", false);
			const result = await deps.driver.readChoices(
				target,
				offset,
				limit,
				ctx.signal,
			);
			active();
			return result;
		},
		inspectTarget: async (tab, ref, target) => {
			observed(tab, ref ?? (await observe()).observationRef, target);
			const info = await deps.driver.inspectTarget(target);
			active();
			return info;
		},
		extract: async (tab, ref, target, max) => {
			const fresh = ref ?? (await observe()).observationRef;
			observed(tab, fresh, target);
			const read = await deps.driver.readText(target, max, ctx.signal);
			if (read.url) await allowed(read.url);
			active();
			return read;
		},
		capture: capture.capture,
	};
	return {
		port,
		snapshotDigest: observations.snapshotDigest,
		grants,
		tabs: observations.tabs,
		setContext(next: InteractExecutionContext) {
			ctx = next;
		},
		async begin(url: string) {
			active();
			const connected = await deps.driver.connect(ctx.signal);
			active();
			if (connected.state !== "connected")
				throw new Error("browser_interact_unavailable");
			const outcome = await operate({
				kind: "operate",
				command: { action: "browser.navigate", url },
				declaredEffect: "navigation",
			});
			if (
				outcome.kind !== "outcome" ||
				outcome.outcome.kind !== "operation" ||
				!outcome.outcome.observation
			)
				throw new Error("browser_interact_navigation_failed");
			return {
				tabs: observations.tabs.open(),
				observation: outcome.outcome.observation,
			};
		},
		save: capture.save,
	};
}

/** Dispatch the fixed public host-call union; unsupported calls remain explicit refusals. */
async function dispatchPart(
	call: HostCall,
	ports: {
		observe: () => Promise<ObservationEnvelope>;
		operate: (
			call: Extract<HostCall, { kind: "operate" }>,
		) => Promise<Executed>;
		list: () => Promise<import("eumenes-interact").TabView[]>;
	},
): Promise<Executed> {
	const { observe, operate, list } = ports;
	try {
		if (call.kind === "observe")
			return {
				kind: "outcome",
				outcome: { kind: "observation", observation: await observe() },
			};
		if (call.kind === "operate") return await operate(call);
		if (call.kind === "tabs.list")
			return {
				kind: "outcome",
				outcome: { kind: "tabs", tabs: await list() },
			};
		return {
			kind: "outcome",
			outcome: { kind: "refused", code: "unsupported", retryable: false },
		};
	} catch (e) {
		if (e instanceof Refusal)
			return {
				kind: "outcome",
				outcome: { kind: "refused", code: e.code, retryable: false },
			};
		throw e;
	}
}
