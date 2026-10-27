import type { Database } from "bun:sqlite";
import { carriedToolCalls } from "./tool-exchange";
import { recordUtteranceInTransaction } from "./utterances";
import { isSystemPrompt } from "../contracts";
import { saveAnnouncement } from "../repository";
import {
	confirmationResourceUris,
	saveConfirmationRefs,
} from "../repository/resources";
import { referencesOfUris, resolveDelegateRefs } from "./delegate-refs";
import type { ToolOutcome } from "./generation-loop";
import {
	TOOL_NAMES,
	toolRejection,
	type DelegateArgs,
	type ParsedCall,
} from "./generation-tools";
import { eventText } from "./event-text";
import { dispatchInTransaction } from "./work-dispatch";

import { instant } from "./executor-search";
import {
	HandoverRefused,
	IMPACT_ORDER,
	acceptHere,
	adoptHere,
	type ExecutorContext,
	type Request,
} from "./executor-context";

/* Delegations: the announced handover, the confirmation before a change and its approval (sections 6.5, 6.7). */
/**
 * The announcement is saved and delivered before the work is handed over (section 6.5); the handover commits
 * only after the delivery (in full, or cut short by the user), with every authority checked again. Committing it
 * is this generation's adoption: its receipt is accepted and the memory it read is recorded there.
 */
