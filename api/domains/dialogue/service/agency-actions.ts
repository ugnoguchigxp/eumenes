import type { Database } from "bun:sqlite";
import { hash } from "../../capabilities";
import type { AgentRuntime } from "../../agent-runtime";
import type {
	ExecutionReference,
	ToolchainExecutionPort,
} from "../../tool-runtime";
import type { ResourceRegistry } from "../../resources";
import type { QueueService } from "../../queue";
import { canonicalJson } from "../../../infrastructure/digest";
import { executionNoticeResult } from "../../tool-runtime";
import type { ToolchainRoutingPort } from "../contracts/toolchains";
import {
	agencyWork,
	agencyWorks,
	agencyRecords,
	insertAgencyWork,
	authorizeAgencyAction,
	autonomousActionSource,
	linkAgencyExecution,
	claimAgencyDispatch,
} from "../repository/agency";
import { agencyActionWork, eraseAgencyActionWork } from "./agency-action-work";
import {
	type AssignmentDetails,
	type AssignmentSource,
	isAgendaSnapshot,
	agendaTicketInput,
	type AgendaHostSnapshot,
} from "../contracts/agency-always-on";

export type AgencyActionDeps = {
	agents?: AgentRuntime;
	toolchains?: ToolchainRoutingPort;
	execution?: () => ToolchainExecutionPort | undefined;
	/** Host policy input; dialogue does not depend on the settings domain. */
	settings?: {
		inTransaction(db: Database): {
			agency: {
				actions?: {
					enabled: boolean;
					maxConcurrent: number;
					dailyLimit: number;
				};
			};
		};
	};
	resources?: ResourceRegistry;
	producesInTransaction?(db: Database, toolchainId: string): string[];
	memory?: Pick<import("../../memory").MemoryService, "referenceInputs">;
	/** Aborts the jobs a stop cancelled (the owner cancels them in the stop's transaction; LARM is told on abort). */
	queue?: Pick<QueueService, "list" | "flushCancellations">;
	now(): number;
};
export function createAgencyActions(deps: AgencyActionDeps) {
	const digest = (value: unknown) =>
		hash(canonicalJson(value, { keyOrder: "codeUnit", omitUndefined: true }));
	const work = agencyActionWork(deps.resources, deps.now);
	const limits = (db: Database) =>
		deps.settings?.inTransaction(db).agency.actions ?? {
			enabled: true,
			maxConcurrent: 1,
			dailyLimit: 3,
		};
	function catalog(db: Database) {
		const port = deps.execution?.();
		return port
			? (deps.toolchains?.catalogInTransaction(db) ?? []).flatMap((entry) => {
					if (entry.selectable === false) return [];
					const card = deps.toolchains!.cardInTransaction(db, entry.revisionId);
					if (!card) return [];
					const policy = port.autonomyInTransaction?.(db, entry.revisionId);
					return [
						{
							revisionId: card.revisionId,
							title: card.title,
							description: card.summary,
							requiresApproval: !limits(db).enabled || !policy?.automatic,
							reason: policy?.reason ?? "capability_unavailable",
							effect: policy?.effect ?? null,
							...(card.instant
								? { argumentsSchema: card.instant.parameters }
								: {}),
						},
					];
				})
			: [];
	}
	return {
		available: () => !!deps.execution?.(),
		catalog,
		start(
			db: Database,
			input: {
				rootId: string;
				conversationId: string;
				epoch: number;
				ticketId: string;
				intentId?: string;
				candidateId?: string;
				question: string;
				revisionId: string;
				deadline: number;
				outboundIntervalMs: number;
				sourceRefs: readonly string[];
				arguments?: Record<string, unknown>;
				/** Work the user asked for (`delegate`): the user's request is its authority, not the agency's budget. */
				assignment?: boolean;
				references?: readonly ExecutionReference[];
				/** An assignment's user-message source: the toolchain takes the work as the user's. */
				source?: AssignmentSource;
				/** An assignment's other `delegate` fields, as they were given. */
				details?: AssignmentDetails;
			},
		) {
			const port = deps.execution?.();
			if (!port || !deps.agents)
				throw new Error("agency_execution_unavailable");
			const existing = agencyWork(db, input.rootId);
			if (existing) {
				if (existing.revoked || !existing.execution_id)
					throw new Error("agency_origin_stale");
				if (
					!existing.authority_json ||
					JSON.parse(existing.authority_json).inputDigest !== digest(input)
				)
					throw new Error("request_conflict");
				return existing.execution_id;
			}
			const card = catalog(db).find((c) => c.revisionId === input.revisionId);
			if (!card || (card.requiresApproval && !input.assignment))
				throw new Error("agency_approval_required");
			const policy = limits(db);
			const now = deps.now();
			const record = agencyRecords(db).find(
				(r) =>
					r.conversationId === input.conversationId && r.epoch === input.epoch,
			);
			if (!record || input.deadline <= now)
				throw new Error("agency_origin_stale");
			const snapshot =
				record.snapshot as import("eumenes-agency").AgencySnapshot;
			const agenda = isAgendaSnapshot(record.snapshot) ? record.snapshot : null;
			if (agenda) assertAgendaTicket(agenda, input);
			const active = agencyWorks(db, input.conversationId).filter(
				(w) => !!w.execution_id,
			);
			const dayStart =
				Math.floor((now + 9 * 3_600_000) / 86_400_000) * 86_400_000 -
				9 * 3_600_000;
			const daily = (
				db
					.query(
						"SELECT COUNT(*) AS n FROM dialogue_agency_work WHERE conversation_id=? AND created_at>=?",
					)
					.get(input.conversationId, dayStart) as { n: number }
			).n;
			// The agenda's own research is the agent's to pace (it keeps one at a time, and the user sets no
			// budget on the agency's thinking): the count limits apply only to a record that is not an agenda. Approval stays.
			if (
				(!policy.enabled && !input.assignment) ||
				(!agenda &&
					(active.length >= policy.maxConcurrent || daily >= policy.dailyLimit))
			)
				throw new Error("agency_action_budget");
			const ticket = snapshot.continuity?.issued.find(
				(t) => t.id === input.ticketId,
			);
			if (
				!agenda &&
				(!ticket ||
					ticket.action !== "tool" ||
					ticket.toolName !== "delegate" ||
					ticket.candidateId !== input.candidateId ||
					digest(JSON.parse(ticket.toolInput!)) !==
						digest({
							revisionId: input.revisionId,
							question: input.question,
							...(input.arguments ? { arguments: input.arguments } : {}),
						}))
			)
				throw new Error("agency_origin_stale");
			if (
				!claimAgencyDispatch(
					db,
					input.conversationId,
					input.epoch,
					now,
					input.outboundIntervalMs,
				)
			)
				throw new Error("agency_dispatch_interval");
			insertAgencyWork(db, {
				root_id: input.rootId,
				conversation_id: input.conversationId,
				epoch: input.epoch,
				ticket_id: input.ticketId,
				// Legacy columns are deliberately empty: a preparation has no invented F intent/candidate.
				intent_id: input.intentId ?? "",
				candidate_id: input.candidateId ?? "",
				question: input.question,
				toolchain_revision_id: input.revisionId,
				deadline: input.deadline,
				source_refs_json: JSON.stringify(input.sourceRefs),
			});
			authorizeAgencyAction(
				db,
				input.rootId,
				{
					settingsDigest: record.settingsDigest,
					inputDigest: digest(input),
					policyDigest: hash({
						version: 1,
						input,
						policy,
						settingsDigest: record.settingsDigest,
					}),
				},
				now,
			);
			// The agency's work is checked as its own (the authority above); an assignment runs as the user's words.
			const own = autonomousActionSource(db, input.rootId, now);
			if (!own) throw new Error("agency_origin_stale");
			// An assignment runs as the user's words, in the shape the conversation issues it (owners digest the source
			// as it is laid out, so the field order is the conversation's).
			const source =
				input.assignment && input.source
					? {
							conversationId: input.source.conversationId,
							messageId: input.source.messageId,
							runId: input.source.runId,
							request: input.source.request,
							digest: input.source.digest,
						}
					: own;
			if (input.assignment && !input.source)
				throw new Error("agency_origin_stale");
			const provenance = agenda
				? agendaTicketInput(agenda, input.ticketId)
				: (
						record.snapshot as import("eumenes-agency").AgencySnapshot
					).provenance?.entries.find(
						([key]) => key === `attempt:${input.ticketId}`,
					)?.[1];
			if (deps.settings && deps.memory && !provenance)
				throw new Error("agency_origin_stale");
			if (provenance)
				deps.memory?.referenceInputs.recordRunInTransaction(
					db,
					input.rootId,
					provenance,
				);
			const entry = deps
				.toolchains!.catalogInTransaction(db)
				.find((e) => e.revisionId === input.revisionId)!;
			const owner =
				entry.runtime.execution === "task"
					? deps.toolchains!.taskInTransaction?.(db, input.revisionId)
					: undefined;
			const references = [...(input.references ?? [])];
			const view = owner
				? owner.startInTransaction(db, {
						source,
						request: input.question,
						references,
						toolchainRevisionId: input.revisionId,
						bindingRevisionId: entry.runtime.binding?.bindingRevisionId,
						deadline: input.deadline,
					})
				: entry.runtime.execution === "pipeline"
					? deps.agents.executions.startPipelineInTransaction(db, {
							source,
							toolchainRevisionId: input.revisionId,
							deadline: input.deadline,
							references,
							...(input.details?.routedSteps
								? { routedSteps: input.details.routedSteps }
								: {}),
							startKey: input.rootId,
						})
					: deps.agents.executions.startSelectedInTransaction(db, {
							source,
							chainRevisionId: input.revisionId,
							request: input.question,
							arguments: input.arguments,
							references,
							deadline: input.deadline,
							startKey: input.rootId,
						});
			linkAgencyExecution(db, input.rootId, view.id);
			return view.id;
		},
		result(db: Database, root: string) {
			const w = agencyWork(db, root);
			if (!w?.execution_id) return null;
			const owner = deps.toolchains?.taskInTransaction?.(
				db,
				w.toolchain_revision_id,
			);
			const view = owner
				? owner.viewInTransaction(db, w.execution_id)
				: deps.agents?.executions.viewInTransaction(db, w.execution_id);
			if (!view) return null;
			if (view.result && deps.resources) {
				const card = deps.toolchains?.cardInTransaction(
					db,
					w.toolchain_revision_id,
				);
				const links = (
					card ? (deps.producesInTransaction?.(db, card.id) ?? []) : []
				)
					.flatMap(
						(kind) =>
							deps
								.resources!.adapter(kind)
								?.fromResultInTransaction(
									db,
									executionNoticeResult(view.result),
									{ conversationId: w.conversation_id, runId: root },
								) ?? [],
					)
					.map((ref) => ref.uri);
				view.result.links = [
					...new Set([...(view.result.links ?? []), ...links]),
				];
			}
			return view;
		},
		cancel(db: Database, root: string) {
			const w = agencyWork(db, root);
			if (w?.execution_id) {
				stopAgencyExecution(deps, db, w, false);
				const view = this.result(db, root);
				if (view?.status === "cancelled" || view?.status === "interrupted")
					work.sync(db, view, root);
			}
		},
		discard(db: Database, root: string) {
			const w = agencyWork(db, root);
			if (!w?.execution_id) return;
			eraseAgencyActionWork(db, w, deps.now());
			stopAgencyExecution(deps, db, w, true);
		},
		control: (
			db: Database,
			root: string,
			input: AssignmentControl,
			messageId: string,
		) => controlAgencyAssignment(deps, db, root, input, messageId),
		synchronize: work.sync,
		link: work.link,
	};
}

