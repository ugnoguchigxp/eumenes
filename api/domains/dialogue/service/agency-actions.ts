import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { hash } from "../../capabilities";
import type { AgentRuntime } from "../../agent-runtime";
import type { ToolchainExecutionPort } from "../../tool-runtime";
import type { ResourceRegistry } from "../../resources";
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
	isAgendaSnapshot,
	agendaTicketInput,
	type AgendaHostSnapshot,
} from "../contracts/agency-always-on";

export type AgencyActionDeps = {
	agents?: AgentRuntime;
	toolchains?: ToolchainRoutingPort;
	execution?: () => ToolchainExecutionPort | undefined;
	store?: Pick<SqliteStore, "read">;
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
			general: unknown;
		};
	};
	resources?: ResourceRegistry;
	producesInTransaction?(db: Database, toolchainId: string): string[];
	memory?: Pick<import("../../memory").MemoryService, "referenceInputs">;
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
		async find(query: string, signal: AbortSignal) {
			if (!deps.toolchains || !deps.store)
				throw new Error("agency_catalog_unavailable");
			const vector = await deps.toolchains.embedQuery(query, signal);
			if (!vector) throw new Error("embedding_unavailable");
			return deps.store.read((db) => {
				const offered = deps.toolchains!.routeInTransaction(db, {
					runId: "agency-catalog",
					text: query,
					query: vector,
					strict: true,
					available: new Set(
						deps.toolchains!.catalogInTransaction(db).map((e) => e.id),
					),
				}).cards;
				const ids = new Set(offered.map((card) => card.revisionId));
				return catalog(db).filter((card) => ids.has(card.revisionId));
			});
		},
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
			if (!card || card.requiresApproval)
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
			// budget on the agency's thinking): the count limits are for the F host's actions. Approval stays.
			if (
				!policy.enabled ||
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
					...(deps.settings
						? {
								settingsStateDigest: hash({
									agency: deps.settings.inTransaction(db).agency,
									general: deps.settings.inTransaction(db).general,
								}),
							}
						: {}),
					policyDigest: hash({
						version: 1,
						input,
						policy,
						settingsDigest: record.settingsDigest,
					}),
				},
				now,
			);
			const source = autonomousActionSource(db, input.rootId, now);
			if (!source) throw new Error("agency_origin_stale");
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
			const view = owner
				? owner.startInTransaction(db, {
						source,
						request: input.question,
						references: [],
						toolchainRevisionId: input.revisionId,
						bindingRevisionId: entry.runtime.binding?.bindingRevisionId,
						deadline: input.deadline,
					})
				: entry.runtime.execution === "pipeline"
					? deps.agents.executions.startPipelineInTransaction(db, {
							source,
							toolchainRevisionId: input.revisionId,
							deadline: input.deadline,
						})
					: deps.agents.executions.startSelectedInTransaction(db, {
							source,
							chainRevisionId: input.revisionId,
							request: input.question,
							arguments: input.arguments,
							references: [],
							deadline: input.deadline,
						});
			linkAgencyExecution(db, input.rootId, view.id);
			work.start(db, agencyWork(db, input.rootId)!, view, {
				id: deps.toolchains!.cardInTransaction(db, input.revisionId)!.id,
				title: card.title,
			});
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
					work.sync(db, view);
			}
		},
		discard(db: Database, root: string) {
			const w = agencyWork(db, root);
			if (!w?.execution_id) return;
			eraseAgencyActionWork(db, w.execution_id, deps.now());
			stopAgencyExecution(deps, db, w, true);
		},
		synchronize: work.sync,
		link: work.link,
	};
}

export function stopAgencyExecution(
	deps: Pick<AgencyActionDeps, "agents" | "toolchains">,
	db: Database,
	work: import("../repository/agency").AgencyWorkRow,
	forget: boolean,
) {
	if (!work.execution_id) return;
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

/** The work must be the research ticket the host saved before it started; nothing else authorizes it. */
function assertAgendaTicket(
	agenda: AgendaHostSnapshot,
	input: {
		ticketId: string;
		revisionId: string;
		question: string;
		arguments?: Record<string, unknown>;
		sourceRefs: readonly string[];
	},
) {
	const digest = (value: unknown) =>
		hash(canonicalJson(value, { keyOrder: "codeUnit", omitUndefined: true }));
	const own = agenda.tickets.find((t) => t.id === input.ticketId);
	if (
		!own ||
		own.revisionId !== input.revisionId ||
		own.question !== input.question ||
		input.arguments !== undefined ||
		digest([...own.inputs].sort()) !== digest([...input.sourceRefs].sort())
	)
		throw new Error("agency_origin_stale");
}
