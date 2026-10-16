import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations as worldPackageMigrations } from "eumenes-world-model/sqlite";
import { openStore } from "../../../infrastructure/sqlite";
import {
	CONVERSATION_DEFAULT_PRINCIPAL,
	CONVERSATION_DEFAULT_SCOPE,
	createConversationService,
} from "../../conversation";
import {
	createConversationSourceAdapter,
	createWorldCuration,
	createWorldHostGate,
	createWorldLifecycle,
	createWorldService,
	migrations as worldMigrations,
	type IntakePorts,
	type WorldApplyRequest,
} from "../../world";
import { migrations as stewardHostMigrations } from "./steward.fixture";

const migrations = [
	...stewardHostMigrations,
	...worldPackageMigrations,
	...worldMigrations,
];

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

/**
 * The real World (package, store, lifecycle, curation) on the steward host schema plus World's, for the tests that hold the
 * steward to World's own behavior. The steward and memory are built over its store and conversation.
 */
export async function openRealWorld(intake: Partial<IntakePorts>) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-steward-world-"));
	const store = openStore(join(dir, "db.sqlite3"), migrations);
	const gate = createWorldHostGate("closed");
	const conversation = createConversationService(store, {
		requireOutbox: true,
	});
	const adapter = createConversationSourceAdapter(conversation, {
		allowedPurposes: [PURPOSE],
		cursorSecret: "test-only-world-cursor-secret",
	});
	const world = createWorldService({
		store,
		policyRevision: (db: Database) =>
			String(
				(
					db
						.query("SELECT revision FROM memory_host_settings WHERE id = 1")
						.get() as { revision: number }
				).revision,
			),
		sources: [adapter],
		gate,
	});
	const lifecycle = createWorldLifecycle({
		store,
		world,
		journalPath: join(dir, "world-journal.jsonl"),
		gate,
		purpose: PURPOSE,
		sources: [adapter],
		scopes: [SCOPE],
		clock: () => NOW,
		intake,
	});
	await store.write((db) => {
		db.exec("CREATE TABLE host_probe (n INTEGER NOT NULL)");
	});
	await world.markInitialSyncComplete();
	await world.setEnabled(true);
	if ((await lifecycle.recoverWorld()).status !== "open")
		throw new Error("world_not_open");
	const curation = createWorldCuration({
		world,
		lifecycle,
		sources: [adapter],
		intake: {
			isAdoptedAnswer: intake.isAdoptedAnswer ?? (() => false),
			blockedMessageIds: intake.blockedMessageIds ?? (() => new Set()),
		},
		gate,
		purpose: PURPOSE,
		clock: () => NOW,
	});
	const registerEntity = () =>
		world.apply({
			access: ACCESS,
			scope: SCOPE,
			operationKey: "e-1",
			clock: NOW,
			operation: {
				kind: "entity.register",
				entity: {
					id: "svc-1",
					displayName: "音声サービス",
					aliases: ["音声"],
					externalRefs: [],
				},
			},
		} as WorldApplyRequest);
	return {
		dir,
		store,
		conversation,
		world,
		lifecycle,
		curation,
		registerEntity,
		async cleanup() {
			await store.close().catch(() => {});
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
export type RealWorld = Awaited<ReturnType<typeof openRealWorld>>;