type AssignmentControl = {
	action: "answer" | "amend";
	text: string;
	/** The question the user answered, as the agent showed it: an answer never goes to another one. */
	question?: string | null;
};

/**
 * Answers or amends an assignment through its owner's control, as the user's words of `messageId` (the owner checks
 * the conversation and the revision). A task owner takes it; other work goes to the selected-execution control, which
 * refuses what a fixed run cannot take (an amendment).
 */
function controlAgencyAssignment(
	deps: Pick<AgencyActionDeps, "agents" | "toolchains">,
	db: Database,
	root: string,
	input: AssignmentControl,
	messageId: string,
) {
	const w = agencyWork(db, root);
	const owner = w
		? deps.toolchains?.taskInTransaction?.(db, w.toolchain_revision_id)
		: undefined;
	const view = w?.execution_id
		? owner
			? owner.viewInTransaction(db, w.execution_id)
			: deps.agents?.executions.viewInTransaction(db, w.execution_id)
		: null;
	if (!w || !view || (!owner && !deps.agents))
		throw new Error("control_unsupported");
	if (
		input.action === "answer" &&
		(!view.question || view.question.prompt !== input.question)
	)
		throw new Error("question_changed");
	// A question that asks for a structured answer (its input schema is not a plain string) takes the text as JSON; an
	// answer that is not JSON is refused with the shape it needs, so the agent can answer again.
	const schema = view.question?.inputSchema;
	let answer: unknown = input.text;
	if (input.action === "answer" && schema && schema.type !== "string") {
		try {
			answer = JSON.parse(input.text);
		} catch {
			throw new AssignmentAnswerInvalid(schema);
		}
	}
	const control = {
		workRef: view.id,
		expectedRevision: view.revision,
		action: input.action,
		...(input.action === "answer"
			? {
					input: answer,
					...(view.question ? { questionRef: view.question.id } : {}),
				}
			: { request: input.text }),
	};
	try {
		return owner
			? owner.controlInTransaction(db, w.conversation_id, control, messageId)
			: deps.agents!.executions.controlInTransaction(
					db,
					w.conversation_id,
					control,
					messageId,
				);
	} catch (error) {
		// An answer of the wrong shape is told the shape it needs, so it can be answered again.
		if (
			schema &&
			error instanceof Error &&
			error.message === "invalid_answer" &&
			!(error instanceof AssignmentAnswerInvalid)
		)
			throw new AssignmentAnswerInvalid(schema);
		throw error;
	}
}

