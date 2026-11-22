import type { Database } from "bun:sqlite";
import { hash } from "../../domains/capabilities";
import type { MemoryService } from "../../domains/memory";
import type { GoalsService } from "../../domains/goals";
import type {
	ExecutionReference,
	ExecutionSource,
	ExecutionView,
} from "../../domains/tool-runtime";
import {
	createWorldContextNames,
	createWorldQuery,
	type WorldDocuments,
	type WorldService,
} from "../../domains/world";
import { parseResourceUri } from "../../domains/resources";
import type {
	ResearchKind,
	SupervisionEvidence,
	SupervisionHost,
	SupervisionNote,
} from "../../domains/development-supervision/contracts";
import { GOALS_ACCESS } from "../world/goals-assembly";
import { WORLD_DEFAULT_SCOPE } from "../world/world";
import type { SqliteStore } from "../../infrastructure/sqlite";

export function supervisionResearchNote(
	kind: ResearchKind,
	view: ExecutionView,
	observedAt: number,
): SupervisionNote | null {
	const result = view.result;
	if (
		!result ||
		(view.status !== "completed" && view.status !== "partial") ||
		view.status !== result.status
	)
		return null;
	const base = { id: view.id, ref: `${kind}:${view.id}` };
	if (kind === "web.note") {
		if (!result.answer?.trim() || !result.sources?.length) return null;
		const { answer, sources } = result;
		const at = Date.parse(sources[0]!.fetchedAt);
		if (!Number.isFinite(at)) return null;
		return {
			evidence: {
				...base,
				kind: "web",
				sources,
				digest: hash({ answer, sources }),
			},
			title: result.title ?? "公開情報の下調べ",
			text: answer,
			at,
		};
	}
	const locations =
		result.report?.sources.flatMap(({ location }) =>
			location ? [location] : [],
		) ?? [];
	if (!locations.length || !result.answer?.trim()) return null;
	const text = [
		result.answer,
		...locations.map(
			({ path, symbol, startLine, endLine }) =>
				`- ${path}:${startLine}-${endLine}${symbol ? ` (${symbol})` : ""}`,
		),
		...(result.report?.limitations ?? []),
	].join("\n");
	return {
		evidence: {
			...base,
			kind: "source",
			locations,
			digest: hash({ text, locations }),
		},
		title: result.title ?? "ソース調査",
		text,
		at: observedAt,
	};
}

type ContextPorts = {
	memory: Pick<
		MemoryService,
		| "executionReferenceInTransaction"
		| "executionReferencesInTransaction"
		| "windowForRunInTransaction"
	>;
	goals: Pick<GoalsService, "adoptedForContextInTransaction">;
	world?: {
		store: SqliteStore;
		service: WorldService;
		documents: WorldDocuments;
	};
	validSourceInTransaction: SupervisionHost["validSourceInTransaction"];
	validReferenceInTransaction: SupervisionHost["validReferenceInTransaction"];
	skillCurrentInTransaction?: (
		db: Database,
		source: Parameters<SupervisionHost["validSourceInTransaction"]>[1],
		evidence: Extract<SupervisionEvidence, { kind: "skill" }>,
	) => boolean;
	now?: () => number;
};

type ResearchContext = {
	contextInTransaction: NonNullable<
		SupervisionHost["research"]["contextInTransaction"]
	>;
	validEvidenceInTransaction: SupervisionHost["research"]["validEvidenceInTransaction"];
};

