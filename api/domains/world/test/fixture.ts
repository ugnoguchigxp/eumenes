import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceRef } from "eumenes-memory";
import { planAssertionTransition } from "eumenes-world-model";
import { migrations } from "../../../application/migrations";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import {
	CONVERSATION_DEFAULT_PRINCIPAL,
	CONVERSATION_DEFAULT_SCOPE,
	createConversationService,
	type ConversationService,
} from "../../conversation";
import {
	createConversationSourceAdapter,
	createWorldService,
	sourceKeyOf,
	type WorldApplyRequest,
	type WorldService,
	type WorldServiceOptions,
} from "..";

export const PURPOSE = "world.test";
export const SCOPE = {
	principal: CONVERSATION_DEFAULT_PRINCIPAL,
	scopeKey: CONVERSATION_DEFAULT_SCOPE,
};
export const NOW = 1791500000000;
export const ACCESS = {
	principal: SCOPE.principal,
	scopeKeys: [SCOPE.scopeKey],
	purpose: PURPOSE,
};

/** What the memory service's access() reads: memory_host_settings.revision. */
export const memoryPolicyRevision = (db: Database): string =>
	String(
		(
			db
				.query("SELECT revision FROM memory_host_settings WHERE id = 1")
				.get() as { revision: number }
		).revision,
	);

export type Harness = {
	store: SqliteStore;
	conversation: ConversationService;
	world: WorldService;
	path: string;
	cleanup(): Promise<void>;
};

/** A temp-file store with the REAL production migrations (host, Memory, World). */
export async function openHarness(
	over: Partial<WorldServiceOptions> = {},
	options: { enabled?: boolean } = {},
): Promise<Harness> {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-world-host-"));
	const path = join(dir, "db.sqlite3");
	let store: SqliteStore | undefined;
	try {
		store = openStore(path, migrations);
		await store.write((db) => {
			db.exec(
				"CREATE TABLE host_probe (n INTEGER NOT NULL); CREATE TABLE host_queue (cursor TEXT NOT NULL);",
			);
		});
		const conversation = createConversationService(store, {
			requireOutbox: true,
		});
		const world = createWorldService({
			store,
			policyRevision: memoryPolicyRevision,
			...over,
			// Extra adapters are added to (never replace) the conversation adapter.
			sources: [
				createConversationSourceAdapter(conversation, {
					allowedPurposes: [PURPOSE],
				}),
				...(over.sources ?? []),
			],
		});
		if (options.enabled !== false) await world.setEnabled(true);
		const opened = store;
		return {
			store: opened,
			conversation,
			world,
			path,
			async cleanup() {
				await opened.close().catch(() => {});
				rmSync(dir, { recursive: true, force: true });
			},
		};
	} catch (error) {
		await store?.close().catch(() => {});
		rmSync(dir, { recursive: true, force: true });
		throw error;
	}
}

export async function withHarness<T>(
	run: (h: Harness) => Promise<T>,
	over: Partial<WorldServiceOptions> = {},
	options: { enabled?: boolean } = {},
): Promise<T> {
	const harness = await openHarness(over, options);
	try {
		return await run(harness);
	} finally {
		await harness.cleanup();
	}
}

export const probe = (db: Database) => {
	db.query("INSERT INTO host_probe (n) VALUES (1)").run();
	db.query("INSERT INTO host_queue (cursor) VALUES ('advanced')").run();
};

export async function addMessage(
	h: Harness,
	id: string,
	text: string,
	role: "user" | "assistant" = "user",
): Promise<void> {
	await h.conversation.append({
		id,
		conversationId: "c1",
		role,
		text,
		createdAt: "2026-10-09T00:00:00.000Z",
		runId: null,
	});
}

/** The CURRENT ref of a conversation message, as the host adapter reports it. */
export function currentRef(h: Harness, id: string): SourceRef {
	const state = h.store.read((db) =>
		h.conversation.sourceInTransaction(db, id),
	);
	if (state.state !== "available") throw new Error(`no source ${id}`);
	return {
		namespace: "conversation",
		kind: "message",
		id,
		representation: "text",
		revision: state.revision,
		digest: state.digest,
	};
}
export const keyOf = (id: string) =>
	sourceKeyOf({
		namespace: "conversation",
		kind: "message",
		id,
		representation: "text",
	});

