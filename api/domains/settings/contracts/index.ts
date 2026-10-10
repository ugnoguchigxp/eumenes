import { z } from "zod";
export const purposeSchema = z.enum(["llm", "asr", "tts"]);
export type Purpose = z.infer<typeof purposeSchema>;
const endpoint = z
	.string()
	.max(2048)
	.refine((value) => {
		try {
			const u = new URL(value);
			return (
				["http:", "https:"].includes(u.protocol) &&
				!u.username &&
				!u.password &&
				!u.search &&
				!u.hash
			);
		} catch {
			return false;
		}
	}, "URLには認証情報や検索文字列を含めないでください");
const privateHost = (host: string) => {
	const h = host.replace(/^\[|\]$/g, "");
	if (h === "localhost" || h === "::1" || h.endsWith(".local")) return true;
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
	if (!m) return false;
	const [a, b] = [Number(m[1]), Number(m[2])];
	return (
		a === 127 ||
		a === 10 ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168)
	);
};
// Bearer credentials may only travel over plain http on private networks.
export const cloudEndpoint = endpoint.refine((value) => {
	const u = new URL(value);
	return u.protocol === "https:" || privateHost(u.hostname);
}, "外部ホストには https が必要です");
export const connectionSchema = z
	.object({
		id: z.uuid(),
		name: z.string().trim().min(1).max(80),
		// Read path stays lenient so settings saved before the https rule still load;
		// applySchema enforces cloudEndpoint on input.
		baseUrl: endpoint,
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
export const resourceSchema = z
	.object({
		id: z.uuid(),
		connectionId: z.uuid(),
		purpose: purposeSchema,
		model: z.string().trim().min(1).max(200),
		contextWindow: z.number().int().min(2048).max(2_000_000).nullable(),
		voice: z.string().trim().max(200).nullable(),
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
		if (r.purpose === "tts" && !r.voice)
			ctx.addIssue({
				code: "custom",
				message: "読み上げ音声が必要です",
				path: ["voice"],
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
export const subtitleStyles = ["netflix", "prime", "classic", "glass"] as const;
export const subtitleSchema = z
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
const asrLanguageCodes = asrLanguages.map(([code]) => code) as [
	AsrLanguage,
	...AsrLanguage[],
];
export const personas = ["butler", "maid", "strategist", "sage"] as const;
export type Persona = (typeof personas)[number];
export const settingsSchema = z
	.object({
		revision: z.number().int().nonnegative(),
		larm: z
			.object({
				baseUrl: endpoint.nullable(),
				profile: z.string().trim().min(1).max(200),
				audience: z.enum(["saaa-desktop", "same-host"]),
				voice: z.string().max(200),
				speed: z.number().min(0.5).max(2).optional(),
				style: z.string().trim().min(1).max(200).optional(),
				pitchScale: z.number().min(-0.15).max(0.15).optional(),
				intonationScale: z.number().min(0).max(2).optional(),
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
				subtitles: subtitleSchema.default(defaultSubtitles),
			})
			.strict(),
		codingSupervision: z
			.object({
				/** Supervisor-generated instructions wait for user approval before reaching the CLI. */
				approveInstructions: z.boolean().default(true),
			})
			.strict()
			.default({ approveInstructions: true }),
	})
	.strict()
	.superRefine((s, ctx) => {
		if (s.larm.profile === "SAAA-gemma4-26b-64k")
			ctx.addIssue({ code: "custom", message: "補助Profileは利用できません" });
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
export type Diagnostics = z.infer<typeof diagnosticsSchema>;
