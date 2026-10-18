import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LarmPort } from "../api/domains/larm";
import { harness } from "../api/application/toolchain/toolchain.fixture";
import {
	analysisReceipt,
	isAnalysisRound,
} from "../api/domains/dialogue/test/analysis.fixture";

/**
 * Browser-test backend for tests/browser/ui-compositions.spec.ts: the real toolchain harness with the
 * ui-compositions bundle and one scripted model. The contract is the spec's header comment:
 * - the normal addressee's first round delegates the message containing `requests.create` or
 *   `requests.again` to the session toolchain (`ui_create`) and answers anything else itself; its second
 *   round starts `ui_create` with that text, and for `requests.again` (sent while a saved work is
 *   viewed) targets that work;
 * - the specialist answers by the request of its turn (the last user message): one `doc.write` (a whole
 *   definition) or `doc.edit` (replacements on the CURRENT_DOCUMENT text) that carries the reply as `text`,
 *   except `requests.explain`, which is answered without changing the draft.
 */
const requests = {
	create: "来場者アンケートのUIを作ってください",
	soften: "もっとやわらかい雰囲気にしてください",
	explain: "この画面の使い方を教えてください",
	again: "見出しを少し直してください",
};
/**
 * Requests of tests/browser/ui-composition-parts.spec.ts: each is delegated like `requests.create` and
 * the specialist applies one finished definition (the acceptance fixtures of the ui-compositions
 * domain, and a small slides composition) under the given title.
 */
const fixtureDir = join(
	import.meta.dir,
	"../api/domains/ui-compositions/test/fixtures",
);
const fixtureOf = (name: string) =>
	JSON.parse(readFileSync(join(fixtureDir, name), "utf8")) as unknown;
const slides = {
	view: "layout",
	direction: "slides",
	title: "紙芝居の入力",
	model: {
		state: { count: { type: "number", initial: 1, min: 0, max: 100 } },
		computed: { doubled: "count * 2" },
	},
	children: [
		{
			view: "layout",
			title: "数を入れる",
			children: [{ view: "number-input", bind: "count", label: "個数" }],
		},
		{
			view: "layout",
			title: "結果",
			children: [
				{ view: "stat", label: "2倍", expr: "doubled", format: "integer" },
			],
		},
	],
};
const parts: Record<string, { title: string; definition: unknown }> = {
	ランディングページを作ってください: {
		title: "コーヒー豆のランディングページ",
		definition: fixtureOf("u1-landing-page.json"),
	},
	老後資金のシミュレーターを作ってください: {
		title: "老後資金の試算",
		definition: fixtureOf("u4-retirement.json"),
	},
	三角測量の説明ページを作ってください: {
		title: "三角測量",
		definition: fixtureOf("u5b-triangulation.json"),
	},
	紙芝居を作ってください: { title: "紙芝居の入力", definition: slides },
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
/** The work document the specialist reads in this call (its CURRENT_DOCUMENT block). */
type Doc = { revision: number; text: string };
/** A turn: the document tool call it makes (given the document it reads), and the reply it speaks. */
type Turn = { call?: (doc: Doc) => Record<string, unknown>; reply: string };

const write = (title: string, definition: unknown) => (doc: Doc) => ({
	tool: "doc.write",
	arguments: { baseRevision: doc.revision, title, content: definition },
});
const once = (text: string, part: string) => text.split(part).length === 2;
const surveyWrite = (title: string, gap?: "relaxed") =>
	write(title, survey(title, gap));
/**
 * The same change as an edit of the canonical text (new title, relaxed gap); a document that does not
 * contain the expected lines exactly once is written whole instead.
 */
const soften = (title: string) => (doc: Doc) => {
	const heading = '"title": "来場者アンケート"';
	const direction = '"direction": "stack"';
	if (!once(doc.text, heading) || !once(doc.text, direction))
		return surveyWrite(title, "relaxed")(doc);
	return {
		tool: "doc.edit",
		arguments: {
			baseRevision: doc.revision,
			title,
			edits: [
				{ old: heading, new: `"title": "${title}"` },
				{ old: direction, new: `${direction},\n  "gap": "relaxed"` },
			],
		},
	};
};
const turns: Record<string, Turn> = {
	[requests.create]: {
		call: surveyWrite("来場者アンケート"),
		reply: "アンケートの初稿を作りました。",
	},
	[requests.soften]: {
		call: soften("やわらかいアンケート"),
		reply: "雰囲気をやわらかくしました。",
	},
	[requests.explain]: { reply: "このままで問題ありません。" },
	[requests.again]: {
		call: surveyWrite("再編集したアンケート"),
		reply: "見出しを直しました。",
	},
	...Object.fromEntries(
		Object.entries(parts).map(([request, { title, definition }]) => [
			request,
			{
				call: write(title, definition),
				reply: `${title}を作りました。`,
			},
		]),
	),
};

type Prompt = Parameters<LarmPort["answer"]>[0];
type Tool = { function?: { name?: string; parameters?: any }; name?: string };

/**
 * The specialist's current turn: its request (the last user message that is not a tool result), the
 * document it reads, and whether a tool result is already in.
 */
function specialistTurn(messages: Prompt) {
	const request =
		messages
			.filter((m) => m.role === "user" && !m.content.startsWith("TOOL_RESULT="))
			.at(-1)?.content ?? "";
	const block =
		/CURRENT_DOCUMENT path=definition\.json revision=(\d+)[^\n]*\n<<<\n([\s\S]*?)\n>>>/.exec(
			messages.map((m) => m.content).join("\n"),
		);
	return {
		request,
		doc: { revision: Number(block?.[1] ?? 0), text: block?.[2] ?? "" },
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
			const { request, doc, applied } = specialistTurn(messages);
			const turn = Object.entries(turns).find(([text]) =>
				request.includes(text),
			)?.[1];
			if (!turn)
				return JSON.stringify({ action: "reply", text: "承知しました。" });
			// The operation carries the reply: the host speaks it once the change is accepted.
			return JSON.stringify(
				turn.call && !applied
					? { action: "invoke", ...turn.call(doc), text: turn.reply }
					: { action: "reply", text: turn.reply },
			);
		}
		if (options?.tools?.length) {
			const question = messages
				.filter((m) => m.role === "user")
				.at(-1)!.content;
			const wants = [
				requests.create,
				requests.again,
				...Object.keys(parts),
			].find((text) => question.includes(text));
			// The first round decides: a UI request goes to the studio, anything else is answered here.
			if (isAnalysisRound(options.tools)) {
				options.onToolCalls!(
					(wants
						? analysisReceipt("fixture", {
								name: "ui_create",
								args: { kind: "creation" },
								announcement: "制作担当に引き継ぎます。",
							})
						: analysisReceipt("fixture")
					).toolCalls as never,
				);
				return "";
			}
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
