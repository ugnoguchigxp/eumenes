import type { Database } from "bun:sqlite";
import type { QueueService } from "../domains/queue";
import type { Capabilities } from "../domains/capabilities";
import type {
	AcquisitionPlanPort,
	AcquisitionObservationInput,
	AcquisitionInitialAction,
	AcquisitionLookupProvenance,
	createAgentRuntime,
} from "../domains/agent-runtime";
import type {
	CachedSourceAuthorizationPort,
	ToolRuntime,
} from "../domains/tool-runtime";
import type { PostAnswerObserverPort } from "../domains/dialogue";
import { getLogger } from "../infrastructure/logger";
import {
	bindRequest,
	buildSearchSpec,
	createResearchRoutes,
	ledger,
	type Clock,
	type FailureKind,
	type LookupProvenance,
	type MaintenanceInference,
	type RequestBinding,
	type ResearchRoutes,
	type RouteFence,
	type RouteLookup,
	type RouteRecipe,
	type SearchSpec,
	type SourceAdoptionPort,
} from "../domains/research-routes";

const log = getLogger("research-routes");

type Agents = ReturnType<typeof createAgentRuntime>;
type Owner = { rootRunId: string; taskId: string; cancelEpoch: number };

/** The cold/fallback package: web search first, then a normal worker. */
export const coldPackageRevisionId = "package:web.research@7";
/** Direct warm fetch attempt budget (ms); fixed by the plan. */
const warmAttemptTimeoutMs = 5_000;
const memoryLimit = 256;
const memoryTtlMs = 15 * 60_000;

type Proposal = {
	rootRunId: string;
	spec: SearchSpec;
	binding: RequestBinding;
	lookup: RouteLookup;
	createdAt: number;
};
type BindingInfo = {
	kind: "search" | "candidate" | "direct";
	owner: Owner;
	spec: SearchSpec;
	binding: RequestBinding;
	/** null: capacity/disabled. Nothing is learned and no cached authority exists. */
	fence: RouteFence | null;
	versionId?: string;
	recipe?: RouteRecipe;
	candidateDigest?: string;
	candidateUrls?: string[];
	original?: LookupProvenance;
	proofId?: string | null;
	projectionDigest?: string;
	pendingCandidates?: {
		fence: RouteFence;
		provenance: LookupProvenance;
		hits: { url: string; title: string; snippet: string }[];
	};
	released?: boolean;
	createdAt: number;
};

/** Provider-side failures that disqualify a cached route (guard/cancel/budget never do). */
const siteFailure: Record<string, FailureKind> = {
	web_attempt_timeout: "web_attempt_timeout",
	web_timeout: "web_attempt_timeout",
	web_acquisition_failed: "network_error",
	web_result_too_large: "format_changed",
	web_quote_symbol_mismatch: "wrong_target",
	// Codes the real acquisition path emits. Throttling is not the site being wrong (ignored).
	web_upstream_http: "http_5xx",
	web_parse_changed: "format_changed",
	web_content_insufficient: "missing_value",
	web_unsupported_content_type: "format_changed",
	web_response_too_large: "format_changed",
	web_rate_limited: "rate_limited",
	web_bot_challenge: "rate_limited",
	// result_expired is a local vault/retention matter, never the site's fault.
};
const toolIdOf = (s: string): RouteRecipe["toolId"] | null => {
	const m = /web\.(forecast|quote|read)/.exec(s);
	return m ? (`web.${m[1]}` as RouteRecipe["toolId"]) : null;
};

const reportEvidence = (input: AcquisitionObservationInput) => ({
	facts: input.facts,
	reportEvidence: input.report.claims.flatMap((c) => c.evidence),
});

export type RouteWiringOptions = {
	queue: QueueService;
	capabilities: Capabilities;
	inference: unknown;
	clock?: Clock;
};

/**
 * Application-side composition of research-routes with the runtimes. The runtimes own their ports
 * and never import research-routes; this adapter converts between the two. `attach` supplies the
 * runtimes after construction (closure), so nothing executes a peer service while constructing.
 */
