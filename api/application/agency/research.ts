import { projectAgencyState, type AgencySnapshot } from "eumenes-agency";
import type { Database } from "bun:sqlite";
import type { AgencyHostDeps, Conv } from "./host-types";
import { z } from "zod";
import {
	delegationRequest,
	defaultLimits,
	type AgencyRuntime,
	type ActionTicket,
	type ToolCapability,
} from "eumenes-agency";
import type { AgencyStatePort } from "../../domains/dialogue";
import type { SqliteStore } from "../../infrastructure/sqlite";
const request = z.strictObject({
	revisionId: z.string().min(1),
	question: z.string().trim().min(1).max(2000),
});
export function researchTools(
	store: Pick<SqliteStore, "read">,
	state: AgencyStatePort | undefined,
): readonly ToolCapability[] {
	const catalog = state
		? store.read((db) => state.catalogInTransaction(db))
		: [];
	return catalog.length
		? [
				{
					name: "delegate",
					requiresApproval: false,
					description: `関心に基づく読み取り調査を委譲します。toolInputはrevisionIdとquestionを持つJSON文字列です。revisionIdには次の一覧から選んだ項目のidをそのまま写し、questionには調べたい問いと受入条件を書きます。一覧: ${JSON.stringify(catalog)}`,
				},
			]
		: [];
}
export function researchInput(
	ticket: ActionTicket,
	runtime: AgencyRuntime,
	conversationId: string,
	scope: string,
	epoch: number,
	now: number,
) {
	// Execution retains the selected capability's enforced model/tool limits.
	const d = delegationRequest(ticket, runtime.snapshot().state, now);
	if (!d || !ticket.candidateId) throw new Error("agency_delegation_invalid");
	const parsed = request.safeParse(JSON.parse(d.question));
	if (!parsed.success) throw new Error("agency_delegation_invalid");
	const snap = runtime.snapshot();
	const attempt = snap.state.attempts.find((a) => a.id === ticket.id);
	const intent = snap.state.intents.find((i) => i.id === d.intentId)!;
	return {
		outboundIntervalMs: defaultLimits.outboundIntervalMs,
		rootId: `agency:${scope}:${ticket.id}`,
		conversationId,
		epoch,
		ticketId: ticket.id,
		intentId: d.intentId,
		candidateId: ticket.candidateId,
		question: parsed.data.question,
		revisionId: parsed.data.revisionId,
		deadline: (attempt?.startedAt ?? now) + 30 * 60000,
		sourceRefs: intent.evidence,
	};
}
export function snapshotRefs(runtime: AgencyRuntime): string[] {
	const s = runtime.snapshot();
	return [
		...new Set([
			...s.observations.map((o) => o.id),
			...s.state.intents.flatMap((i) => i.evidence),
			...(s.state.interests ?? []).flatMap((i) => i.evidence),
			...s.state.candidates.flatMap((c) => c.evidence),
		]),
	];
}

export function projectionLines(
	deps: AgencyHostDeps,
	convs: ReadonlyMap<string, Conv>,
	db: Database,
	id: string,
): readonly string[] {
	const record = deps.state
		?.recordsInTransaction(db)
		.find((r) => r.conversationId === id);
	const snapshot = record?.snapshot as AgencySnapshot | undefined;
	const projection = deps.state
		? snapshot
			? projectAgencyState("F", snapshot.state, 8, snapshot.observations)
			: null
		: convs.get(id)?.runtime.projection(8);
	return (projection?.items ?? []).map((i) => JSON.stringify(i));
}

export function waitingForWork(runtime: AgencyRuntime): boolean {
	const s = runtime.snapshot();
	return (
		s.cursor === s.observations.length &&
		s.state.intents.some((i) => !!i.workRef)
	);
}
