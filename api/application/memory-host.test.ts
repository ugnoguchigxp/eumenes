import { expect, test } from "bun:test";
import {
	existsSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CONTRACT_VERSIONS } from "eumenes-memory";
import { planForget } from "eumenes-memory/sqlite";
import { readProfile, request, type HostConfig } from "eumenes-memory-host";
import { createMemoryHostConnection } from "./memory-host";
import { setupMemory, saveItem } from "../domains/memory/test/memory.fixture";
import { PRINCIPAL, PROFILE_SCOPE } from "../domains/memory/contracts";

async function setup() {
	const h = await setupMemory();
	const before = readdirSync(h.dir).sort();
	const owner = createMemoryHostConnection(h.memory, h.dir);
	expect(readdirSync(h.dir).sort()).toEqual(before);
	return {
		h,
		owner,
		close: async () => {
			await owner.close();
			await h.close();
		},
	};
}

test("host recovery does not repeat committed or reapplied application forgets", async () => {
	const { h, owner, close } = await setup();
	try {
		const committed = await h.say("user", "Already forgotten");
		const interrupted = await h.say("user", "Journaled before interruption");
		const purge = (messageId: string) => ({
			conversationId: "c1",
			itemIds: [],
			messageIds: [messageId],
		});
		expect((await h.memory.forget(purge(committed))).completed).toBe(true);
		const purged: string[] = [];
		h.memory.registerForgetPurge((_db, input) => {
			purged.push(...input.messageIds);
		});
		await expect(
			h.store.write((db) => {
				h.memory.forgetInTransaction(db, purge(interrupted));
				throw new Error("interrupted");
			}),
		).rejects.toThrow("interrupted");
		// The transaction hook ran before rollback. The queued reconciliation then applies the durable entry.
		expect(await h.memory.recover()).toMatchObject({ healthy: true });
		expect(purged).toEqual([interrupted, interrupted]);
		const fence = h.store.read(h.memory.forgetSeqInTransaction);

		await owner.recover();
		expect(owner.status().state).toBe("recovered");
		expect(purged).toEqual([interrupted, interrupted]);
		expect(h.store.read(h.memory.forgetSeqInTransaction)).toBe(fence);
		expect(h.memory.blockedMessageIds([committed, interrupted])).toEqual(
			new Set([committed, interrupted]),
		);
	} finally {
		await close();
	}
});

test("recovery passes a host-origin forget's State IDs to application cleanup", async () => {
	const { h, owner, close } = await setup();
	try {
		const messageId = await h.say("user", "I walk in the morning");
		const item = await saveItem(h.store, h.memory, {
			conversationId: "c1",
			messageId,
			kind: "habit",
			semanticKey: "morning-walk",
			text: "Walk in the morning",
			quote: "I walk in the morning",
		});
		const planned = h.store.read((db) =>
			planForget(db, {
				contractVersion: CONTRACT_VERSIONS.lifecycle,
				access: {
					principal: PRINCIPAL,
					scopeKeys: [PROFILE_SCOPE],
					purpose: "memory.forget",
					policyRevision: h.memory.policyRevisionInTransaction(db),
				},
				targets: [
					{ type: "state_item", scopeKey: PROFILE_SCOPE, itemId: item.id },
				],
				hostIntent: { "host.states": [item.id] },
				clock: { atMs: Date.parse(h.time.now) },
			}),
		);
		if (planned.status !== "planned") throw new Error("forget not planned");
		h.memory.sharedHost.journal.append(planned.plan.entry);
		const purged: string[] = [];
		h.memory.registerForgetPurge((_db, input) => {
			purged.push(...input.itemIds);
		});
		expect(await h.memory.recover()).toMatchObject({
			healthy: true,
			reapplied: 1,
		});
		expect(purged).toEqual([]);
		await owner.recover();
		expect(owner.status().state).toBe("recovered");
		expect(purged).toEqual([item.id]);
	} finally {
		await close();
	}
});

