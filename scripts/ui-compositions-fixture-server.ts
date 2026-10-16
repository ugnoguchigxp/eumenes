import type { LarmPort } from "../api/domains/larm";
import { harness } from "../api/application/toolchain/toolchain.fixture";

/**
 * Browser-test backend for tests/browser/ui-compositions.spec.ts: the real toolchain harness with the
 * ui-compositions bundle and one scripted model. The contract is the spec's header comment:
 * - the normal addressee starts the session toolchain (`ui_create`) for the message containing
 *   `requests.create`, and for `requests.again` (sent while a saved work is viewed) targets that work;
 * - the specialist answers by the request of its turn: `ui.draft.apply` then a reply, except
 *   `requests.explain`, which is answered without changing the draft.
 */
const requests = {
	create: "来場者アンケートのUIを作ってください",
	soften: "もっとやわらかい雰囲気にしてください",
	explain: "この画面の使い方を教えてください",
	again: "見出しを少し直してください",
};

const survey = (heading: string, gap?: "relaxed") => ({
	view: "layout",
	direction: "stack",
	...(gap ? { gap } : {}),
	children: [
		{ view: "text-block", title: heading, body: "ご感想をお聞かせください。" },
		{
			view: "form",
			title: "アンケート",
			fields: [
				{
					id: "rating",
					label: "満足度",
					type: "radio",
					required: true,
					options: ["満足", "普通", "不満"],
				},
				{ id: "comment", label: "感想", type: "textarea", required: false },
			],
		},
	],
});
const draft = (title: string, gap?: "relaxed") => ({
	action: "invoke",
	tool: "ui.draft.apply",
	arguments: { title, definition: survey(title, gap) },
});
const turns: Record<
	string,
	{ apply?: ReturnType<typeof draft>; reply: string }
> = {
	[requests.create]: {
		apply: draft("来場者アンケート"),
		reply: "アンケートの初稿を作りました。",
	},
	[requests.soften]: {
		apply: draft("やわらかいアンケート", "relaxed"),
		reply: "雰囲気をやわらかくしました。",
	},
	[requests.explain]: { reply: "このままで問題ありません。" },
	[requests.again]: {
		apply: draft("再編集したアンケート"),
		reply: "見出しを直しました。",
	},
};

type Prompt = Parameters<LarmPort["answer"]>[0];
type Tool = { function?: { name?: string; parameters?: any }; name?: string };

/** The request of the specialist's current turn, and whether its tool result is already in. */
function specialistTurn(messages: Prompt) {
	const data = messages
		.filter((m) => m.role === "user" && !m.content.startsWith("TOOL_RESULT="))
		.at(-1);
	let request = "";
	try {
		request =
			(JSON.parse(data?.content ?? "{}") as { request?: string }).request ?? "";
	} catch {}
	return {
		request,
		applied: messages.at(-1)?.content.startsWith("TOOL_RESULT=") === true,
	};
}

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
		if (system.includes("TOOLS=")) {
			const { request, applied } = specialistTurn(messages);
			const turn = turns[request];
			if (!turn)
				return JSON.stringify({ action: "reply", text: "承知しました。" });
			return JSON.stringify(
				turn.apply && !applied
					? turn.apply
					: { action: "reply", text: turn.reply },
			);
		}
		if (options?.tools?.length) {
			const question = messages
				.filter((m) => m.role === "user")
				.at(-1)!.content;
			const wants = [requests.create, requests.again].find((text) =>
				question.includes(text),
			);
			if (wants) {
				const tool = (options.tools as Tool[]).find(
					(t) => (t.function?.name ?? t.name) === "ui_create",
				);
				const choices: unknown[] =
					tool?.function?.parameters?.properties?.target?.enum ?? [];
				options.onToolCalls!([
					{
						id: crypto.randomUUID(),
						name: "ui_create",
						arguments: JSON.stringify({
							request: question,
							...(wants === requests.again && choices.length
								? { target: choices[0] }
								: {}),
						}),
					},
				]);
				return "";
			}
		}
		return "かしこまりました。";
	},
};

const h = await harness({ uiCompositions: true, model });
const settings = h.settings.get();
await h.settings.apply({
	requestId: crypto.randomUUID(),
	expectedRevision: settings.revision,
	settings: { ...settings, voice: { ...settings.voice, autoSpeak: false } },
	keys: [],
});
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: Number(process.env.EUMENES_PORT),
	fetch: h.app.fetch,
});
const stop = async () => {
	await h.close();
	server.stop(true);
	process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
