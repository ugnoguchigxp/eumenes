import { afterAll, expect, test } from "bun:test";
import {
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const scratch = mkdtempSync(join(tmpdir(), "eumenes-cli-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
async function cli(args: string[], url: string, stdin?: string) {
	const child = Bun.spawn([process.execPath, "cli/index.ts", ...args], {
		cwd: root,
		env: {
			PATH: process.env.PATH,
			EUMENES_API_TOKEN: "fixture-api-token-long-enough",
			EUMENES_DB: join(scratch, "eumenes.sqlite3"),
			EUMENES_URL: url,
		},
		stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { code, stdout, stderr };
}

test("CLI connection failure has the documented exit code and stdout stays empty", async () => {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(),
	});
	const url = `http://127.0.0.1:${server.port}`;
	await server.stop(true);
	const result = await cli(["status", "--json"], url);
	expect(result.code).toBe(5);
	expect(result.stdout).toBe("");
	expect(result.stderr).toContain("Cannot connect");
});

test("CLI rejects missing or invalid request IDs before submitting a new run", async () => {
	let submissions = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => {
			submissions++;
			return Response.json({});
		},
	});
	try {
		for (const id of [[], ["not-a-uuid"]]) {
			const result = await cli(
				["send", "hello", "--request-id", ...id],
				`http://127.0.0.1:${server.port}`,
			);
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
		}
		expect(submissions).toBe(0);
	} finally {
		await server.stop(true);
	}
});

test("CLI reports invalid API configuration as an argument error", async () => {
	const result = await cli(["status", "--json"], "http://example.test");
	expect(result.code).toBe(2);
	expect(result.stdout).toBe("");
	expect(result.stderr).toContain("loopback_api_required");
});

for (const [scheme, userInfo] of [
	["ftp", ""],
	["http", "fixture-user:fixture-password@"],
]) {
	test(`CLI rejects invalid ${scheme} API URL before requesting or exposing credentials`, async () => {
		let requests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => {
				requests++;
				return Response.json({
					service: "eumenes",
					larm: { state: "unconfigured", capabilities: [] },
				});
			},
		});
		try {
			const result = await cli(
				["status", "--json"],
				`${scheme}://${userInfo}127.0.0.1:${server.port}`,
			);
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("invalid_api_url");
			expect(result.stderr).not.toContain("fixture-password");
			expect(requests).toBe(0);
		} finally {
			await server.stop(true);
		}
	});
}

test("web CLI uses authenticated API, fresh search, explicit stable retention and result polling", async () => {
	const submitted: Record<string, unknown>[] = [];
	const requests: { path: string; method: string }[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			expect(req.headers.get("authorization")).toBe(
				"Bearer fixture-api-token-long-enough",
			);
			const path = new URL(req.url).pathname;
			requests.push({ path, method: req.method });
			if (path === "/api/web-research/runs" && req.method === "POST") {
				submitted.push((await req.json()) as Record<string, unknown>);
				return Response.json({ id: "fixture-run", status: "queued" });
			}
			if (path.endsWith("/cancel"))
				return Response.json({ id: "fixture-run", status: "cancelled" });
			if (path.endsWith("/cache/status"))
				return Response.json({ enabled: true, entries: 0 });
			if (path.endsWith("/cache/clear"))
				return Response.json({ cleared: true });
			return Response.json({
				id: "fixture-run",
				status: "completed",
				result: { cache: "bypass" },
			});
		},
	});
	const url = `http://127.0.0.1:${server.port}`;
	try {
		for (const args of [
			[
				"web",
				"search",
				"Bun documentation",
				"--read-pages",
				"--wait",
				"--json",
			],
			["web", "read", "https://example.com/", "--stable", "--json"],
			["web", "read", "https://example.com/", "--stable", "--fresh", "--json"],
			["web", "cancel", "fixture-run", "--json"],
			["web", "cache", "--json"],
			["web", "clear", "--json"],
		]) {
			const result = await cli(args, url);
			expect(result.code).toBe(0);
			expect(result.stderr).toBe("");
			expect(JSON.parse(result.stdout)).toBeObject();
		}
		expect(submitted[0]).toMatchObject({
			operation: "lookup",
			query: "Bun documentation",
			readPages: 3,
			freshness: "live",
		});
		expect(submitted[1]).toMatchObject({
			operation: "read",
			retention: "stable",
			freshness: "normal",
		});
		expect(submitted[2]).toMatchObject({
			operation: "read",
			retention: "stable",
			freshness: "live",
		});
		expect(requests).toContainEqual({
			path: "/api/web-research/runs/fixture-run",
			method: "GET",
		});
		expect(requests).toContainEqual({
			path: "/api/web-research/cache/clear",
			method: "POST",
		});
	} finally {
		await server.stop(true);
	}
});

