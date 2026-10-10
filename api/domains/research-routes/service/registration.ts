import type { Database } from "bun:sqlite";
import { commonSkillRevisionId, type Definition } from "../../capabilities";
import {
	type CanonicalReportPatch,
	type LookupProvenance,
	type ObservationResult,
	type RequestBinding,
	type RouteFence,
	type RouteRecipe,
	type SafeProjection,
	type SearchSpec,
	type VisibleSource,
	canonicalJson,
	limits,
	lookupProvenance as lookupProvenanceSchema,
	sha256,
	ttl,
	validationPolicyVersion,
} from "../contracts";
import * as repo from "../repository";
import {
	type FlowDeps,
	draftContext,
	enqueueStep,
	endDraft,
	safe,
} from "./flow";
import { renderDraft, validateRegistrationScenarios } from "./assets";
import { renderProjection } from "./projection";
import { hitCoversSource } from "./mapping";
import { type Clock, liveKey, stateTokenOf, versionHealth } from "./registry";
import { checkObservation } from "./validation";
import type { Plans } from "./plans";

export const observedProofTtlMs = 15 * 60_000;

export type ObservationInput = {
	/** null when the ledger is full: pure check + projection only. */
	fence: RouteFence | null;
	spec: SearchSpec;
	binding: RequestBinding;
	owner: { rootRunId: string; taskId: string };
	toolId: RouteRecipe["toolId"];
	sources: VisibleSource[];
	facts: unknown;
	reportEvidence?: Array<{ sourceId: string; quote: string }>;
	/** The lookup (or candidate import) that preceded this read. */
	lookupProvenance: LookupProvenance | null;
	/** Required when lookupProvenance.origin is candidate-cache: the real lookup that produced the candidate. */
	originalProvenance?: LookupProvenance | null;
	/** URLs offered by that lookup/candidate; the read URL must be one of them. */
	lookupHitUrls?: string[];
	/** Healthy direct route: never creates a proof. */
	warm?: boolean;
};
export type AdoptedInput = {
	proofId: string;
	ticketId: string;
	reportEpoch: number;
};
export type AdoptedResult =
	| { kind: "recorded"; draftId: string }
	| { kind: "skipped"; code: string };
export type EditInput = {
	key: string;
	expectedStateToken: string;
	instruction: string;
};
export type EditResult =
	| { kind: "accepted"; draftId: string }
	| { kind: "conflict"; code: string }
	| { kind: "not_found" }
	| { kind: "not_editable" }
	| { kind: "rejected"; code: string }
	| { kind: "busy"; code: string };
export type ActivateInput = {
	draftId: string;
	fence: RouteFence;
	baseVersionId: string | null;
	reviewDigest: string;
};
export type ActivateResult =
	| { kind: "activated"; versionId: string }
	| { kind: "superseded"; code: string }
	| { kind: "interrupted"; code: string }
	| { kind: "rejected"; code: string };
export type FailureKind =
	| "web_attempt_timeout"
	| "network_error"
	| "http_5xx"
	| "not_found"
	| "wrong_target"
	| "missing_value"
	| "format_changed"
	| "stale_value"
	| "source_unusable"
	| "guard_denied"
	| "capability_suspended"
	| "cancelled"
	| "deadline_exceeded"
	| "rate_limited"
	| "report_invalid";
const siteFailures: readonly FailureKind[] = [
	"web_attempt_timeout",
	"network_error",
	"http_5xx",
	"not_found",
	"wrong_target",
	"missing_value",
	"format_changed",
	"stale_value",
	"source_unusable",
];
export type RouteFailureResult =
	| { kind: "disqualified"; stateToken: string }
	| { kind: "ignored"; reason: string }
	| { kind: "stale" };

const structural =
	/(https?:\/\/|ＵＲＬ|\burl\b|取得先を?(変更|変えて|差し替|切り替)|別のサイト|サイトを(変更|変えて)|ツール|引数|必要項目|時点の条件|地点を|銘柄を)/i;

