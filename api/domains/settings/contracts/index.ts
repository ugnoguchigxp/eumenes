import { z } from "zod";
import {
	completionVoiceIds,
	notificationSoundIds,
} from "./notification-sounds";
export {
	completionVoiceOptions,
	type CompletionVoice,
	notificationSoundOptions,
	defaultNotificationSound,
	type NotificationSound,
} from "./notification-sounds";
import { spatialSettingsShape } from "./spatial";
import { endpoint, cloudEndpoint } from "./endpoints";
import type { HttpErrorStatus } from "../../../infrastructure/http";
export { cloudEndpoint } from "./endpoints";
export {
	excalidrawConnectionInput,
	excalidrawConnectionSchema,
	type ExcalidrawConnectionInput,
} from "./local-services";
export const purposeSchema = z.enum(["llm", "asr", "tts"]);
export type Purpose = z.infer<typeof purposeSchema>;
/** The cloud protocol: OpenAI-compatible HTTP, Workers AI speech, or an agent SDK (LLM only). */
const connectionKinds = [
	"openai-compatible",
	"cloudflare-workers-ai",
	"codex-sdk",
	"claude-agent-sdk",
] as const;
export type ConnectionKind = (typeof connectionKinds)[number];
export const isAgentConnection = (c: { kind?: ConnectionKind }) =>
	c.kind === "codex-sdk" || c.kind === "claude-agent-sdk";
/** How a Claude Agent SDK connection authenticates; chosen explicitly, never inferred from a stored key. */
const agentAuths = ["subscription", "api-key"] as const;
export type AgentAuth = (typeof agentAuths)[number];
/** Who bills a call: an automatic route change must never move a call to another billing path. */
export type BillingPath =
	| "larm"
	| "claude-subscription"
	| "claude-api-key"
	| "codex"
	| "openai-compatible"
	| "cloudflare-workers-ai";
export function billingPath(connection: {
	kind?: ConnectionKind;
	auth?: AgentAuth;
}): Exclude<BillingPath, "larm"> {
	switch (connection.kind) {
		case "claude-agent-sdk":
			return connection.auth === "subscription"
				? "claude-subscription"
				: "claude-api-key";
		case "cloudflare-workers-ai":
			return "cloudflare-workers-ai";
		case "codex-sdk":
			return "codex";
		default:
			return "openai-compatible";
	}
}
const connectionSchema = z
	.object({
		id: z.uuid(),
		/** Absent: openai-compatible (settings saved before agent connections). */
		kind: z.enum(connectionKinds).optional(),
		/** Claude Agent SDK only (required there): the credential is an API key or a `claude setup-token` OAuth token. */
		auth: z.enum(agentAuths).optional(),
		name: z.string().trim().min(1).max(80),
		// Read path stays lenient so settings saved before the https rule still load;
		// applySchema enforces cloudEndpoint on input.
		baseUrl: endpoint,
		/** Workers AI account; the API origin is fixed, never supplied by the catalog. */
		accountId: z
			.string()
			.length(32)
			.regex(/^[a-fA-F0-9]{32}$/)
			.optional(),
		enabled: z.boolean(),
		epoch: z.number().int().nonnegative(),
		envRef: z
			.string()
			.regex(/^[A-Z][A-Z0-9_]*$/)
			.max(128)
			.refine(
				(v) =>
					!v.startsWith("LARM_") &&
					!["EUMENES_API_TOKEN", "EUMENES_SECRET_KEY"].includes(v),
				"内部認証用の環境変数は指定できません",
			)
			.nullable(),
	})
	.strict();
const resourceSchema = z
	.object({
		id: z.uuid(),
		connectionId: z.uuid(),
		purpose: purposeSchema,
		model: z.string().trim().min(1).max(200),
		contextWindow: z.number().int().min(2048).max(2_000_000).nullable(),
		voice: z.string().trim().max(200).nullable(),
		language: z.string().trim().min(1).max(80).optional(),
		speed: z.number().min(0.5).max(2).optional(),
	})
	.strict()
	.superRefine((r, ctx) => {
		if (r.purpose === "llm" && !r.contextWindow)
			ctx.addIssue({
				code: "custom",
				message: "会話モデルの文脈長が必要です",
				path: ["contextWindow"],
			});
	});
const routeSchema = z
	.object({
		mode: z.enum(["larm-preferred", "larm-only", "cloud-only"]),
		cloudAllowed: z.boolean(),
		fallbackId: z.uuid().nullable(),
		epoch: z.number().int().nonnegative(),
	})
	.strict();
const subtitleStyles = ["netflix", "prime", "classic", "glass"] as const;
const subtitleSchema = z
	.object({
		enabled: z.boolean(),
		style: z.enum(subtitleStyles),
		size: z.enum(["medium", "large", "xlarge"]),
	})
	.strict();
