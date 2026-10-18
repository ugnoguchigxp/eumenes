import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { SpecialistDocument, SpecialistSet } from "../contracts";

/**
 * The agent kernel's settings and host tools for a session (spec subagent-task-and-session-agents §6–§7).
 * A binding sets what it needs; the rest are these defaults.
 */
const DEFAULTS = {
	maxModelCalls: 4,
	retries: { default: 1, "doc.edit": 1, "doc.write": 0 } as Record<
		string,
		number
	>,
	recentTurns: 12,
	recentBytes: 192 * 1024,
	inlineBytes: 32 * 1024,
};

export type AgentPolicy = {
	maxModelCalls: number;
	/** Retries after a refusal of this tool within one turn. */
	retriesOf(tool: string): number;
	recentTurns: number;
	recentBytes: number;
	inlineBytes: number;
};

export function agentPolicy(set: SpecialistSet): AgentPolicy {
	const retries = { ...DEFAULTS.retries, ...set.agent.retries };
	return {
		maxModelCalls: set.agent.maxModelCalls ?? DEFAULTS.maxModelCalls,
		retriesOf: (tool) => retries[tool] ?? retries.default ?? 1,
		recentTurns: set.agent.recentTurns ?? DEFAULTS.recentTurns,
		recentBytes: set.agent.recentBytes ?? DEFAULTS.recentBytes,
		inlineBytes: set.agent.document?.inlineBytes ?? DEFAULTS.inlineBytes,
	};
}

const baseRevision = z
	.number()
	.int()
	.min(0)
	.describe("編集の元にした版（CURRENT_DOCUMENTのrevision）。");
const title = z
	.string()
	.trim()
	.min(1)
	.max(120)
	.describe("作業のタイトル。変えるときだけ書く。");
const docEdit = z.strictObject({
	baseRevision,
	title: title.optional(),
	edits: z
		.array(
			z.strictObject({
				old: z
					.string()
					.min(1)
					.describe(
						"CURRENT_DOCUMENTの中にちょうど1回だけ現れる文字列。空白・改行・インデントも含めてそのまま写す。一意にならなければ前後の行を含める。",
					),
				new: z.string().describe("oldと置き換える文字列。消すときは空文字。"),
			}),
		)
		.min(1)
		.max(32)
		.describe("上から順に、前の置換を当てた結果へ当てる。"),
});
const docWrite = z.strictObject({
	baseRevision,
	title,
	content: z
		.unknown()
		.describe(
			"文書の全体。JSONの文書ならJSONの値をそのまま書く（文字列にしない）。テキストの文書なら文字列。",
		),
});
const docView = z.strictObject({
	fromLine: z.number().int().min(1).optional(),
	toLine: z.number().int().min(1).optional(),
});

export type DocToolId = "doc.edit" | "doc.write" | "doc.view";
const DOC_TOOLS: Record<
	DocToolId,
	{ schema: z.ZodType; summary: (path: string) => string }
> = {
	"doc.edit": {
		schema: docEdit,
		summary: (path) =>
			`${path}の一部を置き換えて新しい版にする（修正はこれを使う）。成功したらinvokeのtextで一言伝えてターンを終える。`,
	},
	"doc.write": {
		schema: docWrite,
		summary: (path) =>
			`${path}の全体を書く。最初の作成と、利用者が全面的な作り直しを求めたときだけ使う。`,
	},
	"doc.view": {
		schema: docView,
		summary: (path) =>
			`${path}の指定した行を読む。CURRENT_DOCUMENTが目次だけのときに使う。`,
	},
};

export const isDocTool = (tool: string): tool is DocToolId =>
	Object.hasOwn(DOC_TOOLS, tool);

/** The host's document tools as the agent sees them in TOOLS (doc.view only when the document is outlined). */
export function documentTools(
	set: SpecialistSet,
	outlined: boolean,
): Array<{ id: string; description: string; inputSchema: unknown }> {
	const document = set.agent.document;
	if (!document) return [];
	return (Object.keys(DOC_TOOLS) as DocToolId[])
		.filter((id) => id !== "doc.view" || outlined)
		.map((id) => ({
			id,
			description: DOC_TOOLS[id].summary(document.path),
			inputSchema: z.toJSONSchema(DOC_TOOLS[id].schema),
		}));
}

/** The outcome of one document tool: data for the next call, and the counts the session record keeps. */
export type DocOutcome =
	| { ok: true; revision?: number; fixes?: string[]; lines?: string }
	| {
			ok: false;
			error: string;
			index?: number;
			count?: number;
			revision?: number;
			issues?: Array<{ path: string; rule: string }>;
			/** A whole-document draft was kept as the work's rejected draft. */
			kept?: boolean;
	  };

