import { saveLatestSearch } from "../repository/search-offers";
import { conversationOffers } from "./conversation-offers";
import type { Database } from "bun:sqlite";
import { systemContext } from "../../../infrastructure/system-context";
import type { RoutedPipelineStep } from "../../tool-runtime";
import { isSystemPrompt } from "../contracts";
import type { AssignmentDetails } from "../contracts/agency-always-on";
import { saveAnnouncement, transition } from "../repository";
import { resolveDelegateRefs } from "./delegate-refs";
import { REPAIR_TOOLCHAIN, verifiedDiagnostic } from "./diagnostic-evidence";
import { eventText } from "./event-text";
import { executionSourceInTransaction } from "./execution-source";
import {
	TOOL_NAMES,
	requestRequired,
	toolRejection,
	type DelegateArgs,
	type ParsedCall,
} from "./generation-tools";
import { lineText } from "./input-text";
import { startSpecialistSession } from "./specialist-start";
import { carriedToolCalls, lastShownSearch } from "./tool-exchange";
import { recordUtteranceInTransaction } from "./utterances";

import {
	HandoverRefused,
	adoptHere,
	type ExecutorContext,
	type Request,
	type ToolOutcome,
} from "./executor-context";
import { instant } from "./executor-search";

/** A previous offer can be revoked between the model reading State and a tool committing. */
function offerEvidence(
	x: ExecutorContext,
	db: Database,
	card: Request["card"],
) {
	const offer =
		!x.state.newlyOffered.has(card.id) &&
		x.input.offers?.find((o) => o.card.revisionId === card.revisionId);
	if (!offer) return [];
	if (
		!conversationOffers(x.deps, db, x.input.conversationId).some(
			(current) =>
				current.replyId === offer.replyId &&
				current.card.revisionId === card.revisionId,
		)
	)
		return null;
	return [...new Set([offer.replyId, ...offer.sources.map((s) => s.id)])];
}

/* Delegations: the announced hand-over to a session, and an assignment to the agent (spec toolchain-assignment-stage2-implementation-2026-11-25.md section 2.4). */
/**
 * The announcement is saved and delivered before the conversation is handed to the session; the handover commits
 * only after the delivery (in full, or cut short by the user), with every authority checked again. Committing it
 * is this generation's adoption: its receipt is accepted and the memory it read is recorded there.
 */