/** An answer the question cannot take: `inputSchema` is the shape it asks for. */
export class AssignmentAnswerInvalid extends Error {
	constructor(readonly inputSchema: Record<string, unknown>) {
		super("invalid_answer");
	}
}

/**
 * Stops the executions a work holds, and aborts the jobs that stop cancelled once it commits: an owner marks its
 * running job cancelled inside the transaction, but only an abort reaches the provider (LARM's DELETE). A stop that
 * rolls back left no job cancelled, so the flush finds nothing to abort.
 */
export function stopAgencyExecution(
	deps: Pick<AgencyActionDeps, "agents" | "toolchains" | "queue">,
	db: Database,
	work: import("../repository/agency").AgencyWorkRow,
	forget: boolean,
) {
	if (!work.execution_id) return;
	const queue = deps.queue;
	if (queue) queueMicrotask(() => flushCancelledJobs(queue));
	const owner = deps.toolchains?.taskInTransaction?.(
		db,
		work.toolchain_revision_id,
	);
	if (owner) {
		owner.cancelInTransaction?.(db, work.conversation_id, work.execution_id);
		if (forget) owner.forgetInTransaction?.(db, work.execution_id);
	} else if (forget)
		deps.agents?.executions.forgetInTransaction(db, work.execution_id);
	else
		deps.agents?.executions.cancelByUserInTransaction(
			db,
			work.conversation_id,
			work.execution_id,
		);
}

