import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSystemPrompt } from "../service/system-prompt";

/**
 * The conversation's system prompt is compiled from its TOML sources (the persona's role and style, the names).
 * These checks read the expected sentences from those sources, so the prompt cannot drift from its source
 * without a failure; names and placeholder-like text are carried literally, without escaping (section 5.3).
 */
const DIR = join(import.meta.dir, "..", "contexts", "system-prompt");

/** The text block of a context source file: the value between the first `text = '''` and the closing `'''`. */
function sourceText(file: string): string {
	const raw = readFileSync(join(DIR, `${file}.context.toml`), "utf8");
	const match = raw.match(/text = '''\n?([\s\S]*?)'''/);
	if (!match) throw new Error(`no text block in ${file}`);
	return match[1]!.trim();
}

const PERSONAS = ["butler", "maid", "strategist", "sage"] as const;

test("every persona's role and style sentences are in the prompt, as the sources write them", () => {
	for (const persona of PERSONAS) {
		const prompt = buildSystemPrompt({ persona, agentName: "", userName: "" });
		expect(prompt).toContain(`役割: ${sourceText(`${persona}-role`)}`);
		expect(prompt).toContain(`現在の口調: ${sourceText(`${persona}-style`)}`);
	}
});

test("a persona without a source falls back to the butler", () => {
	const unknown = buildSystemPrompt({
		persona: "nobody" as never,
		agentName: "",
		userName: "",
	});
	expect(unknown).toContain(`役割: ${sourceText("butler-role")}`);
});

test("the agent's and the user's names are stated as given, and omitted when empty", () => {
	const named = buildSystemPrompt({
		persona: "maid",
		agentName: "エウメネス",
		userName: "野口",
	});
	expect(named).toContain(`あなたの名前は「エウメネス」です。`);
	expect(named).toContain(
		`ユーザーの名前は「野口」です。必要なときだけ名前で呼びかけてください。`,
	);
	const anonymous = buildSystemPrompt({
		persona: "maid",
		agentName: "",
		userName: "",
	});
	expect(anonymous).not.toContain("あなたの名前は");
	expect(anonymous).not.toContain("ユーザーの名前は");
});

test("names with markup-like and placeholder-like characters are carried literally, not substituted", () => {
	const prompt = buildSystemPrompt({
		persona: "maid",
		agentName: "<x>\n[[role]]",
		userName: "「<y>」&",
	});
	expect(prompt).toContain("あなたの名前は「<x>\n[[role]]」です。");
	expect(prompt).toContain("ユーザーの名前は「「<y>」&」です。");
	// The role sentence is still the persona's own, not the placeholder's.
	expect(prompt).toContain(`役割: ${sourceText("maid-role")}`);
});

test("the prompt is Japanese text as written, never escaped, and the same input gives the same bytes", () => {
	const input = {
		persona: "sage" as const,
		agentName: "エウメネス",
		userName: "野口",
	};
	const first = buildSystemPrompt(input);
	expect(first).not.toMatch(/\\u[0-9a-fA-F]{4}/);
	expect(first).toContain("読み上げません");
	expect(buildSystemPrompt(input)).toBe(first);
});