/** Apply the edits in order to the text; every one must match exactly once, or none is applied. */
export function applyEdits(
	text: string,
	edits: ReadonlyArray<{ old: string; new: string }>,
):
	| { ok: true; text: string }
	| { ok: false; error: string; index: number; count?: number } {
	let current = text;
	for (const [index, edit] of edits.entries()) {
		const first = current.indexOf(edit.old);
		if (first < 0) return { ok: false, error: "edit_not_found", index };
		let count = 1;
		for (
			let at = current.indexOf(edit.old, first + 1);
			at >= 0;
			at = current.indexOf(edit.old, at + 1)
		)
			count++;
		if (count > 1) return { ok: false, error: "edit_ambiguous", index, count };
		current =
			current.slice(0, first) +
			edit.new +
			current.slice(first + edit.old.length);
	}
	return { ok: true, text: current };
}

/** The document text as the agent reads it: whole within the budget, else a numbered outline of its lines. */
export function documentView(
	text: string,
	inlineBytes: number,
): { outlined: boolean; body: string } {
	if (Buffer.byteLength(text) <= inlineBytes)
		return { outlined: false, body: text };
	const lines = text.split("\n");
	// The lines that open a part (`"view"`) or a layout's children say where things are.
	const outline = lines
		.map((line, i) => ({ line, n: i + 1 }))
		.filter(({ line }) => /"view"|"children"|"title"/.test(line))
		.map(({ line, n }) => `${n}: ${line.trim().slice(0, 120)}`);
	return {
		outlined: true,
		body: `lines=${lines.length}\n${outline.join("\n")}`,
	};
}

function numbered(text: string, from?: number, to?: number) {
	const lines = text.split("\n");
	const start = Math.max(1, from ?? 1);
	const end = Math.min(lines.length, to ?? start + 199, start + 399);
	return lines
		.slice(start - 1, end)
		.map((line, i) => `${start + i}: ${line}`)
		.join("\n");
}

/**
 * Run one document tool inside the turn's writer transaction. A write that fails its check is kept as the
 * work's rejected draft in the same transaction, so it is returned (not thrown) and the transaction commits.
 * `no_change` and `revision_conflict` come back as refusals like any other.
 */
export function runDocTool(
	tx: Database,
	document: SpecialistDocument,
	tool: DocToolId,
	args: unknown,
	turn: {
		workRef: string;
		sessionId: string;
		runId: string;
		conversationId: string;
	},
): DocOutcome {
	const parsed = DOC_TOOLS[tool].schema.safeParse(args ?? {});
	if (!parsed.success)
		return {
			ok: false,
			error: "specialist_invalid_arguments",
			issues: parsed.error.issues.slice(0, 8).map((issue) => ({
				path: issue.path.map(String).join(".") || "(root)",
				rule: issue.code,
			})),
		};
	const current = document.readInTransaction(tx, turn.workRef);
	if (!current) return { ok: false, error: "work_missing" };
	if (tool === "doc.view") {
		const view = parsed.data as z.infer<typeof docView>;
		return {
			ok: true,
			revision: current.revision,
			lines: numbered(current.text, view.fromLine, view.toLine),
		};
	}
	const input = parsed.data as
		| z.infer<typeof docEdit>
		| z.infer<typeof docWrite>;
	if (input.baseRevision !== current.revision)
		return {
			ok: false,
			error: "revision_conflict",
			revision: current.revision,
		};
	let text: string;
	if ("edits" in input) {
		const edited = applyEdits(current.text, input.edits);
		if (!edited.ok) return edited;
		text = edited.text;
	} else
		text =
			typeof input.content === "string"
				? input.content
				: JSON.stringify(input.content, null, 2);
	const checked = document.check(text);
	if (!checked.ok) {
		const kept = tool === "doc.write";
		if (kept)
			document.rejectInTransaction(tx, turn.workRef, {
				title: input.title ?? current.title,
				text,
				issues: checked.issues,
				fixes: checked.fixes,
			});
		return {
			ok: false,
			error: checked.code,
			issues: checked.issues.slice(0, 8),
			...(kept ? { kept } : {}),
		};
	}
	try {
		const { revision } = document.commitInTransaction(tx, turn.workRef, {
			baseRevision: input.baseRevision,
			...(input.title !== undefined ? { title: input.title } : {}),
			value: checked.value,
			sessionId: turn.sessionId,
			runId: turn.runId,
			conversationId: turn.conversationId,
		});
		return {
			ok: true,
			revision,
			...(checked.fixes.length ? { fixes: checked.fixes } : {}),
		};
	} catch (error) {
		const code = error instanceof Error ? error.message : "";
		if (code === "no_change" || code === "revision_conflict")
			return { ok: false, error: code };
		throw error;
	}
}
