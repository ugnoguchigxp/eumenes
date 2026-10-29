/**
 * The user-intent judge of LARM's decision provider (the intent gate design, section 4): it reads the user's newest
 * utterance and the agent's utterance before it, and answers one of five labels. It is not the speaking-attitude
 * judge (`LarmPort.judge`), which reads the agent's own answer: the two have their own ports, inputs and results.
 */
export const intentLabels = [
	"request",
	"chat",
	"followup",
	"noise",
	"incomplete",
] as const;
export type IntentLabel = (typeof intentLabels)[number];

/** The question the deployed classifier was trained on: its wording does not change the task, and all five labels are required. */
export const intentQuestion = {
	type: "choice",
	instructions: "最新のユーザー発言の意図を分類してください",
	criteria: {
		request: "依頼",
		chat: "会話",
		followup: "作業への返答",
		noise: "雑音",
		incomplete: "発話途中",
	},
} as const satisfies {
	type: "choice";
	instructions: string;
	criteria: Record<IntentLabel, string>;
};

/** What the judge reads: the newest utterance and the agent's utterance before it (none: left out). */
export type IntentInput = {
	text: string;
	previousAgent: string | null;
};

/** The judge's answer as LARM gave it: a classification, not an instruction. */
export type IntentJudgment = {
	choice: IntentLabel;
	/** The score of every label; a score is compared with a threshold, never read as the chance of being right. */
	probabilities: Record<IntentLabel, number>;
	/** The model the claim named. */
	model: string;
	headRevision: string | null;
	truncated: boolean;
	historyTokensDropped: number;
	stateTokensDropped: number;
};
