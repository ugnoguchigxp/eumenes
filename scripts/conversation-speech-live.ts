import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { harness } from "../api/application/toolchain/toolchain.fixture";
import { createLiveLarm, liveLarmSettings } from "./live-larm";
import { configureLogging } from "../api/infrastructure/logger";
import { spokenText, isBriefSpokenReply } from "../api/domains/delivery";
import type { LarmCallOptions, LarmPort } from "../api/domains/larm";

// Live model + isolated host. This does not start a server or use audio devices.
if (!process.argv.includes("--run")) throw new Error("use --run");
const out = resolve(
	"verification-reports/conversation-speech-live",
	new Date().toISOString().replaceAll(":", "-"),
);
mkdirSync(out, { recursive: true, mode: 0o700 });
configureLogging({
	file: join(out, "backend.jsonl"),
	destination: { write() {} },
});
const calls: Array<{ phase: string; tools: string[]; durationMs?: number }> =
	[];
let staleHistory = false;
const live = createLiveLarm();
function observed(options?: LarmCallOptions) {
	const sample = {
		phase: options?.tools?.some((t) => t.function.name === "answer")
			? "analysis"
			: options?.tools?.length
				? "selection"
				: "answer",
		tools: [] as string[],
		durationMs: 0,
	};
	calls.push(sample);
	return {
		sample,
		options: {
			...options,
			onToolCalls: (
				items: Parameters<NonNullable<LarmCallOptions["onToolCalls"]>>[0],
			) => {
				sample.tools.push(...items.map((c) => c.name));
				options?.onToolCalls?.(items);
			},
		},
	};
}
const history = (messages: Parameters<LarmPort["answer"]>[0]) =>
	staleHistory
		? [
				messages[0]!,
				{ role: "user" as const, content: "以前の説明を詳しくお願い" },
				{
					role: "assistant" as const,
					content:
						"詳しく説明いたします。" +
						"関連事項も含めた長い説明です。".repeat(40),
				},
				...messages.slice(1),
			]
		: messages;
const model: LarmPort = {
	...live,
	async answer(messages, signal, options) {
		const seen = observed(options),
			start = performance.now();
		try {
			return await live.answer(history(messages), signal, seen.options);
		} finally {
			seen.sample.durationMs = performance.now() - start;
		}
	},
	async answerStream(messages, signal, delta, options) {
		const seen = observed(options),
			start = performance.now();
		try {
			return await live.answerStream!(
				history(messages),
				signal,
				delta,
				seen.options,
			);
		} finally {
			seen.sample.durationMs = performance.now() - start;
		}
	},
};
const h = await harness({ model, uiCompositions: true });
const samples: Array<Record<string, unknown>> = [];
async function say(id: string, text: string) {
	const start = performance.now(),
		callStart = calls.length;
	const response = await h.request("/api/runs", {
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text,
	});
	if (!response.ok) throw new Error("test_submission_failed");
	const run = await response.json();
	const final = await h.dialogue.waitForTerminal(run.id, {
		timeoutMs: 180_000,
	});
	const answer = h.dialogue.answerText(run.id) ?? "";
	const sample = {
		id,
		status: final?.status,
		error: final?.error,
		spokenChars: spokenText(answer).length,
		answer,
		announcement: final?.announcement,
		specialistSessionId: final?.specialistSessionId,
		calls: calls.slice(callStart),
		durationMs: performance.now() - start,
	};
	samples.push(sample);
	console.log(
		JSON.stringify({
			id,
			status: final?.status,
			spokenChars: sample.spokenChars,
			specialist: !!final?.specialistSessionId,
			durationMs: sample.durationMs,
		}),
	);
	if (final?.status !== "completed" || !answer || !isBriefSpokenReply(answer))
		throw new Error("speech_contract_failed");
	return sample;
}
try {
	const settings = h.settings.get();
	const applied = await h.request("/api/settings/apply", {
		requestId: crypto.randomUUID(),
		expectedRevision: settings.revision,
		settings: { ...settings, larm: liveLarmSettings() },
		keys: [],
	});
	if (!applied.ok) throw new Error("test_settings_not_saved");
	if (!process.argv.includes("--studio-only")) {
		await say("ordinary-explanation", "降水確率とはどういう意味ですか？");
		staleHistory = true;
		await say(
			"past-verbosity",
			"次の文の結論だけ教えて。会場は横浜、開始は18時、受付は17時30分。開始は何時？",
		);
		staleHistory = false;
		const rewritten = await say(
			"current-request",
			"『明日は16時に鎌倉駅で集合してください』を、丁寧な依頼文にしてください。",
		);
		if (
			!rewritten.answer.includes("16時") ||
			rewritten.answer.includes("16時間") ||
			!rewritten.answer.includes("鎌倉駅")
		)
			process.exitCode = 1;
		console.log(
			JSON.stringify({
				id: "current-request-preserved",
				ok: process.exitCode !== 1,
			}),
		);
	}
	const created = await say(
		"specialist-production",
		"参加者アンケートのUIを作ってください。見出しは『来場者の声』、満足度は3択の必須回答、感想は任意の自由記入にしてください。",
	);
	if (!created.specialistSessionId || !created.announcement)
		throw new Error("specialist_not_started");
	const routingCount = calls.filter((c) => c.phase !== "answer").length;
	await say(
		"specialist-continuation",
		"見出しを『参加者アンケート』に変更して。他はそのままにしてください。",
	);
	if (calls.filter((c) => c.phase !== "answer").length !== routingCount)
		throw new Error("specialist_reentered_main");
	const source = await (
		await h.request(
			"/api/toolchain-artifacts/artifact:ui.studio@2/sources/ui-studio",
		)
	).json();
	writeFileSync(
		join(out, "work.json"),
		JSON.stringify(source, null, 2) + "\n",
		{ mode: 0o600 },
	);
	const definition = JSON.stringify(source.data?.work?.definition);
	if (
		!definition?.includes("参加者アンケート") ||
		!definition.includes("満足度") ||
		!definition.includes("感想")
	)
		throw new Error("current_request_not_preserved");
} catch (error) {
	process.exitCode = 1;
	console.log(
		JSON.stringify({
			failure: error instanceof Error ? error.message : "probe_failed",
		}),
	);
} finally {
	await h.close();
	await live.close();
	writeFileSync(
		join(out, "result.json"),
		JSON.stringify(
			{ lane: "live_model_isolated_host_no_audio_devices", samples },
			null,
			2,
		) + "\n",
		{ mode: 0o600 },
	);
	console.log(`Report: ${out}/result.json`);
}
