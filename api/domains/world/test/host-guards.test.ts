/**
 * Host-level guards added in review round 1: World cannot be switched ON
 * before the host's initial sync, and the conversation cursor secret has no
 * public default.
 */
import { expect, test } from "bun:test";
import { WorldHostStateError, createConversationSourceAdapter } from "..";
import { createConversationService } from "../../conversation";
import { openStore } from "../../../infrastructure/sqlite";
import { migrations } from "../../../application/migrations";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PURPOSE, TEST_CURSOR_SECRET, withHarness } from "./fixture";

test("World stays OFF and cannot be turned ON before the host recorded its initial sync", async () => {
	await withHarness(
		async (h) => {
			expect(h.world.status().enabled).toBe(false);
			const error = await h.world.setEnabled(true).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(WorldHostStateError);
			expect((error as WorldHostStateError).code).toBe("initial_sync_required");
			expect(h.world.status().enabled).toBe(false);
			// The writer-side form is guarded too.
			await expect(
				h.store.write((db) => h.world.setEnabledInWriter(db, true)),
			).rejects.toBeInstanceOf(WorldHostStateError);
			// Turning it OFF never needs the flag.
			await h.world.setEnabled(false);

			await h.world.markInitialSyncComplete();
			await h.world.setEnabled(true);
			expect(h.world.status()).toMatchObject({ enabled: true, usable: true });
			// The flag is durable and not undone by switching OFF.
			await h.world.setEnabled(false);
			await h.world.setEnabled(true);
		},
		{},
		{ enabled: false, initialSync: false },
	);
});

test("the conversation cursor secret is required: no public default exists", () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-world-secret-"));
	const store = openStore(join(dir, "db.sqlite3"), migrations);
	try {
		const conversation = createConversationService(store, {
			requireOutbox: true,
		});
		const make = (options: object) => () =>
			createConversationSourceAdapter(conversation, {
				allowedPurposes: [PURPOSE],
				...options,
			} as never);
		expect(make({})).toThrow("world_cursor_secret_required");
		expect(make({ cursorSecret: "" })).toThrow("world_cursor_secret_required");
		expect(make({ cursorSecret: "short" })).toThrow(
			"world_cursor_secret_required",
		);
		expect(make({ cursorSecret: TEST_CURSOR_SECRET })).not.toThrow();
	} finally {
		void store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a cursor cannot be decoded or forged with another secret", async () => {
	await withHarness(async (h) => {
		const make = (cursorSecret: string) =>
			createConversationSourceAdapter(h.conversation, {
				allowedPurposes: [PURPOSE],
				cursorSecret,
			});
		await h.conversation.append({
			id: "m1",
			conversationId: "c1",
			role: "user",
			text: "a",
			createdAt: "2026-10-09T00:00:00.000Z",
			runId: null,
		});
		const access = {
			principal: "local:owner",
			scopeKeys: ["profile:owner"],
			purpose: PURPOSE,
			policyRevision: "1",
		};
		const page = h.store.read((db) =>
			make("secret-one-123").listChanges(db, access, {
				cursor: null,
				limit: 10,
			}),
		);
		expect(page.nextCursor).toMatch(/^c1\.[0-9a-f]{14}\.[0-9a-f]{12}$/);
		// Not the raw sequence, and useless under another secret.
		expect(page.nextCursor).not.toContain(".00000000000001.");
		expect(() =>
			h.store.read((db) =>
				make("secret-two-456").listChanges(db, access, {
					cursor: page.nextCursor,
					limit: 10,
				}),
			),
		).toThrow("invalid_source_cursor");
	});
});
