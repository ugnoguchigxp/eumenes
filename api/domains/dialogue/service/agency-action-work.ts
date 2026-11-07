import type { Database } from "bun:sqlite";
import type { ExecutionView } from "../../tool-runtime";
import type { ResourceRegistry } from "../../resources";
import { insertWork, workBySource, updateWork, archiveWork } from "../repository/work";
import { setWorkLinks } from "../repository/resources";
import { createResourceLedger } from "./resource-ledger";
import type { AgencyWorkRow } from "../repository/agency";

export function agencyActionWork(resources: ResourceRegistry | undefined, now: () => number) {
	const ledger = createResourceLedger({ clock: () => new Date(now()).toISOString(), id: () => crypto.randomUUID() });
	return {
		start(db: Database, work: AgencyWorkRow, view: ExecutionView, card: { id: string; title: string }) {
			if (workBySource(db, view.id)) return;
			insertWork(db, { id: crypto.randomUUID(), conversationId: work.conversation_id, runId: work.root_id,
				toolchainId: card.id, toolchainRevisionId: work.toolchain_revision_id, execution: "task",
				request: work.question, title: `[${card.title}] ${work.question.slice(0,160)}`, sourceRef: view.id,
				dedupeKey: work.root_id, createdAt: new Date(now()).toISOString(), messageIds: [] });
		},
		sync(db: Database, view: ExecutionView) {
			const work = workBySource(db, view.id);
			if (!work || work.status === "done") return;
			if (view.status === "waiting_user" && view.question && work.questionId !== view.question.id) {
				if (!updateWork(db, work.id, work.revision, { status: "waiting", questionId: view.question.id, question: view.question.prompt }, new Date(now()).toISOString())) throw new Error("agency_work_changed");
				return;
			}
			if (!view.result) return;
			const links = (view.result.links ?? []).map((uri) => {
				const found = resources?.resolveInTransaction(db, uri);
				if (!found?.ok) throw new Error("agency_result_invalidated");
				return { uri, kind: found.resource.kind, label: found.resource.label };
			});
			setWorkLinks(db, work.id, links);
			ledger.enterLinksInTransaction(db, { conversationId: view.conversationId, workId: work.id, links });
			const outcome = view.status === "completed" ? "succeeded" : view.status === "cancelled" ? "cancelled" : view.status === "interrupted" ? "interrupted" : view.status === "failed" ? "failed" : "partial";
			if (!updateWork(db, work.id, work.revision, { status:"done", outcome, questionId:null, question:null, result: view.result }, new Date(now()).toISOString())) throw new Error("agency_work_changed");
			archiveWork(db, work.id, new Date(now()).toISOString());
		},
		link(db: Database, conversationId: string, messageId: string, executionIds: string[]) {
			ledger.linkMessageToWorkInTransaction(db, conversationId, messageId, executionIds.flatMap((id) => {const w=workBySource(db,id);return w?[w.id]:[];}));
		},
	};
}
