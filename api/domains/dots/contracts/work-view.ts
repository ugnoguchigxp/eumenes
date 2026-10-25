/** Public read model consumed by the registered work artifact. */
export type WorkDetailView = {
	task: {
		id: string;
		title: string;
		state: string;
		revision: number;
		request: string | null;
		completionConditions: string[];
		stopIntent: string | null;
		result: { summary: string; evidenceRefs: string[] } | null;
	};
	question: { id: string; prompt: string; choices: string[] } | null;
	sessions: Array<{ threadId: string }>;
	report: { summary: string; facts: string[]; limitations: string[] } | null;
};
