import { expect, test } from "bun:test";
import { waitFor } from "../../../infrastructure/wait-for";
import { capacityFixture, messages, owner } from "./agent-capacity.fixture";
import { createAgentLarm, createGenerationLanes } from "..";

const signal = () => AbortSignal.timeout(5000);

test("host agent metadata selects 200k main and omitted/default 128k sub; JSON and SSE use their own bearer", async () => {
	const f = capacityFixture(),
		p = f.port();
	try {
		expect(await p.answer(messages, signal(), owner("main"))).toBe("ok");
		const deltas: string[] = [];
		expect(
			await p.answerStream!(
				messages,
				signal(),
				(text) => deltas.push(text),
				owner("subagent"),
			),
		).toBe("ok");
		expect(deltas.join("")).toBe("ok");
		expect(f.creates[0]!.body.contextTokens).toBe(200000);
		expect(f.creates[1]!.body).not.toHaveProperty("contextTokens");
		expect([...f.bindings.values()].map((b) => b.capacity)).toEqual([
			200000, 131072,
		]);
		expect(new Set(f.creates.map((r) => r.body.client)).size).toBe(2);
		for (const g of f.generations) {
			expect(g.authorization).toContain(g.id);
			expect(Object.keys(g.body).sort()).toEqual([
				"max_tokens",
				"messages",
				"model",
				"prompt_cache_key",
				"stream",
			]);
			expect(g.body.messages).toEqual(messages);
		}
	} finally {
		await p.close();
	}
});

test("connection and opaque cache identities follow conversation, agent, role and history branch, not message prefixes", async () => {
	const f = capacityFixture(),
		p = f.port();
	try {
		await p.answer(messages, signal(), owner("main"));
		await p.answer(
			[{ role: "user", content: "different prefix" }],
			signal(),
			owner("main"),
		);
		await p.answer(messages, signal(), owner("main", "conversation-b"));
		await p.answer(
			messages,
			signal(),
			owner("main", "conversation-a", "main", "fork"),
		);
		await p.answer(
			messages,
			signal(),
			owner("subagent", "conversation-a", "main"),
		);
		await p.answer(
			messages,
			signal(),
			owner("subagent", "conversation-a", "other-agent"),
		);
		await p.answer(
			messages,
			signal(),
			owner("subagent", "conversation-a", "main"),
		);
		expect(f.creates).toHaveLength(5);
		expect(f.generations[0]!.id).toBe(f.generations[1]!.id);
		expect(f.generations[4]!.id).toBe(f.generations[6]!.id);
		expect(
			new Set(f.generations.map((g) => g.body.prompt_cache_key)).size,
		).toBe(5);
		expect(p.llmContextWindow!()).toBe(200000);
	} finally {
		await p.close();
	}
});

test("main capacity mismatch in readiness or claim never reaches generation", async () => {
	for (const wrong of ["wrongCapacity", "wrongClaimCapacity"] as const) {
		const f = capacityFixture(),
			p = f.port();
		f.controls[wrong] = true;
		try {
			await expect(p.answer(messages, signal(), owner("main"))).rejects.toThrow(
				"larm_agent_context_mismatch",
			);
			expect(f.generations).toHaveLength(0);
			expect([...f.bindings.values()].every((b) => b.released)).toBeTrue();
		} finally {
			await p.close();
		}
	}
});

