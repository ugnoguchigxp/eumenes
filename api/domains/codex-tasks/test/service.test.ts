import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { createCodexTasks, migrations } from "..";
import type { SdkReceipt, SdkActivity } from "../../coding";
import type { CodexEnqueue } from "../contracts";

const stores: SqliteStore[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const store of stores.splice(0)) await store.close();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "codex-task-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db.sqlite"), [
		{ id: "queue/0001-init", sql: "SELECT 1" },
		...migrations,
	]);
	stores.push(store);
	return { store, service: createCodexTasks({ store }) };
}
function input(): CodexEnqueue {
	return {
		scope: "shared-board",
		cardId: "card",
		runId: "attempt",
		requestId: "request",
		runnerId: "runner",
		executorRevision: 1,
		workspaceRef: "shared",
		guardEpoch: "guard-epoch",
		workerRevision: "profile:fixture-worker@1",
		settingsRevision: 1,
		spec: {
			protocol: "eumenes-codex-sdk/1",
			executionId: "attempt",
			ownerId: "card",
			workspaceId: "fixture",
			prompt: "fixture only",
			deadline: new Date(Date.now() + 60_000).toISOString(),
		},
	};
}
function packet(digest: string): {
	receipt: SdkReceipt;
	events: SdkActivity[];
} {
	const at = new Date().toISOString();
	return {
		receipt: {
			protocol: "eumenes-codex-sdk/1",
			executionId: "attempt",
			ownerId: "card",
			workspaceId: "fixture",
			digest,
			epoch: "runner-epoch",
			state: "succeeded",
			seq: 2,
			threadId: "native-thread",
			report: {
				outcome: "done",
				summary: "verified",
				verification: [],
				files: [],
				unconfirmed: [],
				blocker: "",
			},
			managedExecutionStopped: true,
			workspaceReleaseConfirmed: false,
			workspaceHeld: true,
			createdAt: at,
			updatedAt: at,
		},
		events: [
			{ seq: 1, at, type: "turn.started" },
			{ seq: 2, at, type: "turn.completed" },
		],
	};
}

test("outbox acceptance is durable and immutable; publication intent prevents cancellation races", async () => {
	const h = fixture();
	const value = input();
	const first = await h.store.write((tx) =>
		h.service.enqueueInTransaction(tx, value),
	);
	expect(first.state).toBe("accepted");
	expect(
		await h.store.write((tx) => h.service.enqueueInTransaction(tx, value)),
	).toEqual(first);
	await expect(
		h.store.write((tx) =>
			h.service.enqueueInTransaction(tx, {
				...value,
				spec: { ...value.spec, prompt: "changed" },
			}),
		),
	).rejects.toThrow("codex_request_conflict");
	expect(
		await h.store.write((tx) =>
			h.service.beginPublishInTransaction(tx, first.id),
		),
	).toBe(true);
	expect(
		await h.store.write((tx) =>
			h.service.beginPublishInTransaction(tx, first.id),
		),
	).toBe(false);
	expect(
		await h.store.write((tx) =>
			h.service.cancelQueuedInTransaction(tx, first.id),
		),
	).toBe(false);
	expect(h.service.pending()[0]!.published).toBe(true);
});

test("event pages are ordered, replay-safe, scope checked and final adoption waits for the full cursor", async () => {
	const h = fixture();
	const accepted = await h.store.write((tx) =>
		h.service.enqueueInTransaction(tx, input()),
	);
	const frame = packet(accepted.digest);
	const partial = await h.store.write((tx) =>
		h.service.observeInTransaction(tx, accepted.scope, accepted.id, {
			receipt: frame.receipt,
			events: [frame.events[0]!],
		}),
	);
	expect(partial).toMatchObject({ seq: 1, state: "accepted", receipt: null });
	await expect(
		h.store.write((tx) => h.service.markAdoptedInTransaction(tx, accepted.id)),
	).rejects.toThrow("codex_adoption_unconfirmed");
	const complete = await h.store.write((tx) =>
		h.service.observeInTransaction(tx, accepted.scope, accepted.id, frame),
	);
	expect(complete).toMatchObject({ seq: 2, state: "succeeded" });
	expect(
		h.store.readSnapshot((tx) =>
			h.service.activityInTransaction(tx, accepted.scope, accepted.id, 1),
		),
	).toEqual([frame.events[1]!]);
	expect(() =>
		h.store.readSnapshot((tx) =>
			h.service.activityInTransaction(tx, "other-scope", accepted.id, 0),
		),
	).toThrow("codex_attempt_missing");
	await h.store.write((tx) =>
		h.service.markAdoptedInTransaction(tx, accepted.id),
	);
	expect(
		await h.store.write((tx) =>
			h.service.observeInTransaction(tx, accepted.scope, accepted.id, frame),
		),
	).toBeNull();
	expect(h.service.pending()).toEqual([]);
});