export function claim(
	id: string,
	sources: readonly SourceRef[],
	extra: Record<string, unknown> = {},
) {
	const revision = (extra["revision"] as number | undefined) ?? 1;
	return {
		id,
		revision,
		scope: SCOPE,
		subjectId: "svc-1",
		predicate: "available",
		payload: { kind: "value", value: { kind: "boolean", value: true } },
		evidence: sources.slice(0, 1).map((source, i) => ({
			evidenceId: `ev-${id}-${i}`,
			kind: "user_statement",
			stance: "supports",
			source,
			rootEvidenceId: `root-${id}`,
		})),
		inputManifest: [...sources],
		origin: "user_report",
		recordedAt: NOW,
		freshnessPolicy: { maxAgeMs: 86_400_000 },
		condition: { kind: "unspecified" },
		supersedes: [],
		contradicts: [],
		interpretationVersion: "interp-1",
		lifecycle: "candidate",
		rootEvidenceIds: [`root-${id}`],
		...extra,
	};
}

export function adoptPlan(
	id: string,
	revision: number,
	lifecycle = "candidate",
) {
	const result = planAssertionTransition({
		contractVersion: 1,
		scope: SCOPE,
		current: { id, revision, scope: SCOPE, lifecycle, origin: "user_report" },
		expectedRevision: revision,
		request: {
			action: "adopt",
			adoption: { kind: "explicit", operationId: `op-adopt-${id}` },
			subjectConfirmedByHost: true,
		},
		registeredAdoptionRules: [],
	} as never);
	if (!result.ok || result.value.status !== "planned")
		throw new Error(`plan failed: ${JSON.stringify(result)}`);
	return result.value.plan;
}

export const request = (
	operationKey: string,
	operation: unknown,
): WorldApplyRequest => ({
	access: ACCESS,
	scope: SCOPE,
	operationKey,
	clock: NOW,
	operation: operation as WorldApplyRequest["operation"],
});
export const registerClaim = (
	key: string,
	assertion: ReturnType<typeof claim>,
) => request(key, { kind: "assertion.register", assertion });
export const entityOp = (key = "e-1") =>
	request(key, {
		kind: "entity.register",
		entity: {
			id: "svc-1",
			displayName: "音声サービス",
			aliases: ["音声"],
			externalRefs: [],
		},
	});

export const count = (h: Harness, table: string): number =>
	(
		h.store.read((db) =>
			db.query(`SELECT COUNT(*) AS n FROM ${table}`).get(),
		) as { n: number }
	).n;

/** Memory's external dependency edges written by World. */
export const worldEdges = (h: Harness) =>
	h.store.read((db) =>
		db
			.query(
				`SELECT dependent_id, dependency_type, dependency_id FROM memory_dependency
				WHERE dependent_type = 'external' AND dependent_id LIKE 'eumenes-world:%'
				ORDER BY dependent_id, dependency_id`,
			)
			.all(),
	) as {
		dependent_id: string;
		dependency_type: string;
		dependency_id: string;
	}[];

export const WORLD_TABLES = [
	"world_entity",
	"world_assertion",
	"world_assertion_head",
	"world_transition",
	"world_evidence",
	"world_assertion_input",
	"world_current",
	"world_edge",
	"world_scope_epoch",
	"world_operation",
	"world_tombstone",
];
/** Whole-content dump of World + Memory dependency + host rows for rollback equality. */
export function dump(h: Harness): Record<string, unknown[]> {
	return h.store.read((db) =>
		Object.fromEntries(
			[
				...WORLD_TABLES,
				"memory_dependency",
				"memory_seq",
				"host_probe",
				"host_queue",
			].map((table) => [
				table,
				db.query(`SELECT * FROM ${table} ORDER BY rowid`).all(),
			]),
		),
	);
}