/** Resolve only host-issued references and context already available to the conversation's principal. */
export function supervisionBuildContext(ports: ContextPorts): ResearchContext {
	const now = ports.now ?? Date.now;
	const world = ports.world && {
		query: createWorldQuery({
			store: ports.world.store,
			world: ports.world.service,
			now,
		}),
		entities: createWorldContextNames({
			world: ports.world.service,
			scopeOf: () => WORLD_DEFAULT_SCOPE,
		}),
		documents: ports.world.documents,
	};
	function worldClaims(
		db: Database,
		source: ExecutionSource,
	): SupervisionNote[] {
		if (!world) return [];
		const entities = world.entities.knownEntitiesInTransaction(db, {
			conversationId: source.conversationId,
			texts: [source.request],
		});
		if (!entities.length) return [];
		const response = world.query.queryInTransaction(
			db,
			{
				principal: WORLD_DEFAULT_SCOPE.principal,
				scopeKeys: [WORLD_DEFAULT_SCOPE.scopeKey],
			},
			{ mode: "snapshot", entityIds: entities.map(({ id }) => id), depth: 0 },
		);
		if (response.status !== "ok" || response.result.mode !== "snapshot")
			return [];
		const names = new Map(
			entities.map(({ id, displayName }) => [id, displayName]),
		);
		return response.result.entries.map(
			({ evaluatedAt: _evaluatedAt, ...claim }) => ({
				evidence: {
					kind: "world",
					id: claim.id,
					ref: `world:claim:${claim.id}`,
					revision: String(claim.revision),
					digest: hash(claim),
				},
				title: `Worldの記録（${names.get(claim.subjectId) ?? claim.predicate}）`,
				text: JSON.stringify({
					subject: names.get(claim.subjectId) ?? claim.subjectId,
					...claim,
					completeness: response.completeness,
				}),
				at: response.asOf,
			}),
		);
	}
	const memoryBody = (
		db: Database,
		{ ref, id, revision, digest }: ExecutionReference,
	) =>
		ports.memory.executionReferenceInTransaction(db, {
			ref,
			id,
			revision,
			digest,
			owner: "memory",
			kind: "memory",
			label: "",
			preview: "",
		});
	const goalNote = (
		goal: ReturnType<GoalsService["adoptedForContextInTransaction"]>[number],
	): SupervisionNote => ({
		evidence: {
			kind: "goal",
			id: goal.goalId,
			ref: `goal:${goal.goalId}`,
			revision: String(goal.revision),
			digest: hash(goal),
		},
		title: "採用済み目標",
		text: goal.desiredState,
		at: Date.parse(goal.updatedAt),
	});
	function documentNote(
		db: Database,
		id: string,
		ref: string,
	): SupervisionNote | null {
		try {
			const document = world?.documents.lookupInTransaction(
				db,
				WORLD_DEFAULT_SCOPE,
				{ documentId: id },
			);
			if (document?.kind !== "document") return null;
			return {
				evidence: {
					kind: "world",
					ref,
					id,
					revision: document.revision,
					digest: document.digest,
				},
				title: document.title,
				text: document.complete
					? document.text
					: `${document.text}\n（収集資料の先頭部分）`,
				at: now(),
			};
		} catch {
			return null;
		}
	}
	return {
		contextInTransaction(db, source, refs) {
			if (!ports.validSourceInTransaction(db, source)) return [];
			const context = new Map<string, SupervisionNote>();
			const window = ports.memory.windowForRunInTransaction(
				db,
				source.conversationId,
			);
			const sharedMemory = window
				? ports.memory.executionReferencesInTransaction(db, window)
				: [];
			for (const ref of [...refs, ...sharedMemory]) {
				if (!ports.validReferenceInTransaction(db, source, ref)) continue;
				if (ref.owner === "memory" && ref.kind === "memory") {
					const text = memoryBody(db, ref);
					if (text !== null)
						context.set(`memory:${ref.id}`, {
							evidence: {
								kind: "memory",
								ref: ref.ref,
								id: ref.id,
								revision: ref.revision,
								digest: ref.digest,
							},
							title: ref.label,
							text,
							at: now(),
						});
				}
				if (
					ref.kind === "resource" &&
					ref.owner === "world" &&
					parseResourceUri(ref.ref)?.id === ref.id
				) {
					const note = documentNote(db, ref.id, ref.ref);
					if (note) context.set(`world:${ref.id}`, note);
				}
			}
			const claims = worldClaims(db, source);
			for (const claim of claims.slice(0, 4))
				context.set(claim.evidence.ref, claim);
			for (const goal of ports.goals.adoptedForContextInTransaction(
				db,
				GOALS_ACCESS,
			))
				context.set(`goal:${goal.goalId}`, goalNote(goal));
			return [...context.values()];
		},
		validEvidenceInTransaction(db, source, evidence) {
			if (!ports.validSourceInTransaction(db, source)) return false;
			if (evidence.kind === "memory") {
				const body = memoryBody(db, {
					...evidence,
					owner: "memory",
					kind: "memory",
					label: "",
					preview: "",
				});
				return body !== null;
			}
			if (evidence.kind === "world") {
				const current =
					evidence.ref === `world:claim:${evidence.id}`
						? worldClaims(db, source).find(
								(note) => note.evidence.ref === evidence.ref,
							)
						: documentNote(db, evidence.id, evidence.ref);
				return !!current && hash(current.evidence) === hash(evidence);
			}
			if (evidence.kind === "goal") {
				const current = ports.goals
					.adoptedForContextInTransaction(db, GOALS_ACCESS)
					.find((goal) => goal.goalId === evidence.id);
				return !!current && hash(goalNote(current).evidence) === hash(evidence);
			}
			return (
				evidence.kind === "skill" &&
				ports.skillCurrentInTransaction?.(db, source, evidence) === true
			);
		},
	};
}
