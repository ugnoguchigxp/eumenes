import type { Database } from "bun:sqlite";
import type { AgentRuntime } from "../domains/agent-runtime";
import type { Owner } from "../domains/capabilities";
import type {
	ConversationService,
	HistoryOwner,
} from "../domains/conversation";
import type { ToolAdapter, Source } from "../domains/tool-runtime";
import type { WebResearchService } from "../domains/web-research";
import { readActionOriginInTransaction } from "../domains/dialogue";
export function createReadPorts(
	web: WebResearchService,
	conversation: ConversationService | undefined,
	runtime: () => AgentRuntime,
): Pick<
	ToolAdapter,
	| "operationFingerprintInTransaction"
	| "localInTransaction"
	| "prepareSourcesInTransaction"
	| "validateEvidenceInTransaction"
	| "releaseTask"
	| "releaseRoot"
> {
	function historyOwner(
		db: Database,
		owner: Owner,
		stage: "read" | "adopt",
	): HistoryOwner {
		const root = runtime().authorizeReadOwnerInTransaction(db, owner, stage);
		const origin = readActionOriginInTransaction(db, owner.rootRunId);
		if (!origin || !conversation) throw new Error("history_scope_unavailable");
		return {
			key:
				"agent:" +
				JSON.stringify([owner.rootRunId, owner.taskId, owner.cancelEpoch]),
			conversationId: origin.conversationId,
			deadline: root.deadline,
			excludeMessageId: origin.messageId,
		};
	}
	const historyRoots = new Map<string, Set<string>>();
	return {
		operationFingerprintInTransaction(db, r) {
			if (r.tool.id === "web.find" || r.tool.id === "web.read_saved") {
				try {
					return web.savedBodies.fingerprint(
						r.owner,
						r.arguments as { sourceRef: string },
						r.tool.id,
					);
				} catch (e) {
					// Invalid saved references still consume a local attempt and settle
					// as a failed observation; they never authorize an external fetch.
					if (
						e instanceof Error &&
						[
							"source_expired",
							"source_ref_invalid",
							"source_cursor_invalid",
							"body_unavailable",
						].includes(e.message)
					)
						return undefined;
					throw e;
				}
			}
			if (r.tool.id === "history.search" || r.tool.id === "history.read") {
				try {
					return conversation!.historyFingerprintInTransaction(
						db,
						historyOwner(db, r.owner, "read"),
						r.arguments,
						r.tool.id,
					);
				} catch (e) {
					if (e instanceof Error && e.message === "history_cursor_stale")
						return undefined;
					throw e;
				}
			}
			return undefined;
		},
		localInTransaction(db, r) {
			runtime().authorizeReadOwnerInTransaction(db, r.owner, "read");
			const base = {
				observedAt: new Date().toISOString(),
				hits: [],
				documents: [],
				failures: [],
			};
			if (r.tool.id === "web.find")
				return {
					state: "succeeded",
					result: {
						...base,
						notes: web.savedBodies.find(
							r.owner,
							r.arguments as {
								sourceRef: string;
								query: string;
								cursor?: string;
							},
						),
					},
				};
			if (r.tool.id === "web.read_saved")
				return {
					state: "succeeded",
					result: {
						...base,
						readings: [
							web.savedBodies.read(
								r.owner,
								r.arguments as {
									sourceRef: string;
									cursor?: string;
									start?: "head";
									characters?: number;
								},
							),
						],
					},
				};
			const owner = historyOwner(db, r.owner, "read");
			const keys = historyRoots.get(r.owner.rootRunId) ?? new Set<string>();
			keys.add(owner.key);
			historyRoots.set(r.owner.rootRunId, keys);
			const result =
				r.tool.id === "history.search"
					? conversation!.historySearchInTransaction(db, owner, r.arguments)
					: conversation!.historyReadInTransaction(db, owner, r.arguments);
			const messages =
				"candidates" in result ? result.candidates : result.messages;
			const readings: Source[] = messages.map((m) => ({
				kind: "conversation_source",
				sourceId: m.messageId,
				messageRef: m.messageRef,
				messageId: m.messageId,
				conversationId: m.conversationId,
				speaker: m.speaker,
				createdAt: m.createdAt,
				revision: m.revision,
				digest: m.digest,
				viewId: m.viewId,
				viewDigest: m.viewDigest,
				scopeRef: result.scope.scopeRef,
				start: m.start,
				end: m.end,
				nextCursor: m.nextCursor,
				title: "保存済み発言",
				basis: "conversation",
				fetchedAt: m.createdAt,
				body: m.text,
				truncated: m.truncated,
			}));
			return {
				state: "succeeded",
				result: {
					...base,
					readings,
					notes: {
						scope: result.scope,
						...("cursor" in result ? { cursor: result.cursor } : {}),
					},
					proofs: [
						{ kind: "conversation_source", scopeRef: result.scope.scopeRef },
					],
				},
			};
		},
		prepareSourcesInTransaction(db, inv, result) {
			if (
				result.readings ||
				inv.operation_id.startsWith("local:") ||
				!runtime().usesViewEvidenceInTransaction(db, inv.owner_task_id)
			)
				return undefined;
			const owner = {
				rootRunId: inv.root_run_id,
				taskId: inv.owner_task_id,
				cancelEpoch: inv.cancel_epoch ?? 0,
			};
			const root = runtime().authorizeReadOwnerInTransaction(db, owner, "read");
			const pages = web.savedBodies.issue(
				inv.operation_id,
				owner,
				root.deadline,
				inv.deadline,
			);
			const snippets: Source[] = result.hits.map((h) => {
				const sourceId = crypto.randomUUID();
				return {
					kind: "web_source",
					sourceId,
					viewId: crypto.randomUUID(),
					viewDigest: new Bun.CryptoHasher("sha256")
						.update(h.snippet)
						.digest("hex"),
					sourceRevision: sourceId,
					url: h.url,
					title: h.title,
					basis: "snippet",
					fetchedAt: result.observedAt,
					body: h.snippet,
					truncated: true,
				};
			});
			const unavailable = result.documents
				.filter((d) => !pages.some((p) => p.url === d.url))
				.map((d) => ({
					kind: "web_source" as const,
					sourceId: crypto.randomUUID(),
					viewId: crypto.randomUUID(),
					viewDigest: new Bun.CryptoHasher("sha256")
						.update(d.text.slice(0, 2400))
						.digest("hex"),
					url: d.url,
					title: d.title,
					basis: "page" as const,
					fetchedAt: d.fetchedAt,
					body: d.text.slice(0, 2400),
					truncated: true,
					acquisitionTruncated: d.truncated,
				}));
			if (unavailable.length)
				result.failures = [
					...result.failures,
					...unavailable.map((s) => ({ url: s.url, code: "body_unavailable" })),
				];
			return [...snippets, ...pages, ...unavailable];
		},
		validateEvidenceInTransaction(db, owner, sources, proofs) {
			try {
				runtime().authorizeReadOwnerInTransaction(db, owner, "adopt");
				if (
					!web.savedBodies.validate(
						owner,
						sources.filter((s) => s.sourceRef),
					)
				)
					return false;
				const history = sources.filter((s) => s.kind === "conversation_source");
				if (history.length || proofs.length) {
					const scope = historyOwner(db, owner, "adopt");
					for (const ref of new Set([
						...proofs.map((p) => p.scopeRef),
						...history.map((s) => s.scopeRef!),
					]))
						if (
							!conversation!.validateHistoryInTransaction(
								db,
								scope,
								ref,
								history
									.filter((s) => s.scopeRef === ref)
									.map((s) => ({
										viewId: s.viewId!,
										messageId: s.messageId!,
										revision: s.revision!,
										digest: s.digest!,
										viewDigest: s.viewDigest!,
									})),
							)
						)
							return false;
				}
				return true;
			} catch {
				return false;
			}
		},
		releaseTask: (taskId) => web.savedBodies.releaseTask(taskId),
		releaseRoot(rootRunId) {
			web.savedBodies.releaseRoot(rootRunId);
			for (const key of historyRoots.get(rootRunId) ?? [])
				conversation?.releaseHistory(key);
			historyRoots.delete(rootRunId);
		},
	};
}
