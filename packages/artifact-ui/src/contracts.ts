import { z } from "zod";

const title = z.string().max(120).optional();
const source = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const field = z.strictObject({
	id: source,
	label: z.string().min(1).max(120),
	type: z.enum(["text", "textarea", "number", "select", "boolean"]),
	required: z.boolean().optional(),
	options: z.array(z.string().min(1).max(120)).min(1).max(8).optional(),
}).superRefine((f, ctx) => {
	if (f.type === "select" && !f.options)
		ctx.addIssue({ code: "custom", message: "選択肢が必要です" });
});
const question = z.strictObject({
	prompt: z.string().min(1).max(500),
	options: z.array(z.string().min(1).max(120)).min(1).max(8).optional(),
});
export const viewRegistry = {
	"components": { name: "Components", label: "基本コンポーネント", schema: z.strictObject({ view: z.literal("components"), source, title }) },
	"generated-image": { name: "GeneratedImage", label: "画像の額縁", schema: z.strictObject({ view: z.literal("generated-image"), source, title }) },
	"question": { name: "Question", label: "質問と回答", schema: z.strictObject({ view: z.literal("question"), source: source.optional(), title, question: question.optional() }).superRefine((r, ctx) => {
		if (!r.source && !r.question) ctx.addIssue({ code: "custom", message: "source または question が必要です" });
		if (r.source && r.question) ctx.addIssue({ code: "custom", message: "source と question は併用できません" });
	}) },
	"form": { name: "SmallForm", label: "小さなフォーム", schema: z.strictObject({ view: z.literal("form"), source: source.optional(), title, fields: z.array(field).min(1).max(8).optional() }).superRefine((r, ctx) => {
		if ((!r.source && !r.fields) || (r.source && r.fields)) ctx.addIssue({ code: "custom", message: "source または fields の一方を指定してください" });
		if (r.fields && new Set(r.fields.map(f => f.id)).size !== r.fields.length) ctx.addIssue({code:"custom",message:"項目IDが重複しています"});
	}) },
	"memory": { name: "MemoryReview", label: "メモリーの整理", schema: z.strictObject({ view: z.literal("memory"), source, title }) },
	"settings": { name: "SettingsForm", label: "表示と音声の設定", schema: z.strictObject({ view: z.literal("settings"), source, title }) },
} as const;
export type View = keyof typeof viewRegistry;
export type ArtifactRequest = { [K in View]: z.infer<(typeof viewRegistry)[K]["schema"]> }[View];
export type Field = z.infer<typeof field>;
export type QuestionData = z.infer<typeof question>;
export const maxDefinitionBytes = 16_384;
export function parseRequest(value: unknown): ArtifactRequest {
	if (!value || typeof value !== "object" || !("view" in value) || typeof value.view !== "string" || !Object.hasOwn(viewRegistry, value.view)) throw new Error("未登録の表示です");
	return viewRegistry[value.view as View].schema.parse(value);
}
export function parseDefinition(input: string): ArtifactRequest {
	if (new TextEncoder().encode(input).length > maxDefinitionBytes) throw new Error("定義が大きすぎます（16KBまで）");
	return parseRequest(JSON.parse(input));
}

export type ImageResource = { kind: "generated-image"; revision: number; status: "queued" | "running" | "succeeded" | "failed" | "cancelled"; url?: string; alt: string };
export type QuestionResource = { kind: "question"; revision: number; status: "open" | "answered" | "expired"; question: QuestionData; answer?: string };
export type FormResource = { kind: "form"; revision: number; fields: Field[]; defaults: Record<string, string | boolean>; submitted?: Record<string, string | boolean> };
export type MemoryResource = { kind: "memory"; revision: number; entries: { id: string; text: string; selected: boolean }[] };
export type SettingsResource = { kind: "settings"; revision: number; theme: "light" | "dark"; autoSpeak: boolean; volume: number };
export type Resource = ImageResource | QuestionResource | FormResource | MemoryResource | SettingsResource | { kind: "components"; revision: number };
export type Snapshot = Readonly<Record<string, Resource>>;
export type ArtifactEvent = { id: string; source: string; revision: number; action: "answer" | "submit" | "memory-correct" | "memory-select" | "settings-save" | "demo-click"; values: Record<string, string | boolean> };
export type Receipt = { status: "accepted" | "duplicate" | "conflict" | "rejected"; message: string };
