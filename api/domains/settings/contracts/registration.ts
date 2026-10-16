import { z } from "zod";
import {
	cloudEndpoint,
	connectionSchema,
	isAgentConnection,
	purposeSchema,
	resourceSchema,
} from "./index";

/** The same registration contract is checked before staging and before saving. */
export const connectionRegistrationSchema = z.strictObject({
	connectionId: z.uuid(),
	kind: connectionSchema.shape.kind,
	auth: connectionSchema.shape.auth,
	name: connectionSchema.shape.name,
	baseUrl: cloudEndpoint.optional(),
	accountId: connectionSchema.shape.accountId,
	envRef: connectionSchema.shape.envRef.unwrap().optional(),
	enabled: z.boolean().optional(),
	resourceId: z.uuid().optional(),
	purpose: purposeSchema.optional(),
	model: resourceSchema.shape.model.optional(),
	contextWindow: resourceSchema.shape.contextWindow.unwrap().optional(),
	voice: resourceSchema.shape.voice.unwrap().optional(),
	language: resourceSchema.shape.language,
	assign: z.boolean().optional(),
});

export function prepareConnectionRegistration(input: unknown, hasKey: boolean) {
	const parsed = connectionRegistrationSchema.safeParse(input);
	if (!parsed.success)
		return {
			ok: false as const,
			code: "invalid_input",
			field: String(parsed.error.issues[0]?.path[0] ?? ""),
			message: "形式・文字数・入力範囲を確認してください。",
		};
	const v = parsed.data;
	const workers = v.kind === "cloudflare-workers-ai";
	const claude = v.kind === "claude-agent-sdk";
	const refuse = (code: string, field: string, message: string) => ({
		ok: false as const,
		code,
		field,
		message,
	});
	if (workers && !v.accountId)
		return refuse(
			"invalid_input",
			"accountId",
			"Account IDを入力してください。",
		);
	if (!workers && !v.baseUrl)
		return refuse(
			"invalid_input",
			"baseUrl",
			"APIのベースURLを入力してください。",
		);
	if (!workers && v.accountId)
		return refuse(
			"invalid_input",
			"accountId",
			"Account IDはWorkers AI接続に指定します。",
		);
	if (claude && !v.auth)
		return refuse("auth_required", "auth", "認証方式を選んでください。");
	if (
		v.purpose
			? !v.resourceId || !v.model
			: v.model ||
				v.contextWindow !== undefined ||
				v.voice !== undefined ||
				v.language !== undefined ||
				v.assign
	)
		return refuse(
			"invalid_input",
			"purpose",
			"モデルを追加する場合は用途とモデル名を指定してください。",
		);
	if ((hasKey && v.envRef) || (claude && v.auth === "subscription" && v.envRef))
		return refuse(
			"invalid_credential_source",
			"envRef",
			"APIキー／トークンと環境変数名は併用できません。",
		);
	if (!hasKey && !v.envRef && v.kind !== "codex-sdk")
		return refuse(
			"credential_required",
			"apiKey",
			"APIキー／APIトークンを入力してください。",
		);
	if (
		v.purpose &&
		((workers && v.purpose === "llm") ||
			(isAgentConnection(v) && v.purpose !== "llm"))
	)
		return refuse(
			"invalid_input",
			"purpose",
			"この接続で利用できる用途を選んでください。",
		);
	if (v.purpose === "tts" && !workers && !v.voice)
		return refuse("invalid_input", "voice", "読み上げ音声を入力してください。");
	return {
		ok: true as const,
		input: v,
		connection: connectionSchema.parse({
			id: v.connectionId,
			...(v.kind && v.kind !== "openai-compatible" ? { kind: v.kind } : {}),
			...(claude ? { auth: v.auth } : {}),
			name: v.name,
			baseUrl: workers ? "https://api.cloudflare.com/client/v4" : v.baseUrl,
			...(v.accountId ? { accountId: v.accountId } : {}),
			enabled: v.enabled ?? true,
			epoch: 0,
			envRef: v.envRef ?? null,
		}),
	};
}
