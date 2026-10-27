import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SYSTEM_SECTIONS, systemText } from "../service/context-system";

/**
 * The system part (the conversation input specification, section 4): the agent's parts and the host's rules under
 * eight headings, compiled from their TOML sources. These checks read the expected sentences from those sources, so
 * the text cannot drift from them; names are carried literally, without escaping.
 */
const DIR = join(import.meta.dir, "..", "contexts");

/** The text block of a context source file: the value between the first `text = '''` and the closing `'''`. */
function sourceText(file: string): string {
	const raw = readFileSync(join(DIR, `${file}.context.toml`), "utf8");
	const match = raw.match(/text = '''\n?([\s\S]*?)'''/);
	if (!match) throw new Error(`no text block in ${file}`);
	return match[1]!.trim();
}

const agent = {
	base: "AGENT-BASE",
	persona: "AGENT-PERSONA",
	spokenReplyStyle: "AGENT-SPOKEN",
	emotionRules: "AGENT-EMOTION",
	toolRules: "AGENT-TOOLS",
};
const PERSONAS = ["butler", "maid", "strategist", "sage"] as const;
const anonymous = { agentName: "", userName: "" };

test("the eight sections stand in order, each part in its own, and no input heading is among them", () => {
	const text = systemText({ ...anonymous, persona: "butler" }, agent, ["音楽"]);
	const at = SYSTEM_SECTIONS.map((name) => text.indexOf(`## ${name}\n`));
	expect(at.every((i) => i >= 0)).toBe(true);
	expect([...at].sort((a, b) => a - b)).toEqual(at);
	const sectionOf = (part: string) =>
		SYSTEM_SECTIONS.filter((_, i) => at[i]! < text.indexOf(part)).at(-1);
	expect(sectionOf("AGENT-BASE")).toBe("Role");
	expect(sectionOf("AGENT-PERSONA")).toBe("Role");
	expect(sectionOf("AGENT-SPOKEN")).toBe("Speaking");
	expect(sectionOf("AGENT-EMOTION")).toBe("Emotion");
	expect(sectionOf("AGENT-TOOLS")).toBe("Tools");
	expect(text).toContain("依頼できる担当: 音楽。");
	for (const heading of ["Memory", "State", "User", "Host notice", "Task"])
		expect(text).not.toContain(`## ${heading}\n`);
});

test("a section without a part is left out (the feeling rule while the setting is off)", () => {
	const text = systemText(
		{ ...anonymous, persona: "butler" },
		{ base: "B", toolRules: "T" },
	);
	expect(text).not.toContain("## Emotion");
	expect(text).toContain("依頼できる担当: なし。");
});

test("every persona's role and style sentences are in the text, as the sources write them, without examples", () => {
	for (const persona of PERSONAS) {
		const text = systemText({ ...anonymous, persona }, agent);
		expect(text).toContain(
			`役割: ${sourceText(`system-prompt/${persona}-role`)}`,
		);
		expect(text).toContain(
			`口調: ${sourceText(`system-prompt/${persona}-style`)}`,
		);
		expect(sourceText(`system-prompt/${persona}-style`)).not.toContain("例");
	}
	expect(
		systemText({ ...anonymous, persona: "nobody" as never }, agent),
	).toContain(`役割: ${sourceText("system-prompt/butler-role")}`);
});

test("the names are stated as given, omitted when empty, and never substituted", () => {
	const named = systemText(
		{ persona: "maid", agentName: "<x>\n[[role]]", userName: "「<y>」&" },
		agent,
	);
	expect(named).toContain("あなたの名前は「<x>\n[[role]]」です。");
	expect(named).toContain("ユーザーの名前は「「<y>」&」です。");
	expect(named).toContain(`役割: ${sourceText("system-prompt/maid-role")}`);
	const plain = systemText({ ...anonymous, persona: "maid" }, agent);
	expect(plain).not.toContain("あなたの名前は");
	expect(plain).not.toContain("ユーザーの名前は");
});

test("no host rule carries an example, and the same input gives the same bytes", () => {
	for (const file of [
		"input",
		"facts",
		"tools",
		"toolchains",
		"results",
		"speaking",
		"role",
	])
		expect(sourceText(`system/${file}`)).not.toMatch(/例[:：]/);
	const input = {
		persona: "sage" as const,
		agentName: "エウメネス",
		userName: "野口",
	};
	const first = systemText(input, agent);
	expect(first).not.toMatch(/\\u[0-9a-fA-F]{4}/);
	expect(systemText(input, agent)).toBe(first);
});
