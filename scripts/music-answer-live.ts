import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { harness } from "../api/application/toolchain.fixture";
import { musicLibraryFixture } from "../api/application/music-library.fixture";
import { createLiveLarm } from "./live-larm";
import type { Messages } from "../api/domains/inference/contracts";
import { buildSystemPrompt } from "../api/domains/dialogue/service/system-prompt";

if (!process.argv.includes("--run"))
	throw new Error(
		"use --run to evaluate music answers with the saved LARM model",
	);
const out = resolve("verification-reports/music-answer-live");
mkdirSync(out, { recursive: true });
const fixture = musicLibraryFixture();
const trackIds = [
	"music_a74ea9cb-06e5-40a4-98b7-285cf3dcf7f0",
	"music_943c1fa4-3ea0-4ddc-9219-940eb738f60a",
];
fixture.tracks.forEach((track, i) => {
	track.id = trackIds[i] ?? "music_other";
	track.audioUrl = `/v1/music/tracks/${track.id}/audio`;
	track.metadataUrl = `/v1/music/tracks/${track.id}/metadata`;
});
let captured: Messages | undefined;
const h = await harness({
	musicGateway: fixture.gateway,
	model: {
		...fixture.model,
		answer: async (messages, signal, options) => {
			if (messages.some((m) => m.content.includes('"musicResult":')))
				captured = structuredClone(messages);
			return fixture.model.answer(messages, signal, options);
		},
	},
});
try {
	const run = await (
		await h.request("/api/runs", {
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "音楽再生プレイリストを見せて",
		})
	).json();
	if (
		(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status !==
			"completed" ||
		!captured
	)
		throw new Error("music_answer_context_missing");
} finally {
	await h.close();
}
writeFileSync(`${out}/context.json`, JSON.stringify(captured, null, 2));
const source = captured!;
const resultIndex = source.findIndex((m) =>
	m.content.includes('"musicResult":'),
);
const original = JSON.parse(source[resultIndex]!.content).musicResult;
if (original.state !== "completed") throw new Error("fixture_playlist_failed");
const cases = [
	{
		name: "reported-request",
		question: "音楽再生プレイリストを見せて",
		result: original,
		short: true,
	},
	{
		name: "paraphrase",
		question: "保存してある曲の再生画面を出してくれる？",
		result: original,
		short: true,
	},
	{
		name: "maid-persona",
		question: "音楽再生プレイリストを見せて",
		result: original,
		short: true,
		persona: "maid" as const,
	},
	{
		name: "previous-id-reading",
		question: "音楽再生プレイリストを見せて",
		result: original,
		short: true,
		previous: `以下の曲が含まれています。${trackIds.join("、")}。Artifactで詳細の確認や再生が可能です。`,
	},
	{
		name: "details-requested",
		question: "プレイリストにはどんな曲が入っているか説明して",
		result: original,
		short: false,
	},
	{
		name: "empty-playlist",
		question: "音楽再生プレイリストを見せて",
		result: { ...original, trackIds: [], currentId: null },
		short: false,
	},
	{
		name: "failed",
		question: "音楽再生プレイリストを見せて",
		result: { ...original, state: "failed", errorCode: "playlist_interrupted" },
		short: false,
	},
	{
		name: "cancelled",
		question: "音楽再生プレイリストを見せて",
		result: { ...original, state: "cancelled", errorCode: "cancel_requested" },
		short: false,
	},
];
const live = createLiveLarm();
const results: { name: string; answer: string; pass: boolean }[] = [];
try {
	for (const scenario of cases) {
		const messages = structuredClone(source);
		if (scenario.persona)
			messages[0]!.content = messages[0]!.content.replace(
				buildSystemPrompt({ agentName: "", userName: "", persona: "butler" }),
				buildSystemPrompt({
					agentName: "あみ",
					userName: "",
					persona: scenario.persona,
				}),
			);
		messages[resultIndex]!.content = JSON.stringify({
			musicResult: scenario.result,
		});
		messages.at(-1)!.content = scenario.question;
		if (scenario.previous)
			messages.splice(
				1,
				0,
				{
					role: "user",
					content: "前のプレイリストを見せて",
				},
				{ role: "assistant", content: scenario.previous },
			);
		const answer = await live.answer(messages, AbortSignal.timeout(45000), {
			contextPolicy: "exact",
		});
		const identifiers = [
			...trackIds,
			original.id,
			original.runId,
			"playlist_interrupted",
			"cancel_requested",
		];
		const pass =
			!identifiers.some((id) => answer.includes(id)) &&
			!answer.includes("Artifact") &&
			(!scenario.short ||
				(answer.length <= 60 &&
					!answer.includes("\n") &&
					/開|表示/.test(answer))) &&
			(scenario.name !== "empty-playlist" ||
				/見つか|ありません|なかった|ない/.test(answer)) &&
			(scenario.name !== "failed" || /でき|失敗|開け/.test(answer)) &&
			(scenario.name !== "cancelled" ||
				/取消|取り消|キャンセル|中止/.test(answer));
		results.push({ name: scenario.name, answer, pass });
		writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
		console.log(JSON.stringify(results.at(-1)));
	}
	if (results.some((r) => !r.pass)) throw new Error("music_answer_eval_failed");
} finally {
	await live.close();
}