export function createRouteWiring(opts: RouteWiringOptions) {
	const refs: { agents?: Agents; tools?: ToolRuntime } = {};
	const proposals = new Map<string, Proposal>();
	const bindings = new Map<string, BindingInfo>();
	const nowMs = () => opts.clock?.now() ?? Date.now();
	const prune = () => {
		const cutoff = nowMs() - memoryTtlMs;
		for (const map of [proposals, bindings] as Map<
			string,
			{ createdAt: number }
		>[])
			if (map.size > memoryLimit)
				for (const [k, v] of map) if (v.createdAt < cutoff) map.delete(k);
	};

	const adoption: SourceAdoptionPort = {
		validateInTransaction(db, input) {
			const agents = refs.agents;
			if (!agents) return { status: "rejected", code: "runtime_unavailable" };
			const evidence = agents.getAdoptedEvidenceInTransaction(db, {
				rootRunId: input.runId,
				ticketId: input.ticketId,
				reportEpoch: input.reportEpoch,
			});
			if (
				!evidence ||
				!agents.validateAdoptedEvidenceInTransaction(db, evidence)
			)
				return { status: "rejected", code: "source_run_unavailable" };
			if (evidence.childTaskId !== input.taskId)
				return { status: "rejected", code: "source_task_mismatch" };
			return { status: "allowed" };
		},
		protectedBindingsInTransaction() {
			const cutoff = nowMs() - memoryTtlMs;
			const ids = new Set<string>();
			for (const b of bindings.values())
				if (
					b.kind === "direct" &&
					b.versionId &&
					!b.released &&
					b.createdAt >= cutoff
				)
					ids.add(b.versionId);
			return [...ids];
		},
	};
	const learning =
		typeof (opts.inference as MaintenanceInference | undefined)
			?.captureMaintenanceControlInTransaction === "function"
			? {
					queue: opts.queue,
					capabilities: opts.capabilities,
					inference: opts.inference as MaintenanceInference,
					adoption,
				}
			: undefined;
	const routes: ResearchRoutes = createResearchRoutes({
		clock: opts.clock,
		externalBytes: (db) =>
			opts.capabilities.learnedUsageInTransaction(db).bytes,
		prune: (db, input) =>
			opts.capabilities.pruneLearnedInTransaction(db, input),
		queue: opts.queue,
		adoption,
		learning,
	});

	/** Cached authority is valid only while the same key incarnation/generation still serves it. */
	function routeValid(db: Database, info: BindingInfo): boolean {
		if (info.kind === "search" || !info.fence) return false;
		const r = routes.getRouteInTransaction(db, info.fence.key);
		if (!r) return false;
		const row = r.row;
		if (
			row.epoch !== info.fence.epoch ||
			row.incarnation !== info.fence.incarnation ||
			row.generation !== info.fence.generation ||
			!row.enabled
		)
			return false;
		if (info.kind === "direct") {
			// The version this run used must still be healthy. A newer healthy version becoming
			// active meanwhile does not revoke an answer fetched through the older one.
			const rev = info.versionId
				? ledger.getRevision(db, info.versionId)
				: null;
			return (
				!!rev &&
				rev.incarnation === info.fence.incarnation &&
				!ledger.getHealth(db, rev.version_id)
			);
		}
		const c = ledger.getCandidate(db, info.fence.epoch, info.fence.key);
		return !!c && c.digest === info.candidateDigest;
	}
	const sameOwner = (a: Owner, b: Owner) =>
		a.taskId === b.taskId && a.rootRunId === b.rootRunId;

	const acquisition: AcquisitionPlanPort = {
		resolveInTransaction(db, input) {
			const built = buildSearchSpec(input.question);
			if (built.kind === "ambiguous")
				return {
					kind: "clarification",
					question: "対象の地点を市の名前で教えてください。",
				};
			if (built.kind === "unsupported") return { kind: "unmatched" };
			const binding = bindRequest(built.spec, input.requestAtMs);
			let lookup = routes.lookupInTransaction(db, built.spec, binding);
			// A replacement after a site-side failure is a real search even when the ledger still
			// considers the route healthy (e.g. provider throttling does not disqualify it).
			if (
				input.replaceReason &&
				(lookup.kind === "direct" || lookup.kind === "candidate")
			)
				lookup = {
					kind: "lookup",
					reason: "source_failure",
					fence: lookup.fence,
				};
			if (lookup.kind === "unavailable")
				return { kind: "unavailable", code: lookup.code };
			prune();
			const proposalToken = crypto.randomUUID();
			proposals.set(proposalToken, {
				rootRunId: input.rootRunId,
				spec: built.spec,
				binding,
				lookup,
				createdAt: nowMs(),
			});
			switch (lookup.kind) {
				case "direct": {
					const rev = ledger.getRevision(db, lookup.versionId);
					if (!rev)
						return { kind: "unavailable", code: "route_revision_missing" };
					return {
						kind: "direct",
						proposalToken,
						packageRevisionId: rev.package_revision_id,
					};
				}
				case "candidate":
					return { kind: "candidate", proposalToken };
				// disabled/capacity/new key: a normal search; learning is decided by the fence.
				default:
					return {
						kind: "search-first",
						proposalToken,
						query: built.spec.keywords,
						language: built.spec.language,
						region: built.spec.region,
					};
			}
		},
		bindInTransaction(db, input) {
			const p = proposals.get(input.proposalToken);
			if (!p) return { kind: "rejected", code: "proposal_unknown" };
			const owner = input.childOwner;
			if (owner.rootRunId !== p.rootRunId)
				return { kind: "rejected", code: "owner_mismatch" };
			const bindingToken = crypto.randomUUID();
			const base = {
				owner,
				spec: p.spec,
				binding: p.binding,
				createdAt: nowMs(),
			};
			const lk = p.lookup;
			let packageRevisionId = coldPackageRevisionId;
			let initialAction: AcquisitionInitialAction;
			let info: BindingInfo;
			if (lk.kind === "direct") {
				const rev = ledger.getRevision(db, lk.versionId);
				if (!rev) return { kind: "rejected", code: "route_revision_missing" };
				packageRevisionId = rev.package_revision_id;
				info = {
					...base,
					kind: "direct",
					fence: lk.fence,
					versionId: lk.versionId,
					recipe: lk.recipe,
				};
				initialAction = {
					kind: "direct-invoke",
					toolId: lk.recipe.toolId,
					arguments: lk.recipe.arguments,
					exactUrl: lk.recipe.sourceUrl,
					attemptTimeoutMs: warmAttemptTimeoutMs,
				};
			} else if (lk.kind === "candidate") {
				const c = ledger.getCandidate(db, lk.fence.epoch, lk.fence.key);
				if (!c || c.digest !== lk.candidateDigest)
					return { kind: "rejected", code: "candidate_unavailable" };
				const hits = JSON.parse(c.hits_json) as {
					url: string;
					title: string;
					snippet: string;
				}[];
				const provenance: NonNullable<AcquisitionLookupProvenance> = {
					origin: "lookup",
					runId: c.source_run_id,
					stepId: c.source_step_id,
					query: p.spec.keywords,
					searchedAt: c.searched_at,
					provider: c.provider_version,
					digest: c.digest,
				};
				info = {
					...base,
					kind: "candidate",
					fence: lk.fence,
					candidateDigest: c.digest,
					candidateUrls: hits.map((h) => h.url),
					original: provenance,
				};
				initialAction = {
					kind: "candidate-import",
					query: p.spec.keywords,
					searchedAt: c.searched_at,
					provenanceDigest: c.digest,
					hits,
					provenance,
				};
			} else if (lk.kind === "lookup" || lk.kind === "disabled") {
				info = {
					...base,
					kind: "search",
					fence: lk.kind === "lookup" ? lk.fence : null,
				};
				initialAction = {
					kind: "host-lookup",
					query: p.spec.keywords,
					language: p.spec.language,
					region: p.spec.region,
				};
			} else return { kind: "rejected", code: "route_unavailable" };
			bindings.set(bindingToken, info);
			return { kind: "bound", bindingToken, packageRevisionId, initialAction };
		},
		validateInTransaction(db, input) {
			const info = bindings.get(input.bindingToken);
			if (!info || info.released)
				return { kind: "rejected", code: "binding_unknown" };
			if (!sameOwner(info.owner, input.owner))
				return { kind: "rejected", code: "owner_mismatch" };
			if (info.kind !== "search" && !routeValid(db, info))
				return { kind: "rejected", code: "route_revoked" };
			return { kind: "allowed" };
		},
		recordObservationInTransaction(db, input) {
			const info = bindings.get(input.bindingToken);
			if (!info || info.released)
				return { kind: "policy_unavailable", code: "binding_unknown" };
			if (!sameOwner(info.owner, input.owner))
				return { kind: "policy_unavailable", code: "owner_mismatch" };
			const sources = input.visibleSources;
			const provenance = input.lookupProvenance as LookupProvenance | null;
			const hitUrls = [
				...new Set([
					...sources.filter((s) => s.basis === "snippet").map((s) => s.url),
					...(info.candidateUrls ?? []),
				]),
			];
			// A real lookup's hits become the 24h candidate. The finish below runs in a savepoint
			// that rolls back on a failed check, so the hits are stored now (valid path) and again
			// at release (durable even when the check fails and the savepoint is undone).
			if (
				info.fence &&
				provenance?.origin === "lookup" &&
				info.kind === "search"
			) {
				const hits = sources
					.filter((s) => s.basis === "snippet")
					.slice(0, 5)
					.map((s) => ({
						url: s.url,
						title: "",
						snippet: s.body.slice(0, 400),
					}));
				if (hits.length) {
					info.pendingCandidates = {
						fence: info.fence,
						provenance,
						hits,
					};
					routes.storeCandidatesInTransaction(db, {
						fence: info.fence,
						provenance,
						hits,
						providerVersion: provenance.provider,
					});
				}
			}
			const used = input.tools
				.map((t) => toolIdOf(t.toolId))
				.filter((t): t is RouteRecipe["toolId"] => !!t);
			const result = routes.recordObservationInTransaction(db, {
				fence: info.fence,
				spec: info.spec,
				binding: info.binding,
				owner: { rootRunId: input.owner.rootRunId, taskId: input.owner.taskId },
				toolId: info.recipe?.toolId ?? used.at(-1) ?? "web.read",
				sources,
				...reportEvidence(input),
				lookupProvenance: provenance,
				originalProvenance: info.original ?? null,
				lookupHitUrls: hitUrls,
				warm: info.kind === "direct",
			});
			if (result.kind === "valid") {
				info.proofId = result.proofId;
				info.projectionDigest = result.projectionDigest;
				return {
					kind: "valid",
					proofId: result.proofId,
					canonicalReportPatch: result.canonicalReportPatch,
					safeProjection: result.projection,
					projectionDigest: result.projectionDigest,
				};
			}
			if (
				result.kind === "source_unusable" &&
				info.kind === "direct" &&
				info.versionId &&
				info.fence
			)
				routes.recordRouteFailureInTransaction(db, {
					versionId: info.versionId,
					fence: info.fence,
					failure: "source_unusable",
				});
			return result;
		},
		validateAdoptionInTransaction(db, input) {
			const info = bindings.get(input.bindingToken);
			if (!info) return { kind: "rejected", code: "binding_unknown" };
			if (!sameOwner(info.owner, input.owner))
				return { kind: "rejected", code: "owner_mismatch" };
			if (
				info.projectionDigest &&
				info.projectionDigest !== input.projectionDigest
			)
				return { kind: "rejected", code: "projection_mismatch" };
			// Cached authority is re-checked at adoption; a normal lookup answer survives a clear.
			if (info.kind !== "search" && !routeValid(db, info))
				return { kind: "rejected", code: "route_revoked" };
			return { kind: "allowed" };
		},
		releaseInTransaction(db, input) {
			const info = bindings.get(input.bindingToken);
			if (!info || !sameOwner(info.owner, input.owner))
				return { kind: "stale" };
			// The runtime's own durable fact comes first: a failed finish is rolled back with its
			// savepoint, so the observation-time verdict reaches the ledger through this release.
			if (info.pendingCandidates) {
				const c = info.pendingCandidates;
				info.pendingCandidates = undefined;
				try {
					routes.storeCandidatesInTransaction(db, {
						fence: c.fence,
						provenance: c.provenance,
						hits: c.hits,
						providerVersion: c.provenance.provider,
					});
				} catch {
					// candidates are an optimisation only
				}
			}
			// A cached route that failed on the site side (tool error, or unusable material
			// reported by the runtime) is disqualified before the runtime swaps in a search.
			if (info.kind === "direct" && info.versionId && info.fence) {
				const fromReason =
					input.reason === "source_unusable"
						? "source_unusable"
						: input.reason
							? siteFailure[input.reason]
							: undefined;
				const failed =
					fromReason ??
					(refs.tools
						? refs.tools
								.summaryInTransaction(db, info.owner.taskId)
								.map((o) =>
									o.errorCode ? siteFailure[o.errorCode] : undefined,
								)
								.find((f) => !!f)
						: undefined);
				if (failed)
					routes.recordRouteFailureInTransaction(db, {
						versionId: info.versionId,
						fence: info.fence,
						failure: failed,
					});
			}
			info.released = true;
			return { kind: "released" };
		},
	};

	const cachedSource: CachedSourceAuthorizationPort = {
		validateInTransaction(db, input) {
			const info = bindings.get(input.bindingToken);
			if (!info || info.released)
				return { status: "rejected", code: "binding_unknown" };
			if (!sameOwner(info.owner, input.owner))
				return { status: "rejected", code: "owner_mismatch" };
			if (info.kind === "search")
				return { status: "rejected", code: "not_cached" };
			const inScope =
				info.kind === "direct"
					? input.exactUrl === info.recipe?.sourceUrl
					: !!info.candidateUrls?.includes(input.exactUrl);
			if (!inScope) return { status: "rejected", code: "url_out_of_scope" };
			if (!routeValid(db, info))
				return { status: "rejected", code: "route_revoked" };
			return { status: "allowed" };
		},
	};

	const rawObserver: PostAnswerObserverPort = {
		recordInTransaction(db, input) {
			const agents = refs.agents;
			if (!agents) return { status: "skipped", code: "runtime_unavailable" };
			const evidence = agents.getAdoptedEvidenceInTransaction(db, {
				rootRunId: input.runId,
				ticketId: input.ticketId,
				reportEpoch: input.reportEpoch,
			});
			if (!evidence) return { status: "skipped", code: "no_evidence" };
			if (!evidence.bindingToken)
				return { status: "skipped", code: "not_route" };
			const info = bindings.get(evidence.bindingToken);
			if (!info) return { status: "skipped", code: "binding_unknown" };
			if (info.kind === "direct") {
				if (!info.versionId || !info.fence)
					return { status: "skipped", code: "no_fence" };
				// Warm success only refreshes use time; it never creates a proof, draft or job.
				const used = routes.recordRouteUseInTransaction(db, {
					versionId: info.versionId,
					fence: info.fence,
					usedAt: nowMs(),
				});
				return used.kind === "updated"
					? { status: "recorded" }
					: { status: "skipped", code: "stale" };
			}
			if (!info.proofId) return { status: "skipped", code: "no_proof" };
			const r = routes.recordAdoptedProofAndEnqueueInTransaction(db, {
				proofId: info.proofId,
				ticketId: input.ticketId,
				reportEpoch: input.reportEpoch,
			});
			return r.kind === "recorded"
				? { status: "recorded" }
				: { status: "skipped", code: r.code };
		},
	};

	// Operational metadata only: ids and a fixed skip code, never keywords, bodies or proofs.
	const observer: PostAnswerObserverPort = {
		recordInTransaction(db, input) {
			const result = rawObserver.recordInTransaction(db, input);
			if (result.status === "skipped" && result.code !== "not_route")
				log.info("research_routes.learning_skipped", {
					runId: input.runId,
					reason: result.code,
				});
			return result;
		},
	};

	return {
		routes,
		acquisition,
		cachedSource,
		observer,
		adoption,
		attach(next: { agents: Agents; tools: ToolRuntime }) {
			refs.agents = next.agents;
			refs.tools = next.tools;
		},
		/** Queue handlers for author/review; empty when no maintenance inference is available. */
		handlers: () => [
			...(learning ? routes.handlers() : []),
			...routes.maintenanceHandlers(),
		],
	};
}
export type RouteWiring = ReturnType<typeof createRouteWiring>;
