import { expect, test } from "bun:test";
import { createLarm } from "..";
import type { LarmPort } from "..";
import { waitFor as until, settle } from "../../../infrastructure/wait-for";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
function fixture() {
	type Connection = {
		id: string;
		client: string;
		profile: string;
		ready: boolean;
		expiresAt: number;
		token: number;
		providers: string[];
		terminal?: boolean;
		/** Claimed before: LARM's probe cache reports it unclaimable although a claim succeeds. */
		claimedBefore?: boolean;
	};
	const connections = new Map<string, Connection>();
	const bodies: Array<{ id: string; body: Record<string, unknown> }> = [];
	const inference = new Map<
		string,
		{ messages: unknown[]; output: ReturnType<typeof deferred<string>> }
	>();
	const claimed: string[] = [],
		released: string[] = [];
	const deleting: string[] = [];
	const controls = { releaseGate: null as Promise<void> | null };
	const specs = (_profile: string) =>
		["llm", "asr", "tts"].map((name) => ({
			name,
			protocol:
				name === "llm"
					? "openai.chat-completions.v1"
					: name === "asr"
						? "openai.audio-transcriptions.v1"
						: "openai.audio-speech.v1",
			endpoint:
				name === "llm"
					? "/v1/chat/completions"
					: name === "asr"
						? "/v1/audio/transcriptions"
						: "/v1/audio/speech",
			model: name === "llm" ? "fixture-llm" : `fixture-${name}`,
			...(name === "llm"
				? {
						contextWindow: {
							maxTokens: 262144,
							outputReserveTokens: 4096,
							safetyMarginTokens: 1976,
						},
					}
				: {}),
		}));
	const state = (c: Connection) => ({
		id: c.id,
		profile: c.profile,
		agentProfile: c.profile,
		catalogRevision: "revision",
		status: c.terminal ? "released" : c.ready ? "ready" : "pending",
		phase: c.ready ? "ready" : "waiting-capacity",
		expiresAt: new Date(c.expiresAt).toISOString(),
		providers: specs(c.profile)
			.filter((p) => c.providers.includes(p.name))
			.map((p) => ({
				...p,
				readiness: c.ready ? "ready" : "waiting",
				claimable: c.ready && !c.claimedBefore,
			})),
	});
	const request = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		if (url.pathname === "/v3/agent-profiles") {
			const profile = url.searchParams.get("profile")!;
			return Response.json({
				contractVersion: "agent-connection.v3",
				catalogRevision: "revision",
				requestedProfile: profile,
				profiles: [{ id: profile, providers: specs(profile) }],
			});
		}
		if (url.pathname === "/v1/agent-connections") {
			const body = JSON.parse(String(init?.body));
			expect(body.expectedCatalogRevision).toBe("revision");
			const reused = [...connections.values()].find(
				(c) => c.client === body.client && c.profile === body.profile,
			);
			if (reused) return Response.json(state(reused), { status: 201 });
			const id = `session${bodies.length}`;
			bodies.push({ id, body });
			const c = {
				id,
				client: body.client,
				profile: body.profile,
				providers: body.providers ?? ["llm", "asr", "tts"],
				ready: connections.size < 4,
				expiresAt: Date.now() + 900000,
				token: 1,
			};
			connections.set(id, c);
			return Response.json(state(c), { status: c.ready ? 201 : 202 });
		}
		if (url.pathname.startsWith("/v1/agent-connections/")) {
			const [, , , id, operation] = url.pathname.split("/");
			const c = connections.get(id!)!;
			if (init?.method === "DELETE") {
				deleting.push(id!);
				await controls.releaseGate;
				connections.delete(id!);
				released.push(id!);
				const waiting = [...connections.values()].find((x) => !x.ready);
				if (waiting) waiting.ready = true;
				return new Response(null, { status: 204 });
			}
			if (operation === "renew") {
				c.token++;
				c.expiresAt = Date.now() + 900000;
			}
			if (operation !== "claim") return Response.json(state(c));
			expect(c.ready).toBe(true);
			claimed.push(c.id);
			return Response.json({
				...state(c),
				providers: specs(c.profile)
					.filter((p) => c.providers.includes(p.name))
					.map((p) => ({
						...p,
						baseUrl: `http://127.0.0.1/${c.id}/${p.name}/v1`,
						endpoint: `http://127.0.0.1/${c.id}/${p.name}${p.endpoint}`,
						configuration: {
							fields: {
								baseURL: `http://127.0.0.1/${c.id}/${p.name}/v1`,
								model: p.model,
							},
						},
						credential: { token: `${c.id}-${p.name}-${c.token}` },
					})),
			});
		}
		const id = url.pathname.split("/")[1]!;
		const c = connections.get(id)!;
		expect(new Headers(init?.headers).get("Authorization")).toBe(
			`Bearer ${id}-llm-${c.token}`,
		);
		const body = JSON.parse(String(init?.body));
		expect(body.model).toBe("fixture-llm");
		expect(c.ready).toBe(true);
		const output = deferred<string>();
		inference.set(id, { messages: body.messages, output });
		const text = await Promise.race([
			output.promise,
			new Promise<never>((_, reject) =>
				init?.signal?.addEventListener(
					"abort",
					() => reject(init.signal?.reason),
					{ once: true },
				),
			),
		]);
		return Response.json({ choices: [{ message: { content: text } }] });
	};
	const create = (
		profile = "saved-profile",
		options: { client?: string; keepAlive?: boolean } = {},
	) =>
		createLarm({
			baseUrl: "http://127.0.0.1:9810",
			token: "control",
			profile,
			fetch: request,
			...options,
		});
	return {
		create,
		connections,
		bodies,
		inference,
		claimed,
		released,
		deleting,
		controls,
	};
}
const history = (key: string) => [
	{ role: "user" as const, content: `私の識別子は${key}です。` },
	{ role: "assistant" as const, content: `識別子${key}を記憶しました。` },
	{ role: "user" as const, content: "私の識別子を答えてください。" },
];