test("identity mismatches and cursor gaps roll back all activity/result writes", async () => {
	const h = fixture();
	const accepted = await h.store.write((tx) =>
		h.service.enqueueInTransaction(tx, input()),
	);
	const frame = packet(accepted.digest);
	await expect(
		h.store.write((tx) =>
			h.service.observeInTransaction(tx, accepted.scope, accepted.id, {
				...frame,
				receipt: { ...frame.receipt, ownerId: "other-card" },
			}),
		),
	).rejects.toThrow("codex_execution_identity_mismatch");
	await expect(
		h.store.write((tx) =>
			h.service.observeInTransaction(tx, accepted.scope, accepted.id, {
				...frame,
				events: [frame.events[1]!],
			}),
		),
	).rejects.toThrow("codex_event_gap");
	expect(h.service.pending()[0]!.seq).toBe(0);
	expect(
		h.store.readSnapshot((tx) =>
			h.service.activityInTransaction(tx, accepted.scope, accepted.id, 0),
		),
	).toEqual([]);
});

test("a done report without managed termination or with a contradictory outcome cannot be adopted", async () => {
	const h = fixture();
	const accepted = await h.store.write((tx) =>
		h.service.enqueueInTransaction(tx, input()),
	);
	const frame = packet(accepted.digest);
	await expect(
		h.store.write((tx) =>
			h.service.observeInTransaction(tx, accepted.scope, accepted.id, {
				...frame,
				receipt: { ...frame.receipt, managedExecutionStopped: false },
			}),
		),
	).rejects.toThrow("codex_result_unconfirmed");
	await expect(
		h.store.write((tx) =>
			h.service.observeInTransaction(tx, accepted.scope, accepted.id, {
				...frame,
				receipt: {
					...frame.receipt,
					report: { ...frame.receipt.report!, outcome: "blocked" },
				},
			}),
		),
	).rejects.toThrow("codex_result_unconfirmed");
	expect(h.service.pending()[0]!.state).toBe("accepted");
});

test("backend disconnect cannot discard an accepted execution; results and shared adoption rollback together", async () => {
	const h = fixture();
	const accepted = await h.store.write((tx) =>
		h.service.enqueueInTransaction(tx, input()),
	);
	const frame = packet(accepted.digest);
	await expect(
		h.store.write((tx) => {
			h.service.observeInTransaction(tx, accepted.scope, accepted.id, frame);
			h.service.markAdoptedInTransaction(tx, accepted.id);
			throw new Error("shared_adoption_failed");
		}),
	).rejects.toThrow("shared_adoption_failed");
	expect(h.service.pending()[0]).toMatchObject({
		seq: 0,
		adopted: false,
		published: false,
	});
	await h.store.write((tx) => {
		h.service.observeInTransaction(tx, accepted.scope, accepted.id, frame);
		h.service.markAdoptedInTransaction(tx, accepted.id);
	});
	expect(h.service.pending()).toEqual([]);
});

