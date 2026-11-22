import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { composeSystem, planSystem } from "eumenes-agency/agenda";
import {
	goalReplyInstructions,
	goalReplyTools,
} from "./agency/always-on-goal-reply";
import type { ConversationAgentPort } from "../domains/dialogue";
import { testConversationAgent } from "../domains/dialogue/test/conversation-agent.fixture";
import {
	reply,
	setup as dialogueSetup,
} from "../domains/dialogue/test/generation.fixture";
import { defaults, type Settings } from "../domains/settings";
import type { StewardService } from "../domains/steward";
import { setupSteward } from "../domains/steward/test/steward.fixture";
import {
	estimateJsonTokens,
	estimateTextTokens,
} from "../infrastructure/context-budget";
import { systemContext } from "../infrastructure/system-context";
import {
	agendaFixture,
	composeSay,
	planNothing,
	replyWith,
	type CallKind,
} from "./agency/always-on.fixture";
import { agencyReplyParts } from "./agency/system-context";
import { imageFixture } from "./media/image.fixture";

/**
 * The size of the inputs the conversation agent, the agency and the steward send on every call (system texts and tool
 * definitions), recorded in fixed-input-size.json (spec conversation-agent-token-efficiency-and-debt-plan, E2).
 * This is a record, not a limit: a change fails the test and says which element grew or shrank, so a cut is kept
 * and a growth is seen. After an intended change, record the new values:
 *   bun run fixed-input-size -- --write
 * Every element is built from the real code (the dialogue's own prompt assembly with the always-on host's reply
 * parts, the agency package's own calls, the steward's own step) with fixed inputs. The domains imported above
 * (dialogue, settings, steward) are the ones whose `verify --domain` selection runs this test.
 */
const recordPath = join(import.meta.dir, "fixed-input-size.json");
type Size = { chars: number; tokens: number };

const textSize = (text: string): Size => ({
	chars: text.length,
	tokens: estimateTextTokens(text),
});
const jsonSize = (value: unknown): Size => ({
	chars: JSON.stringify(value).length,
	tokens: estimateJsonTokens(value),
});

/** The persona the system is written for: fixed, so the text changes only with the product's own texts. */
const CONDITIONS = {
	persona: "butler, agent name Eumenes, user name ユーザー",
	settings: "defaults (emotion on, no interests)",
	goal: "goal reply rules and tools added as the always-on reply adds them for a goal-enabled agenda",
	steward: "curate-memory step of one exchange, no requests",
};
const SECTIONS = ["Role", "Speaking", "Emotion", "Input", "Facts"] as const;

function settingsOf(): Settings {
	const settings = defaults({});
	settings.general.agentName = "Eumenes";
	settings.general.userName = "ユーザー";
	settings.general.persona = "butler";
	return settings;
}

type NativeTool = {
	function?: { name: string; description?: string; parameters?: unknown };
	name?: string;
	description?: string;
	parameters?: unknown;
};
/** A tool as the model is offered it, whichever shape the caller held it in. */
const definitionOf = (tool: NativeTool) => {
	const { name, description, parameters } = tool.function ?? tool;
	return { name: name!, description, parameters };
};

/** The real talk call of a conversation: its system text and the tools the host offers it. */
async function talkCall() {
	const settings = settingsOf();
	const agent: ConversationAgentPort = {
		...testConversationAgent,
		system: () => agencyReplyParts(settings.agency, true),
	};
	const h = await dialogueSetup({
		settings,
		memory: true,
		agents: {},
		worldContext: {
			knownNamesInTransaction: () => [],
			recordsInTransaction: () => ({ entities: [], documents: [] }),
		},
		conversationAgent: agent,
	});
	try {
		h.state.steps.push(...reply("🙂おはようございます。"));
		await h.say("おはよう");
		const call = h.state.calls.at(-1)!;
		const system = call.messages.find((m) => m.role === "system")!.content;
		const tools = ((call.toolDefinitions ?? []) as NativeTool[]).map(
			definitionOf,
		);
		return { system, tools };
	} finally {
		await h.close();
	}
}