test("web wait distinguishes cancellation, failure and expired delivery", async () => {
	let terminal: Record<string, unknown> = { status: "cancelled" };
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (req) =>
			Response.json(
				req.method === "POST"
					? { id: "fixture-run", status: "queued" }
					: { id: "fixture-run", ...terminal },
			),
	});
	try {
		for (const [state, expected] of [
			[{ status: "cancelled" }, 4],
			[{ status: "failed" }, 3],
			[{ status: "completed", resultExpired: true }, 4],
		] as const) {
			terminal = state;
			expect(
				(
					await cli(
						["web", "search", "fixture", "--wait", "--json"],
						`http://127.0.0.1:${server.port}`,
					)
				).code,
			).toBe(expected);
		}
	} finally {
		await server.stop(true);
	}
});

test("web SIGINT exits with unconfirmed cancellation even if the API never confirms it", async () => {
	let polls = 0,
		cancels = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (req) => {
			if (new URL(req.url).pathname.endsWith("/cancel")) cancels++;
			if (req.method === "GET") polls++;
			return Response.json({ id: "fixture-run", status: "queued" });
		},
	});
	const child = Bun.spawn(
		[
			process.execPath,
			"cli/index.ts",
			"web",
			"search",
			"fixture",
			"--wait",
			"--json",
		],
		{
			cwd: root,
			env: {
				PATH: process.env.PATH,
				EUMENES_API_TOKEN: "fixture-api-token-long-enough",
				EUMENES_URL: `http://127.0.0.1:${server.port}`,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	try {
		for (let i = 0; i < 100 && !polls; i++) await Bun.sleep(10);
		expect(polls).toBeGreaterThan(0);
		child.kill("SIGINT");
		const [code, output, error] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(code).toBe(4);
		expect(output).toBe("");
		expect(error).toContain("outcome unconfirmed");
		expect(cancels).toBe(1);
	} finally {
		if (child.exitCode === null) child.kill();
		await server.stop(true);
	}
}, 2000);

test("SIGINT also cancels a web status request whose response never arrives", async () => {
	let polls = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			if (req.method === "GET") {
				polls++;
				return new Promise<Response>(() => {});
			}
			return Response.json({ id: "fixture-run", status: "queued" });
		},
	});
	const child = Bun.spawn(
		[
			process.execPath,
			"cli/index.ts",
			"web",
			"search",
			"fixture",
			"--wait",
			"--json",
		],
		{
			cwd: root,
			env: {
				PATH: process.env.PATH,
				EUMENES_API_TOKEN: "fixture-api-token-long-enough",
				EUMENES_URL: `http://127.0.0.1:${server.port}`,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	try {
		for (let i = 0; i < 100 && !polls; i++) await Bun.sleep(10);
		expect(polls).toBeGreaterThan(0);
		child.kill("SIGINT");
		const [code, error] = await Promise.all([
			child.exited,
			new Response(child.stderr).text(),
		]);
		expect(code).toBe(4);
		expect(error).toContain("outcome unconfirmed");
	} finally {
		if (child.exitCode === null) child.kill();
		await server.stop(true);
	}
}, 2000);

type Seen = { method: string; path: string; body: unknown };
/** Fixture backend that records every request and answers from `routes` by "METHOD /path". */
function fixtureApi(
	routes: Record<string, (seen: Seen) => Response | Promise<Response>>,
) {
	const seen: Seen[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			expect(req.headers.get("authorization")).toBe(
				"Bearer fixture-api-token-long-enough",
			);
			const url = new URL(req.url);
			const text = req.method === "GET" ? "" : await req.text();
			const entry: Seen = {
				method: req.method,
				path: url.pathname + url.search,
				body: text ? JSON.parse(text) : undefined,
			};
			seen.push(entry);
			const handler = routes[`${req.method} ${entry.path}`];
			return handler
				? handler(entry)
				: Response.json({ error: "not_found" }, { status: 404 });
		},
	});
	return {
		seen,
		url: `http://127.0.0.1:${server.port}`,
		stop: () => server.stop(true),
	};
}

