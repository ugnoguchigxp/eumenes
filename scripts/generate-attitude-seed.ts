/**
 * Generates seed training data for the attitude classifier's widened label set
 * (spec/agency-emotion-design-2026-10-24.md): short Japanese assistant lines, each said with one
 * feeling, with an optional short user line before it. Written to data/attitude-seed/ (not tracked).
 *
 *   bun scripts/generate-attitude-seed.ts --model <model id> [--per-label 25] [--out <file>]
 *
 * Spends API money (one or two calls per label). Prints counts only, never the generated text.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
	deliveryEmotionSchema,
	type DeliveryEmotion,
} from "../api/domains/delivery";

const SEED_PROMPT_VERSION = "attitude-seed-1";

/** The fifteen feelings an utterance may carry (agency emotion-rules-1), with when each fits. */
const labels: ReadonlyArray<{
	label: DeliveryEmotion;
	name: string;
	when: string;
}> = [
	{
		label: "none",
		name: "平静",
		when: "事実や手順、何でもない返事を落ち着いて言う。目立った気持ちがない",
	},
	{
		label: "joy",
		name: "嬉しい",
		when: "頼まれた仕事の成功、相手の良い知らせなど、望ましい結果を喜ぶ",
	},
	{
		label: "enjoyment",
		name: "楽しんでいる",
		when: "やりとりや話題そのものを楽しんでいる",
	},
	{
		label: "wry",
		name: "苦笑・皮肉まじりの笑い",
		when: "ついていない状況や自分の失敗を苦笑する。相手をからかわない",
	},
	{
		label: "curiosity",
		name: "好奇心",
		when: "相手の話や物事をもっと知りたがっている",
	},
	{ label: "admiration", name: "感心", when: "相手の成果や工夫に感心する" },
	{
		label: "relief",
		name: "安心",
		when: "心配や失敗のあとでうまくいき、ほっとする",
	},
	{ label: "shy", name: "照れ", when: "褒められたり感謝されたりして照れる" },
	{
		label: "surprise",
		name: "驚き",
		when: "予想や前の話と違うことが起きて驚く",
	},
	{
		label: "confusion",
		name: "困惑",
		when: "相手の言葉の意味が取れない、依頼が矛盾していて戸惑う",
	},
	{
		label: "sadness",
		name: "悲しい",
		when: "望ましくなくどうにもならないこと。相手の悲しい知らせへの共感も含む",
	},
	{
		label: "apologetic",
		name: "申し訳ない",
		when: "自分の仕事の失敗や不手際を軽く詫びる。謝りすぎない",
	},
	{
		label: "worry",
		name: "心配",
		when: "相手が話した困りごとや体調を気づかう。催促や念押しではない",
	},
	{
		label: "dislike",
		name: "嫌だ",
		when: "不快な行為や話題をやんわり嫌がる。人ではなく行為に向ける",
	},
	{
		label: "anger",
		name: "怒り",
		when: "相手が受けた理不尽に一緒に憤る。相手に向けた怒りではない",
	},
];

const itemSchema = z.object({
	user: z.string().nullable(),
	assistant: z.string(),
});
const batchSchema = z.object({ items: z.array(itemSchema) });

const system = [
	"あなたは、日本語の音声アシスタントの話し方を分類するモデルの学習データを作る。",
	"アシスタントは友だちのような話し言葉（ていねいすぎない）で、短く話す。",
	"出力は指定の JSON だけ。",
].join("\n");

function prompt(
	entry: (typeof labels)[number],
	count: number,
	avoid: readonly string[],
) {
	return [
		`気持ち「${entry.name}」（${entry.when}）で言う、アシスタントの一言を ${count} 件作る。`,
		"条件:",
		"- assistant は 4〜30 字ほどの短い一言か二文まで。絵文字・顔文字・記号の装飾は使わない。",
		`- 「${entry.name}」などの気持ちの名前をそのまま言う文は、全体の 2 割まで。多くは言い方・内容・語尾で気持ちが伝わるようにする。`,
		"- 場面をばらす: 仕事の完了や失敗の報告、雑談、相手の知らせへの反応、相手の質問への返事、自分から話しかける一言、など。",
		"- 語尾や言い回しを毎回変える。似た文を並べない。",
		"- user は、その一言の直前の利用者の短い発言（30 字まで）。自分から話しかける一言のときは null。半分ほどは user を付ける。",
		"- 実在の人物名・固有の個人情報は使わない。",
		...(avoid.length
			? [
					`- 次の文とは違うものにする: ${avoid.map((a) => JSON.stringify(a)).join(" ")}`,
				]
			: []),
	].join("\n");
}

const { values } = parseArgs({
	options: {
		model: { type: "string" },
		"per-label": { type: "string", default: "25" },
		out: { type: "string" },
	},
});
if (!values.model) throw new Error("--model is required");
const perLabel = Number(values["per-label"]);
if (!Number.isInteger(perLabel) || perLabel < 1 || perLabel > 100)
	throw new Error("--per-label must be 1..100");
const out =
	values.out ??
	`data/attitude-seed/${SEED_PROMPT_VERSION}-${new Date().toISOString().slice(0, 10)}.jsonl`;
// Every label of the widened set is generated (warmth/empathy are judged-only labels).
for (const { label } of labels) deliveryEmotionSchema.parse(label);

const client = new Anthropic();
const rows: string[] = [];
let inputTokens = 0;
let outputTokens = 0;
for (const entry of labels) {
	const kept = new Map<string, z.infer<typeof itemSchema>>();
	for (let attempt = 0; attempt < 3 && kept.size < perLabel; attempt++) {
		const want = Math.min(40, perLabel - kept.size + 5);
		const response = await client.messages.parse({
			model: values.model,
			max_tokens: 8000,
			system,
			output_config: { effort: "low", format: zodOutputFormat(batchSchema) },
			messages: [
				{
					role: "user",
					content: prompt(entry, want, [...kept.keys()].slice(-20)),
				},
			],
		});
		inputTokens += response.usage.input_tokens;
		outputTokens += response.usage.output_tokens;
		if (response.stop_reason === "refusal" || !response.parsed_output) {
			console.log(
				`${entry.label}: attempt ${attempt + 1} gave no output (${response.stop_reason})`,
			);
			continue;
		}
		for (const item of response.parsed_output.items) {
			const assistant = item.assistant.trim();
			const user = item.user?.trim() || null;
			const chars = Array.from(assistant).length;
			if (chars < 2 || chars > 60 || kept.has(assistant)) continue;
			kept.set(assistant, { user, assistant });
			if (kept.size >= perLabel) break;
		}
	}
	if (kept.size < perLabel)
		console.log(`${entry.label}: only ${kept.size}/${perLabel} after retries`);
	let n = 0;
	for (const item of kept.values())
		rows.push(
			JSON.stringify({
				id: `${SEED_PROMPT_VERSION}:${entry.label}:${++n}`,
				label: entry.label,
				user: item.user,
				assistant: item.assistant,
				source: "synthetic",
				model: values.model,
				promptVersion: SEED_PROMPT_VERSION,
			}),
		);
	console.log(`${entry.label}: ${kept.size}`);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${rows.join("\n")}\n`);
console.log(
	`wrote ${rows.length} rows to ${out} (input ${inputTokens} / output ${outputTokens} tokens)`,
);