async function handOver(
	x: ExecutorContext,
	call: ParsedCall,
	chosen: Request,
	signal: AbortSignal,
): Promise<ToolOutcome> {
	const { deps, events, at, current, acted, handle, origin } = x;
	const { store, toolchains } = deps;
	const target = `delegate:${chosen.card.id}`;
	const announcement = systemContext(
		"dialogue.contexts.local.router-announce",
		{
			title: lineText(chosen.card.title).slice(0, 30),
		},
	);
	const available = store.read((db) => {
		try {
			toolchains!.resolveInTransaction(db, chosen.card.revisionId);
			return true;
		} catch {
			return false;
		}
	});
	if (!available)
		return { result: { delegated: false, code: "toolchain_unavailable" } };
	const { run, said } = await store.write((tx) => {
		const run = current(tx);
		saveAnnouncement(
			tx,
			run.id,
			run.revision,
			`${run.revision}:${call.call.id}`,
			announcement,
		);
		handle(tx);
		const { event } = events.appendInTransaction(tx, {
			conversationId: run.conversationId,
			at: at(),
			type: "said",
			by: "agent",
			fields: { text: announcement, origin: "announcement" },
			messageIds: origin,
			dedupeKey: `announcement:${run.id}:${run.revision}`,
			deliveryKey: `announcement:${run.id}:${run.revision}`,
		});
		return { run, said: event };
	});
	x.publish();
	const delivered = (heard: "full" | "partial" | "none") =>
		store.write((tx) => {
			const { created } = events.appendInTransaction(tx, {
				conversationId: run.conversationId,
				at: at(),
				type: "delivered",
				by: "host",
				fields: {
					ref: said.id,
					heard,
					...(deps.externalOutput?.owns(tx, run.id)
						? { channel: "screen" }
						: {}),
				},
				dedupeKey: `delivered:${said.id}`,
			});
			// The announcement reached the user: it is the agent's utterance of the conversation's input.
			if (created && heard !== "none" && !deps.externalOutput?.owns(tx, run.id))
				recordUtteranceInTransaction(deps, tx, {
					conversationId: run.conversationId,
					speaker: "agent",
					text: announcement,
					// The words it was asked by: forgetting them takes the announcement out too.
					messageId: run.inputMessageId,
					at: deps.clock(),
				});
		});
	// A spoken announcement is delivered before the session takes over; one that failed hands nothing over.
	let heard: "full" | "partial" = "full";
	if (
		deps.externalOutput &&
		store.read((tx) => deps.externalOutput!.owns(tx, run.id))
	) {
		heard = await deps.externalOutput.announce(run, announcement, signal);
	} else if (run.utteranceId) {
		if (!deps.deliverAnnouncement)
			throw new Error("announcement_delivery_unavailable");
		try {
			heard = await deps.deliverAnnouncement(run, signal);
		} catch (error) {
			await delivered("none").catch(() => undefined);
			throw error;
		}
	}
	signal.throwIfAborted();
	await delivered(heard);
	try {
		await store.write((tx) => {
			signal.throwIfAborted();
			const run = current(tx);
			if (
				chosen.diagnosticRef &&
				!verifiedDiagnostic(
					deps,
					tx,
					run.conversationId,
					chosen.diagnosticRef,
					run.id,
				)
			)
				throw new HandoverRefused("diagnostic_evidence_changed");
			const sources = offerEvidence(x, tx, chosen.card);
			if (!sources) throw new HandoverRefused("toolchain_unavailable");
			adoptHere(x, tx, run);
			const started = startSpecialistSession(deps, tx, run, {
				revisionId: chosen.card.revisionId,
				request: chosen.request,
				references: chosen.references ?? [],
				...(chosen.target ? { target: chosen.target } : {}),
				...(chosen.resolveUnsaved
					? { resolveUnsaved: chosen.resolveUnsaved }
					: {}),
			});
			// A refused start rolls everything of this step back; the model is told why.
			if (!started.ok) throw new HandoverRefused(started.code);
			transition(tx, run.id, run.revision, "queued", deps.clock());
			// The resources handed over were used now: they move to the top of the state's list.
			touchRefs(x, tx, run, chosen);
			acted(tx, target, {
				action: "delegate",
				toolchain: chosen.card.id,
				request: eventText(deps, chosen.request),
				session: true,
			});
			recordChoice(x, tx, run, chosen);
			// The announcement reached the user before this commit: the turn's calls join it here.
			saveLatestSearch(
				tx,
				run.id,
				run.inputMessageId,
				lastShownSearch(x.state.exchange),
			);
			deps.conversation.input.attachToolCallsInTransaction(tx, {
				conversationId: run.conversationId,
				messageId: run.inputMessageId,
				toolCalls: carriedToolCalls([
					...x.state.exchange,
					{
						name: call.name,
						arguments: call.call.arguments,
						result: { delegated: true },
					},
				]),
			});
		});
	} catch (error) {
		if (error instanceof HandoverRefused)
			return { result: { delegated: false, code: error.code } };
		throw error;
	}
	x.state.handover = { announcement };
	return { result: { delegated: true }, end: true };
}

/** The resources handed over with a request were used now: they move to the top of the state's list. */
function touchRefs(
	x: ExecutorContext,
	tx: Database,
	run: { conversationId: string },
	chosen: Request,
) {
	const { deps } = x;
	for (const uri of chosen.refUris ?? []) {
		const used = deps.resourceLedger?.byUriInTransaction(
			tx,
			run.conversationId,
			uri,
		);
		if (used) deps.resourceLedger!.touchInTransaction(tx, used.id);
	}
}