const tempDir = () => mkdtempSync(join(scratch, "case-"));

test("collection CLI maps each subcommand to the attitude API and prints JSON", async () => {
	const sample = {
		revision: 3,
		primary_label: "calm",
		acceptable_labels: ["calm"],
		expression_transition: null,
		review_status: "pending",
		correction_reason: null,
		template_group_id: "g1",
		template_group_confirmed: false,
		coverage_tags: ["a"],
	};
	const ok = (value: unknown) => () => Response.json(value);
	const api = fixtureApi({
		"GET /api/attitude-dataset/status": ok({ running: false }),
		"POST /api/attitude-dataset/start": ok({ running: true }),
		"POST /api/attitude-dataset/stop": ok({ running: false }),
		"GET /api/attitude-dataset/samples": ok([{ id: "s1" }]),
		"GET /api/attitude-dataset/samples/s1": ok(sample),
		"GET /api/attitude-dataset/samples/s1?predictions=show": ok({
			...sample,
			predictions: [],
		}),
		"POST /api/attitude-dataset/samples/s1/review": ok({ ok: true }),
		"GET /api/attitude-dataset/report": ok({ total: 1 }),
		"POST /api/attitude-dataset/split": ok({ split: true }),
		"GET /api/attitude-dataset/export": ok({
			jsonl: "r\n",
			partitions: { train: "t\n", calibration: "c\n", eval: "e\n" },
			report: { total: 1 },
			schema: { v: 1 },
		}),
	});
	const dir = tempDir();
	const reviewFile = join(dir, "review.json");
	writeFileSync(
		reviewFile,
		JSON.stringify({ revision: 3, primary_label: "calm" }),
	);
	try {
		const cases: [string[], unknown][] = [
			[["collection", "--json"], { running: false }],
			[["collection", "status", "--json"], { running: false }],
			[["collection", "start", "--json"], { running: true }],
			[["collection", "stop", "--json"], { running: false }],
			[["collection", "list", "--json"], [{ id: "s1" }]],
			[["collection", "show", "s1", "--json"], sample],
			[
				["collection", "show", "s1", "predictions", "--json"],
				{ ...sample, predictions: [] },
			],
			[["collection", "report", "--json"], { total: 1 }],
			[["collection", "split", "--json"], { split: true }],
			[["collection", "review", "s1", reviewFile, "--json"], { ok: true }],
		];
		for (const [args, expected] of cases) {
			const result = await cli(args, api.url);
			expect([args.join(" "), result.code, result.stderr]).toEqual([
				args.join(" "),
				0,
				"",
			]);
			expect(JSON.parse(result.stdout)).toEqual(expected);
		}
		expect(api.seen.find((r) => r.path.endsWith("/review"))?.body).toEqual({
			revision: 3,
			primary_label: "calm",
		});
		// prepare writes a private draft once and refuses to overwrite it.
		const draft = join(dir, "draft.json");
		const prepared = await cli(
			["collection", "prepare", "s1", draft, "--json"],
			api.url,
		);
		expect(prepared.code).toBe(0);
		expect(JSON.parse(prepared.stdout)).toEqual({ file: draft });
		expect(JSON.parse(readFileSync(draft, "utf8"))).toMatchObject({
			revision: 3,
			primary_label: "calm",
		});
		expect(statSync(draft).mode & 0o777).toBe(0o600);
		const again = await cli(
			["collection", "prepare", "s1", draft, "--json"],
			api.url,
		);
		expect(again.code).toBe(2);
		expect(again.stdout).toBe("");
		// export claims a fresh private directory.
		const out = join(dir, "export");
		const exported = await cli(
			["collection", "export", out, "--json"],
			api.url,
		);
		expect(exported.code).toBe(0);
		expect(JSON.parse(exported.stdout)).toEqual({ directory: out });
		expect(readdirSync(out).sort()).toEqual([
			"calibration.jsonl",
			"eval.jsonl",
			"report.json",
			"reviewed.jsonl",
			"schema.json",
			"train.jsonl",
		]);
		expect(readFileSync(join(out, "train.jsonl"), "utf8")).toBe("t\n");
		expect(
			(await cli(["collection", "export", out, "--json"], api.url)).code,
		).toBe(2);
	} finally {
		await api.stop();
	}
});