function flushCancelledJobs(queue: NonNullable<AgencyActionDeps["queue"]>) {
	try {
		const jobs = queue
			.list({ state: "cancel_requested" }, null, 100)
			.items.map((job) => job.id);
		if (jobs.length) queue.flushCancellations(jobs);
	} catch {
		// The abort is best effort: the job is cancelled in the queue, the runner stops it at its next check.
	}
}

/** The work must be the research ticket the host saved before it started; nothing else authorizes it. */
function assertAgendaTicket(
	agenda: AgendaHostSnapshot,
	input: {
		ticketId: string;
		revisionId: string;
		question: string;
		arguments?: Record<string, unknown>;
		sourceRefs: readonly string[];
		assignment?: boolean;
		references?: readonly ExecutionReference[];
		details?: AssignmentDetails;
	},
) {
	const digest = (value: unknown) =>
		hash(canonicalJson(value, { keyOrder: "codeUnit", omitUndefined: true }));
	const own = agenda.tickets.find((t) => t.id === input.ticketId);
	if (
		!own ||
		own.revisionId !== input.revisionId ||
		own.question !== input.question ||
		!!own.assignment !== !!input.assignment ||
		digest(own.references ?? []) !== digest(input.references ?? []) ||
		digest(own.details ?? {}) !== digest(input.details ?? {}) ||
		input.arguments !== undefined ||
		digest([...own.inputs].sort()) !== digest([...input.sourceRefs].sort())
	)
		throw new Error("agency_origin_stale");
}