test("a replacement helper waits for the evicted connection's DELETE to finish before requesting capacity", async () => {
	const f = fixture();
	const main = f.create();
	const signal = AbortSignal.timeout(5000);
	const release = deferred<void>();
	const helper = (key: string) =>
		main.answer(history(key), signal, { sessionRole: "subagent", taskId: key });
	const work = [helper("first"), helper("busy")];
	try {
		await until(() => f.inference.size === 2);
		f.inference.get("session1")!.output.resolve("first");
		await work[0];
		f.controls.releaseGate = release.promise;
		work.push(helper("replacement"));
		await until(() => f.deleting.includes("session1"));
		await settle();
		// Main plus two helpers: replacement must not create a fourth connection yet.
		expect(f.bodies).toHaveLength(3);
		expect(f.inference.has("session3")).toBe(false);
		release.resolve();
		await until(() => f.inference.has("session3"));
		f.inference.get("session2")!.output.resolve("busy");
		f.inference.get("session3")!.output.resolve("replacement");
		expect(await Promise.all(work)).toEqual(["first", "busy", "replacement"]);
	} finally {
		release.resolve();
		const done = Promise.allSettled(work);
		await main.close();
		await done;
	}
});

test("a helper connection serves one prefix: the same instructions reuse it, a new prefix evicts the idle least-used one or waits", async () => {
	const f = fixture();
	const main = f.create();
	const signal = AbortSignal.timeout(10000);
	const helper = (key: string) =>
		main.answer(history(key), signal, { sessionRole: "auxiliary" });
	const work: Promise<string>[] = [];
	try {
		work.push(main.answer(history("main"), signal));
		await until(() => f.inference.size === 1);
		work.push(helper("a"), helper("b"));
		await until(() => f.inference.size === 3);
		expect(new Set([...f.connections.values()].map((c) => c.client)).size).toBe(
			3,
		);
		// Helpers always use the saved profile, whatever its name is, and only the llm provider.
		expect(f.bodies.map((x) => x.body.profile)).toEqual(
			Array(3).fill("saved-profile"),
		);
		for (const { body } of f.bodies) expect(body.providers).toEqual(["llm"]);
		expect(f.inference.get("session1")!.messages).toEqual(history("a"));
		expect(f.inference.get("session2")!.messages).toEqual(history("b"));
		// Both helper slots are busy: a third prefix waits without a connection.
		work.push(helper("c"));
		await Bun.sleep(20);
		expect(f.connections.size).toBe(3);
		f.inference.get("session1")!.output.resolve("a");
		expect(await work[1]).toBe("a");
		await until(() => f.inference.has("session3"));
		expect(f.released).toContain("session1");
		expect(f.inference.get("session3")!.messages).toEqual(history("c"));
		f.inference.get("session3")!.output.resolve("c");
		expect(await work[3]).toBe("c");
		// The same instructions again go to their held connection.
		for (const [id, entry] of f.inference) entry.output.resolve(id);
		await Promise.all(work);
		f.inference.clear();
		const again = helper("c");
		await until(() => f.inference.has("session3"));
		expect(f.bodies).toHaveLength(4);
		f.inference.get("session3")!.output.resolve("again");
		expect(await again).toBe("again");
	} finally {
		await main.close();
		await Promise.allSettled(work);
	}
	expect(f.connections.size).toBe(0);
});

