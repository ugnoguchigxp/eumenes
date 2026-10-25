import { afterEach, expect, test } from "bun:test";
import type { LarmPort } from "../../domains/larm";
import {
	callsOf,
	isUtteranceRound,
	searchThenDelegate,
} from "../toolchain/conversation-script.fixture";
import { harness } from "../toolchain/toolchain.fixture";

/**
 * The pipeline studio as a user meets it (spec task-pipeline-design 2026-10-22 §8.1, §13.6): the conversation hands
 * over to the studio's specialist, which writes the definition with the host's document tools; the screen shows it
 * and publishes it, and the published pipeline is a candidate of the next request. Only the models are scripted.
 */

const STUDIO = "artifact:pipeline.studio@2";
const id = () => crypto.randomUUID();
type Prompt = Array<{ role: string; content: string }>;

const definition = {
	formatVersion: 1,
	id: "timer-pair",
	title: "二つのタイマー",
	summary: "分のタイマーと、続けて30秒のタイマーを掛ける",
	useWhen: ["タイマーを続けて二つ掛けたい", "二段階のタイマーを頼みたい"],
	avoidWhen: [],
	inputs: { minutes: { type: "integer", description: "分", required: true } },
	steps: [
		{
			id: "first",
			kind: "toolchain",
			title: "一つ目",
			toolchain: "timers.manage",
			request: "${inputs.minutes}分のタイマー",
		},
		{
			id: "second",
			kind: "toolchain",
			title: "二つ目",
			toolchain: "timers.manage",
			request: "30秒のタイマー",
		},
	],
	tests: [
		{
			utterance: "5分のタイマーと、続けてもう一つ掛けて",
			inputs: { minutes: 5 },
			stepResults: { first: { summary: "300秒" }, second: { summary: "30秒" } },
			expect: {},
		},
	],
};
const documentRevision = (messages: Prompt) =>
	Number(
		/CURRENT_DOCUMENT path=pipeline\.json revision=(\d+)/.exec(
			messages.map((m) => m.content).join("\n"),
		)?.[1] ?? 0,
	);

const rigs: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
	for (const r of rigs.splice(0)) await r.close();
});

async function rig() {
	const specialist: Array<(messages: Prompt) => unknown> = [];
	const specialistPrompts: Prompt[] = [];
	const model: LarmPort = {
		status: () => ({ state: "ready", capabilities: ["llm", "asr", "tts"] }),
		connect: async () => {},
		close: async () => {},
		transcribe: async () => "",
		speak: async () => new Uint8Array(48),
		answer: async (messages, _signal, options) => {
			const system = messages[0]!.content;
			if (system.includes("転記された発話の主要な言語"))
				return JSON.stringify({
					status: "identified",
					languages: ["ja"],
					confidence: 0.99,
				});
			if (system.includes("FUNCTIONS="))
				return JSON.stringify({
					decision: "answer",
					functionName: "",
					request: "",
					questionRef: "",
				});
			if (system.includes("あなたはタスクパイプライン制作の専門担当です")) {
				specialistPrompts.push(messages.map((m) => ({ ...m })));
				const step = specialist.shift();
				if (!step) throw new Error("script_specialist_missing");
				return JSON.stringify(step(messages as Prompt));
			}
			if (isUtteranceRound(options?.tools)) {
				// The conversation's round: a search for the studio, then the hand-over of the request.
				const step = searchThenDelegate(
					(candidate) => candidate.id === "pipeline.studio",
					messages.at(-1)!.content,
					{
						announcement: "パイプライン制作の担当に引き継ぎます。",
						impact: "create",
					},
				)(messages);
				if (step.calls?.length)
					options!.onToolCalls!(callsOf(step, () => id()) as never);
				return step.text ?? "";
			}
			return "かしこまりました。";
		},
	};
	const h = await harness({
		timers: true,
		pipelines: true,
		model,
		// The studio is the one the discovery finds.
		discoveryTarget: () => "pipeline_studio",
	});
	rigs.push({ close: () => h.close() });
	const say = async (text: string) => {
		const response = await h.request("/api/runs", {
			requestId: id(),
			conversationId: "main",
			text,
		});
		expect(response.status).toBe(202);
		const run = (await response.json()) as { id: string };
		return h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 });
	};
	const source = async () => {
		const response = await h.request(
			`/api/toolchain-artifacts/${STUDIO}/sources/pipeline-studio`,
		);
		expect(response.status).toBe(200);
		return (await response.json()) as {
			revision: number;
			data: { work: Record<string, any> | null; history: unknown[] };
		};
	};
	const act = async (actionId: "publish" | "source", text?: string) => {
		const now = await source();
		const work = now.data.work!;
		const response = await h.request("/api/toolchain-actions", {
			version: 1,
			eventId: id(),
			eventCreatedAt: new Date().toISOString(),
			eventExpiresAt: new Date(Date.now() + 60_000).toISOString(),
			artifactId: "tab-1",
			artifactRevisionId: STUDIO,
			source: "pipeline-studio",
			sourceRevision: now.revision,
			actionId,
			scopeRef: h.toolchain.actionRequests.scopeRef,
			input: {
				workRef: work.workRef,
				expectedRevision: String(work.revision),
				...(text !== undefined ? { text } : {}),
			},
		});
		return (await response.json()) as {
			status: string;
			errorCode?: string;
		};
	};
	return { h, specialist, specialistPrompts, say, source, act };
}

