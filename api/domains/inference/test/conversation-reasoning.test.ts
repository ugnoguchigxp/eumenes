import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	createSettings,
	migration as settingsMigration,
	epochsMigration as settingsEpochsMigration,
} from "../../settings";
import {
	createInference,
	migration,
	parentsMigration,
	diagnosticsMigration,
	controlMigration,
	migrations as inferenceMigrations,
} from "..";
import type { LarmPort } from "../../larm";
import type { Settings } from "../../settings/contracts";
import type { CloudAgentCall, CloudAgents } from "../adapters/cloud-agents";

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
		/** The LARM level of the conversation, for the calls on it. */
		conversationReasoning?: "off" | "low" | "medium" | "high";
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
		...(route.conversationReasoning
			? { conversationReasoning: route.conversationReasoning }
			: {}),
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

test("a main streamed call on a cloud-only Codex SDK route passes the reasoning as the effort, and gets its tool calls back", async () => {
	const h = await setup({
		text: "",
		toolCalls: [{ id: "c1", name: "fixture_tool", arguments: "{}" }],
	});
	const signal = new AbortController().signal;
	for (const reasoning of ["low", "medium", "high"] as const) {
		const receipt = await h.inference.executeStream(
			await h.request(),
			messages,
			signal,
			() => {},
			undefined,
			tools,
			{
				sessionRole: "main",
				reasoning: { larm: "off", cloud: reasoning },
				context: { instructionCount: 1, historyCount: 2 },
			},
		);
		expect(receipt.toolCalls).toEqual([
			{ id: "c1", name: "fixture_tool", arguments: "{}" },
		]);
		expect(h.calls.at(-1)).toMatchObject({
			kind: "codex-sdk",
			model: "fixture-model",
			reasoningEffort: reasoning,
			tools,
		});
	}
});

test("off sends no effort, and a main call without reasoning sends none either", async () => {
	const h = await setup({ text: "answer" });
	const signal = new AbortController().signal;
	await h.inference.executeStream(
		await h.request(),
		messages,
		signal,
		() => {},
		undefined,
		undefined,
		{ sessionRole: "main", reasoning: { larm: "high", cloud: "off" } },
	);
	await h.inference.executeStream(
		await h.request(),
		messages,
		signal,
		() => {},
		undefined,
		undefined,
		{ sessionRole: "main" },
	);
	expect(h.calls).toHaveLength(2);
	for (const call of h.calls) expect(call.reasoningEffort).toBeUndefined();
});

test("a fallback from LARM to the cloud inside one call gives each attempt the level of its own side", async () => {
	const larm: unknown[] = [];
	const h = await setup(
		{ text: "answer" },
		{
			mode: "larm-preferred",
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
		{ sessionRole: "main", reasoning: { larm: "off", cloud: "medium" } },
	);
	expect(receipt.value).toBe("answer");
	expect(larm).toEqual(["off"]);
	expect(h.calls).toHaveLength(1);
	expect(h.calls[0]!.reasoningEffort).toBe("medium");
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

test("target cloud on a larm-preferred route skips LARM and runs the cloud with the cloud level", async () => {
	const larm = larmCalls();
	const h = await setup(
		{ text: "answer" },
		{ mode: "larm-preferred", localStream: larm.localStream },
	);
	const receipt = await h.inference.executeStream(
		await h.request(),
		messages,
		new AbortController().signal,
		() => {},
		undefined,
		undefined,
		{
			sessionRole: "main",
			target: "cloud",
			reasoning: { larm: "off", cloud: "high" },
		},
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

test("a LARM call that names no reasoning does not think; a call on the conversation takes the conversation's level; a named level is sent as it is", async () => {
	for (const conversationReasoning of [undefined, "low"] as const) {
		const larm = larmCalls("hello");
		const h = await setup(
			{ text: "cloud" },
			{
				mode: "larm-preferred",
				localStream: larm.localStream,
				conversationReasoning,
			},
		);
		for (const session of [
			undefined,
			{ sessionRole: "auxiliary" as const },
			{ sessionRole: "auxiliary" as const, onConversation: true },
			{ sessionRole: "main" as const },
			{
				sessionRole: "main" as const,
				reasoning: { larm: "high", cloud: "low" },
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
		expect(larm.options.map((o) => o?.reasoning)).toEqual([
			"off",
			"off",
			conversationReasoning ?? "off",
			"off",
			"high",
		]);
		expect(h.calls).toHaveLength(0);
	}
});

test("a main call may offer tools with toolChoice none: LARM gets the tools and the choice", async () => {
	const larm = larmCalls("hello");
	const h = await setup(
		{ text: "cloud" },
		{ mode: "larm-preferred", localStream: larm.localStream },
	);
	await h.inference.executeStream(
		await h.request(),
		messages,
		new AbortController().signal,
		() => {},
		undefined,
		tools,
		{ sessionRole: "main", toolChoice: "none" },
	);
	expect(larm.options[0]).toMatchObject({ tools, toolChoice: "none" });
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
