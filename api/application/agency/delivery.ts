import { combineInput, observationInput } from "./input";
import { resultInput } from "./memory";
import { defaultLimits } from "eumenes-agency";
import type { Database } from "bun:sqlite";
import type { ActionTicket, ActionReceipt, CycleOutcome } from "eumenes-agency";
import { getLogger } from "../../infrastructure/logger";
import { toErrorCode } from "../../infrastructure/error-code";
import { persistSpeech, speechReceipt } from "./speech";
import { researchInput } from "./research";
import type { AgencyHostDeps, Conv, Cycle } from "./host-types";
export function createAgencyDelivery(config: {
	deps: AgencyHostDeps;
	nowMs: () => number;
	save(c: Conv): Promise<boolean>;
	isCurrent(cy: Cycle, db: Database, ticket: ActionTicket): boolean;
}) {
	const { deps, nowMs, save } = config;
	const { store } = deps;
	const log = getLogger("agency");
	/** Pass technical failures and deferrals back to the idle scheduler. */
	async function deliver(
		cy: Cycle,
		ticket: ActionTicket,
		evidenceRefs: readonly string[],
	): Promise<CycleOutcome> {
		const { c, trigger } = cy;
		if (
			ticket.action === "tool" &&
			ticket.toolName === "find_toolchain" &&
			deps.state
		) {
			try {
				if (!(await save(c))) return "aborted";
				const raw = JSON.parse(ticket.toolInput ?? "{}");
				if (
					typeof raw.query !== "string" ||
					!raw.query.trim() ||
					raw.query.length > 2000
				)
					throw new Error("agency_catalog_input_invalid");
				const cards = await deps.state.findCapabilities(
					raw.query,
					cy.controller.signal,
				);
				if (!store.read((db) => config.isCurrent(cy, db, ticket)))
					return "aborted";
				receipt(
					cy,
					ticket,
					{ status: "succeeded", resultText: JSON.stringify(cards) },
					{
						sources: cards.map((card) => `capability:${card.revisionId}`),
						complete: true,
					},
				);
				await save(c);
				return "aborted";
			} catch (error) {
				receipt(cy, ticket, {
					status: cy.controller.signal.aborted ? "interrupted" : "failed",
					resultText: toErrorCode(error, "agency_catalog_failed"),
				});
				await save(c);
				return "failed";
			}
		}
		if (ticket.action === "tool" && deps.state) {
			try {
				if (!(await save(c))) return "aborted";
				const input = researchInput(
					ticket,
					cy.runtime,
					c.id,
					c.scope,
					c.epoch,
					nowMs(),
				);
				await store.write((db) => {
					if (!config.isCurrent(cy, db, ticket))
						throw new Error("agency_origin_stale");
					deps.state!.startInTransaction(db, input);
				});
				log.info("agency.research_started", {
					subjectId: c.id,
					attemptId: ticket.id,
				});
			} catch (error) {
				const code = toErrorCode(error, "research_failed");
				receipt(cy, ticket, {
					status: "failed",
					resultText: code,
				});
				await save(c);
				return code === "agency_dispatch_interval" ||
					code === "agency_origin_stale"
					? "aborted"
					: "failed";
			}
			await save(c);
			return "aborted";
		}
		if (ticket.action !== "speak") {
			log.info("agency.delivered", {
				subjectId: c.id,
				attemptId: ticket.id,
				kind: trigger,
				outcome: "tool_not_supported",
			});
			receipt(cy, ticket, { status: "failed", resultText: "no tool runtime" });
			return "failed";
		}
		const text = ticket.utterance ?? "";
		const messageId = `agency:${c.scope}:${ticket.id}`;
		let at = 0;
		let outcome: "appended" | "stale" | "interval" | "routed";
		try {
			outcome = await store.write((db) => {
				// Re-checked inside the writer transaction: the setting as committed (not the cached copy),
				// and nothing may have been said since the opportunity.
				if (text === "" || !config.isCurrent(cy, db, ticket)) return "stale";
				at = nowMs();
				const interval = defaultLimits.outboundIntervalMs;
				const allowed = deps.state
					? deps.state.claimDispatchInTransaction(
							db,
							c.id,
							c.epoch,
							at,
							interval,
						)
					: c.lastDispatchAt === undefined || at - c.lastDispatchAt >= interval;
				if (!allowed) return "interval";
				return persistSpeech(deps, db, {
					conversationId: c.id,
					messageId,
					text,
					at,
					ticket,
					evidenceRefs,
					input: resultInput(c, ticket.id),
				});
			});
		} catch (error) {
			log.warn("agency.delivered", {
				subjectId: c.id,
				attemptId: ticket.id,
				kind: trigger,
				outcome: "write_failed",
				reason: toErrorCode(error, "write_failed"),
			});
			receipt(cy, ticket, { status: "failed", resultText: "" });
			return "failed";
		}
		if (outcome === "stale" || outcome === "interval") {
			log.info("agency.delivered", {
				subjectId: c.id,
				attemptId: ticket.id,
				kind: trigger,
				outcome,
			});
			receipt(cy, ticket, {
				status: "interrupted",
				resultText: outcome === "interval" ? "agency_dispatch_interval" : "",
			});
			return "aborted";
		}
		c.lastDispatchAt = at;
		cy.planner.proactiveSpoke(nowMs());
		log.info("agency.delivered", {
			subjectId: c.id,
			attemptId: ticket.id,
			kind: trigger,
			outcome,
			outputCharacters: text.length,
			...(ticket.emotion ? { emotion: ticket.emotion } : {}),
		});
		receipt(cy, ticket, speechReceipt(outcome, text));
		return "spoke";
	}

	/** One terminal receipt per ticket (S3), recorded on the runtime that issued it and only while it is current. */
	function receipt(
		cy: Cycle,
		ticket: ActionTicket,
		result: Omit<ActionReceipt, "ticketId" | "at">,
		context?: import("eumenes-agency").InputContext,
	) {
		const { c } = cy;
		const { status } = result;
		// A replaced runtime already interrupted its tickets; its late receipt belongs to nobody.
		if (c.runtime !== cy.runtime) {
			log.info("agency.receipt", {
				subjectId: c.id,
				attemptId: ticket.id,
				status,
				outcome: "dropped",
			});
			return;
		}
		try {
			let input = combineInput(
				resultInput(cy.c, ticket.id),
				context ?? { sources: [], complete: true },
			);
			if (
				ticket.action === "speak" &&
				result.status === "succeeded" &&
				!result.speechHandoff
			) {
				const id = `agency:${cy.c.scope}:${ticket.id}`;
				input = combineInput(
					input,
					deps.store.read((db) => observationInput(deps, db, id)),
				);
			}
			cy.runtime.recordResult(
				{
					ticketId: ticket.id,
					at: nowMs(),
					...result,
				},
				input,
			);
			log.info("agency.receipt", {
				subjectId: c.id,
				attemptId: ticket.id,
				status,
			});
		} catch (error) {
			log.warn("agency.receipt", {
				subjectId: c.id,
				attemptId: ticket.id,
				status,
				reason: toErrorCode(error, "receipt_failed"),
			});
		}
	}

	return { deliver };
}