export async function handOver(
	x: ExecutorContext,
	call: ParsedCall,
	chosen: Request,
	signal: AbortSignal,
): Promise<ToolOutcome> {
	const { deps, events, at, current, acted, handle, origin, actionKey } = x;
	const { store, toolchains } = deps;
	const target = `delegate:${chosen.card.id}`;
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
			chosen.announcement,
		);
		handle(tx);
		const { event } = events.appendInTransaction(tx, {
			conversationId: run.conversationId,
			at: at(),
			type: "said",
			by: "agent",
			fields: { text: chosen.announcement, origin: "announcement" },
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
				fields: { ref: said.id, heard },
				dedupeKey: `delivered:${said.id}`,
			});
			// The announcement reached the user: it is the agent's utterance of the conversation's input.
			if (created && heard !== "none")
				recordUtteranceInTransaction(deps, tx, {
					conversationId: run.conversationId,
					speaker: "agent",
					text: chosen.announcement,
					// The words it was asked by: forgetting them takes the announcement out too.
					messageId: run.inputMessageId,
					at: deps.clock(),
				});
		});
	// A spoken announcement is delivered before the work is handed over; one that failed hands nothing over.
	let heard: "full" | "partial" = "full";
	if (run.utteranceId) {
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
	let committed: { handed: boolean; workId: string | null };
	try {
		committed = await store.write((tx) => {
			const run = current(tx);
			adoptHere(x, tx, run);
			if (
				chosen.confirmationId &&
				!deps.work!.useConfirmationInTransaction(tx, chosen.confirmationId)
			)
				throw new Error("confirmation_used");
			const dispatched = dispatchInTransaction(deps, tx, {
				jobId: x.jobId,
				run,
				card: chosen.card,
				request: chosen.request,
				...(chosen.target ? { target: chosen.target } : {}),
				...(chosen.resolveUnsaved
					? { resolveUnsaved: chosen.resolveUnsaved }
					: {}),
				...(chosen.inputs ? { inputs: chosen.inputs } : {}),
				references: chosen.references ?? [],
			});
			// A refused dispatch rolls everything of this step back; the model is told why.
			if (!dispatched.ok) throw new HandoverRefused(dispatched.code);
			acceptHere(x, tx, dispatched);
			// The resources handed over were used now: they move to the top of the state's list.
			for (const uri of chosen.refUris ?? []) {
				const used = deps.resourceLedger?.byUriInTransaction(
					tx,
					run.conversationId,
					uri,
				);
				if (used) deps.resourceLedger!.touchInTransaction(tx, used.id);
			}
			const work = dispatched.session
				? null
				: deps.work!.startInTransaction(tx, {
						conversationId: run.conversationId,
						runId: run.id,
						card: chosen.card,
						request: chosen.request,
						dedupeKey: actionKey(target),
						messageIds: origin,
						...(dispatched.sourceRef
							? { sourceRef: dispatched.sourceRef }
							: {}),
					}).row;
			acted(tx, target, {
				action: "delegate",
				toolchain: chosen.card.id,
				request: eventText(deps, chosen.request),
				...(work ? { todo: work.id } : { session: true }),
			});
			toolchains!.recordSelectionInTransaction(tx, {
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
			// The announcement reached the user before this commit: the turn's calls join it here, with the work.
			deps.conversation.input.attachToolCallsInTransaction(tx, {
				conversationId: run.conversationId,
				messageId: run.inputMessageId,
				toolCalls: carriedToolCalls(
					[
						...x.state.exchange,
						{
							name: call.name,
							arguments: call.call.arguments,
							result: {
								delegated: true,
								...(work ? { todo: work.id } : {}),
							},
						},
					],
					deps.work!.refsInTransaction(tx, run.conversationId),
				),
			});
			return { handed: dispatched.handed, workId: work?.id ?? null };
		});
	} catch (error) {
		if (error instanceof HandoverRefused)
			return { result: { delegated: false, code: error.code } };
		throw error;
	}
	x.state.handover = { announcement: chosen.announcement, ...committed };
	return {
		result: {
			delegated: true,
			...(committed.workId ? { todo: committed.workId } : {}),
		},
		end: true,
	};
}

/** A confirmation before a change (section 6.7): saved, never executed; the generation's speech states it. */
export function confirm(
	x: ExecutorContext,
	call: ParsedCall,
	chosen: Omit<Request, "announcement">,
	impact: string,
): Promise<ToolOutcome> {
	const { deps, current, acted, handle, origin } = x;
	const { store } = deps;
	return store.write((tx) => {
		const run = current(tx);
		const row = deps.work!.issueConfirmationInTransaction(
			tx,
			{
				conversationId: run.conversationId,
				toolchainId: chosen.card.id,
				toolchainRevisionId: chosen.card.revisionId,
				request: chosen.request,
				inputs: chosen.inputs ?? null,
				impact,
				statementDeliveryKey: `run:${run.id}`,
			},
			origin,
		);
		// The resources named with the request are handed over as they were when it is approved.
		if (chosen.refUris?.length)
			saveConfirmationRefs(tx, row.id, chosen.refUris);
		handle(tx);
		acted(tx, `confirm:${chosen.card.id}`, {
			action: "confirm",
			confirmation: row.id,
			toolchain: chosen.card.id,
			impact,
		});
		return {
			result: { confirmation: `c${row.ref}` },
			confirmation: true,
		};
	});
}

export async function delegate(
	x: ExecutorContext,
	call: ParsedCall,
	args: DelegateArgs,
	signal: AbortSignal,
): Promise<ToolOutcome> {
	const { deps, offered } = x;
	const { store, toolchains } = deps;
	if (!toolchains || !deps.work)
		return { result: { delegated: false, code: "toolchain_unavailable" } };
	// A host-written prompt (a schedule, a notice) acts for no one present: it starts no work.
	if (store.read((db) => isSystemPrompt(x.current(db).sourceKind)))
		return { result: { delegated: false, code: "not_from_user" } };
	if (args.mode === "approve") {
		const approved = store.read((db) => approval(x, db, args.confirmation));
		if (!approved.ok)
			return { result: { delegated: false, code: approved.code } };
		if (!args.announcement)
			throw toolRejection("announcement_required", [
				{
					tool: TOOL_NAMES.delegate,
					path: "announcement",
					reason: "announcement_required",
				},
			]);
		// The resources named when it was issued must still be there (held in the ledger and at their owner).
		const refs = approved.request.refUris ?? [];
		const references = await referencesOfUris(
			deps,
			x.input.conversationId,
			refs,
			signal,
		);
		if (!references)
			return { result: { delegated: false, code: "resource_unavailable" } };
		return handOver(
			x,
			call,
			{ ...approved.request, references, announcement: args.announcement },
			signal,
		);
	}
	const card = offered.get(args.toolchain);
	if (!card)
		throw toolRejection("toolchain_not_offered", [
			{
				tool: TOOL_NAMES.delegate,
				path: "toolchain",
				reason: "toolchain_not_offered",
			},
		]);
	if (card.instant && args.mode === "execute")
		return instant(x, call, card, args.inputs, signal);
	let inputs = args.inputs;
	if (card.pipeline) {
		const parsed = card.pipeline.parse(args.inputs ?? {}, x.utteranceText());
		if (!parsed.ok)
			throw toolRejection(
				"invalid_tool_arguments",
				parsed.issues.map((issue) => ({
					tool: TOOL_NAMES.delegate,
					path: `inputs.${issue.path}`,
					reason: issue.code,
				})),
			);
		inputs = parsed.value;
	}
	const { uris, references } = await resolveDelegateRefs(
		deps,
		x.input.conversationId,
		args.refs,
		signal,
	);
	const chosen = {
		card,
		request: args.request,
		...(uris.length ? { references, refUris: uris } : {}),
		...(inputs ? { inputs } : {}),
		...(args.target ? { target: args.target } : {}),
		...(args.resolveUnsaved ? { resolveUnsaved: args.resolveUnsaved } : {}),
	};
	// The toolchain's declared least impact raises the conversation's estimate, never lowers it (section 6.7).
	const impact =
		IMPACT_ORDER[
			Math.max(
				IMPACT_ORDER.indexOf(args.impact),
				card.minImpact ? IMPACT_ORDER.indexOf(card.minImpact) : 0,
			)
		]!;
	const needsConfirmation =
		impact === "modify_existing" || impact === "irreversible";
	if (args.mode === "confirm") return confirm(x, call, chosen, impact);
	if (needsConfirmation)
		throw toolRejection("confirmation_required", [
			{
				tool: TOOL_NAMES.delegate,
				path: "mode",
				reason: "confirmation_required",
			},
		]);
	if (!args.announcement)
		throw toolRejection("announcement_required", [
			{
				tool: TOOL_NAMES.delegate,
				path: "announcement",
				reason: "announcement_required",
			},
		]);
	return handOver(
		x,
		call,
		{ ...chosen, announcement: args.announcement },
		signal,
	);
}

/** The structural checks of an approval (section 6.7): the host executes the saved request as it is. */
export function approval(
	x: ExecutorContext,
	db: Database,
	confirmationId: string,
):
	| { ok: true; request: Omit<Request, "announcement"> }
	| { ok: false; code: string } {
	const { deps, input, events } = x;
	const { clock, toolchains } = deps;
	// The model names the confirmation by its number (`c<ref>`, the layout specification's section 6).
	const ref = /^c(\d+)$/.exec(confirmationId);
	const row = ref
		? deps.work!.confirmationByRefInTransaction(
				db,
				input.conversationId,
				Number(ref[1]),
			)
		: null;
	if (!row) return { ok: false, code: "confirmation_not_found" };
	if (row.usedAt) return { ok: false, code: "confirmation_used" };
	if (row.supersededAt) return { ok: false, code: "confirmation_superseded" };
	if (Date.parse(row.expiresAt) <= Date.parse(clock()))
		return { ok: false, code: "confirmation_expired" };
	if (input.final.kind !== "utterances")
		return { ok: false, code: "approval_missing" };
	const statement = events.deliveredUtteranceInTransaction(
		db,
		input.conversationId,
		row.statementDeliveryKey,
	);
	const pending = events.pendingInTransaction(db, input.conversationId);
	if (
		!statement ||
		!pending.some(
			(event) =>
				event.seq > statement.seq &&
				input.final.kind === "utterances" &&
				input.final.seqs.includes(event.seq),
		)
	)
		return { ok: false, code: "approval_before_statement" };
	const heard = events.heardInTransaction(
		db,
		input.conversationId,
		statement.id,
	);
	const enough =
		row.impact === "irreversible"
			? heard === "full"
			: heard === "full" || heard === "partial";
	if (!enough) return { ok: false, code: "confirmation_not_heard" };
	const card = toolchains!.cardInTransaction(db, row.toolchainRevisionId);
	if (!card) return { ok: false, code: "toolchain_unavailable" };
	return {
		ok: true,
		request: {
			card,
			request: row.request,
			...(row.inputs ? { inputs: row.inputs } : {}),
			confirmationId: row.id,
			refUris: confirmationResourceUris(db, row.id),
		},
	};
}
