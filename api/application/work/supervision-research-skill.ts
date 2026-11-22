import type { Database } from "bun:sqlite";
import {
	digest,
	type Authority,
	type createSkillSmith,
	type ExecutionContext,
	type GuidanceRequest,
} from "eumenes-skill-smith";
import { sqliteRepository } from "eumenes-skill-smith/sqlite";
import { CONVERSATION_DEFAULT_PRINCIPAL } from "../../domains/conversation";
import type { ExecutionSource } from "../../domains/tool-runtime";
import type {
	SupervisionEvidence,
	SupervisionNote,
} from "../../domains/development-supervision/contracts";
import type { SqliteStore } from "../../infrastructure/sqlite";

export const supervisionKnowledgeScope = "knowledge:development-supervision";
const supervisionSourceRef = (messageId: string) =>
	`${supervisionKnowledgeScope}:message:${messageId}`;

export function createSupervisionSkillGuidance(deps: {
	service: Pick<
		ReturnType<typeof createSkillSmith<Database>>,
		| "prepareSkillSelection"
		| "selectSkill"
		| "bindSkillSelection"
		| "getSkillDelivery"
		| "get"
		| "forget"
	>;
	store: Pick<SqliteStore, "read" | "write">;
	request(query: string, source: ExecutionSource): GuidanceRequest;
	selectionCalls(signal: AbortSignal): ExecutionContext;
}) {
	const { service, store } = deps;

	const supervisionAuthority = (source: ExecutionSource): Authority | null =>
		source.messageId
			? {
					principal: CONVERSATION_DEFAULT_PRINCIPAL,
					scope: supervisionKnowledgeScope,
					epoch: 0,
					parentRef: source.runId,
					sourceRefs: [supervisionSourceRef(source.messageId)],
					permissions: ["build"],
				}
			: null;

	async function selectForSupervision(
		query: string,
		source: ExecutionSource,
		signal: AbortSignal,
		assertCurrent: (tx: Database) => void,
	): Promise<SupervisionNote[]> {
		const auth = supervisionAuthority(source);
		if (!auth) return [];
		const request = deps.request(query, source);
		const authorizedRead = <T>(operation: (tx: Database) => T) =>
			store.read((tx) => {
				signal.throwIfAborted();
				assertCurrent(tx);
				return operation(tx);
			});
		const prepared = authorizedRead((tx) =>
			service.prepareSkillSelection(tx, request, auth),
		);
		const selected = await service.selectSkill(
			prepared,
			deps.selectionCalls(signal),
		);
		if (selected.decision.kind === "miss") return [];
		const ref = await store.write((tx) => {
			signal.throwIfAborted();
			assertCurrent(tx);
			return service.bindSkillSelection(tx, prepared, selected, auth)
				.requestRef;
		});
		if (!ref) return [];
		const delivery = await service.getSkillDelivery(
			ref,
			auth,
			authorizedRead,
			signal,
		);
		if (delivery.kind !== "ready") return [];
		const result = authorizedRead((tx) => service.get(tx, ref, auth));
		if (result.kind !== "ready" || !result.build.publication) return [];
		const { publication } = result.build;
		return [
			{
				evidence: {
					kind: "skill",
					id: ref,
					ref: `skill:${ref}`,
					digest: publication.composition?.bundleDigest ?? publication.digest,
					reason: publication.assessment,
				},
				title: delivery.skill.name,
				text: `${publication.assessment}\n\n${delivery.skill.content}`,
				at: result.build.createdAt,
			},
		];
	}

	function supervisionSkillCurrentInTransaction(
		tx: Database,
		source: ExecutionSource,
		evidence: Extract<SupervisionEvidence, { kind: "skill" }>,
	) {
		const auth = supervisionAuthority(source);
		if (!auth || evidence.ref !== `skill:${evidence.id}`) return false;
		const stored = sqliteRepository.request(tx, evidence.id);
		if (
			!stored ||
			digest(stored.authority) !== digest(auth) ||
			stored.request.task.situation?.revision !== source.digest
		)
			return false;
		const result = service.get(tx, evidence.id, auth);
		const publication =
			result.kind === "ready" ? result.build.publication : undefined;
		return (
			!!publication &&
			(publication.composition?.bundleDigest ?? publication.digest) ===
				evidence.digest &&
			publication.assessment === evidence.reason
		);
	}

	return {
		selectForSupervision,
		supervisionSkillCurrentInTransaction,
		forgetSupervisionSourcesInTransaction(
			tx: Database,
			messageIds: readonly string[],
		) {
			let pending = messageIds.map(supervisionSourceRef);
			while (pending.length) pending = service.forget(tx, pending).pending;
		},
	};
}
