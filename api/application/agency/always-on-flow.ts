import {
	defaultLimits,
	type AlwaysOnTicket,
	type InputContext,
} from "eumenes-agency";
import type { OutboxEvent } from "../../domains/conversation";
import { imageReferenceText } from "../../domains/conversation";
import { combineInput, currentInput, observationInput } from "./input";
import { archiveOf } from "./memory";
import { persistSpeech } from "./speech";
import { agencyResearchRequest } from "./research";
import { toErrorCode } from "../../infrastructure/error-code";
import type { AgencyHostDeps } from "./host-types";
import type { AlwaysOnScope } from "./always-on-scope";

export function feedAlwaysOn(
	deps: AgencyHostDeps,
	c: AlwaysOnScope,
	event: OutboxEvent,
	at: number,
) {
	if (event.kind === "retracted") {
		c.agent.forget([event.sourceId]);
		c.generation++;
		c.revision++;
		return;
	}
	deps.store.read((db) => {
		const source = deps.conversation.sourceInTransaction(db, event.sourceId);
		if (
			source.state !== "available" ||
			source.message.presentation === "artifact" ||
			deps.memory.isBlockedInTransaction?.(db, event.sourceId)
		)
			return;
		const m = source.message;
		// The delivery receipt owns our text, including after a restart.
		if (m.id.startsWith(`agency:${c.scope}:`)) return;
		const images = deps.conversation
			.imageReferencesInTransaction(db, m.id)
			.filter(
				(ref) => !deps.memory.isBlockedInTransaction?.(db, ref.messageId),
			);
		let input = combineInput(
			observationInput(deps, db, m.id),
			...images.map((ref) => observationInput(deps, db, ref.messageId)),
			m.role === "assistant" && m.runId && deps.memory.referenceInputs
				? (deps.memory.referenceInputs.readRunInTransaction(db, m.runId) ?? {
						sources: [],
						complete: false,
					})
				: { sources: [], complete: true },
		);
		if (!input.complete || !currentInput(deps, db, input)) return;
		if (event.kind === "corrected") {
			const previous = c.agent.snapshot();
			const refs = previous.observationInputs?.find(([id]) => id === m.id)?.[1]
				.sources ?? [m.id];
			c.agent.forget(refs);
			// The corrected version retains its Memory stamp, without reusing a tombstoned observation identity.
			input = {
				...input,
				sources: input.sources.filter((ref) => ref !== m.id),
			};
		}
		if (m.role === "user") {
			c.generation++;
			// Outstanding proposals can no longer authorize delivery after a new user input.
			const delivered = new Set(
				c.agent.snapshot().observations.map((o) => o.causationId),
			);
			c.tickets = c.tickets.filter(
				(t) => t.action === "prepare" || delivered.has(t.id),
			);
		}
		c.agent.observe(
			{
				id: event.kind === "corrected" ? `${m.id}:c${event.seq}` : m.id,
				kind: event.kind === "corrected" ? "correction" : "exchange.adopted",
				actor: m.role === "user" ? "user" : "agent",
				occurredAt: Date.parse(m.createdAt) || at,
				text: [m.text, imageReferenceText(images)].filter(Boolean).join("\n"),
			},
			input,
		);
		c.revision++;
		c.touched = at;
	});
}

export function findingWorkRefs(
	deps: AgencyHostDeps,
	c: AlwaysOnScope,
	refs: readonly string[],
) {
	const snap = c.agent.snapshot();
	const archive = archiveOf(deps, c);
	return [
		...new Set(
			snap.state.stock
				.filter((s) => refs.includes(`stock:${s.id}`))
				.flatMap((s) =>
					s.sourceRefs.flatMap((id) => {
						const observation =
							snap.observations.find((o) => o.id === id) ??
							archive.get(id)?.observation;
						return observation?.workRef ? [observation.workRef] : [];
					}),
				),
		),
	];
}

export async function deliverAlwaysOn(input: {
	deps: AgencyHostDeps;
	c: AlwaysOnScope;
	ticket: AlwaysOnTicket;
	at: number;
	current(speech: boolean, db: import("bun:sqlite").Database): boolean;
	save(): Promise<boolean>;
}) {
	const { deps, c, ticket, at } = input;
	const context: InputContext = { sources: ticket.inputs, complete: true };
	try {
		if (!(await input.save())) throw new Error("agency_checkpoint_stale");
		if (ticket.action === "prepare") {
			const parsed = agencyResearchRequest
				.omit({ revisionId: true })
				.parse(JSON.parse(ticket.toolInput ?? "null"));
			await deps.store.write((db) => {
				if (!input.current(false, db)) throw new Error("agency_origin_stale");
				deps.state!.startInTransaction(db, {
					rootId: `agency:${c.scope}:${ticket.id}`,
					conversationId: c.id,
					epoch: c.epoch,
					ticketId: ticket.id,
					revisionId: ticket.toolName!,
					...parsed,
					deadline: ticket.at + 30 * 60_000,
					sourceRefs: ticket.inputs,
					outboundIntervalMs: defaultLimits.outboundIntervalMs,
				});
			});
			c.agent.recordResult({ ticketId: ticket.id, status: "succeeded", at });
		} else {
			const messageId = `agency:${c.scope}:${ticket.id}`;
			const outcome = await deps.store.write((db) => {
				if (!input.current(true, db) || !currentInput(deps, db, context))
					throw new Error("agency_origin_stale");
				const others = c.tickets.filter(
					(t) => t.action !== "prepare" && t.id !== ticket.id,
				);
				const delivered = new Set(
					c.agent.snapshot().observations.map((o) => o.causationId),
				);
				if (others.some((t) => !delivered.has(t.id)))
					throw new Error("agency_delivery_unknown");
				if (
					!deps.state!.claimDispatchInTransaction(
						db,
						c.id,
						c.epoch,
						at,
						(deps.settings.get().agency.speechIntervalSec ?? 10) * 1000,
					)
				)
					throw new Error("agency_dispatch_interval");
				return persistSpeech(deps, db, {
					conversationId: c.id,
					messageId,
					text: ticket.utterance ?? "",
					at,
					ticket: {
						findingWorkRefs: findingWorkRefs(deps, c, ticket.evidenceRefs),
					},
					evidenceRefs: ticket.evidenceRefs,
					input: context,
				});
			});
			// A Live handoff is a proposal; its acceptance is never fabricated as delivered speech.
			if (outcome === "appended") {
				c.agent.recordResult({
					ticketId: ticket.id,
					status: "succeeded",
					at,
					observationId: messageId,
				});
				c.tickets = c.tickets.filter((t) => t.id !== ticket.id);
			}
		}
	} catch (error) {
		c.agent.recordResult({ ticketId: ticket.id, status: "failed", at });
		c.tickets = c.tickets.filter((t) => t.id !== ticket.id);
		throw new Error(toErrorCode(error, "agency_delivery_failed"));
	} finally {
		c.revision++;
		await input.save();
	}
}
