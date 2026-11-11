/** Fixed control model for lifecycle tests. Semantic choice is verified separately with a real model. */
export function researchScript(
	options: {
		consult?: boolean;
		sourceStart?: number;
		grader?: boolean;
		document?: boolean;
		answer?: string;
	} = {},
) {
	let proposals = 0,
		asked = false;
	return (
		schema: Record<string, unknown>,
		messages: readonly { content: unknown }[] = [],
	) => {
		const properties = schema.properties as Record<string, unknown>;
		if (properties.strategy)
			return {
				strategy: "一次資料を比較して結論を確認",
				rationale: "本文と出典を照合",
				alternatives: ["別の説明を検証"],
				parts: ["本文確認", "回答検証"],
			};
		if (properties.hypothesis)
			return {
				hypothesis: "本文を取得すると根拠を確認できる",
				rationale: "一次資料を読む",
				tools: ["web_lookup", "web_read", "report_draft", "report_read"],
				targets: ["report.json"],
				expected: "本文根拠と回答が揃う",
			};
		if (properties.passed)
			return {
				passed: options.grader !== false,
				evidence:
					options.grader === false
						? "必須条件の確認が不足"
						: "元依頼と本文を照合した",
			};
		if (properties.decision)
			return {
				decision: "continue_strategy",
				reason: "本文が得られた",
				brokenAssumption: "",
				direction: "回答を確認",
			};
		const draft = {
			completion: "complete",
			...(options.document ? { title: "一次資料の比較調査" } : {}),
			answer:
				options.answer ??
				"本文で確認した結論です。[資料](https://example.com/source)",
			summary: "本文に基づく結論",
			claims: [
				{ text: "本文で確認した事実", status: "verified", evidence: ["e1"] },
			],
			limitations: [],
			stopReason: "依頼の条件を本文で確認した",
		};
		if (properties.basis) {
			const packet = JSON.parse(String(messages.at(-1)?.content));
			const state = JSON.parse(packet.state.split("\n\n").at(-1));
			const attempts = state.attempts as {
				tool: string;
				state: string;
				seq: number;
			}[];
			const used = (tool: string) => attempts.some((a) => a.tool === tool);
			const action = (tool: string, input: object) => ({
				tool,
				inputJson: JSON.stringify(input),
				text: null,
				expectedStatus: "ok",
				expectedObservation: "必要な根拠を取得",
				refutedIf: "status:error",
				whatChanged: "",
			});
			const base = {
				basis: state.basis,
				progress: {
					assessed: state.newlyUnassessed,
					kind: state.previousProgress?.length
						? attempts.length
							? "evidence"
							: "reasoning"
						: "initial",
					change: "調査の現状を確認",
					criteria: ["answer"],
					evidence: attempts
						.filter((a) => a.state === "settled")
						.map((a) => a.seq),
					conclusions: [],
				},
				choice: "act",
				reason: "本文と回答を照合",
				missing: "",
				contribution: "必要な証拠を確認",
				route: "advance",
				actions: [] as ReturnType<typeof action>[],
				sequence: false,
				waitAfterDispatch: false,
				cancelPending: false,
				renewStrategy: null,
				renewHypothesis: null,
			};
			if (options.consult && !asked) {
				asked = true;
				return {
					...base,
					choice: "consult",
					missing: "対象期間",
					reason: "比較の対象期間を教えてください",
				};
			}
			if (state.pending.length) return { ...base, choice: "wait" };
			if (!used("web_lookup"))
				return {
					...base,
					waitAfterDispatch: true,
					actions: [
						action("web_lookup", { query: "一次資料 比較", language: "ja" }),
					],
				};
			if (!used("web_read"))
				return {
					...base,
					waitAfterDispatch: true,
					actions: [action("web_read", { url: "https://example.com/source" })],
				};
			if (options.sourceStart !== undefined && !used("source_read"))
				return {
					...base,
					actions: [
						action("source_read", {
							evidence: "e1",
							start: options.sourceStart,
							limit: 1000,
						}),
					],
				};
			if (state.savedReadBack)
				return {
					...base,
					choice: options.grader === false ? "partial" : "complete",
				};
			return {
				...base,
				choice: "complete",
				sequence: true,
				actions: [action("report_draft", draft), action("report_read", {})],
			};
		}
		if (!properties.kind) throw new Error("fixture_schema_unknown");
		const base = {
			tool: null,
			inputJson: null,
			expectedStatus: null,
			expectedObservation: null,
			whatChanged: "",
			message: "本文と回答を照合",
			missing: "",
			text: null,
			findings: [],
			refute: [],
			uses: [],
			assessment: [],
			refutedIf: null,
			acceptanceCheck: [],
		};
		if (options.consult && !asked) {
			asked = true;
			return {
				...base,
				kind: "consult",
				message: "比較の対象期間を教えてください",
				missing: "対象期間",
			};
		}
		const steps: Array<[string, unknown]> = [
			["web_lookup", { query: "一次資料 比較", language: "ja" }],
			["web_read", { url: "https://example.com/source" }],
			["report_draft", draft],
			["report_read", {}],
		];
		if (options.sourceStart !== undefined)
			steps.splice(2, 0, [
				"source_read",
				{ evidence: "e1", start: options.sourceStart, limit: 1000 },
			]);
		const step = steps[proposals++];
		return step
			? {
					...base,
					kind: "tool",
					tool: step[0],
					inputJson: JSON.stringify(step[1]),
					expectedStatus: "ok",
					expectedObservation: "必要な根拠を取得",
					refutedIf: "status:error",
				}
			: {
					...base,
					kind: "done",
					assessment: [
						{ part: 1, status: "done", evidence: "本文", next: "" },
						{ part: 2, status: "done", evidence: "回答確認", next: "" },
					],
					acceptanceCheck: [
						{ id: "citations", met: true, where: "本文e1" },
						{ id: "answer", met: true, where: "report.json" },
					],
				};
	};
}
