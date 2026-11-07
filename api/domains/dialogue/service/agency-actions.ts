import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { hash } from "../../capabilities";
import type { AgentRuntime } from "../../agent-runtime";
import type { SettingsService } from "../../settings";
import type { ToolchainExecutionPort } from "../../tool-runtime";
import type { ResourceRegistry } from "../../resources";
import type { ToolchainRoutingPort } from "../contracts/toolchains";
import { agencyWork, agencyWorks, agencyRecords, insertAgencyWork, authorizeAgencyAction, autonomousActionSource, linkAgencyExecution, claimAgencyDispatch } from "../repository/agency";
import { agencyActionWork } from "./agency-action-work";

export type AgencyActionDeps = {
	agents?: AgentRuntime;
	toolchains?: ToolchainRoutingPort;
	execution?: () => ToolchainExecutionPort | undefined;
	store?: Pick<SqliteStore, "read">;
	settings?: Pick<SettingsService, "inTransaction">;
	resources?: ResourceRegistry;
	memory?: Pick<import("../../memory").MemoryService,"referenceInputs">;
	now(): number;
};
export function createAgencyActions(deps: AgencyActionDeps) {
	const work = agencyActionWork(deps.resources, deps.now);
	const limits = (db: Database) => deps.settings?.inTransaction(db).agency.actions ?? { enabled:true, maxConcurrent:1, dailyLimit:3 };
	function catalog(db: Database) {
		const port = deps.execution?.();
		return port ? (deps.toolchains?.catalogInTransaction(db) ?? []).flatMap((entry) => {
			const card = deps.toolchains!.cardInTransaction(db, entry.revisionId);
			if (!card) return [];
			const policy = port.autonomyInTransaction?.(db, entry.revisionId);
			return [{ revisionId:card.revisionId, title:card.title, description:card.summary,
				requiresApproval: !limits(db).enabled || !policy?.automatic,
				reason: policy?.reason ?? "capability_unavailable",
				...(card.instant ? { argumentsSchema:card.instant.parameters } : {}) }];
		}) : [];
	}
	return {
		available: () => !!deps.execution?.(),
		catalog,
		async find(query: string, signal: AbortSignal) {
			if (!deps.toolchains || !deps.store) throw new Error("agency_catalog_unavailable");
			const vector = await deps.toolchains.embedQuery(query, signal);
			if (!vector) throw new Error("embedding_unavailable");
			return deps.store.read((db) => {
				const offered = deps.toolchains!.routeInTransaction(db, { runId: "agency-catalog", text:query, query:vector, strict:true,
					available:new Set(deps.toolchains!.catalogInTransaction(db).map((e) => e.id)) }).cards;
				const ids = new Set(offered.map((card) => card.revisionId));
				return catalog(db).filter((card) => ids.has(card.revisionId));
			});
		},
		start(db: Database, input: { rootId:string; conversationId:string; epoch:number; ticketId:string; intentId:string; candidateId:string; question:string; revisionId:string; deadline:number; outboundIntervalMs:number; sourceRefs:readonly string[]; arguments?:Record<string,unknown> }) {
			const port = deps.execution?.();
			if (!port || !deps.agents) throw new Error("agency_execution_unavailable");
			const existing = agencyWork(db,input.rootId);
			if (existing) {
				if (existing.revoked || !existing.execution_id) throw new Error("agency_origin_stale");
				return existing.execution_id;
			}
			const card = catalog(db).find((c) => c.revisionId === input.revisionId);
			if (!card || card.requiresApproval) throw new Error("agency_approval_required");
			const policy = limits(db);
			const now = deps.now();
			const active = agencyWorks(db,input.conversationId).filter((w) => !!w.execution_id);
			const dayStart = Math.floor((now + 9 * 3_600_000) / 86_400_000) * 86_400_000 - 9 * 3_600_000;
			const daily = (db.query("SELECT COUNT(*) AS n FROM dialogue_agency_work WHERE conversation_id=? AND created_at>=?").get(input.conversationId,dayStart) as {n:number}).n;
			if (!policy.enabled || active.length >= policy.maxConcurrent || daily >= policy.dailyLimit) throw new Error("agency_action_budget");
			const record = agencyRecords(db).find((r) => r.conversationId === input.conversationId && r.epoch === input.epoch);
			if (!record || input.deadline <= now) throw new Error("agency_origin_stale");
			if (!claimAgencyDispatch(db,input.conversationId,input.epoch,now,input.outboundIntervalMs)) throw new Error("agency_dispatch_interval");
			insertAgencyWork(db,{root_id:input.rootId,conversation_id:input.conversationId,epoch:input.epoch,ticket_id:input.ticketId,intent_id:input.intentId,candidate_id:input.candidateId,question:input.question,toolchain_revision_id:input.revisionId,deadline:input.deadline,source_refs_json:JSON.stringify(input.sourceRefs)});
			authorizeAgencyAction(db,input.rootId,{settingsDigest:record.settingsDigest,policyDigest:hash({version:1,input,policy,settingsDigest:record.settingsDigest})},now);
			const source = autonomousActionSource(db,input.rootId,now);
			if (!source) throw new Error("agency_origin_stale");
			const provenance = (record.snapshot as import("eumenes-agency").AgencySnapshot).provenance?.entries.find(([key])=>key === `attempt:${input.ticketId}`)?.[1];
            if (deps.settings && deps.memory && !provenance) throw new Error("agency_origin_stale");
            if (provenance) deps.memory?.referenceInputs.recordRunInTransaction(db,input.rootId,provenance);
            const view = deps.agents.executions.startSelectedInTransaction(db,{source,chainRevisionId:input.revisionId,request:input.question,arguments:input.arguments,references:[],deadline:input.deadline});
			linkAgencyExecution(db,input.rootId,view.id);
			work.start(db,agencyWork(db,input.rootId)!,view,{id:deps.toolchains!.cardInTransaction(db,input.revisionId)!.id,title:card.title});
			return view.id;
		},
		result(db: Database, root: string) {
			const w = agencyWork(db,root);
			if (!w?.execution_id) return null;
			const view = deps.agents?.executions.viewInTransaction(db,w.execution_id);
			if (!view) return null;
			return view;
		},
		cancel(db: Database, root: string) {
			const w = agencyWork(db,root);
			if (w?.execution_id) deps.agents?.executions.cancelByUserInTransaction(db,w.conversation_id,w.execution_id);
		},
		synchronize: work.sync,
		link: work.link,
	};
}