test("cancelling while a helper release is pending never creates the replacement connection", async () => {
	const f = fixture();
	const main = f.create();
	const release = deferred<void>();
	const abort = new AbortController();
	const signal = AbortSignal.timeout(5000);
	const helper = (key: string, scoped = signal) =>
		main.answer(history(key), scoped, { sessionRole: "auxiliary" });
	const work = [helper("first"), helper("busy")];
	try {
		await until(() => f.inference.size === 2);
		f.inference.get("session1")!.output.resolve("first");
		await work[0];
		f.controls.releaseGate = release.promise;
		const waiting = Promise.allSettled([helper("cancelled", abort.signal)]);
		await until(() => f.deleting.includes("session1"));
		abort.abort();
		expect((await waiting)[0]!.status).toBe("rejected");
		release.resolve();
		await settle();
		expect(f.bodies).toHaveLength(3);
		expect(f.inference.size).toBe(2);
	} finally {
		release.resolve();
		const done = Promise.allSettled(work);
		await main.close();
		await done;
	}
});

test("a restarted host with the same client gets its kept connections back; keep-alive holds the connection without a call", async () => {
	const f = fixture();
	const first = f.create("saved-profile", { client: "eumenes-fixed" });
	const signal = AbortSignal.timeout(10000);
	const reply = first.answer(history("aux"), signal, {
		sessionRole: "auxiliary",
	});
	await until(() => f.inference.size === 1);
	f.inference.get("session1")!.output.resolve("aux");
	expect(await reply).toBe("aux");
	await first.close({ keepConnection: true });
	expect(f.released).toEqual([]);
	for (const c of f.connections.values()) c.claimedBefore = true;
	const second = f.create("saved-profile", {
		client: "eumenes-fixed",
		keepAlive: true,
	});
	try {
		// Held without any call, under the same main connection.
		await until(() => f.claimed.filter((id) => id === "session0").length === 2);
		second.retain!(false);
		f.inference.clear();
		const again = second.answer(history("aux"), signal, {
			sessionRole: "auxiliary",
		});
		await until(() => f.inference.has("session1"));
		f.inference.get("session1")!.output.resolve("back");
		expect(await again).toBe("back");
		expect(f.bodies).toHaveLength(2);
		expect(f.released).toEqual([]);
	} finally {
		await second.close();
	}
	expect(f.connections.size).toBe(0);
});