export function buildRecipe(
	spec: SearchSpec,
	toolId: RouteRecipe["toolId"],
	url: string,
	key: string,
): RouteRecipe | null {
	if (toolId === "web.read")
		return {
			toolId,
			arguments: { url },
			sourceUrl: url,
			specDigest: key,
			validationProfile:
				spec.purpose === "weather" ? "weather-excerpt-v1" : "quote-excerpt-v1",
			singleSource: true,
		};
	if (toolId === "web.quote" && spec.purpose === "quote")
		return {
			toolId,
			arguments: { symbol: spec.target.ticker },
			sourceUrl: url,
			specDigest: key,
			validationProfile: "quote-json-v1",
			singleSource: true,
		};
	return null;
}

export function createRegistration(
	deps: Partial<FlowDeps> & { clock: Clock; plans: Plans },
) {
	const { clock } = deps;
	// One source of external (learned definition) bytes: never add capabilities' usage twice.
	const ext = (db: Database) =>
		deps.externalBytes
			? deps.externalBytes(db)
			: (deps.capabilities?.learnedUsageInTransaction(db).bytes ?? 0);
	const ready = deps.queue && deps.capabilities && deps.inference;

	function savepoint<T>(
		db: Database,
		name: string,
		fn: () => T,
		onError: (e: unknown) => T,
	): T {
		db.exec(`SAVEPOINT ${name}`);
		try {
			const out = fn();
			db.exec(`RELEASE ${name}`);
			return out;
		} catch (e) {
			db.exec(`ROLLBACK TO ${name}`);
			db.exec(`RELEASE ${name}`);
			return onError(e);
		}
	}

	/** Independent host check of the child's facts. Cold/rediscovery runs also keep a private observed proof. */
	function recordObservationInTransaction(
		db: Database,
		input: ObservationInput,
	): ObservationResult {
		const now = clock.now();
		const check = checkObservation({ ...input, now });
		if (check.kind !== "valid") return check;
		const rendered = renderProjection(check.facts, check.sourceId);
		const out = (proofId: string | null): ObservationResult => ({
			kind: "valid",
			proofId,
			canonicalReportPatch:
				rendered.canonicalReportPatch as CanonicalReportPatch,
			projection: rendered.projection as SafeProjection,
			projectionDigest: rendered.digest,
		});
		if (input.warm || !input.fence) return out(null);
		const fence = input.fence;
		const k = liveKey(db, fence);
		if (!k || !k.enabled || fence.key !== input.binding.specDigest)
			return out(null);
		const current = lookupProvenanceSchema.safeParse(input.lookupProvenance);
		if (!current.success) return out(null);
		let origin = current.data;
		if (origin.origin === "candidate-cache") {
			const orig = lookupProvenanceSchema.safeParse(input.originalProvenance);
			if (!orig.success || orig.data.origin !== "lookup") return out(null);
			origin = orig.data;
		}
		if (origin.query !== input.spec.keywords) return out(null);
		if (
			!input.lookupHitUrls?.some((u) =>
				hitCoversSource(input.spec, input.toolId, u, check.url),
			)
		)
			return out(null);
		const recipe = buildRecipe(input.spec, input.toolId, check.url, fence.key);
		if (
			!recipe ||
			validateRegistrationScenarios(input.spec, recipe, fence.key).length
		)
			return out(null);
		if (repo.ledgerBytes(db) + ext(db) >= limits.totalBytes) return out(null);
		const source = input.sources.find((s) => s.sourceId === check.sourceId);
		const { evidence: _evidence, ...factValues } = check.facts;
		const id = clock.id();
		const stored = {
			facts: factValues,
			recipe,
			sourceDigest: sha256(source?.body ?? ""),
		};
		const body = {
			key: fence.key,
			incarnation: fence.incarnation,
			generation: fence.generation,
			url: check.url,
			binding: input.binding,
			projectionDigest: rendered.digest,
			factsDigest: check.factsDigest,
			policy: validationPolicyVersion,
			provenance: [current.data, input.originalProvenance ?? null],
		};
		repo.insertProof(db, {
			id,
			root_run_id: input.owner.rootRunId,
			task_id: input.owner.taskId,
			ticket_id: null,
			report_epoch: null,
			epoch: fence.epoch,
			incarnation: fence.incarnation,
			key: fence.key,
			generation: fence.generation,
			source_url: check.url,
			binding_json: canonicalJson(input.binding),
			projection_digest: rendered.digest,
			lookup_provenance_json: canonicalJson({
				current: current.data,
				original: input.originalProvenance ?? null,
			}),
			validation_policy_version: validationPolicyVersion,
			facts_json: canonicalJson(stored),
			fetched_at: Date.parse(check.fetchedAt) || now,
			validated_at: now,
			adopted_at: null,
			status: "observed",
			digest: sha256(canonicalJson(body)),
			expires_at: now + observedProofTtlMs,
		});
		return out(id);
	}

	/** Called inside the dialogue's optional-learning SAVEPOINT after the answer was adopted. */
	function recordAdoptedProofAndEnqueueInTransaction(
		db: Database,
		input: AdoptedInput,
	): AdoptedResult {
		if (!ready) return { kind: "skipped", code: "learning_unavailable" };
		const now = clock.now();
		return savepoint<AdoptedResult>(
			db,
			"rr_adopt",
			() => {
				const proof = repo.getProof(db, input.proofId);
				if (!proof || proof.status !== "observed")
					return { kind: "skipped", code: "proof_unavailable" };
				if (proof.expires_at <= now)
					return { kind: "skipped", code: "proof_expired" };
				const k = liveKey(db, {
					key: proof.key,
					epoch: proof.epoch,
					incarnation: proof.incarnation,
					generation: proof.generation,
				});
				if (!k) return { kind: "skipped", code: "stale_fence" };
				if (!k.enabled) return { kind: "skipped", code: "disabled" };
				if (repo.openDraftOf(db, k.incarnation))
					return { kind: "skipped", code: "draft_exists" };
				if (k.active_version_id) {
					const { health, version } = versionHealth(db, k, now);
					if (health === "healthy")
						return { kind: "skipped", code: "route_active" };
					if (health === "disqualified" && version) {
						const bad = repo.getHealth(db, version.version_id);
						const old = JSON.parse(version.recipe_json) as RouteRecipe;
						if (
							bad &&
							old.sourceUrl === proof.source_url &&
							proof.fetched_at <= bad.disqualified_at
						)
							return { kind: "skipped", code: "stale_proof" };
					}
				}
				if (repo.ledgerBytes(db) + ext(db) >= limits.totalBytes)
					return { kind: "skipped", code: "capacity" };
				if (
					!repo.updateProof(db, proof.id, "observed", {
						status: "adopted",
						ticket_id: input.ticketId,
						report_epoch: input.reportEpoch,
						adopted_at: now,
						expires_at: now + ttl.terminalMs,
					})
				)
					return { kind: "skipped", code: "proof_unavailable" };
				const draft: repo.DraftRow = {
					id: clock.id(),
					key: k.key,
					epoch: k.epoch,
					incarnation: k.incarnation,
					base_generation: k.generation,
					base_version_id: k.active_version_id,
					origin: "adoption",
					proof_id: proof.id,
					base_certificate_digest: null,
					instruction: null,
					skill_draft: null,
					review_json: null,
					corrections: 0,
					state: "queued",
					error_code: null,
					created_at: now,
					updated_at: now,
					expires_at: now + limits.draftDeadlineMs,
				};
				repo.insertDraft(db, draft);
				enqueueStep(db, deps as FlowDeps, draft, "author-1");
				return { kind: "recorded", draftId: draft.id };
			},
			(e) => ({
				kind: "skipped",
				code: safe(e) === "queue_full" ? "queue_full" : "skipped_error",
			}),
		);
	}

	/** Description-only edit of a healthy active route: instruction -> author -> review -> new version. */
	function editInTransaction(db: Database, input: EditInput): EditResult {
		const now = clock.now();
		const epoch = repo.getEpoch(db);
		const k = repo.getKey(db, epoch, input.key);
		if (!k) return { kind: "not_found" };
		if (stateTokenOf(k) !== input.expectedStateToken)
			return { kind: "conflict", code: "stale_state_token" };
		if (structural.test(input.instruction))
			return { kind: "rejected", code: "recipe_change_requires_rediscovery" };
		if (!k.enabled || !k.active_version_id) return { kind: "not_editable" };
		const { health, version } = versionHealth(db, k, now);
		if (health !== "healthy" || !version) return { kind: "not_editable" };
		if (repo.openDraftOf(db, k.incarnation))
			return { kind: "conflict", code: "draft_exists" };
		if (!ready) return { kind: "busy", code: "learning_unavailable" };
		if (repo.ledgerBytes(db) + ext(db) >= limits.totalBytes)
			return { kind: "busy", code: "capacity" };
		return savepoint<EditResult>(
			db,
			"rr_edit",
			() => {
				const draft: repo.DraftRow = {
					id: clock.id(),
					key: k.key,
					epoch: k.epoch,
					incarnation: k.incarnation,
					base_generation: k.generation,
					base_version_id: version.version_id,
					origin: "edit",
					proof_id: null,
					base_certificate_digest: sha256(
						version.registration_certificate_json,
					),
					instruction: input.instruction,
					skill_draft: null,
					review_json: null,
					corrections: 0,
					state: "queued",
					error_code: null,
					created_at: now,
					updated_at: now,
					expires_at: now + limits.draftDeadlineMs,
				};
				repo.insertDraft(db, draft);
				enqueueStep(db, deps as FlowDeps, draft, "author-1");
				return { kind: "accepted", draftId: draft.id };
			},
			(e) => ({
				kind: "busy",
				code: safe(e) === "queue_full" ? "queue_full" : "enqueue_failed",
			}),
		);
	}

	const hex32 = (id: string) => {
		const v = id.replaceAll("-", "");
		return /^[0-9a-f]{32}$/.test(v) ? v : sha256(v).slice(0, 32);
	};

	/**
	 * Approved review -> capability registration + version + active CAS + draft activated, all in one
	 * transaction (own SAVEPOINT). Never leaves a partial registration.
	 */
	function activateInTransaction(
		db: Database,
		input: ActivateInput,
	): ActivateResult {
		if (!ready) return { kind: "rejected", code: "learning_unavailable" };
		const d = deps as FlowDeps;
		const now = clock.now();
		const draft = repo.getDraft(db, input.draftId);
		if (!draft || draft.state !== "reviewing")
			return { kind: "rejected", code: "draft_not_reviewing" };
		const finish = (
			to: "rejected" | "interrupted" | "superseded",
			code: string,
		): ActivateResult => {
			endDraft(db, clock, draft, to, code);
			return { kind: to, code } as ActivateResult;
		};
		if (
			draft.key !== input.fence.key ||
			draft.epoch !== input.fence.epoch ||
			draft.incarnation !== input.fence.incarnation ||
			draft.base_generation !== input.fence.generation ||
			draft.base_version_id !== input.baseVersionId
		)
			return finish("rejected", "fence_mismatch");
		const k = liveKey(db, input.fence);
		if (!k) return finish("interrupted", "stale_fence");
		if (!k.enabled) return finish("interrupted", "route_disabled");
		if (k.active_version_id !== draft.base_version_id)
			return finish("superseded", "route_updated");
		if (now >= draft.expires_at) return finish("interrupted", "draft_deadline");
		const ctx = draftContext(db, draft);
		if (!ctx || !draft.skill_draft)
			return finish("rejected", "draft_context_missing");
		const stored = JSON.parse(draft.skill_draft) as {
			author: Parameters<typeof renderDraft>[0];
			digest: string;
		};
		const rendered = renderDraft(
			stored.author,
			ctx.spec,
			ctx.recipe,
			draft.base_version_id,
		);
		if (
			rendered.digest !== input.reviewDigest ||
			rendered.digest !== stored.digest
		)
			return finish("rejected", "digest_mismatch");
		const problems = validateRegistrationScenarios(ctx.spec, ctx.recipe, k.key);
		if (problems.length) return finish("rejected", `scenario_${problems[0]}`);
		let base: repo.RevisionRow | null = null;
		if (draft.origin === "adoption") {
			const p = ctx.proof!;
			if (
				p.status !== "adopted" ||
				p.incarnation !== k.incarnation ||
				p.generation !== draft.base_generation ||
				p.ticket_id === null ||
				p.report_epoch === null
			)
				return finish("rejected", "proof_not_adopted");
			const src = d.adoption.validateInTransaction(db, {
				runId: p.root_run_id,
				taskId: p.task_id,
				ticketId: p.ticket_id,
				reportEpoch: p.report_epoch,
			});
			if (src.status !== "allowed") return finish("interrupted", src.code);
			if (k.active_version_id) {
				const { health, version } = versionHealth(db, k, now);
				if (health === "healthy") return finish("superseded", "route_active");
				const bad = version ? repo.getHealth(db, version.version_id) : null;
				if (
					bad &&
					version &&
					(JSON.parse(version.recipe_json) as RouteRecipe).sourceUrl ===
						p.source_url &&
					p.fetched_at <= bad.disqualified_at
				)
					return finish("rejected", "stale_proof");
			}
		} else {
			base = draft.base_version_id
				? repo.getRevision(db, draft.base_version_id)
				: null;
			if (
				!base ||
				versionHealth(db, k, now).health !== "healthy" ||
				sha256(base.registration_certificate_json) !==
					draft.base_certificate_digest
			)
				return finish("superseded", "base_changed");
		}
		if (repo.ledgerBytes(db) + ext(db) >= limits.totalBytes)
			return finish("rejected", "capacity");
		const versionId = clock.id();
		const capId = `learned.web.${hex32(versionId)}`;
		const own = `skill:${capId}@1`;
		const toolRev = `tool:${ctx.recipe.toolId}@1`;
		const schemaKey = (
			{
				"web.read": "read",
				"web.quote": "quote",
				"web.forecast": "forecast",
			} as const
		)[ctx.recipe.toolId];
		const shared = {
			revision: 1,
			id: capId,
			title: stored.author.name,
			summary: stored.author.description,
			aliases: [],
			tags: [],
			useWhen: [],
			avoidWhen: [],
			discoveryMode: "route-only" as const,
		};
		const skillDef: Definition = {
			...shared,
			kind: "skill",
			dependencies: [],
			body: rendered.skill,
		};
		const packageDef: Definition = {
			...shared,
			kind: "package",
			backend: "web",
			schemaKey,
			dependencies: [
				"profile:web.research@1",
				commonSkillRevisionId,
				own,
				toolRev,
			],
			profileRevisionId: "profile:web.research@1",
			requiredSkillRevisionIds: [commonSkillRevisionId, own],
			toolRevisionIds: [toolRev],
		};
		return savepoint<ActivateResult>(
			db,
			"rr_activate",
			() => {
				d.capabilities.registerLearnedInTransaction(db, skillDef);
				d.capabilities.registerLearnedInTransaction(db, packageDef);
				const proof = ctx.proof;
				const baseCert = base
					? (JSON.parse(base.registration_certificate_json) as {
							validatedAt: number;
							proofDigest: string;
						})
					: null;
				const validatedAt = proof ? proof.validated_at : baseCert!.validatedAt;
				const proofDigest = proof ? proof.digest : baseCert!.proofDigest;
				const certificate = {
					specDigest: k.key,
					recipeDigest: sha256(canonicalJson(ctx.recipe)),
					policyVersion: validationPolicyVersion,
					validatedAt,
					proofDigest,
					reviewDigest: rendered.digest,
					origin: draft.origin,
				};
				const revalidateAt = base
					? base.revalidate_at
					: validatedAt + ttl.absoluteMs;
				repo.insertRevision(db, {
					version_id: versionId,
					epoch: k.epoch,
					key: k.key,
					incarnation: k.incarnation,
					revision: repo.nextRevisionNumber(db, k.incarnation),
					recipe_json: canonicalJson(ctx.recipe),
					context_projection: rendered.context,
					skill_revision_id: own,
					package_revision_id: `package:${capId}@1`,
					proof_digest: proofDigest,
					review_digest: rendered.digest,
					registration_certificate_json: canonicalJson(certificate),
					validation_policy_version: validationPolicyVersion,
					created_at: now,
					revalidate_at: revalidateAt,
				});
				if (
					!repo.activateVersionCas(db, {
						epoch: k.epoch,
						key: k.key,
						incarnation: k.incarnation,
						generation: k.generation,
						expectedVersionId: draft.base_version_id,
						versionId,
						now,
						idleExpiresAt: base
							? (k.idle_expires_at ?? now + ttl.idleMs)
							: now + ttl.idleMs,
						lastSuccessAt: base ? k.last_success_at : validatedAt,
					})
				)
					throw new Error("cas_failed");
				if (
					proof &&
					!repo.updateProof(db, proof.id, "adopted", { status: "consumed" })
				)
					throw new Error("proof_unavailable");
				if (
					!repo.setDraftState(
						db,
						draft.id,
						["reviewing"],
						"activated",
						null,
						now,
					)
				)
					throw new Error("draft_not_reviewing");
				return { kind: "activated", versionId };
			},
			(e) => {
				const code = safe(e);
				return code === "cas_failed"
					? finish("superseded", "cas_failed")
					: finish("rejected", `registration_${code}`);
			},
		);
	}

	/** Failure of the version used in this run. Site-side failures disqualify; safety/cancel/budget do not. */
	function recordRouteFailureInTransaction(
		db: Database,
		input: { versionId: string; fence: RouteFence; failure: FailureKind },
	): RouteFailureResult {
		if (!siteFailures.includes(input.failure))
			return { kind: "ignored", reason: input.failure };
		const r = deps.plans.markVersionDisqualifiedInTransaction(db, {
			versionId: input.versionId,
			fence: input.fence,
			reason: input.failure,
		});
		return r.kind === "updated"
			? { kind: "disqualified", stateToken: r.stateToken }
			: { kind: "stale" };
	}

	/** Package revision ids that GC must keep: active, drafts' bases, and versions held by running roots. */
	function protectedPackageRevisionIdsInTransaction(db: Database): string[] {
		const epoch = repo.getEpoch(db);
		const ids = new Set<string>();
		const versions = new Set<string>();
		for (const r of db
			.query(
				"SELECT active_version_id v FROM research_route_keys WHERE epoch=? AND active_version_id IS NOT NULL",
			)
			.all(epoch) as { v: string }[])
			versions.add(r.v);
		for (const r of db
			.query(
				"SELECT base_version_id v FROM research_route_drafts WHERE base_version_id IS NOT NULL AND state IN ('queued','authoring','reviewing')",
			)
			.all() as { v: string }[])
			versions.add(r.v);
		for (const v of deps.adoption?.protectedBindingsInTransaction?.(db) ?? [])
			versions.add(v);
		for (const v of versions) {
			const rev = repo.getRevision(db, v);
			if (rev) ids.add(rev.package_revision_id);
		}
		return [...ids];
	}

	return {
		recordObservationInTransaction,
		recordAdoptedProofAndEnqueueInTransaction,
		editInTransaction,
		activateInTransaction,
		recordRouteFailureInTransaction,
		protectedPackageRevisionIdsInTransaction,
	};
}
export type Registration = ReturnType<typeof createRegistration>;