export type SubtitleSettings = z.infer<typeof subtitleSchema>;
export const defaultSubtitles: SubtitleSettings = {
	enabled: false,
	style: "netflix",
	size: "large",
};
/** ASR languages offered in settings (same set as SAAA's Voice settings). */
export const asrLanguages = [
	["ja", "日本語"],
	["en", "英語"],
	["zh", "中国語"],
	["yue", "広東語"],
	["ko", "韓国語"],
	["ar", "アラビア語"],
	["de", "ドイツ語"],
	["fr", "フランス語"],
	["es", "スペイン語"],
	["pt", "ポルトガル語"],
	["id", "インドネシア語"],
	["it", "イタリア語"],
	["ru", "ロシア語"],
	["th", "タイ語"],
	["vi", "ベトナム語"],
	["tr", "トルコ語"],
	["hi", "ヒンディー語"],
	["ms", "マレー語"],
	["nl", "オランダ語"],
	["sv", "スウェーデン語"],
	["da", "デンマーク語"],
	["fi", "フィンランド語"],
	["pl", "ポーランド語"],
	["cs", "チェコ語"],
	["fil", "フィリピン語"],
	["fa", "ペルシャ語"],
	["el", "ギリシャ語"],
	["ro", "ルーマニア語"],
	["hu", "ハンガリー語"],
	["mk", "マケドニア語"],
] as const;
export type AsrLanguage = (typeof asrLanguages)[number][0];
/** The English names ASR providers report a detected language with. */
const asrLanguageNames: Record<AsrLanguage, string> = {
	ja: "Japanese",
	en: "English",
	zh: "Chinese",
	yue: "Cantonese",
	ko: "Korean",
	ar: "Arabic",
	de: "German",
	fr: "French",
	es: "Spanish",
	pt: "Portuguese",
	id: "Indonesian",
	it: "Italian",
	ru: "Russian",
	th: "Thai",
	vi: "Vietnamese",
	tr: "Turkish",
	hi: "Hindi",
	ms: "Malay",
	nl: "Dutch",
	sv: "Swedish",
	da: "Danish",
	fi: "Finnish",
	pl: "Polish",
	cs: "Czech",
	fil: "Filipino",
	fa: "Persian",
	el: "Greek",
	ro: "Romanian",
	hu: "Hungarian",
	mk: "Macedonian",
};
/** How a detected language of an allowed one may be reported: its code or English name, lower case. */
export const asrAcceptedLanguages = (languages: readonly AsrLanguage[]) =>
	languages.flatMap((code) => [code, asrLanguageNames[code].toLowerCase()]);
/** ASR takes one language: Japanese whenever it is allowed, otherwise the first allowed one. */
export const asrRequestLanguage = (languages: readonly AsrLanguage[]) =>
	languages.includes("ja") ? "ja" : languages[0];
const asrLanguageCodes = asrLanguages.map(([code]) => code) as [
	AsrLanguage,
	...AsrLanguage[],
];
const personas = ["butler", "maid", "strategist", "sage"] as const;
const backgroundSchema = z.enum(["light-fairy", "spatial"]);
export type BackgroundKind = z.infer<typeof backgroundSchema>;
export const backgroundKinds = backgroundSchema.options;
/**
 * The user-intent judge (the intent gate design, section 5), apart from the speaking-attitude judge's settings:
 * `legacy` keeps the existing routing, `shadow` also asks the judge and records it, `ruri` (the default) lets the
 * judge's result decide the routing.
 */
export const intentModes = ["legacy", "shadow", "ruri"] as const;
const intentProfile = z.string().trim().min(1).max(200);
const intentTimeoutMs = z.number().int().min(100).max(5000);
const intentSearchScore = z.number().min(0).max(1);
export const intentSettingsSchema = z
	.object({
		mode: z.enum(intentModes).default("ruri"),
		/** The LARM Agent Profile of the judge; absent until saved, and then no judge is asked. */
		profile: intentProfile.optional(),
		/** How long `ruri` waits for the judge before the existing routing goes on alone. */
		timeoutMs: intentTimeoutMs.default(1500),
		/** `ruri` asks for the toolchain search first when `request` scores at least this (a threshold, not a chance). */
		searchScore: intentSearchScore.default(0.6),
	})
	.strict();
export type IntentSettings = z.infer<typeof intentSettingsSchema>;
/** A change of the judge's settings: the fields given replace the saved ones; a null profile removes it. */
export const intentPatchSchema = z
	.object({
		mode: z.enum(intentModes),
		profile: intentProfile.nullable(),
		timeoutMs: intentTimeoutMs,
		searchScore: intentSearchScore,
	})
	.partial()
	.strict();