test("a sub-agent call infers on its own connection like a helper, not on the main one", async () => {
	const f = fixture();
	const main = f.create();
	const signal = AbortSignal.timeout(10000);
	const work: Promise<string>[] = [];
	try {
		work.push(main.answer(history("main"), signal));
		await until(() => f.inference.size === 1);
		work.push(
			main.answer(history("task"), signal, {
				sessionRole: "subagent",
				taskId: "agent:task-1",
			}),
		);
		await until(() => f.inference.size === 2);
		expect(new Set([...f.connections.values()].map((c) => c.client)).size).toBe(
			2,
		);
		expect(f.inference.get("session1")!.messages).toEqual(history("task"));
		for (const [id, entry] of f.inference) entry.output.resolve(id);
		await Promise.all(work);
	} finally {
		await main.close();
		await Promise.allSettled(work);
	}
});

test("cancellation of a call waiting for a helper slot never connects or infers; parent close releases active helpers", async () => {
	const f = fixture(),
		main = f.create();
	const work: Promise<string>[] = [];
	try {
		for (let i = 0; i < 2; i++)
			work.push(
				main.answer(history(`${i}`), new AbortController().signal, {
					sessionRole: "auxiliary",
				}),
			);
		await until(() => f.inference.size === 2);
		const abort = new AbortController();
		const waiting = main.answer(history("cancelled"), abort.signal, {
			sessionRole: "auxiliary",
		});
		const settled = Promise.allSettled([waiting]);
		await Bun.sleep(20);
		abort.abort();
		expect((await settled)[0]!.status).toBe("rejected");
		expect(f.connections.size).toBe(3);
		expect(f.inference.size).toBe(2);
		const done = Promise.allSettled(work);
		await main.close();
		await done;
		expect(f.connections.size).toBe(0);
	} finally {
		await main.close();
	}
});

test("auxiliary renew reclaims tokens and a released connection reconnects with the catalog revision", async () => {
	const f = fixture();
	const p: LarmPort = f.create("other-profile");
	const signal = AbortSignal.timeout(5000);
	try {
		await p.connect();
		f.connections.get("session0")!.expiresAt = Date.now() + 60000;
		await p.connect();
		expect(f.claimed).toEqual(["session0", "session0"]);
		const reply = p.answer(history("renewed"), signal);
		await until(() => f.inference.has("session0"));
		f.inference.get("session0")!.output.resolve("renewed");
		expect(await reply).toBe("renewed");
		f.connections.get("session0")!.terminal = true;
		await p.connect();
		expect(f.released).toContain("session0");
		expect(p.inspect!().connectionId).toBe("session1");
		expect(f.claimed).toEqual(["session0", "session0", "session1"]);
	} finally {
		await p.close();
	}
});

test("parallel calls of one prefix take the free slot instead of queueing; a full set queues on its own prefix", async () => {
	const f = fixture();
	const main = f.create();
	const signal = AbortSignal.timeout(10000);
	const helper = () =>
		main.answer(history("same"), signal, { sessionRole: "auxiliary" });
	const work = [helper(), helper()];
	try {
		await until(() => f.inference.size === 2);
		expect([...f.inference.keys()].sort()).toEqual(["session1", "session2"]);
		work.push(helper());
		await Bun.sleep(20);
		expect(f.connections.size).toBe(3);
		f.inference.get("session1")!.output.resolve("first");
		expect(await work[0]).toBe("first");
		await until(() => f.inference.get("session1")!.output !== undefined);
		for (const [id, entry] of f.inference) entry.output.resolve(id);
		await Bun.sleep(20);
		for (const [id, entry] of f.inference) entry.output.resolve(id);
		expect((await Promise.all(work)).length).toBe(3);
		expect(f.bodies).toHaveLength(3);
	} finally {
		await main.close();
		await Promise.allSettled(work);
	}
});