test("ready HTTP success waits for provider claimable; creation transport retry reuses the UUID", async () => {
	const f = capacityFixture(),
		p = f.port();
	f.controls.claimable = false;
	f.controls.timeoutCreate = true;
	try {
		const work = p.answer(messages, signal(), owner("main"));
		await waitFor(() => f.controls.polls > 0);
		expect(f.claims).toHaveLength(0);
		expect(f.generations).toHaveLength(0);
		f.controls.claimable = true;
		expect(await work).toBe("ok");
		expect(f.creates).toHaveLength(2);
		expect(f.creates[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
		expect(f.creates[0]!.key).toBe(f.creates[1]!.key);
	} finally {
		await p.close();
	}
});

test("generation lanes admit main plus two subagents, queue extras and remove cancelled waiters across settings ports", async () => {
	const f = capacityFixture(),
		lanes = createGenerationLanes();
	const p = createAgentLarm(f.config, lanes),
		other = createAgentLarm({ ...f.config, speed: 1.2 }, lanes);
	let finish!: () => void;
	const held = new Promise<void>((resolve) => {
		finish = resolve;
	});
	f.controls.hold = (_id, abort) =>
		new Promise<void>((resolve, reject) => {
			void held.then(resolve);
			abort.addEventListener("abort", () => reject(abort.reason), {
				once: true,
			});
		});
	const cancelled = new AbortController();
	const first = [
		p.answer(messages, signal(), owner("main")),
		p.answer(messages, signal(), owner("subagent", "a", "one")),
		p.answer(messages, signal(), owner("subagent", "a", "two")),
	];
	try {
		await waitFor(() => f.generations.length === 3);
		const queued = other.answer(
			messages,
			cancelled.signal,
			owner("main", "other"),
		);
		const rejected = Promise.allSettled([queued]);
		const extra = p.answer(messages, signal(), owner("subagent", "a", "three"));
		cancelled.abort();
		expect((await rejected)[0]!.status).toBe("rejected");
		expect(f.generations).toHaveLength(3);
		finish();
		await Promise.all([...first, extra]);
		expect(f.generations).toHaveLength(4);
		expect(
			[...f.bindings.values()].filter((b) => b.capacity === 200000),
		).toHaveLength(1);
	} finally {
		finish();
		await Promise.all([p.close(), other.close()]);
	}
});

test("reclaim renews provider bearer before its own expiry; reconnect and boot changes retain role, capacity and cache identity", async () => {
	const f = capacityFixture(),
		p = f.port();
	try {
		for (const role of ["main", "subagent"] as const) {
			const options = owner(role);
			f.controls.credentialMs = 120000;
			await p.answer(messages, signal(), options);
			f.controls.credentialMs = 900000;
			await p.answer(messages, signal(), options);
			const [before, renewed] = f.generations.slice(-2);
			expect(before!.id).toBe(renewed!.id);
			expect(before!.authorization).not.toBe(renewed!.authorization);
			f.bindings.get(renewed!.id)!.released = true;
			await p.answer(messages, signal(), options);
			const after = f.generations.at(-1)!;
			expect(after.id).not.toBe(renewed!.id);
			expect(after.body.prompt_cache_key).toBe(before!.body.prompt_cache_key);
			expect(f.bindings.get(after.id)!.capacity).toBe(
				role === "main" ? 200000 : 131072,
			);
		}
	} finally {
		await p.close();
	}
});

test("unknown generation transport result does not regenerate or reconnect", async () => {
	const f = capacityFixture(),
		p = f.port();
	f.controls.generationError = true;
	try {
		await expect(p.answer(messages, signal(), owner("main"))).rejects.toThrow();
		expect(f.generations).toHaveLength(1);
		expect(f.creates).toHaveLength(1);
	} finally {
		await p.close();
	}
});

test("new port recovers the same client and prompt cache key without using a fixed connection id", async () => {
	const f = capacityFixture();
	let p = f.port();
	try {
		await p.answer(messages, signal(), owner("main"));
		await p.close();
		p = f.port();
		await p.answer(messages, signal(), owner("main"));
		expect(f.creates[0]!.body.client).toBe(f.creates[1]!.body.client);
		expect(f.generations[0]!.id).not.toBe(f.generations[1]!.id);
		expect(f.generations[0]!.body.prompt_cache_key).toBe(
			f.generations[1]!.body.prompt_cache_key,
		);
	} finally {
		await p.close();
	}
});