/** The system text split at its `## Section` headings: each section's own text, heading included. */
function sectionsOf(system: string) {
	const found = new Map<string, string>();
	for (const part of system.split(/\n\n(?=## )/))
		found.set(/^## (\w+)/.exec(part)![1]!, part);
	return found;
}

/** The agency's model calls, by kind, as the fixture host sent them (the system text of each). */
async function agencyCalls() {
	const wanted: CallKind[] = ["check", "ask_check", "profile"];
	let phase = 0;
	const f = await agendaFixture({
		media: imageFixture("success"),
		script: (kind, request) => {
			if (kind === "compose") return composeSay("できました");
			if (kind !== "plan") return undefined;
			// One plan: two researches (the second is checked against the first) and a question.
			if (phase === 0 && request.prompt.includes("user-a")) {
				phase = 1;
				return {
					add: [
						{
							kind: "research",
							text: "fixture independent picture",
							refs: ["user-a"],
							value: 5,
							reason: "fixture",
							topic: "picture",
						},
						{
							kind: "research",
							text: "fixture another picture",
							refs: ["user-a"],
							value: 4,
							reason: "fixture",
							topic: "another",
						},
						{
							kind: "ask",
							text: "fixture question",
							refs: [],
							value: 3,
							reason: "fixture",
							topic: "question",
						},
					],
					drop: [],
					focus: "picture",
				};
			}
			return planNothing();
		},
	});
	try {
		await f.start();
		await f.user("user-a", "ao", "来月、箱根に温泉旅行に行こうと思ってる");
		await f.assistant("answer-a", "いいですね。", "ao");
		const systems = new Map<CallKind, string>();
		for (let i = 0; i < 120 && wanted.some((k) => !systems.has(k)); i++) {
			await f.advance(15_000);
			await new Promise((resolve) => setTimeout(resolve, 10));
			f.requests.forEach((request, n) => {
				systems.set(f.kinds[n]!, request.system);
			});
		}
		for (const kind of wanted)
			if (!systems.has(kind))
				throw new Error(`agency_call_not_reached:${kind}`);
		const { toolDefinitions } = await replyWith(f, []);
		return {
			check: systems.get("check")!,
			askCheck: systems.get("ask_check")!,
			profile: systems.get("profile")!,
			agendaTools: toolDefinitions[0]!.map(definitionOf),
		};
	} finally {
		await f.close();
	}
}

/** The steward's curate-memory call of one exchange: what it sent as system text and as output schema. */
async function curateMemoryCall() {
	const h: { steward: StewardService } & Awaited<
		ReturnType<typeof setupSteward>
	> = await setupSteward();
	try {
		h.inference.script("curate-memory", {
			remember: [],
			update: [],
			stop: [],
			notes: [],
			resolve: [],
			route: [],
		});
		await h.exchange("辛いものが好きです", "覚えておきます");
		await h.drain();
		const call = h.inference.callsOf("curate-memory")[0]!;
		return {
			sent: call.messages.find((m) => m.role === "system")!.content,
			schema: call.schema,
		};
	} finally {
		await h.close();
	}
}

const stewardInstructions = (
	step: "curate-memory" | "curate-goals" | "curate-world",
) =>
	systemContext("steward.contexts.common.preface", {}) +
	systemContext(`steward.contexts.${step}.instructions-text`, {});

async function measure() {
	const elements: Record<string, Size> = {};
	const alwaysOn = await talkCall();
	elements["system.alwaysOn"] = textSize(alwaysOn.system);
	const sections = sectionsOf(alwaysOn.system);
	for (const name of SECTIONS)
		elements[`system.alwaysOn.${name}`] = textSize(sections.get(name) ?? "");
	const [withGoal] = goalReplyInstructions([
		{ role: "system", content: alwaysOn.system },
	]);
	elements["system.alwaysOnGoal"] = textSize(withGoal!.content);

	const agency = await agencyCalls();
	const toolsNamed = (names: readonly string[]) =>
		names.map((name) => {
			const tool = alwaysOn.tools.find((t) => t.name === name);
			if (!tool) throw new Error(`tool_not_offered:${name}`);
			return tool;
		});
	const goalTools = goalReplyTools(
		{ tools: [], call: async () => ({ content: "" }) },
		{} as never,
		() => undefined,
	).tools.map(definitionOf);
	const groups: Record<string, ReturnType<typeof definitionOf>[]> = {
		"tools.read": toolsNamed([
			"read_memory",
			"read_history",
			"read_runs",
			"read_agents",
			"read_world",
		]),
		"tools.talkWork": toolsNamed(["find_toolchain", "delegate"]),
		"tools.workControls": toolsNamed([
			"approve_confirmation",
			"decline_confirmation",
			"work",
			"discard_for_pending_switch",
		]),
		"tools.agenda": agency.agendaTools,
		"tools.goalReply": goalTools,
	};
	for (const [group, tools] of Object.entries(groups)) {
		elements[group] = jsonSize(tools);
		for (const tool of tools) elements[`tool.${tool.name}`] = jsonSize(tool);
	}

	// The host's own memory tool is not in a group of the plan's table, but it is sent on every call too.
	elements["tool.memory"] = jsonSize(toolsNamed(["memory"])[0]);

	elements["agency.planSystem"] = textSize(planSystem());
	elements["agency.composeSystem"] = textSize(composeSystem());
	elements["agency.profileSystem"] = textSize(agency.profile);
	elements["agency.checkSystem"] = textSize(agency.check);
	elements["agency.askCheckSystem"] = textSize(agency.askCheck);

	const steward = await curateMemoryCall();
	elements["steward.curateMemory.instructions"] = textSize(
		stewardInstructions("curate-memory"),
	);
	elements["steward.curateMemory.schema"] = jsonSize(steward.schema);
	elements["steward.curateMemory.systemSent"] = textSize(steward.sent);
	elements["steward.curateGoals.instructions"] = textSize(
		stewardInstructions("curate-goals"),
	);
	elements["steward.curateWorld.instructions"] = textSize(
		stewardInstructions("curate-world"),
	);
	// The instructions are the start of what the call sent (a check that the text measured is the one sent).
	expect(steward.sent.startsWith(stewardInstructions("curate-memory"))).toBe(
		true,
	);
	return elements;
}

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

/** Each element that is new, gone or different, as one line saying what changed by how much. */
function differences(
	recorded: Record<string, Size>,
	measured: Record<string, Size>,
) {
	const lines: string[] = [];
	for (const key of new Set([
		...Object.keys(recorded),
		...Object.keys(measured),
	])) {
		const before = recorded[key];
		const after = measured[key];
		if (!before) {
			lines.push(
				`${key}: new element (${after!.chars} chars, ${after!.tokens} tokens)`,
			);
		} else if (!after) {
			lines.push(`${key}: element gone (was ${before.chars} chars)`);
		} else if (before.chars !== after.chars || before.tokens !== after.tokens) {
			lines.push(
				`${key}: ${before.chars} -> ${after.chars} chars (${signed(after.chars - before.chars)}), ` +
					`${before.tokens} -> ${after.tokens} tokens (${signed(after.tokens - before.tokens)})`,
			);
		}
	}
	return lines;
}

test("the fixed inputs keep the size recorded in fixed-input-size.json", async () => {
	const elements = await measure();
	if (process.env.FIXED_INPUT_SIZE_WRITE === "1") {
		const recorded = JSON.parse(readFileSync(recordPath, "utf8")) as {
			elements?: Record<string, Size>;
		};
		const changes = differences(recorded.elements ?? {}, elements);
		writeFileSync(
			recordPath,
			`${JSON.stringify({ conditions: CONDITIONS, elements }, null, "\t")}\n`,
		);
		console.log(
			changes.length
				? `fixed-input-size.json updated:\n${changes.join("\n")}`
				: "fixed-input-size.json unchanged",
		);
		return;
	}
	const recorded = JSON.parse(readFileSync(recordPath, "utf8")) as {
		elements: Record<string, Size>;
	};
	// A mismatch lists every changed element; after an intended change: bun run fixed-input-size -- --write
	expect(differences(recorded.elements, elements)).toEqual([]);
}, 60_000);
