import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	controlMigration,
	createInference,
	diagnosticsMigration,
	migrations as inferenceMigrations,
	migration,
	parentsMigration,
} from "..";
import { openStore } from "../../../infrastructure/sqlite";
import {
	configureLogging,
	withLogContext,
} from "../../../infrastructure/logger";
import type { LarmPort } from "../../larm";
import {
	createSettings,
	epochsMigration as settingsEpochsMigration,
	migration as settingsMigration,
} from "../../settings";
import type { Settings } from "../../settings/contracts";
import type { CloudAgentCall } from "../adapters/cloud-agent-shared";
import type { CloudAgents } from "../adapters/cloud-agents";
import { REASONING_ALLOWANCE_TOKENS } from "../service/attempt-work";
import type { ConnectionModelsService } from "../service/connection-models";

type CloudAgentResult = Awaited<ReturnType<CloudAgents["run"]>>;

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});
const messages = [
	{ role: "system" as const, content: "system" },
	{ role: "user" as const, content: "hi" },
	{ role: "assistant" as const, content: "hello" },
	{ role: "user" as const, content: "now" },
];
const tools = [
	{
		type: "function" as const,
		function: {
			name: "fixture_tool",
			description: "Fixture",
			parameters: { type: "object", properties: {} },
		},
	},
];