export const settingsSchema = z
	.object({
		revision: z.number().int().nonnegative(),
		larm: z
			.object({
				baseUrl: endpoint.nullable(),
				/** Optional opaque monitor targets. A unique target is selected automatically. */
				monitoringNodeId: z.string().min(1).max(192).optional(),
				monitoringGpuId: z.string().min(1).max(192).optional(),
				/** The Agent Profile selector chosen by the user; absent until saved. */
				profile: z.string().trim().min(1).max(200).optional(),
				audience: z.enum(["saaa-desktop", "same-host"]),
				voice: z.string().max(200),
				/** Routes English stretches of spoken text to the catalog's English voice. */
				englishSpeechEnabled: z.boolean().optional(),
				/** Legacy fields accepted for stored documents; English voices and speed are fixed. */
				englishVoice: z.string().trim().max(200).optional(),
				englishMasculineVoice: z.string().trim().max(200).optional(),
				englishSpeed: z.number().min(0.5).max(2).optional(),
				speed: z.number().min(0.5).max(2).optional(),
				style: z.string().trim().min(1).max(200).optional(),
				pitchScale: z.number().min(-0.15).max(0.15).optional(),
				intonationScale: z.number().min(0).max(2).optional(),
				/** Applies the per-phrase delivery to the voice; absent means on. */
				autoIntonation: z.boolean().optional(),
				/** Scales how far per-phrase adjustments move from the saved baseline. */
				autoStrength: z.number().min(0).max(2).optional(),
			})
			.strict(),
		connections: z.array(connectionSchema).max(32),
		resources: z.array(resourceSchema).max(128),
		routes: z
			.object({ llm: routeSchema, asr: routeSchema, tts: routeSchema })
			.strict(),
		voice: z
			.object({
				autoSpeak: z.boolean(),
				notificationSound: z.enum(notificationSoundIds).optional(),
				completionVoice: z.enum(completionVoiceIds).optional(),
				outputVolume: z.number().min(0).max(1).default(1),
				bargeIn: z.boolean(),
				inputDevice: z.string().max(300),
				outputDevice: z.string().max(300),
				threshold: z.number().min(0.001).max(0.1),
				silenceMs: z.number().int().min(300).max(3000),
				echoCancellation: z.boolean(),
				noiseSuppression: z.boolean(),
				autoGainControl: z.boolean(),
			})
			.strict(),
		general: z
			.object({
				agentName: z.string().trim().max(40).default(""),
				userName: z.string().trim().max(40).default(""),
				persona: z.enum(personas).default("butler"),
				asrLanguages: z
					.array(z.enum(asrLanguageCodes))
					.min(1)
					.max(asrLanguageCodes.length)
					.refine((v) => new Set(v).size === v.length, "言語が重複しています")
					.default(["ja", "en"]),
				theme: z.enum(["system", "light", "dark"]),
				background: backgroundSchema.optional(),
				...spatialSettingsShape,
				subtitles: subtitleSchema.default(defaultSubtitles),
			})
			.strict(),
		intent: intentSettingsSchema.default({
			mode: "ruri",
			timeoutMs: 1500,
			searchScore: 0.6,
		}),
		world: z
			.object({
				/**
				 * Personal World ON/OFF, read once at backend startup (a change takes effect on
				 * restart). OFF still protects (forget propagation only) while World holds content.
				 */
				enabled: z.boolean().default(false),
				/**
				 * The cloud LLM resource the steward writes World with; null keeps the conversation route.
				 * Read on each request: a change applies to the next World curation.
				 */
				curationResourceId: z.uuid().nullable().default(null),
			})
			.strict()
			.default({ enabled: false, curationResourceId: null }),
		agency: z
			.object({
				/** Seconds of silence before an AI-initiated turn; 0 turns the silence-triggered turns off (turn_end still runs). */
				idleSec: z.number().int().min(0).max(86400).default(20),
				/** AI-initiated utterances allowed in a row without a user reply. */
				maxUnanswered: z.number().int().min(1).max(10).default(1),
				/** Standing interests the persona may bring up on its own. */
				interests: z.array(z.string().min(1).max(200)).max(3).default([]),
				/** The agency picks a light feeling for each utterance (voice tone and motion). */
				emotion: z.boolean().default(true),
			})
			.strict()
			.default({
				idleSec: 20,
				maxUnanswered: 1,
				interests: [],
				emotion: true,
			}),
	})
	.strict()
	.superRefine((s, ctx) => {
		if (s.larm.baseUrl && URL.canParse(s.larm.baseUrl)) {
			const u = new URL(s.larm.baseUrl);
			const host = u.hostname;
			const local =
				host === "localhost" ||
				host.endsWith(".local") ||
				(/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) &&
					host.split(".").every((part) => Number(part) <= 255) &&
					/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host));
			if (
				!local ||
				(s.larm.audience === "same-host" &&
					!["localhost", "127.0.0.1"].includes(host))
			)
				ctx.addIssue({
					code: "custom",
					message: "LARMにはローカルのURLを指定してください",
				});
		}
		const ids = new Set(s.connections.map((c) => c.id));
		if (
			ids.size !== s.connections.length ||
			new Set(s.resources.map((r) => r.id)).size !== s.resources.length
		)
			ctx.addIssue({ code: "custom", message: "IDが重複しています" });
		for (const r of s.resources)
			if (!ids.has(r.connectionId))
				ctx.addIssue({ code: "custom", message: "接続先がありません" });
		for (const r of s.resources) {
			const c = s.connections.find((c) => c.id === r.connectionId);
			if (
				r.purpose === "tts" &&
				!r.voice &&
				c?.kind !== "cloudflare-workers-ai"
			)
				ctx.addIssue({ code: "custom", message: "読み上げ音声が必要です" });
		}
		for (const c of s.connections) {
			if (c.kind === "cloudflare-workers-ai") {
				if (
					!c.accountId ||
					c.baseUrl !== "https://api.cloudflare.com/client/v4"
				)
					ctx.addIssue({
						code: "custom",
						message: "Workers AIのAccount IDと接続先が不正です",
					});
				if (
					s.resources.some(
						(r) => r.connectionId === c.id && r.purpose === "llm",
					)
				)
					ctx.addIssue({
						code: "custom",
						message: "このWorkers AI接続は音声用途に使います",
					});
			} else if (c.accountId !== undefined)
				ctx.addIssue({
					code: "custom",
					message: "Account IDはWorkers AI接続に指定します",
				});
			if (
				isAgentConnection(c) &&
				s.resources.some((r) => r.connectionId === c.id && r.purpose !== "llm")
			)
				ctx.addIssue({
					code: "custom",
					message: "エージェントSDKの接続は会話用途にだけ使えます",
				});
			if ((c.kind === "claude-agent-sdk") !== !!c.auth)
				ctx.addIssue({
					code: "custom",
					message: "認証方式はClaude Agent SDKの接続にだけ、必ず指定します",
				});
			if (c.auth === "subscription" && c.envRef)
				ctx.addIssue({
					code: "custom",
					message: "サブスクリプションの接続には環境変数のキーを指定できません",
				});
		}
		for (const p of purposeSchema.options) {
			const route = s.routes[p];
			if (
				route.fallbackId &&
				!s.resources.some((r) => r.id === route.fallbackId && r.purpose === p)
			)
				ctx.addIssue({ code: "custom", message: "用途と代替先が一致しません" });
			if (
				route.mode === "cloud-only" &&
				(!route.cloudAllowed || !route.fallbackId)
			)
				ctx.addIssue({
					code: "custom",
					message: "クラウド専用には許可と代替先が必要です",
				});
		}
		const worldResource = s.world.curationResourceId;
		if (
			worldResource &&
			!s.resources.some((r) => r.id === worldResource && r.purpose === "llm")
		)
			ctx.addIssue({
				code: "custom",
				message: "Worldの記録に使うAIが会話モデルとして登録されていません",
				path: ["world", "curationResourceId"],
			});
	});
