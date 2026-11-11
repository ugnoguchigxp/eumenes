import { z } from "zod";
import type { ControlContract } from "../../inference";
import { spokenReplyMeasure } from "../../delivery";

const sentence = z
	.string()
	.regex(/^[^\r\n。！？!?]{1,149}[。！？!?]?$/u)
	.refine((text) => spokenReplyMeasure(text).sentences === 1);

const output = z.strictObject({
	action: z
		.enum(["reply", "invoke", "return", "discard"])
		.describe(
			"reply は専門範囲の相談への説明や、情報が足りないときの質問。invoke は登録操作。return は担当範囲外の依頼か、利用者が担当からの復帰を求めた場合。discard は利用者が明示した破棄。",
		),
	tool: z.string().nullable().describe("invoke で使う TOOLS の id。"),
	arguments: z
		.string()
		.nullable()
		.describe("操作引数を JSON オブジェクトとして文字列に入れる。"),
	text: z
		.strictObject({
			first: sentence.describe("利用者への最初の一文。"),
			second: sentence.nullable().describe("補足が必要なときの二文目。"),
		})
		.nullable()
		.describe("短い返信。invoke の結果を読んでから答える場合は null。"),
	forward: z
		.boolean()
		.nullable()
		.describe(
			"return で担当外の依頼を通常担当へ渡す場合は true。復帰だけなら false。",
		),
	stateUpdate: z
		.string()
		.nullable()
		.describe(
			"共同作業の状態更新がある場合に JSON オブジェクトとして文字列に入れる。",
		),
});

export const specialistOutputSchema = z.toJSONSchema(output, { io: "input" });

export const specialistSingleSentenceOutputSchema = z.toJSONSchema(
	output.extend({
		text: z.strictObject({ first: sentence, second: z.null() }).nullable(),
	}),
	{ io: "input" },
);

export function structuredSpecialistControl(
	control: ControlContract,
): ControlContract {
	const state = (
		control.outputSchema as { properties?: { stateUpdate?: unknown } }
	).properties?.stateUpdate;
	return {
		...control,
		instructions:
			control.instructions +
			"\n応答は OUTPUT_SCHEMA の一つのオブジェクトにまとめます。不要な項目は null を入れます。返信は first に一文を書き、補足が必要な場合だけ second に一文を入れます。引用する原文や数値はそのまま写します。文の区切りは各欄の末尾に置きます。" +
			(state
				? "\nstateUpdate の中に入れる JSON の形式は STATE_UPDATE_SCHEMA=" +
					JSON.stringify(state)
				: "\nこのターンの stateUpdate には null を入れます。"),
		outputSchema: specialistOutputSchema,
	};
}

export class SpecialistOutputError extends Error {
	constructor(readonly issues: { path: string; code: string }[]) {
		super("specialist_structured_output_invalid");
	}
}

function parseJsonField(text: string, path: string): unknown {
	try {
		return JSON.parse(text);
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
		throw new SpecialistOutputError([{ path, code: "invalid_json" }]);
	}
}

/** Decode the transport fields before the existing action, tool and state validators run. */
export function decodeSpecialistOutput(raw: string): unknown {
	const parsed = output.safeParse(parseJsonField(raw, ""));
	if (!parsed.success)
		throw new SpecialistOutputError(
			parsed.error.issues.slice(0, 8).map(({ path, code }) => ({
				path: path.join("."),
				code,
			})),
		);
	const {
		action,
		tool,
		arguments: args,
		text,
		forward,
		stateUpdate,
	} = parsed.data;
	return {
		action,
		...(tool !== null ? { tool } : {}),
		...(args !== null ? { arguments: parseJsonField(args, "arguments") } : {}),
		...(text
			? { text: [text.first, text.second].filter(Boolean).join(" ") }
			: {}),
		...(forward !== null ? { forward } : {}),
		...(stateUpdate !== null
			? { stateUpdate: parseJsonField(stateUpdate, "stateUpdate") }
			: {}),
	};
}
