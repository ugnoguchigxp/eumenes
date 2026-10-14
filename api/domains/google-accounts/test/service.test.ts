import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createGoogleAccounts } from "../service";
import { migrations, read, save } from "../repository";
import { seal, unseal } from "../secrets";
import {
	GoogleAccountError,
	type Authorization,
	type GoogleProvider,
} from "../contracts";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) await fn();
});
function setup() {
	const dir = mkdtempSync(join(tmpdir(), "google-account-test-"));
	const store = openStore(
		join(dir, "db.sqlite3"),
		migrations.map((m) => ({ ...m, after: [] })),
	);
	cleanups.push(async () => {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	let time = 1_000_000;
	const key = () => new Uint8Array(32).fill(7);
	let authorization: Authorization;
	const calls = { refresh: 0, revoke: 0, exchange: 0 };
	const provider: GoogleProvider = {
		identity: "google-client",
		authorization(a) {
			authorization = a;
			return "https://accounts.google.com/?state=" + a.state;
		},
		async exchange() {
			calls.exchange++;
			return {
				profile: { sub: "person-1", name: "花子", email: "hanako@example.com" },
				tokens: {
					refresh: "private-refresh",
					access: "private-access",
					expires: time + 3600_000,
				},
			};
		},
		async refresh() {
			calls.refresh++;
			return {
				refresh: "private-refresh",
				access: "new-access",
				expires: time + 3600_000,
			};
		},
		async revoke() {
			calls.revoke++;
		},
	};
	const service = createGoogleAccounts(store, {
		key,
		provider,
		now: () => time,
	});
	const begin = async () => {
		const flow = await service.begin(service.view().revision);
		return {
			state: authorization!.state,
			browser: flow.browser,
			code: "private-code",
		};
	};
	return {
		store,
		key,
		provider,
		service,
		calls,
		begin,
		advance: (ms: number) => {
			time += ms;
		},
		reopen: () =>
			createGoogleAccounts(store, { key, provider, now: () => time }),
	};
}
test("connect persists encrypted credentials and exposes only public identity across reopening", async () => {
	const h = setup();
	const flow = await h.begin();
	expect(h.service.view().pending).toBe(true);
	expect(await h.service.finish(flow)).toBe("connected");
	expect(h.reopen().view()).toMatchObject({
		status: "connected",
		profile: { sub: "person-1" },
		pending: false,
	});
	const publicJson = JSON.stringify(h.service.view()),
		stored = JSON.stringify(h.store.read(read));
	for (const secret of [
		"private-refresh",
		"private-access",
		"private-code",
		flow.browser,
		flow.state,
	]) {
		expect(publicJson).not.toContain(secret);
		expect(stored).not.toContain(secret);
	}
	await expect(h.service.finish(flow)).rejects.toThrow("invalid_authorization");
	expect(h.calls.exchange).toBe(1);
});
test("state and browser binding reject forged callbacks without consuming the valid attempt", async () => {
	const h = setup();
	const flow = await h.begin();
	await expect(
		h.service.finish({ ...flow, browser: "other-browser" }),
	).rejects.toThrow("invalid_authorization");
	await expect(
		h.service.finish({ ...flow, state: "wrong-state" }),
	).rejects.toThrow("invalid_authorization");
	expect(h.calls.exchange).toBe(0);
	expect(await h.service.finish(flow)).toBe("connected");
});
test("denial and expired attempts never exchange a code; fresh authorization still works", async () => {
	const h = setup();
	let flow = await h.begin();
	expect(await h.service.finish({ ...flow, denied: true })).toBe("cancelled");
	expect(h.service.view().pending).toBe(false);
	flow = await h.begin();
	h.advance(600_001);
	await expect(h.service.finish(flow)).rejects.toThrow("invalid_authorization");
	expect(h.calls.exchange).toBe(0);
	await h.service.maintain();
	expect(h.service.view().result).toBe("expired");
	expect(await h.service.finish(await h.begin())).toBe("connected");
});
test("a cancelled in-flight exchange cannot restore a connection", async () => {
	const h = setup();
	const flow = await h.begin();
	const original = h.provider.exchange;
	let release!: () => void;
	let entered!: () => void;
	const started = new Promise<void>((r) => {
		entered = r;
	});
	const wait = new Promise<void>((r) => {
		release = r;
	});
	h.provider.exchange = async (...args) => {
		entered();
		await wait;
		return original(...args);
	};
	const shownRevision = h.service.view().revision;
	const completion = h.service.finish(flow);
	await started;
	try {
		await h.service.cancel(shownRevision);
	} finally {
		release();
		await completion;
	}
	expect(await completion).toBe("failed");
	expect(h.service.view()).toMatchObject({
		status: "disconnected",
		result: "cancelled",
		pending: false,
	});
});
test("revision conflicts, wrong identity on reconnect, and changed OAuth client fail closed", async () => {
	const h = setup();
	const flow = await h.begin();
	await expect(h.service.begin(0)).rejects.toThrow("conflict");
	await h.service.finish(flow);
	const changed = createGoogleAccounts(h.store, {
		key: h.key,
		provider: { ...h.provider, identity: "different-client" },
	});
	expect(changed.view().status).toBe("reconnect");
	expect(changed.view().result).toBeUndefined();
	const next = await h.begin();
	const original = h.provider.exchange;
	h.provider.exchange = async (...args) => {
		const r = await original(...args);
		return { ...r, profile: { ...r.profile, sub: "other-person" } };
	};
	expect(await h.service.finish(next)).toBe("failed");
	expect(h.service.view().profile?.sub).toBe("person-1");
});
test("refresh detects revocation, while network outages retain the account and retry", async () => {
	const h = setup();
	await h.service.finish(await h.begin());
	h.advance(3600_000);
	h.provider.refresh = async () => {
		throw new GoogleAccountError("provider_unavailable");
	};
	await h.service.maintain();
	expect(h.service.view().status).toBe("connected");
	h.provider.refresh = async () => {
		throw new GoogleAccountError("invalid_grant");
	};
	h.advance(60_001);
	await h.service.maintain();
	expect(h.service.view().status).toBe("reconnect");
	expect(h.service.view().result).toBeUndefined();
});
test("refresh completion after disconnect is discarded and pending revocation survives restart", async () => {
	const h = setup();
	await h.service.finish(await h.begin());
	h.advance(3600_000);
	let release!: () => void, entered!: () => void;
	const started = new Promise<void>((r) => {
		entered = r;
	});
	const waiting = new Promise<void>((r) => {
		release = r;
	});
	const original = h.provider.refresh;
	h.provider.refresh = async (token) => {
		entered();
		await waiting;
		return original(token);
	};
	const refresh = h.service.maintain();
	await started;
	h.provider.revoke = async () => {
		throw new GoogleAccountError("provider_unavailable");
	};
	await expect(h.service.disconnect(h.service.view().revision)).rejects.toThrow(
		"provider_unavailable",
	);
	expect(h.reopen().view().status).toBe("disconnecting");
	release();
	await refresh;
	expect(h.service.view().status).toBe("disconnecting");
	h.provider.revoke = async () => {};
	await h.reopen().maintain();
	expect(h.service.view()).toMatchObject({ status: "disconnected" });
	expect(h.service.view().profile).toBeUndefined();
});
test("missing config/key disables authorization without exposing stored secrets", async () => {
	const h = setup();
	const service = createGoogleAccounts(h.store, { key: () => undefined });
	expect(service.view().configured).toBe(false);
	await expect(service.begin(0)).rejects.toThrow("unconfigured");
});

test("background token maintenance preserves the displayed revision across reopening", async () => {
	const h = setup();
	await h.service.finish(await h.begin());
	const shown = h.service.view();
	h.advance(3600_000);
	await h.service.maintain();
	expect(h.calls.refresh).toBe(1);
	expect(h.reopen().view()).toEqual(shown);
	h.advance(3600_000);
	h.provider.refresh = async () => {
		throw new GoogleAccountError("provider_unavailable");
	};
	await h.service.maintain();
	expect(h.reopen().view()).toEqual(shown);
	await h.service.disconnect(shown.revision);
	expect(h.service.view().status).toBe("disconnected");
});
test("disconnect and maintenance share revocation; cancellation cannot interrupt unlink", async () => {
	const h = setup();
	await h.service.finish(await h.begin());
	let release!: () => void, entered!: () => void;
	const started = new Promise<void>((r) => {
		entered = r;
	});
	const waiting = new Promise<void>((r) => {
		release = r;
	});
	h.provider.revoke = async () => {
		h.calls.revoke++;
		entered();
		await waiting;
	};
	const disconnect = h.service.disconnect(h.service.view().revision);
	await started;
	const maintenance = h.service.maintain();
	try {
		await expect(h.service.cancel(h.service.view().revision)).rejects.toThrow(
			"conflict",
		);
	} finally {
		release();
		await Promise.all([disconnect, maintenance]);
	}
	expect(h.calls.revoke).toBe(1);
	expect(h.service.view().status).toBe("disconnected");
});

for (const offline of [false, true])
	test(`disconnect revokes late authorization, offline=${offline}`, async () => {
		const h = setup();
		await h.service.finish(await h.begin());
		const flow = await h.begin();
		const original = h.provider.exchange;
		let release!: () => void, entered!: () => void;
		const started = new Promise<void>((r) => {
			entered = r;
		});
		const waiting = new Promise<void>((r) => {
			release = r;
		});
		h.provider.exchange = async (...args) => {
			entered();
			await waiting;
			const result = await original(...args);
			return {
				...result,
				tokens: { ...result.tokens, refresh: "late-refresh" },
			};
		};
		const revoked: string[] = [];
		h.provider.revoke = async (token) => {
			revoked.push(token);
			if (offline) throw new GoogleAccountError("provider_unavailable");
		};
		const completion = h.service.finish(flow);
		await started;
		const disconnect = h.service
			.disconnect(h.service.view().revision)
			.catch((error) => {
				if (!offline) throw error;
			});
		// Flush the disconnect's transaction without waiting for external authorization.
		await h.store.write(() => {});
		const maintenance = h.service.maintain();
		release();
		await Promise.all([disconnect, maintenance, completion]);
		if (offline) {
			expect(h.reopen().view().status).toBe("disconnecting");
			h.provider.revoke = async (token) => {
				revoked.push(token);
			};
			h.advance(60_001);
			await h.reopen().maintain();
		}
		expect(h.service.view().status).toBe("disconnected");
		expect(revoked).toContain("late-refresh");
		expect(revoked.filter((x) => x === "late-refresh")).toHaveLength(1);
	});

test("old encrypted records retain their public revision when maintenance first upgrades them", async () => {
	const h = setup();
	await h.service.finish(await h.begin());
	await h.store.write((db) => {
		const row = read(db);
		const state = unseal<Record<string, unknown>>(row.sealed!, h.key());
		delete state.viewRevision;
		save(db, row.revision, seal(state, h.key()));
	});
	const shown = h.reopen().view();
	h.advance(3600_000);
	await h.service.maintain();
	expect(h.reopen().view()).toEqual(shown);
	await h.service.disconnect(shown.revision);
	expect(h.service.view().revision).toBeGreaterThan(shown.revision);
});
test("unreadable stored credentials report an error rather than an unconnected account", async () => {
	const h = setup();
	await h.service.finish(await h.begin());
	const wrongKey = createGoogleAccounts(h.store, {
		key: () => new Uint8Array(32).fill(9),
		provider: h.provider,
	});
	expect(() => wrongKey.view()).toThrow("unconfigured");
	expect(h.service.view().status).toBe("connected");
});