export type Settings = z.infer<typeof settingsSchema>;
export type Connection = z.infer<typeof connectionSchema>;
export type Resource = z.infer<typeof resourceSchema>;
export const applySchema = z
	.object({
		requestId: z.uuid(),
		expectedRevision: z.number().int().nonnegative(),
		settings: settingsSchema,
		keys: z
			.array(
				z
					.object({
						connectionId: z.uuid(),
						value: z
							.string()
							.min(1)
							.max(4096)
							.refine(
								(v) => new TextEncoder().encode(v).length <= 4096,
								"APIキーは4096バイト以内で指定してください",
							)
							.nullable(),
					})
					.strict(),
			)
			.max(32),
		/** Required only when the saved LARM origin changes; must equal the new origin. */
		confirmLarmOrigin: z.string().max(2048).optional(),
	})
	.strict()
	.superRefine((input, ctx) => {
		input.settings.connections.forEach((connection, index) => {
			if (!cloudEndpoint.safeParse(connection.baseUrl).success)
				ctx.addIssue({
					code: "custom",
					message: "外部ホストには https が必要です",
					path: ["settings", "connections", index, "baseUrl"],
				});
		});
	});
export type ApplySettings = z.infer<typeof applySchema>;

export const diagnosticsSchema = z.object({
	keyError: z.string().nullable(),
	connections: z.array(
		z.object({
			id: z.string(),
			credentialAvailable: z.boolean(),
			source: z.string(),
		}),
	),
});

/** The same registration contract is checked before staging and before saving. */
const connectionRegistrationSchema = z.strictObject({
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
/** HTTP status of each code the settings operations throw. */
export const errorStatus = {
	env_ref_not_allowed: 400,
} as const satisfies Record<string, HttpErrorStatus>;
