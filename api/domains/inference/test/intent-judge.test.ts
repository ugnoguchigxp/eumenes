import { expect, test } from "bun:test";
import type { LarmPort } from "../../larm";
import { defaults } from "../../settings";
import type { Settings } from "../../settings/contracts";
import { createIntentJudge } from "../service/intent-judge";

/**
 * The user-intent judge's port (the intent gate design, section 3): made from the saved intent profile, made again
 * when the profile or the LARM origin changes, closed in `legacy` and at the end; never the conversation's port.
 */
function harness(intent: Partial<Settings["intent"]>) {
	let saved = defaults({});
	saved.larm.baseUrl = "http://127.0.0.1:9810";
	saved.intent = { ...saved.intent, ...intent };
	const listeners = new Set<() => void>();
	const made: Array<{ profile: string | undefined; closed: boolean }> = [];
	const judge = createIntentJudge({
		settings: {
			get: () => saved,
			onChange: (fn) => {
				listeners.add(fn);
				return () => listeners.delete(fn);
			},
		},
		options: {
			intentLarmFactory: (s) => {
				const record = { profile: s.intent.profile, closed: false };
				made.push(record);
				return {
					judgeIntent: async (input) => ({
						choice: input.text === "天気" ? "request" : "chat",
						probabilities: {
							request: 0.7,
							chat: 0.2,
							followup: 0.05,
							noise: 0.03,
							incomplete: 0.02,
						},
						model: `model-of-${s.intent.profile}`,
						headRevision: null,
						truncated: false,
						historyTokensDropped: 0,
						stateTokensDropped: 0,
					}),
					connect: async () => {},
					close: async () => {
						record.closed = true;
					},
				} as Partial<LarmPort> as LarmPort;
			},
		},
	});
	const change = (next: (s: Settings) => void) => {
		saved = structuredClone(saved);
		next(saved);
		for (const fn of listeners) fn();
	};
	return { judge, made, change };
}
const signal = () => new AbortController().signal;
const input = { previousAgent: null, text: "天気" };

test("a configured judge's port is made ahead of the first judgement, once, and held", async () => {
	const warmed = harness({ profile: "judge-a" });
	expect(warmed.made).toEqual([{ profile: "judge-a", closed: false }]);
	await warmed.judge.close();
});

test("the judge is asked on a port of the saved intent profile, made once and held", async () => {
	const h = harness({ profile: "judge-a" });
	expect(await h.judge.judge(input, signal())).toMatchObject({
		choice: "request",
		model: "model-of-judge-a",
	});
	await h.judge.judge(input, signal());
	expect(h.made).toEqual([{ profile: "judge-a", closed: false }]);
	await h.judge.close();
	expect(h.made[0]!.closed).toBe(true);
	await expect(h.judge.judge(input, signal())).rejects.toThrow(
		"intent_judge_closed",
	);
});

test("without a saved profile, or in legacy, no port is made and the caller falls back", async () => {
	const missing = harness({});
	await expect(missing.judge.judge(input, signal())).rejects.toThrow(
		"intent_profile_missing",
	);
	const legacy = harness({ mode: "legacy", profile: "judge-a" });
	await expect(legacy.judge.judge(input, signal())).rejects.toThrow(
		"intent_judge_unconfigured",
	);
	expect([...missing.made, ...legacy.made]).toEqual([]);
});

test("a changed profile releases the old port and the next judgement makes the new one; legacy releases it too", async () => {
	const h = harness({ profile: "judge-a" });
	await h.judge.judge(input, signal());
	h.change((s) => {
		s.intent.profile = "judge-b";
	});
	expect(h.made[0]!.closed).toBe(true);
	expect(await h.judge.judge(input, signal())).toMatchObject({
		model: "model-of-judge-b",
	});
	h.change((s) => {
		s.intent.mode = "legacy";
	});
	expect(h.made.map((m) => m.closed)).toEqual([true, true]);
	// A change of the attitude judge's (voice) settings keeps the intent port.
	h.change((s) => {
		s.intent.mode = "shadow";
	});
	await h.judge.judge(input, signal());
	h.change((s) => {
		s.larm.voice = "another-voice";
	});
	expect(h.made.at(-1)!.closed).toBe(false);
	await h.judge.close();
});