test("collection CLI reports usage errors as 2 and API failures as 3", async () => {
	const api = fixtureApi({
		"POST /api/attitude-dataset/start": () =>
			Response.json({ error: "attitude_busy" }, { status: 409 }),
	});
	try {
		const usage = await cli(["collection", "bogus", "--json"], api.url);
		expect(usage.code).toBe(2);
		expect(usage.stdout).toBe("");
		expect(usage.stderr).toContain("usage: collection");
		const failed = await cli(["collection", "start", "--json"], api.url);
		expect(failed.code).toBe(3);
		expect(failed.stdout).toBe("");
		expect(failed.stderr).toContain("attitude_busy");
	} finally {
		await api.stop();
	}
});

const TIMER_ID = "11111111-1111-4111-8111-111111111111";
const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-10-10T00:00:00.000Z";
const timerDto = (over: Record<string, unknown> = {}) => ({
	id: TIMER_ID,
	revision: 1,
	state: "active",
	label: "tea",
	durationSeconds: 60,
	startedAt: NOW,
	dueAt: "2026-10-10T00:01:00.000Z",
	cancelledAt: null,
	remainingSeconds: 60,
	conversationId: null,
	originRunId: null,
	originMessageId: null,
	errorCode: null,
	bodyExpired: false,
	...over,
});

test("timer CLI lists, shows, starts and cancels with validated request IDs", async () => {
	const api = fixtureApi({
		"GET /api/timers": () =>
			Response.json({ serverNow: NOW, items: [timerDto()], nextCursor: null }),
		[`GET /api/timers/${TIMER_ID}`]: () =>
			Response.json({ serverNow: NOW, timer: timerDto(), notification: null }),
		"POST /api/timers": () =>
			Response.json({
				kind: "timer_action",
				action: "started",
				operationId: OPERATION_ID,
				serverNow: NOW,
				timer: timerDto(),
				artifact: { kind: "timer", version: 1, timerId: TIMER_ID },
			}),
		[`POST /api/timers/${TIMER_ID}/cancel`]: () =>
			Response.json({
				kind: "timer_action",
				action: "cancelled",
				operationId: OPERATION_ID,
				serverNow: NOW,
				timer: timerDto({ state: "cancelled", revision: 2 }),
			}),
	});
	try {
		for (const args of [
			["timer", "--json"],
			["timer", "list", "--json"],
		]) {
			const list = await cli(args, api.url);
			expect(list.code).toBe(0);
			expect(JSON.parse(list.stdout).items).toHaveLength(1);
		}
		const shown = await cli(["timer", "show", TIMER_ID, "--json"], api.url);
		expect(shown.code).toBe(0);
		expect(JSON.parse(shown.stdout).timer.id).toBe(TIMER_ID);

		const started = await cli(
			["timer", "start", "60", "tea", "--request-id", REQUEST_ID, "--json"],
			api.url,
		);
		expect(started.code).toBe(0);
		expect(started.stderr).toBe("");
		expect(JSON.parse(started.stdout)).toMatchObject({
			action: "started",
			artifact: { timerId: TIMER_ID },
		});
		const startBody = api.seen.find(
			(r) => r.method === "POST" && r.path === "/api/timers",
		)?.body;
		expect(startBody).toMatchObject({
			requestId: REQUEST_ID,
			durationSeconds: 60,
			label: "tea",
		});
		expect(
			Date.parse((startBody as { issuedAt: string }).issuedAt),
		).not.toBeNaN();

		const cancelled = await cli(
			["timer", "cancel", TIMER_ID, "1", "--request-id", REQUEST_ID, "--json"],
			api.url,
		);
		expect(cancelled.code).toBe(0);
		expect(JSON.parse(cancelled.stdout)).toMatchObject({
			action: "cancelled",
			timer: { state: "cancelled" },
		});
		expect(api.seen.at(-1)?.body).toMatchObject({
			requestId: REQUEST_ID,
			expectedRevision: 1,
		});
	} finally {
		await api.stop();
	}
});