/** Settings saved as cloud-only on a Codex SDK connection (the conversation's cloud route), the request captured from them. */
async function setup(
	result: CloudAgentResult,
	route: {
		mode?: "cloud-only" | "larm-preferred";
		localStream?: LarmPort["answerStream"];
		/** Changes the saved settings before they are applied. */
		edit?: (s: Settings) => void;
		/** The saved thinking level (default: the settings' own default). */
		effort?: string;
		/** The catalog of the cloud connection. */
		models?: ConnectionModelsService;
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-conversation-reasoning-"));
	const store = openStore(join(dir, "test.db"), [
		settingsMigration,
		migration,
		settingsEpochsMigration,
		parentsMigration,
		diagnosticsMigration,
		controlMigration,
		...inferenceMigrations.slice(4).map((m) => m.sql),
	]);
	const settings = await createSettings(store, {
		dbPath: join(dir, "test.db"),
		env: {},
	});
	const s = settings.get();
	const connectionId = crypto.randomUUID();
	const resourceId = crypto.randomUUID();
	s.connections.push({
		id: connectionId,
		name: "Cloud",
		kind: "codex-sdk",
		baseUrl: "https://example.invalid/v1",
		enabled: true,
		epoch: 0,
		envRef: null,
	});
	s.resources.push({
		id: resourceId,
		connectionId,
		purpose: "llm",
		model: "fixture-model",
		contextWindow: 100_000,
		voice: null,
	});
	s.routes.llm.mode = route.mode ?? "cloud-only";
	s.routes.llm.cloudAllowed = true;
	s.routes.llm.fallbackId = resourceId;
	if (route.effort) s.general.reasoningEffort = route.effort;
	route.edit?.(s);
	await settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: 0,
		settings: s,
		keys: [],
	});
	const calls: CloudAgentCall[] = [];
	const port: LarmPort = {
		status: () => ({ state: "unconfigured", capabilities: [] }),
		answerStream: route.localStream,
		connect: async () => {},
		answer: async () => {
			throw new Error("larm_unconfigured");
		},
		transcribe: async () => {
			throw new Error("larm_unconfigured");
		},
		speak: async () => {
			throw new Error("larm_unconfigured");
		},
		close: async () => {},
	};
	const inference = createInference(store, settings, {
		larmFactory: () => port,
		...(route.models ? { connectionModels: route.models } : {}),
		cloudAgents: {
			run: async (call) => {
				calls.push(call);
				return result;
			},
		},
	});
	cleanup.push(async () => {
		await inference.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	// The conversation's capture: the saved cloud route, an exact context policy, as the dialogue sets them.
	const request = () =>
		store.write((db) => {
			const id = inference.captureInTransaction(
				db,
				crypto.randomUUID(),
				"llm",
				Date.now() + 60_000,
			);
			inference.setContextPolicyInTransaction!(db, id, "exact");
			return id;
		});
	return { inference, calls, request, store };
}

/** A catalog that lists one model with the given levels (and `default`). */
const catalog = (
	efforts: string[] | undefined,
	options: { known?: true } = {},
): ConnectionModelsService => {
	const value = {
		models: [
			{
				id: "fixture-model",
				displayName: "fixture",
				contextWindow: null,
				...(efforts ? { reasoning: { efforts, default: "low" } } : {}),
			},
		],
		account: { auth: "api-key" as const, subscriptionType: null },
	};
	return {
		list: async () => value,
		...(options.known ? { known: () => value } : {}),
	};
};

test("a main streamed call on a cloud-only Codex SDK route passes the saved level as the effort, and gets its tool calls back", async () => {
	for (const effort of ["low", "medium", "high", "xhigh"]) {
		const h = await setup(
			{
				text: "",
				toolCalls: [{ id: "c1", name: "fixture_tool", arguments: "{}" }],
			},
			{ effort },
		);
		const receipt = await h.inference.executeStream(
			await h.request(),
			messages,
			new AbortController().signal,
			() => {},
			undefined,
			tools,
			{
				sessionRole: "main",
				context: { instructionCount: 1, historyCount: 2 },
			},
		);
		expect(receipt.toolCalls).toEqual([
			{ id: "c1", name: "fixture_tool", arguments: "{}" },
		]);
		expect(h.calls.at(-1)).toMatchObject({
			kind: "codex-sdk",
			model: "fixture-model",
			reasoningEffort: effort,
			tools,
		});
	}
});

test("a cloud call of any role thinks at the saved level, the settings' default when none was chosen", async () => {
	const h = await setup({ text: "answer" });
	for (const session of [
		undefined,
		{ sessionRole: "auxiliary" as const },
		{ sessionRole: "main" as const },
	])
		await h.inference.executeStream(
			await h.request(),
			messages,
			new AbortController().signal,
			() => {},
			undefined,
			undefined,
			session,
		);
	expect(h.calls.map((c) => c.reasoningEffort)).toEqual(["low", "low", "low"]);
});

test("a fallback from LARM to the cloud inside one call sends the saved level on both attempts", async () => {
	const larm: unknown[] = [];
	const h = await setup(
		{ text: "answer" },
		{
			mode: "larm-preferred",
			effort: "medium",
			localStream: async (_messages, _signal, _onDelta, options) => {
				larm.push(options?.reasoning);
				throw new Error("larm_provider_failed");
			},
		},
	);
	const receipt = await h.inference.executeStream(
		await h.request(),
		messages,
		new AbortController().signal,
		() => {},
		undefined,
		undefined,
		{ sessionRole: "main" },
	);
	expect(receipt.value).toBe("answer");
	expect(larm).toEqual(["medium"]);
	expect(h.calls).toHaveLength(1);
	expect(h.calls[0]!.reasoningEffort).toBe("medium");
});

test("a level the call's model does not accept fails the attempt with an explicit code, is logged, and is never changed", async () => {
	const lines: Array<Record<string, unknown>> = [];
	configureLogging({
		level: "info",
		destination: { write: (line) => void lines.push(JSON.parse(line)) },
	});
	try {
		// The cloud model's catalog lists no `xhigh`: the call fails before the SDK is reached.
		const cloud = await setup(
			{ text: "answer" },
			{ effort: "xhigh", models: catalog(["low", "medium", "high"]) },
		);
		const id = await cloud.request();
		await expect(
			cloud.inference.executeStream(
				id,
				messages,
				new AbortController().signal,
				() => {},
			),
		).rejects.toThrow("reasoning_effort_unsupported");
		expect(cloud.calls).toHaveLength(0);
		expect(status(cloud, id)).toBe("failed");
		expect(await attempts(cloud, id)).toEqual([
			{ source: "cloud", status: "failed" },
		]);
		// LARM declares low, medium and high only; the saved level is not sent in their place, and the route does not fall back.
		const larm = larmCalls("hello");
		const local = await setup(
			{ text: "cloud" },
			{
				mode: "larm-preferred",
				effort: "xhigh",
				localStream: larm.localStream,
			},
		);
		await expect(
			local.inference.executeStream(
				await local.request(),
				messages,
				new AbortController().signal,
				() => {},
			),
		).rejects.toThrow("reasoning_effort_unsupported");
		expect(larm.options).toHaveLength(0);
		expect(local.calls).toHaveLength(0);
		const refusals = lines.filter(
			(l) => l.event === "inference.reasoning_effort_unsupported",
		);
		expect(refusals).toMatchObject([
			{ level: "warn", source: "cloud", kind: "xhigh" },
			{ level: "warn", source: "larm", kind: "xhigh" },
		]);
	} finally {
		configureLogging({ level: "silent" });
	}
});

test("the catalog decides what is sent: an accepted level goes as it is, a model with no level to choose gets none, an unknown catalog sends the saved level", async () => {
	for (const [models, expected] of [
		[catalog(["low", "xhigh"]), "xhigh"],
		[catalog([]), undefined],
		[catalog(undefined), "xhigh"],
		// The last list of the connection answers without a new read.
		[
			{ ...catalog(["xhigh"], { known: true }), list: undefined as never },
			"xhigh",
		],
		// A catalog that can not be read says nothing: the saved level goes out and the provider answers.
		[
			{
				list: async () => {
					throw new Error("cloud_credential_unavailable");
				},
			},
			"xhigh",
		],
	] as const) {
		const h = await setup({ text: "answer" }, { effort: "xhigh", models });
		await h.inference.executeStream(
			await h.request(),
			messages,
			new AbortController().signal,
			() => {},
		);
		expect(h.calls).toHaveLength(1);
		expect(h.calls[0]!.reasoningEffort).toBe(expected);
	}
});

const schema = {
	type: "object",
	properties: { kind: { type: "string", enum: ["reply"] } },
	required: ["kind"],
	additionalProperties: false,
};

/** The options of each LARM call, the stream returning the JSON text. */
function larmCalls(text = '{"kind":"reply"}') {
	const options: Array<Parameters<NonNullable<LarmPort["answerStream"]>>[3]> =
		[];
	const localStream: LarmPort["answerStream"] = async (
		_messages,
		_signal,
		onDelta,
		o,
	) => {
		options.push(o);
		onDelta(text);
		return text;
	};
	return { options, localStream };
}

test("a main call with an output schema on LARM sends it as the strict format, no native tools, and gets the JSON text back", async () => {
	const larm = larmCalls();
	const h = await setup(
		{ text: "cloud" },
		{ mode: "larm-preferred", localStream: larm.localStream },
	);
	const deltas: string[] = [];
	const receipt = await h.inference.executeStream(
		await h.request(),
		messages,
		new AbortController().signal,
		(t) => {
			deltas.push(t);
		},
		undefined,
		tools,
		{ sessionRole: "main", outputSchema: schema },
	);
	expect(receipt.value).toBe('{"kind":"reply"}');
	expect(receipt.toolCalls).toBeUndefined();
	expect(larm.options).toHaveLength(1);
	expect(larm.options[0]).toMatchObject({
		jsonOutput: true,
		jsonSchema: schema,
		toolOutputFormat: "json-schema",
	});
	expect(larm.options[0]!.tools).toBeUndefined();
	expect(larm.options[0]!.onToolCalls).toBeUndefined();
	expect(deltas.join("")).toBe('{"kind":"reply"}');
	expect(h.calls).toHaveLength(0);
});

test("a main call with an output schema on the cloud passes it as the output schema and no tools", async () => {
	const h = await setup({ text: '{"kind":"reply"}' });
	const receipt = await h.inference.executeStream(
		await h.request(),
		messages,
		new AbortController().signal,
		() => {},
		undefined,
		tools,
		{ sessionRole: "main", outputSchema: schema },
	);
	expect(receipt.value).toBe('{"kind":"reply"}');
	expect(h.calls).toHaveLength(1);
	expect(h.calls[0]!.outputSchema).toEqual(schema);
	expect(h.calls[0]!.tools).toBeUndefined();
});

test("target cloud on a larm-preferred route skips LARM and runs the cloud with the saved level", async () => {
	const larm = larmCalls();
	const h = await setup(
		{ text: "answer" },
		{ mode: "larm-preferred", effort: "high", localStream: larm.localStream },
	);
	const receipt = await h.inference.executeStream(
		await h.request(),
		messages,
		new AbortController().signal,
		() => {},
		undefined,
		undefined,
		{ sessionRole: "main", target: "cloud" },
	);
	expect(receipt.value).toBe("answer");
	expect(larm.options).toHaveLength(0);
	expect(h.calls).toHaveLength(1);
	expect(h.calls[0]!.reasoningEffort).toBe("high");
});

test("target cloud without a usable cloud answer fails before any attempt", async () => {
	for (const edit of [
		(s: Settings) => {
			s.routes.llm.mode = "larm-only";
		},
		(s: Settings) => {
			s.routes.llm.cloudAllowed = false;
		},
	]) {
		const larm = larmCalls();
		const h = await setup(
			{ text: "answer" },
			{ mode: "larm-preferred", localStream: larm.localStream, edit },
		);
		const id = await h.request();
		await expect(
			h.inference.executeStream(
				id,
				messages,
				new AbortController().signal,
				() => {},
				undefined,
				undefined,
				{ sessionRole: "main", target: "cloud" },
			),
		).rejects.toThrow("cloud_fallback_unavailable");
		expect(larm.options).toHaveLength(0);
		expect(h.calls).toHaveLength(0);
	}
});

test("every LARM chat call thinks at the saved level, a call on the conversation too", async () => {
	for (const effort of ["low", "medium"]) {
		const larm = larmCalls("hello");
		const h = await setup(
			{ text: "cloud" },
			{ mode: "larm-preferred", localStream: larm.localStream, effort },
		);
		for (const session of [
			undefined,
			{ sessionRole: "auxiliary" as const },
			{ sessionRole: "auxiliary" as const, onConversation: true },
			{ sessionRole: "main" as const },
		] as const)
			await h.inference.executeStream(
				await h.request(),
				messages,
				new AbortController().signal,
				() => {},
				undefined,
				undefined,
				session,
			);
		expect(larm.options.map((o) => o?.reasoning)).toEqual([
			effort,
			effort,
			effort,
			effort,
		]);
		expect(h.calls).toHaveLength(0);
	}
});

test("a call this domain makes think gets room for the thinking on its output limit; the conversation's own call, or a read-ahead, does not", async () => {
	const larm = larmCalls("hello");
	const h = await setup(
		{ text: "cloud" },
		{ mode: "larm-preferred", localStream: larm.localStream },
	);
	for (const session of [
		{ sessionRole: "auxiliary" as const, outputLimit: 1200 },
		{ sessionRole: "main" as const, outputLimit: 4096 },
		// The prewarm: it reads the conversation's prompt and stops at its one token.
		{
			sessionRole: "auxiliary" as const,
			onConversation: true,
			readAhead: true,
			outputLimit: 1,
		},
	] as const)
		await h.inference.executeStream(
			await h.request(),
			messages,
			new AbortController().signal,
			() => {},
			undefined,
			undefined,
			session,
		);
	expect(larm.options.map((o) => o?.maxOutputTokens)).toEqual([
		1200 + REASONING_ALLOWANCE_TOKENS,
		4096,
		1,
	]);
});

test("the conversation's own call on LARM gets room for the thinking only above the default level", async () => {
	const sizes: Record<string, number | undefined> = {};
	for (const effort of ["low", "medium"]) {
		const larm = larmCalls("hello");
		const h = await setup(
			{ text: "cloud" },
			{ mode: "larm-preferred", localStream: larm.localStream, effort },
		);
		await h.inference.executeStream(
			await h.request(),
			messages,
			new AbortController().signal,
			() => {},
			undefined,
			undefined,
			{ sessionRole: "main", outputLimit: 4096 },
		);
		sizes[effort] = larm.options[0]?.maxOutputTokens;
	}
	expect(sizes).toEqual({
		low: 4096,
		medium: 4096 + REASONING_ALLOWANCE_TOKENS,
	});
});

test("a request whose snapshot holds no thinking level runs at the setting's default", async () => {
	const larm = larmCalls("hello");
	const h = await setup(
		{ text: "cloud" },
		{ mode: "larm-preferred", localStream: larm.localStream, effort: "high" },
	);
	const id = await h.request();
	// A request made before the level was a setting.
	await h.store.write((db) => {
		const row = db
			.query("SELECT snapshot FROM inference_requests WHERE id=?")
			.get(id) as { snapshot: string };
		const snapshot = JSON.parse(row.snapshot) as Settings;
		delete (snapshot.general as Partial<Settings["general"]>).reasoningEffort;
		db.query("UPDATE inference_requests SET snapshot=? WHERE id=?").run(
			JSON.stringify(snapshot),
			id,
		);
	});
	await h.inference.executeStream(
		id,
		messages,
		new AbortController().signal,
		() => {},
		undefined,
		undefined,
		{ sessionRole: "main" },
	);
	expect(larm.options[0]?.reasoning).toBe("low");
});

test("an output schema or a target on a non-main call is refused", async () => {
	const h = await setup({ text: "answer" });
	for (const session of [
		{ outputSchema: schema },
		{ target: "cloud" as const },
		{ sessionRole: "auxiliary" as const, outputSchema: schema },
		{ sessionRole: "auxiliary" as const, target: "cloud" as const },
	])
		await expect(
			h.inference.executeStream(
				await h.request(),
				messages,
				new AbortController().signal,
				() => {},
				undefined,
				undefined,
				session,
			),
		).rejects.toThrow("invalid_session_role");
	expect(h.calls).toHaveLength(0);
});

const status = (h: Awaited<ReturnType<typeof setup>>, id: string) =>
	(
		h.store.read((db) =>
			db.query("SELECT status FROM inference_requests WHERE id=?").get(id),
		) as { status: string }
	).status;

const attempts = (h: Awaited<ReturnType<typeof setup>>, id: string) =>
	h.store.read((db) =>
		db
			.query(
				"SELECT source,status FROM inference_attempts WHERE request_id=? ORDER BY started",
			)
			.all(id),
	);

/** A first call whose delta function refuses the first text, as the dialogue does when the held head fails its checks. */
async function refusedFirstCall(retain: boolean) {
	const larm = larmCalls("hello there");
	const h = await setup(
		{ text: "cloud answer" },
		{ mode: "larm-preferred", localStream: larm.localStream },
	);
	const id = await h.request();
	const first = h.inference.executeStream(
		id,
		messages,
		new AbortController().signal,
		() => {
			throw new Error("head_refused");
		},
		undefined,
		undefined,
		{
			sessionRole: "main",
			...(retain ? { retainRequest: true as const } : {}),
		},
	);
	return { h, id, first, larm };
}

test("a main call that retains its request leaves it pending when its delta refuses, and the cloud answers it next", async () => {
	const { h, id, first, larm } = await refusedFirstCall(true);
	await expect(first).rejects.toThrow("head_refused");
	expect(status(h, id)).toBe("pending");
	expect(larm.options).toHaveLength(1);
	expect(h.calls).toHaveLength(0);
	expect(await attempts(h, id)).toEqual([{ source: "larm", status: "failed" }]);
	const receipt = await h.inference.executeStream(
		id,
		messages,
		new AbortController().signal,
		() => {},
		undefined,
		undefined,
		{ sessionRole: "main", target: "cloud", retainRequest: true },
	);
	expect(receipt.value).toBe("cloud answer");
	expect(h.calls).toHaveLength(1);
	expect(
		await h.store.write((db) => h.inference.acceptInTransaction!(db, receipt)),
	).toBe(true);
});

test("without retainRequest a refused delta still fails the request", async () => {
	const { h, id, first } = await refusedFirstCall(false);
	await expect(first).rejects.toThrow("head_refused");
	expect(status(h, id)).toBe("failed");
	expect(h.calls).toHaveLength(0);
});

test("a call that ends with nothing said ends only that call: the request stays pending and an earlier answer is adopted", async () => {
	let call = 0;
	const h = await setup(
		{ text: "cloud answer" },
		{
			mode: "larm-preferred",
			localStream: async (_messages, _signal, onDelta) => {
				if (++call > 1) throw new Error("chat_output_empty");
				onDelta("担当に頼みます。");
				return "担当に頼みます。";
			},
		},
	);
	const id = await h.request();
	const session = { sessionRole: "main" as const };
	const first = await h.inference.executeStream(
		id,
		messages,
		new AbortController().signal,
		() => {},
		undefined,
		undefined,
		session,
	);
	await expect(
		h.inference.executeStream(
			id,
			messages,
			new AbortController().signal,
			() => {},
			undefined,
			undefined,
			session,
		),
	).rejects.toThrow("chat_output_empty");
	expect(status(h, id)).toBe("pending");
	expect(h.calls).toHaveLength(0);
	expect(
		await h.store.write((db) => h.inference.acceptInTransaction!(db, first)),
	).toBe(true);
});

/** A stream of pieces; the delta function receives each, and the stream stops at the first throw. */
function streamOf(pieces: string[]) {
	const localStream: LarmPort["answerStream"] = async (
		_messages,
		_signal,
		onDelta,
	) => {
		for (const piece of pieces) onDelta(piece);
		return pieces.join("");
	};
	return localStream;
}
const pieces = ["hel", "lo, ", "how ", "are you?"];

test("provider timing records the first nonblank chunk once with its attempt, even when held", async () => {
	const h = await setup(
		{ text: "unused cloud response" },
		{
			mode: "larm-preferred",
			localStream: streamOf([" ", "private fixture reply", " tail"]),
		},
	);
	const id = await h.request();
	const lines: Array<Record<string, unknown>> = [];
	configureLogging({
		level: "info",
		destination: { write: (line) => void lines.push(JSON.parse(line)) },
	});
	try {
		const firstDeltas = () =>
			lines.filter(
				(event) =>
					event.event === "performance.stage" &&
					event.phase === "provider_first_delta",
			);
		const counts: number[] = [];
		const receipt = await withLogContext(
			{ runId: "fixture-run", jobId: "fixture-job" },
			() =>
				h.inference.executeStream(
					id,
					messages,
					new AbortController().signal,
					() => {
						counts.push(firstDeltas().length);
						return false;
					},
				),
		);
		expect(counts).toEqual([0, 1, 1]);
		expect(firstDeltas()).toMatchObject([
			{
				runId: "fixture-run",
				jobId: "fixture-job",
				inferenceId: id,
				attemptId: receipt.attemptId,
				source: "larm",
				outcome: "ok",
			},
		]);
		expect(Number(firstDeltas()[0]?.durationMs)).toBeGreaterThanOrEqual(0);
		expect(JSON.stringify(lines)).not.toContain("private fixture reply");
	} finally {
		configureLogging({ level: "silent" });
	}
});

test("pieces held unpublished (the delta returns false) then a throw leave the request pending for the cloud", async () => {
	const h = await setup(
		{ text: "cloud answer" },
		{ mode: "larm-preferred", localStream: streamOf(pieces) },
	);
	const id = await h.request();
	let seen = "";
	await expect(
		h.inference.executeStream(
			id,
			messages,
			new AbortController().signal,
			(text) => {
				seen += text;
				if (seen.length > 8) throw new Error("head_refused");
				return false;
			},
			undefined,
			undefined,
			{ sessionRole: "main", retainRequest: true },
		),
	).rejects.toThrow("head_refused");
	expect(status(h, id)).toBe("pending");
	expect(h.calls).toHaveLength(0);
	expect(await attempts(h, id)).toEqual([{ source: "larm", status: "failed" }]);
	const receipt = await h.inference.executeStream(
		id,
		messages,
		new AbortController().signal,
		() => {},
		undefined,
		undefined,
		{ sessionRole: "main", target: "cloud", retainRequest: true },
	);
	expect(receipt.value).toBe("cloud answer");
	expect(
		await h.store.write((db) => h.inference.acceptInTransaction!(db, receipt)),
	).toBe(true);
});

test("once a piece was published (the delta returned void) a later throw still fails the request", async () => {
	const h = await setup(
		{ text: "cloud" },
		{ mode: "larm-preferred", localStream: streamOf(pieces) },
	);
	const id = await h.request();
	let count = 0;
	await expect(
		h.inference.executeStream(
			id,
			messages,
			new AbortController().signal,
			() => {
				if (++count > 1) throw new Error("late_refusal");
			},
			undefined,
			undefined,
			{ sessionRole: "main", retainRequest: true },
		),
	).rejects.toThrow("late_refusal");
	expect(status(h, id)).toBe("failed");
	expect(h.calls).toHaveLength(0);
});

test("retainRequest on a non-main call is refused", async () => {
	const h = await setup({ text: "answer" });
	await expect(
		h.inference.executeStream(
			await h.request(),
			messages,
			new AbortController().signal,
			() => {},
			undefined,
			undefined,
			{ sessionRole: "auxiliary", retainRequest: true },
		),
	).rejects.toThrow("invalid_session_role");
});