/** What `delegate` carries besides the request and its references: handed to the agent as the assignment's details. */
function detailsOf(chosen: Request): AssignmentDetails | undefined {
	const details: AssignmentDetails = {
		...(chosen.inputs ? { inputs: chosen.inputs } : {}),
		...(chosen.target ? { target: chosen.target } : {}),
		...(chosen.diagnosticRef ? { diagnosticRef: chosen.diagnosticRef } : {}),
		...(chosen.resolveUnsaved ? { resolveUnsaved: chosen.resolveUnsaved } : {}),
		...(chosen.routedSteps ? { routedSteps: [...chosen.routedSteps] } : {}),
	};
	return Object.keys(details).length ? details : undefined;
}

/**
 * Hands the work to the agent as its assignment, as `start_preparation` hands a research: the agent holds it (its
 * status, the assignee's question, its result as a note) and tells the user when it is done. No announcement and no
 * confirmation: the reply says what it took from this tool's result.
 */
async function assignTo(
	x: ExecutorContext,
	chosen: Request,
): Promise<ToolOutcome> {
	const { deps, current, acted, actionKey } = x;
	const { store } = deps;
	const title = chosen.card.title;
	const prepared = store.read((db) => {
		const run = current(db);
		const source = executionSourceInTransaction(deps, db, run.id);
		return source ? { run, source } : null;
	});
	if (!prepared) return { result: { delegated: false, code: "not_from_user" } };
	const { conversationId, messageId, runId, request, digest } = prepared.source;
	const details = detailsOf(chosen);
	let assigned: string;
	try {
		assigned = await store.write((tx) => {
			const run = current(tx);
			touchRefs(x, tx, run, chosen);
			recordChoice(x, tx, run, chosen);
			const adapterRef = deps
				.toolchains!.catalogInTransaction(tx)
				.find((e) => e.revisionId === chosen.card.revisionId)?.runtime
				.binding?.adapterRef;
			// Everything that can throw comes first: `assign` changes the agent's memory outside this transaction, so it
			// is the last statement and nothing after it may fail (a refusal throws and rolls the rest back).
			acted(tx, actionKey(`delegate:${chosen.card.id}`), {
				action: "delegate",
				toolchain: chosen.card.id,
				request: eventText(deps, chosen.request),
			});
			const outcome = deps.agency!.assign!({
				toolchainId: chosen.card.id,
				revisionId: chosen.card.revisionId,
				title,
				request: chosen.request,
				references: chosen.references ?? [],
				source: { conversationId, messageId, runId, request, digest },
				...(details ? { details } : {}),
				...(adapterRef ? { adapterRef } : {}),
			});
			if (outcome.status === "refused")
				throw new AssignmentRefused(outcome.code, outcome.id);
			return outcome.id;
		});
	} catch (error) {
		// A duplicate names the assignment that does it already: the reply says so instead of asking again.
		if (error instanceof AssignmentRefused)
			return {
				result: {
					delegated: false,
					code: error.code,
					...(error.id ? { assignment: error.id } : {}),
				},
			};
		throw error;
	}
	// The run's trace keeps this choice when the generation ends (it is not an answer without a hand-over).
	x.state.assigned = { card: chosen.card, request: chosen.request };
	return {
		result: {
			delegated: true,
			assignment: assigned,
			assignee: title,
			next: "状態の assignments に出る。担当の質問はそこに出て、終わると作業報告のメモで届く（あなたから知らせる）",
		},
	};
}

class AssignmentRefused extends Error {
	constructor(
		readonly code: string,
		readonly id?: string,
	) {
		super(code);
	}
}