test("timer CLI rejects mutations without a request ID or valid arguments before calling the API", async () => {
	const api = fixtureApi({});
	try {
		for (const [args, message] of [
			[["timer", "start", "60", "--json"], "require --request-id"],
			[["timer", "cancel", TIMER_ID, "1", "--json"], "require --request-id"],
			[
				["timer", "start", "abc", "--request-id", REQUEST_ID, "--json"],
				"usage: timer start",
			],
			[
				[
					"timer",
					"cancel",
					TIMER_ID,
					"x",
					"--request-id",
					REQUEST_ID,
					"--json",
				],
				"usage: timer cancel",
			],
			[["timer", "show", "--json"], "usage: timer show"],
			[
				["timer", "bogus", "--request-id", REQUEST_ID, "--json"],
				"usage: timer start",
			],
		] as const) {
			const result = await cli([...args], api.url);
			expect([args.join(" "), result.code]).toEqual([args.join(" "), 2]);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain(message);
		}
		expect(api.seen).toEqual([]);
	} finally {
		await api.stop();
	}
});

const memoryItem = (over: Record<string, unknown> = {}) => ({
	id: "mem-1",
	kind: "preference",
	semanticKey: "drink",
	text: "likes tea",
	polarity: "affirmed",
	status: "active",
	origin: "user",
	revision: 1,
	sourceMessageIds: ["m1"],
	validFromMs: null,
	validUntilMs: null,
	...over,
});

test("memory CLI covers list, status, toggle, remember, actions and forget", async () => {
	const api = fixtureApi({
		"GET /api/memory/items": () => Response.json({ items: [memoryItem()] }),
		"GET /api/memory/items?all=1": () =>
			Response.json({
				items: [memoryItem(), memoryItem({ id: "mem-2", status: "stopped" })],
			}),
		"GET /api/memory/status": () =>
			Response.json({ enabled: true, healthy: true }),
		"POST /api/memory/settings": ({ body }) =>
			Response.json({
				enabled: (body as { enabled: boolean }).enabled,
				healthy: true,
			}),
		"POST /api/memory/items": () => Response.json(memoryItem()),
		"POST /api/memory/items/mem-1/stop": () =>
			Response.json(memoryItem({ status: "stopped", revision: 2 })),
		"POST /api/memory/items/mem-1/resume": () =>
			Response.json(memoryItem({ revision: 3 })),
		"POST /api/memory/items/mem-1/retract": () =>
			Response.json(memoryItem({ status: "retracted" })),
		"POST /api/memory/items/mem-1/forget": () =>
			Response.json({ forgetId: "f1", completed: true }),
	});
	try {
		const run = async (...args: string[]) => {
			const result = await cli(["memory", ...args, "--json"], api.url);
			expect([args.join(" "), result.code, result.stderr]).toEqual([
				args.join(" "),
				0,
				"",
			]);
			return JSON.parse(result.stdout);
		};
		expect(await run()).toHaveLength(1);
		expect(await run("list")).toHaveLength(1);
		expect(await run("all")).toHaveLength(2);
		expect(await run("status")).toEqual({ enabled: true, healthy: true });
		expect(await run("off")).toEqual({ enabled: false, healthy: true });
		expect(await run("on")).toEqual({ enabled: true, healthy: true });
		expect(
			await run("remember", "m1", "drink", "preference", "I like tea"),
		).toMatchObject({ id: "mem-1" });
		expect(
			api.seen.filter((r) => r.path === "/api/memory/items").at(-1)?.body,
		).toMatchObject({
			conversationId: "main",
			messageId: "m1",
			semanticKey: "drink",
			kind: "preference",
			quote: "I like tea",
			text: "I like tea",
		});
		expect(await run("stop", "mem-1", "1")).toMatchObject({
			status: "stopped",
		});
		expect(await run("resume", "mem-1", "2")).toMatchObject({ revision: 3 });
		expect(await run("retract", "mem-1", "3")).toMatchObject({
			status: "retracted",
		});
		expect(
			api.seen.filter((r) => r.path.endsWith("/retract")).at(-1)?.body,
		).toEqual({ expectedRevision: 3 });
		expect(await run("forget", "mem-1")).toEqual({
			forgetId: "f1",
			completed: true,
		});
	} finally {
		await api.stop();
	}
});

test("memory CLI rejects bad arguments with 2 and surfaces API failures as 3", async () => {
	const api = fixtureApi({
		"GET /api/memory/status": () =>
			Response.json({ error: "memory_down" }, { status: 503 }),
	});
	try {
		for (const [args, message] of [
			[["memory", "bogus"], "usage: memory list"],
			[["memory", "remember", "m1"], "usage: memory remember"],
			[["memory", "stop", "mem-1"], "usage: memory stop"],
			[["memory", "forget"], "item ID required"],
		] as const) {
			const result = await cli([...args, "--json"], api.url);
			expect([args.join(" "), result.code]).toEqual([args.join(" "), 2]);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain(message);
		}
		expect(api.seen).toEqual([]);
		const down = await cli(["memory", "status", "--json"], api.url);
		expect(down.code).toBe(3);
		expect(down.stdout).toBe("");
		expect(down.stderr).toContain("memory_down");
	} finally {
		await api.stop();
	}
});