test("the conversation hands over to the studio; its specialist writes the definition, the screen shows and publishes it", async () => {
	const r = await rig();
	r.specialist.push(
		(messages) => ({
			action: "invoke",
			tool: "doc.write",
			arguments: {
				baseRevision: documentRevision(messages),
				title: "二つのタイマー",
				content: definition,
			},
		}),
		() => ({ action: "reply", text: "下書きを作りました。" }),
	);
	const run = await r.say("タイマーを二つ続けて掛けるパイプラインを作りたい");
	expect(run?.status).toBe("completed");
	expect(r.h.dialogue.answerText(run!.id)).toBe("下書きを作りました。");
	// The specialist works with the document tools, reads the toolchains a step may name, and the draft is the work's.
	const first = r.specialistPrompts[0]!.map((m) => m.content).join("\n");
	expect(first).toContain('"id":"doc.write"');
	expect(first).toContain('"timers.manage"');
	const shown = (await r.source()).data.work!;
	expect(shown).toMatchObject({
		revision: 1,
		title: "二つのタイマー",
		issues: [],
		dirty: true,
	});
	expect(shown.flow.steps.map((s: { id: string }) => s.id)).toEqual([
		"first",
		"second",
	]);
	// Only the screen publishes.
	expect(await r.act("publish")).toMatchObject({ status: "accepted" });
	const published = (await r.source()).data.work!;
	expect(published).toMatchObject({
		dirty: false,
		published: { toolchainRevisionId: "toolchain:pipeline.timer-pair@1" },
	});
	const card = r.h.store.read((db) =>
		r.h.routing.cardInTransaction(db, "toolchain:pipeline.timer-pair@1"),
	);
	expect(card?.pipeline?.outline).toBe("一つ目→二つ目");
});

test("the user edits the source on the screen; a text that fails is shown as the rejected draft", async () => {
	const r = await rig();
	r.specialist.push(
		(messages) => ({
			action: "invoke",
			tool: "doc.write",
			arguments: {
				baseRevision: documentRevision(messages),
				title: "二つのタイマー",
				content: definition,
			},
		}),
		() => ({ action: "reply", text: "下書きを作りました。" }),
	);
	await r.say("タイマーを二つ続けて掛けるパイプラインを作りたい");
	expect(await r.act("source", "{ 壊れた")).toMatchObject({
		status: "accepted",
	});
	expect((await r.source()).data.work!.rejected.issues).toEqual([
		{ path: "/", rule: "invalid_json" },
	]);
	const edited = { ...definition, title: "二段のタイマー" };
	expect(await r.act("source", JSON.stringify(edited))).toMatchObject({
		status: "accepted",
	});
	expect((await r.source()).data.work).toMatchObject({
		revision: 2,
		title: "二段のタイマー",
		rejected: null,
	});
});
