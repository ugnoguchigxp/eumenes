import { expect, test } from "bun:test";
import { createLarm } from "..";
import type { LarmPort } from "..";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
async function until(condition: () => boolean) {
	for (let i = 0; i < 300; i++) {
		if (condition()) return;
		await Bun.sleep(5);
	}
	throw new Error("condition_not_reached");
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
	};
	const connections = new Map<string, Connection>();
	const bodies: Array<{ id: string; body: Record<string, unknown> }> = [];
	const inference = new Map<
		string,
		{ messages: unknown[]; output: ReturnType<typeof deferred<string>> }
	>();
	const claimed: string[] = [],
		released: string[] = [];
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
				claimable: c.ready,
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
	const create = (profile = "saved-profile") =>
		createLarm({
			baseUrl: "http://127.0.0.1:9810",
			token: "control",
			profile,
			fetch: request,
		});
	return { create, connections, bodies, inference, claimed, released };
}
const history = (key: string) => [
	{ role: "user" as const, content: `私の識別子は${key}です。` },
	{ role: "assistant" as const, content: `識別子${key}を記憶しました。` },
	{ role: "user" as const, content: "私の識別子を答えてください。" },
];

test("main plus three helpers infer independently; fifth waits without claim or inference then uses a released slot", async () => {
	const f = fixture();
	const main = f.create();
	const signal = AbortSignal.timeout(10000);
	const work: Promise<string>[] = [];
	try {
		work.push(main.answer(history("main"), signal));
		await until(() => f.inference.size === 1);
		for (let i = 1; i <= 3; i++)
			work.push(
				main.answer(history(`helper${i}`), signal, {
					sessionRole: "auxiliary",
				}),
			);
		await until(() => f.inference.size === 4);
		expect(new Set([...f.connections.values()].map((c) => c.client)).size).toBe(
			4,
		);
		// Helpers always use the saved profile, whatever its name is.
		expect(f.bodies.map((x) => x.body.profile)).toEqual(
			Array(4).fill("saved-profile"),
		);
		expect(f.bodies[0]!.body.providers).toEqual(["llm"]);
		for (const { body } of f.bodies.slice(1))
			expect(body.providers).toEqual(["llm"]);
		for (let i = 0; i < 4; i++)
			expect(f.inference.get(`session${i}`)!.messages).toEqual(
				history(i === 0 ? "main" : `helper${i}`),
			);
		work.push(
			main.answer(history("fifth"), signal, { sessionRole: "auxiliary" }),
		);
		await until(() => f.connections.size === 5);
		expect(f.connections.get("session4")!.ready).toBe(false);
		expect(f.claimed).not.toContain("session4");
		expect(f.inference.has("session4")).toBe(false);
		f.inference.get("session1")!.output.resolve("helper1");
		expect(await work[1]).toBe("helper1");
		expect(f.released).toContain("session1");
		await until(() => f.inference.has("session4"));
		expect(f.inference.get("session4")!.messages).toEqual(history("fifth"));
		for (const [id, entry] of f.inference) entry.output.resolve(id);
		await Promise.all(work);
		expect(f.connections.size).toBe(1);
	} finally {
		await main.close();
		await Promise.allSettled(work);
	}
	expect(f.connections.size).toBe(0);
});

test("cancellation of a waiting helper releases it and never infers; parent close releases active helpers", async () => {
	const f = fixture(),
		main = f.create();
	const work: Promise<string>[] = [];
	try {
		for (let i = 0; i < 3; i++)
			work.push(
				main.answer(history(`${i}`), new AbortController().signal, {
					sessionRole: "auxiliary",
				}),
			);
		await until(() => f.inference.size === 3);
		const abort = new AbortController();
		const waiting = main.answer(history("cancelled"), abort.signal, {
			sessionRole: "auxiliary",
		});
		const settled = Promise.allSettled([waiting]);
		await until(() => f.connections.size === 5);
		abort.abort();
		expect((await settled)[0]!.status).toBe("rejected");
		expect(f.released).toContain("session4");
		expect(f.inference.has("session4")).toBe(false);
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