const runBody = (over: Record<string, unknown> = {}) => ({
	id: "run-1",
	requestId: REQUEST_ID,
	conversationId: "main",
	utteranceId: null,
	status: "queued",
	revision: 1,
	inputMessageId: "m1",
	answerMessageId: null,
	error: null,
	jobId: null,
	deadlineAt: null,
	sourceKind: "manual",
	scheduleId: null,
	occurrenceId: null,
	createdAt: NOW,
	updatedAt: NOW,
	...over,
});

test("send --wait polls the run and maps its terminal status to the exit code", async () => {
	let terminal = "completed";
	const api = fixtureApi({
		"POST /api/runs": () => Response.json(runBody()),
		"GET /api/runs/run-1": () =>
			Response.json(runBody({ status: terminal, answerMessageId: "m2" })),
	});
	try {
		for (const [status, code] of [
			["completed", 0],
			["failed", 3],
			["cancelled", 4],
		] as const) {
			terminal = status;
			const result = await cli(
				[
					"send",
					"hello",
					"world",
					"--wait",
					"--request-id",
					REQUEST_ID,
					"--json",
				],
				api.url,
			);
			expect([status, result.code, result.stderr]).toEqual([status, code, ""]);
			expect(JSON.parse(result.stdout)).toMatchObject({ id: "run-1", status });
		}
		expect(api.seen.find((r) => r.method === "POST")?.body).toEqual({
			requestId: REQUEST_ID,
			conversationId: "main",
			text: "hello world",
		});
	} finally {
		await api.stop();
	}
});

test("send without --wait prints the queued run, reads stdin and honours --conversation", async () => {
	const api = fixtureApi({
		"POST /api/runs": () => Response.json(runBody({ conversationId: "other" })),
	});
	try {
		const result = await cli(
			["send", "--conversation", "other", "--json"],
			api.url,
			"from stdin\n",
		);
		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toMatchObject({
			status: "queued",
			conversationId: "other",
		});
		expect(api.seen).toHaveLength(1);
		expect(api.seen[0]?.body).toMatchObject({
			conversationId: "other",
			text: "from stdin",
		});
		const empty = await cli(["send", "--json"], api.url, "  \n");
		expect(empty.code).toBe(2);
		expect(empty.stderr).toContain("message required");
		expect(api.seen).toHaveLength(1);
	} finally {
		await api.stop();
	}
});

test("send reports the request ID when submission fails so a retry stays idempotent", async () => {
	const api = fixtureApi({
		"POST /api/runs": () =>
			Response.json({ error: "queue_full" }, { status: 429 }),
	});
	try {
		const result = await cli(
			["send", "hello", "--request-id", REQUEST_ID, "--wait", "--json"],
			api.url,
		);
		expect(result.code).toBe(3);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(`Request ID: ${REQUEST_ID}`);
		expect(result.stderr).toContain("queue_full");
	} finally {
		await api.stop();
	}
});

test("CLI rejects unknown commands with usage and exit code 2", async () => {
	const result = await cli(["bogus", "--json"], "http://127.0.0.1:1");
	expect(result.code).toBe(2);
	expect(result.stdout).toBe("");
	expect(result.stderr).toContain("usage: bun cli/index.ts");
	const inherited = await cli(["constructor", "--json"], "http://127.0.0.1:1");
	expect(inherited.code).toBe(2);
});

test("CLI without a token file exits 2 and creates no keys directory", async () => {
	const dir = mkdtempSync(join(scratch, "notoken-"));
	const child = Bun.spawn([process.execPath, "cli/index.ts", "status"], {
		cwd: root,
		env: {
			PATH: process.env.PATH,
			EUMENES_DB: join(dir, "eumenes.sqlite3"),
			EUMENES_URL: "http://127.0.0.1:9",
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, stderr] = await Promise.all([
		child.exited,
		new Response(child.stderr).text(),
	]);
	expect(code).toBe(2);
	expect(stderr).toContain("api_token_not_found");
	expect(readdirSync(dir)).toEqual([]);
});