test("configuration uses registered IDs and SQLite revision; incomplete or arbitrary paths never enable execution", async () => {
	const h = fixture();
	const allowed = {
		runners: ["runner"],
		workspaces: ["fixture"],
		resources: ["00000000-0000-4000-8000-000000000001"],
	};
	const change = {
		expectedRevision: 0,
		enabled: true,
		runnerId: "runner",
		workspaceId: "fixture",
		resourceId: allowed.resources[0],
	};
	await expect(
		h.store.write((tx) =>
			h.service.configureInTransaction(
				tx,
				{ ...change, resourceId: null },
				allowed,
			),
		),
	).rejects.toThrow("codex_configuration_incomplete");
	await expect(
		h.store.write((tx) =>
			h.service.configureInTransaction(
				tx,
				{ ...change, workspaceId: "unregistered" },
				allowed,
			),
		),
	).rejects.toThrow("codex_configuration_unregistered");
	expect(
		await h.store.write((tx) =>
			h.service.configureInTransaction(tx, change, allowed),
		),
	).toMatchObject({
		revision: 1,
		enabled: true,
		resourceId: allowed.resources[0],
	});
	await expect(
		h.store.write((tx) =>
			h.service.configureInTransaction(tx, change, allowed),
		),
	).rejects.toThrow("revision_conflict");
});

test("Git success requires the frozen group/target and verified SHA; commit proof cannot be lost", async () => {
	const h = fixture();
	const value = input();
	value.spec.git = {
		grantId: "ui-grant",
		mode: "commit_push",
		remoteId: "target",
		files: ["value.js"],
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
	};
	const accepted = await h.store.write((tx) =>
		h.service.enqueueInTransaction(tx, value),
	);
	const frame = packet(accepted.digest);
	await expect(
		h.store.write((tx) =>
			h.service.observeInTransaction(tx, accepted.scope, accepted.id, frame),
		),
	).rejects.toThrow("codex_git_result_unconfirmed");
	const commitSha = "a".repeat(40);
	const git = {
		groupId: accepted.id,
		remoteId: "target",
		commitSha,
		commitVerified: true,
		pushVerified: false,
		unknown: false,
	};
	const commit = {
		...frame,
		receipt: {
			...frame.receipt,
			state: "running" as const,
			report: undefined,
			git,
		},
	};
	await h.store.write((tx) =>
		h.service.observeInTransaction(tx, accepted.scope, accepted.id, commit),
	);
	await expect(
		h.store.write((tx) =>
			h.service.observeInTransaction(tx, accepted.scope, accepted.id, {
				...frame,
				receipt: {
					...frame.receipt,
					git: {
						...git,
						commitSha: "b".repeat(40),
						pushVerified: true,
						remoteSha: "b".repeat(40),
					},
				},
			}),
		),
	).rejects.toThrow("codex_git_commit_conflict");
	await expect(
		h.store.write((tx) =>
			h.service.observeInTransaction(tx, accepted.scope, accepted.id, {
				...frame,
				receipt: {
					...frame.receipt,
					git: {
						...git,
						remoteId: "other",
						pushVerified: true,
						remoteSha: commitSha,
					},
				},
			}),
		),
	).rejects.toThrow("codex_git_identity_mismatch");
	const done = await h.store.write((tx) =>
		h.service.observeInTransaction(tx, accepted.scope, accepted.id, {
			...frame,
			receipt: {
				...frame.receipt,
				git: { ...git, pushVerified: true, remoteSha: commitSha },
			},
		}),
	);
	expect(done?.receipt?.git).toMatchObject({
		commitSha,
		remoteSha: commitSha,
		pushVerified: true,
	});
});

test("settings receipt replays an accepted revision without applying a second change", async () => {
	const h = fixture();
	const allowed = {
		runners: ["runner"],
		workspaces: ["fixture"],
		resources: [crypto.randomUUID()],
	};
	const change = {
		expectedRevision: 0,
		enabled: true,
		runnerId: "runner",
		workspaceId: "fixture",
		resourceId: allowed.resources[0],
	};
	const first = await h.store.write((tx) =>
		h.service.configureInTransaction(tx, change, allowed, "configure"),
	);
	expect(
		await h.store.write((tx) =>
			h.service.configureInTransaction(tx, change, allowed, "configure"),
		),
	).toEqual(first);
	expect(h.service.settings().revision).toBe(1);
	await expect(
		h.store.write((tx) =>
			h.service.configureInTransaction(
				tx,
				{ ...change, enabled: false },
				allowed,
				"configure",
			),
		),
	).rejects.toThrow("request_conflict");
});
