/** Fixed control model for lifecycle tests. Semantic choice is verified separately with a real model. */
export function researchScript(
	options: {
		consult?: boolean;
		sourceStart?: number;
		grader?: boolean;
		document?: boolean;
	} = {},
) {
	let proposals = 0,
		asked = false;
	return (schema: Record<string, unknown>) => {
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
			[
				"report_draft",
				{
					completion: "complete",
					...(options.document ? { title: "一次資料の比較調査" } : {}),
					answer: "本文で確認した結論です。[資料](https://example.com/source)",
					summary: "本文に基づく結論",
					claims: [
						{
							text: "本文で確認した事実",
							status: "verified",
							evidence: ["e1"],
						},
					],
					limitations: [],
					stopReason: "依頼の条件を本文で確認した",
				},
			],
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
