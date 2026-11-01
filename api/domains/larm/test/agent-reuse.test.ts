import { expect, jest, test } from "bun:test";
import { createAgentLarm } from "..";
import type { LarmCallOptions } from "../contracts";
import { waitFor, settle } from "../../../infrastructure/wait-for";
import { capacityFixture, messages, owner } from "./agent-capacity.fixture";

const signal = () => AbortSignal.timeout(5000);
const flush = async () => {
	for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};

test("missing main/conversation owner is refused before a catalog or connection can allocate an anonymous main", async () => {
	const f = capacityFixture(),
		p = f.port();
	try {
		for (const options of [
			{ sessionRole: "main" },
			{ sessionRole: "auxiliary", onConversation: true },
			{
				...owner("main"),
				agentSession: { conversationId: null, agentId: "request-id" },
			},
		] satisfies LarmCallOptions[]) {
			await expect(p.answer(messages, signal(), options)).rejects.toThrow(
				"larm_agent_identity_required",
			);
		}
		expect(f.creates).toHaveLength(0);
		expect(p.inspect!().agentConnections).toEqual([]);
	} finally {
		await p.close();
	}
});

test("initial probe and screen presence allocate no shared LLM; foreground and conversation background share one main", async () => {
	const f = capacityFixture(),
		p = createAgentLarm({ ...f.config, keepAlive: true });
	const main = owner("main", "conversation-a", "conversation-a");
	try {
		await p.connect();
		await p.probe!(signal());
		p.retain!(true);
		await flush();
		expect(f.creates).toHaveLength(0);
		await p.answer(messages, signal(), main);
		for (let i = 0; i < 4; i++)
			await p.answer(messages, signal(), {
				sessionRole: "auxiliary",
				onConversation: true,
				agentSession: main.agentSession,
			});
		await p.answer(messages, signal(), main);
		expect(f.bindings.size).toBe(1);
		expect(f.creates.every((r) => r.body.contextTokens === 200000)).toBeTrue();
		expect(new Set(f.generations.map((g) => g.id)).size).toBe(1);
		expect(
			new Set(f.generations.map((g) => g.body.prompt_cache_key)).size,
		).toBe(1);
		expect(p.inspect!().agentConnections).toHaveLength(1);
	} finally {
		await p.close();
	}
});

test("twenty idle minutes, hidden-screen notification and renewal do not add connections or lose the 200k main", async () => {
	jest.useFakeTimers();
	const f = capacityFixture(),
		p = createAgentLarm({ ...f.config, keepAlive: true });
	try {
		await p.answer(messages, new AbortController().signal, owner("main"));
		p.retain!(false);
		for (let i = 0; i < 40; i++) {
			jest.advanceTimersByTime(30000);
			await flush();
		}
		expect(p.status().state).toBe("ready");
		expect(f.bindings.size).toBe(1);
		expect(new Set(f.creates.map((c) => c.id)).size).toBe(1);
		expect(f.creates.length).toBeGreaterThan(20);
		expect(f.creates.every((r) => r.body.contextTokens === 200000)).toBeTrue();
		expect(f.claims.length).toBeGreaterThanOrEqual(2);
		expect(f.generations).toHaveLength(1);
	} finally {
		await p.close();
		jest.useRealTimers();
	}
});

test("a ready connection with an expired semantic cache is health-checked, re-read and claimed without recreation", async () => {
	const f = capacityFixture(),
		p = f.port();
	f.controls.claimable = false;
	f.controls.probeReady = true;
	try {
		expect(await p.answer(messages, signal(), owner("main"))).toBe("ok");
		expect(f.controls.healthCalls).toBe(1);
		expect(f.controls.polls).toBeGreaterThan(0);
		expect(f.creates).toHaveLength(1);
		expect(f.claims).toHaveLength(1);
		expect(f.generations).toHaveLength(1);
	} finally {
		await p.close();
	}
});

test("independent one-shot calls release their default-capacity connections and leave no growing management entries", async () => {
	const f = capacityFixture(),
		p = f.port();
	try {
		for (let i = 0; i < 4; i++)
			await p.answer(messages, signal(), {
				sessionRole: "auxiliary",
				agentSession: { conversationId: null, agentId: `request-${i}` },
			});
		expect(p.inspect!().agentConnections).toEqual([]);
		expect(
			[...f.bindings.values()].every(
				(b) => b.released && b.capacity === 131072,
			),
		).toBeTrue();
		expect(
			f.creates.every((r) => !Object.hasOwn(r.body, "contextTokens")),
		).toBeTrue();
	} finally {
		await p.close();
	}
});

test("an explicit task end releases only its own sub connection, while live task calls and the main reuse theirs", async () => {
	const f = capacityFixture(),
		p = f.port();
	try {
		for (const options of [
			owner("main"),
			owner("subagent", "a", "one"),
			owner("subagent", "a", "one"),
			owner("subagent", "a", "two"),
		])
			await p.answer(messages, signal(), options);
		expect(f.generations[1]!.id).toBe(f.generations[2]!.id);
		await p.releaseTaskSession!("one");
		expect(f.bindings.get(f.generations[1]!.id)!.released).toBeTrue();
		expect(f.bindings.get(f.generations[0]!.id)!.released).toBeFalse();
		expect(f.bindings.get(f.generations[3]!.id)!.released).toBeFalse();
		expect(p.inspect!().agentConnections).toHaveLength(2);
	} finally {
		await p.close();
	}
});

test("task release waits for active generation to finish naturally instead of aborting or replaying it", async () => {
	const f = capacityFixture(),
		p = f.port(),
		gate = Promise.withResolvers<void>();
	let activeSignal: AbortSignal | undefined,
		released = false;
	f.controls.hold = (_id, abort) => {
		activeSignal = abort;
		return gate.promise;
	};
	const work = p.answer(messages, signal(), owner("subagent", "a", "one"));
	try {
		await waitFor(() => f.generations.length === 1);
		const release = p.releaseTaskSession!("one").then(() => {
			released = true;
		});
		await settle();
		expect(released).toBeFalse();
		expect(activeSignal!.aborted).toBeFalse();
		gate.resolve();
		expect(await work).toBe("ok");
		await release;
		expect(f.generations).toHaveLength(1);
		expect([...f.bindings.values()][0]!.released).toBeTrue();
	} finally {
		gate.resolve();
		await p.close();
	}
});