test("app memory host recovers first, gates requests until start, and reuses the app's writer and sources", async () => {
	const { h, owner, close } = await setup();
	try {
		await owner.recover();
		expect(owner.status().state).toBe("recovered");
		const profile = readProfile(owner.profilePath);
		expect(statSync(dirname(owner.profilePath)).mode & 0o777).toBe(0o700);
		expect(statSync(owner.profilePath).mode & 0o777).toBe(0o600);
		const config = JSON.parse(
			readFileSync(join(dirname(owner.profilePath), "owner.json"), "utf8"),
		) as HostConfig;
		expect(config.credentials[profile.credential]).toMatchObject({
			scopeKeys: [PROFILE_SCOPE],
			confirmedWrites: false,
		});
		expect(readdirSync(dirname(owner.profilePath)).sort()).toEqual([
			"owner.json",
			"profile.json",
		]);
		await owner.listen();
		expect(await request(profile, "status", {})).toMatchObject({
			code: "HOST_NOT_READY",
		});
		owner.start();
		expect((await request(profile, "status", {})).status).toBe("ready");
		const messageId = await h.say("user", "朝だけ散歩を楽しみます");
		const item = await saveItem(h.store, h.memory, {
			conversationId: "c1",
			messageId,
			kind: "habit",
			semanticKey: "runtime-walk",
			text: "朝だけ散歩を楽しむ",
			quote: "朝だけ散歩を楽しみます",
		});
		const context = await request(profile, "context", {});
		expect(context["items"]).toMatchObject([
			{ itemId: item.id, evidenceStatus: "current" },
		]);
		const result = await h.memory.forget({
			conversationId: "c1",
			itemIds: [item.id],
			messageIds: [messageId],
		});
		expect(result.completed).toBe(true);
		expect((await request(profile, "context", {}))["items"]).toEqual([]);
		await h.memory.setEnabled(false);
		expect(await request(profile, "context", {})).toMatchObject({
			code: "HOST_NOT_READY",
		});
		await h.memory.setEnabled(true);
		expect((await request(profile, "status", {})).status).toBe("ready");
	} finally {
		await close();
	}
});

test("app memory host keeps its profile across restarts and enforces current credential grants", async () => {
	const { owner, close } = await setup();
	try {
		await owner.recover();
		await owner.listen();
		owner.start();
		const before = readFileSync(owner.profilePath, "utf8");
		const profile = readProfile(owner.profilePath);
		const first = await request(profile, "status", {});
		await owner.close();
		expect(existsSync(owner.socketPath)).toBe(false);
		await owner.recover();
		await owner.listen();
		owner.start();
		expect(readFileSync(owner.profilePath, "utf8")).toBe(before);
		expect((await request(profile, "status", {}))["epoch"]).not.toBe(
			first["epoch"],
		);
		const path = join(dirname(owner.profilePath), "owner.json");
		const config = JSON.parse(readFileSync(path, "utf8")) as HostConfig;
		delete config.credentials[profile.credential];
		writeFileSync(path, JSON.stringify(config));
		expect(await request(profile, "context", {})).toMatchObject({
			code: "AUTH_REQUIRED",
		});
	} finally {
		await close();
	}
});

test("an invalid existing profile stays untouched and does not disable the application API memory", async () => {
	const { h, owner, close } = await setup();
	try {
		await owner.recover();
		await owner.close();
		const invalid = JSON.stringify({
			version: 1,
			socketPath: owner.socketPath,
			credential: "wrong",
		});
		writeFileSync(owner.profilePath, invalid);
		await owner.recover();
		await owner.listen();
		owner.start();
		expect(owner.status().state).toBe("unavailable");
		expect(h.memory.status().healthy).toBe(true);
		expect(readFileSync(owner.profilePath, "utf8")).toBe(invalid);
	} finally {
		await close();
	}
});

test("a regular file at the socket path is never unlinked or overwritten", async () => {
	const { h, owner, close } = await setup();
	try {
		await owner.recover();
		writeFileSync(owner.socketPath, "existing-file");
		await owner.listen();
		owner.start();
		expect(owner.status().state).toBe("unavailable");
		await owner.close();
		expect(readFileSync(owner.socketPath, "utf8")).toBe("existing-file");
		expect(h.memory.status().healthy).toBe(true);
	} finally {
		await close();
	}
});

test("unhealthy app memory publishes no host or configuration", async () => {
	const { h, owner, close } = await setup();
	try {
		writeFileSync(join(h.dir, "journal.jsonl"), "invalid\n");
		expect((await h.memory.recover()).healthy).toBe(false);
		await owner.recover();
		await owner.listen();
		owner.start();
		expect(owner.status().state).toBe("unavailable");
		expect(existsSync(owner.profilePath)).toBe(false);
	} finally {
		await close();
	}
});

test("a broken live host configuration refuses MCP but cannot block the app's own purge", async () => {
	const { h, owner, close } = await setup();
	try {
		await owner.recover();
		await owner.listen();
		owner.start();
		const profile = readProfile(owner.profilePath);
		const messageId = await h.say("user", "検証用の観測です");
		const item = await saveItem(h.store, h.memory, {
			conversationId: "c1",
			messageId,
			kind: "personal_fact",
			semanticKey: "host-config-failure",
			text: "検証用の観測がある",
		});
		expect((await request(profile, "context", {})).status).toBe("context");
		writeFileSync(join(dirname(owner.profilePath), "owner.json"), "invalid\n");
		expect((await request(profile, "status", {})).status).toBe("failed");
		expect(
			(
				await h.memory.forget({
					conversationId: "c1",
					itemIds: [item.id],
					messageIds: [messageId],
				})
			).completed,
		).toBe(true);
		expect(h.memory.status().healthy).toBe(true);
	} finally {
		await close();
	}
});