/** The choice of this toolchain among the candidates the search showed: the search learns from it. */
function recordChoice(
	x: ExecutorContext,
	tx: Database,
	run: {
		id: string;
		conversationId: string;
		utteranceId?: string | null;
		requestId?: string | null;
	},
	chosen: Request,
) {
	x.deps.toolchains!.recordSelectionInTransaction(tx, {
		runId: run.id,
		conversationId: run.conversationId,
		utteranceId: run.utteranceId ?? null,
		requestId: run.requestId ?? null,
		retrieval: x.state.search?.route.retrieval ?? "none",
		candidates: (x.state.search?.route.cards ?? []).map((card) => ({
			toolchainId: card.id,
			revisionId: card.revisionId,
			functionName: card.functionName,
			...card.score,
		})),
		historyRefs:
			x.state.search?.route.past.map((past) => past.selectionId) ?? [],
		decision: "toolchain",
		toolchainId: chosen.card.id,
		toolchainRevisionId: chosen.card.revisionId,
		functionName: chosen.card.functionName,
		request: chosen.request,
		...(x.state.search?.query ? { query: x.state.search.query } : {}),
	});
}

/**
 * One hand-over of work to a toolchain (the toolchain assignment design, section 2.4): an instant one answers at
 * once, a session takes the conversation over after the host's announcement, and anything else is the agent's own
 * assignment, with no confirmation. Without an agency that serves the conversation's replies there is no one to give
 * the work to: `agency_unavailable`.
 */
export async function delegate(
	x: ExecutorContext,
	call: ParsedCall,
	args: DelegateArgs,
	signal: AbortSignal,
	routedSteps?: readonly RoutedPipelineStep[],
): Promise<ToolOutcome> {
	const { deps, offered } = x;
	const { store, toolchains } = deps;
	if (!toolchains)
		return { result: { delegated: false, code: "toolchain_unavailable" } };
	// A host-written prompt (a schedule, a notice) acts for no one present: it starts no work.
	if (store.read((db) => isSystemPrompt(x.current(db).sourceKind)))
		return { result: { delegated: false, code: "not_from_user" } };
	const card = offered.get(args.toolchain);
	if (!card)
		throw toolRejection("toolchain_not_offered", [
			{
				tool: TOOL_NAMES.delegate,
				path: "toolchain",
				reason: "toolchain_not_offered",
			},
		]);
	if (!store.read((db) => offerEvidence(x, db, card)))
		return { result: { delegated: false, code: "toolchain_unavailable" } };
	if (card.instant) return instant(x, call, card, args.inputs, signal);
	// The request text is what the toolchain works from; an instant one needed only its inputs.
	const request = args.request;
	if (!request) throw requestRequired();
	if (args.diagnosticRef && card.id !== REPAIR_TOOLCHAIN)
		return {
			result: { delegated: false, code: "diagnostic_ref_not_supported" },
		};
	const { diagnosticRef: _reserved, ...inputs } = args.inputs ?? {};
	const { uris, references } = await resolveDelegateRefs(
		deps,
		x.input.conversationId,
		args.refs,
		signal,
	);
	const chosen: Request = {
		card,
		request,
		...(routedSteps ? { routedSteps } : {}),
		...(uris.length ? { references, refUris: uris } : {}),
		...(args.inputs ? { inputs } : {}),
		...(args.diagnosticRef ? { diagnosticRef: args.diagnosticRef } : {}),
		...(args.target ? { target: args.target } : {}),
		...(args.resolveUnsaved ? { resolveUnsaved: args.resolveUnsaved } : {}),
	};
	if (card.execution === "session") return handOver(x, call, chosen, signal);
	const served =
		!!deps.agency?.assign &&
		store.read((db) =>
			deps.agency!.servesRepliesInTransaction?.(db, x.input.conversationId),
		);
	if (!served)
		return { result: { delegated: false, code: "agency_unavailable" } };
	return assignTo(x, chosen);
}
