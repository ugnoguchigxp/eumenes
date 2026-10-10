import { test, expect } from "bun:test";
import {
	replay,
	invoke,
	finish,
	syntheticAcquisition,
} from "./research-history.fixture";
const url = "https://example.com/synthetic-long";
test("three far-apart facts and the seventh condition retain earlier evidence through the complete dialogue", async () => {
	const facts = [
		"第一条件は10時集合。",
		"第七条件は雨天中止。",
		"第三条件は参加費500円。",
	];
	const body =
		facts[0] +
		"通常の資料。".repeat(2500) +
		facts[1] +
		"通常の資料。".repeat(2500) +
		facts[2] +
		"通常の資料。".repeat(2500);
	const references: string[] = [];
	const capture = (data: any, fact: string) => {
		const excerpt = data.observations
			.flatMap((o: any) => o.excerpts)
			.find((e: any) => e.quote.includes(fact));
		expect(excerpt).toBeDefined();
		references.push(excerpt.reference);
	};
	const h = await replay(
		[
			() => invoke("web.read", { url }),
			(data) => {
				capture(data, facts[0]!);
				return invoke("web.find", {
					sourceRef: data.observations[0]!.document,
					query: facts[1]!,
				});
			},
			(data) =>
				invoke("web.read_saved", {
					sourceRef: data.observations[0]!.document,
					cursor: data.operations.at(-1)!.notes!.matches![0]!.cursor,
					characters: 1200,
				}),
			(data) => {
				capture(data, facts[1]!);
				return invoke("web.find", {
					sourceRef: data.observations[0]!.document,
					query: facts[2]!,
				});
			},
			(data) =>
				invoke("web.read_saved", {
					sourceRef: data.observations[0]!.document,
					cursor: data.operations.at(-1)!.notes!.matches![0]!.cursor,
					characters: 1200,
				}),
			(data) => {
				capture(data, facts[2]!);
				return {
					action: "finish",
					report: {
						outcome: "answered",
						summary: facts.join(""),
						claims: facts.map((text, i) => ({
							text,
							evidence: [references[i]],
						})),
						limitations: [],
					},
				};
			},
		],
		{
			acquire: syntheticAcquisition({ [url]: body }),
			parent: () => facts.join(""),
		},
	);
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: `${url} を調べて、第一条件、第七条件、第三条件をすべて確認して`,
		});
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
		).toBe("completed");
		h.assertConsumed();
		const report = h.toolchain.agents.report(
			h.dialogue.get(run.id)!.agentTaskId!,
		)!;
		expect(report.claims.map((c) => c.evidence[0]!.quote)).toHaveLength(3);
		for (const [i, fact] of facts.entries())
			expect(report.claims[i]!.evidence[0]!.quote).toContain(fact);
		expect(h.acquisitions).toBe(1);
		expect(h.dialogue.answerText(run.id)).toContain(facts[1]!);
	} finally {
		await h.close();
	}
});
test("an out-of-scope model URL is rejected before fetching; a finite repair can read only the original URL", async () => {
	const keyword = "集合時刻は10時";
	const h = await replay(
		[
			() => invoke("web.read", { url: "https://example.com/invented" }),
			(_data, messages) => {
				expect(h.acquisitions).toBe(0);
				expect(
					messages.some((m) => m.content.includes("tool_url_out_of_scope")),
				).toBe(true);
				return invoke("web.read", { url });
			},
			(data) => finish(data, keyword),
		],
		{
			acquire: syntheticAcquisition({ [url]: keyword }),
			parent: () => keyword,
		},
	);
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: `${url} の集合時刻を確認して`,
		});
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
		).toBe("completed");
		h.assertConsumed();
		expect(h.acquisitions).toBe(1);
		const child = h.toolchain.agents
			.list(run.id)
			.find((t) => t.kind === "worker")!;
		expect(child.status).toBe("completed");
		expect(child.modelCalls).toBe(4);
		expect(child.toolCalls).toBe(1);
	} finally {
		await h.close();
	}
});
test("repeating an out-of-scope URL exhausts one repair without any external acquisition", async () => {
	const h = await replay(
		Array.from(
			{ length: 2 },
			() => () => invoke("web.read", { url: "https://example.com/invented" }),
		),
	);
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: `${url} の集合時刻を確認して`,
		});
		await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 });
		h.assertConsumed();
		expect(h.acquisitions).toBe(0);
		const child = h.toolchain.agents
			.list(run.id)
			.find((t) => t.kind === "worker")!;
		expect(child.status).toBe("failed");
		expect(child.errorCode).toBe("tool_url_out_of_scope");
		expect(child.modelCalls).toBe(2);
		expect(child.toolCalls).toBe(0);
	} finally {
		await h.close();
	}
});
test("cursor/start conflict is refused with a precise, private repair hint, then a correct saved read succeeds", async () => {
	const keyword = "中間で確認した集合時刻は10時";
	const h = await replay(
		[
			() => invoke("web.lookup", { query: "合成資料 集合時刻" }),
			() => invoke("web.read", { url }),
			(d) =>
				invoke("web.find", {
					sourceRef: d.observations.find((s) => s.basis === "page")!.sourceRef,
					query: "集合時刻",
				}),
			(d) =>
				invoke("web.read_saved", {
					sourceRef: d.observations.find((s) => s.basis === "page")!.sourceRef,
					cursor: d.operations.find((o) => o.notes?.matches)?.notes!
						.matches![0]!.cursor,
					start: "head",
				}),
			(d, messages) => {
				expect(
					messages.some((m) => m.content.includes("invalid_tool_input")),
				).toBe(true);
				return invoke("web.read_saved", {
					sourceRef: d.observations.find((s) => s.basis === "page")!.sourceRef,
					cursor: d.operations.find((o) => o.notes?.matches)?.notes!
						.matches![0]!.cursor,
				});
			},
			(d) => finish(d, keyword),
		],
		{
			acquire: syntheticAcquisition({
				[url]: "序文".repeat(3000) + keyword + "末尾".repeat(3000),
			}),
			parent: () => keyword,
		},
	);
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "Web検索で集合時刻を確認して",
		});
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
		).toBe("completed");
		h.assertConsumed();
		expect(h.acquisitions).toBe(2);
		const child = h.toolchain.agents
			.list(run.id)
			.find((t) => t.kind === "worker")!;
		expect(child.toolCalls).toBe(4);
		expect(child.modelCalls).toBe(7);
	} finally {
		await h.close();
	}
});
test("new research may search after a specified URL is mismatched, using only its existing grants and budget", async () => {
	const correct = "https://example.com/correct",
		keyword = "確認した集合時刻は10時";
	const h = await replay(
		[
			(data, messages) => {
				expect(data.task).toMatchObject({ urls: [url] });
				const contracts = JSON.parse(
					messages[0]!.content
						.split("TOOLS=")[1]!
						.split("\nOUTPUT_SCHEMA=")[0]!,
				);
				expect(
					contracts.some((t: { id: string }) =>
						["web.find", "web.read_saved"].includes(t.id),
					),
				).toBe(false);
				return invoke("web.read", { url });
			},
			(_data, messages) => {
				const contracts = JSON.parse(
					messages[0]!.content
						.split("TOOLS=")[1]!
						.split("\nOUTPUT_SCHEMA=")[0]!,
				);
				expect(
					contracts.some((t: { id: string }) => t.id === "web.lookup"),
				).toBe(true);
				return invoke("web.lookup", { query: "集合時刻 別資料" });
			},
			() => invoke("web.read", { url: correct }),
			(d) => finish(d, keyword),
		],
		{
			acquire: syntheticAcquisition({ [url]: "対象外", [correct]: keyword }),
			parent: () => keyword,
			urls: ["https://example.com/invented-by-model"],
		},
	);
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: `${url}を読み、対象が違えばWeb検索して集合時刻を確認して`,
		});
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
		).toBe("completed");
		h.assertConsumed();
		expect(h.acquisitions).toBe(3);
		expect(h.dialogue.answerText(run.id)).toBe(keyword);
	} finally {
		await h.close();
	}
});
test("an invalid saved-body reference is refused before execution and a valid retry uses the same budget without fetching again", async () => {
	const keyword = "中間の集合時刻は10時です。";
	const h = await replay(
		[
			() => invoke("web.lookup", { query: "合成資料 集合時刻" }),
			() => invoke("web.read", { url }),
			() =>
				invoke("web.find", {
					sourceRef: "d999",
					query: "集合時刻",
				}),
			(d) => {
				expect(d.operations.at(-1)).toMatchObject({});
				return invoke("web.find", {
					sourceRef: d.observations.find((s) => s.basis === "page")!.sourceRef,
					query: "集合時刻",
				});
			},
			(d) =>
				invoke("web.read_saved", {
					sourceRef: d.observations.find((s) => s.basis === "page")!.sourceRef,
					cursor: d.operations.find((o) => o.notes?.matches)?.notes!
						.matches![0]!.cursor,
				}),
			(d) => finish(d, keyword),
		],
		{
			acquire: syntheticAcquisition({
				[url]:
					"無関係な序文".repeat(3000) + keyword + "無関係な末尾".repeat(3000),
			}),
			parent: () => keyword,
		},
	);
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "合成資料の集合時刻をWeb検索で調べて",
		});
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
		).toBe("completed");
		h.assertConsumed();
		expect(h.acquisitions).toBe(2);
		expect(
			h.toolchain.agents.list(run.id).find((t) => t.kind === "worker")!
				.toolCalls,
		).toBe(4);
	} finally {
		await h.close();
	}
});
test("R1/R2/R3: fetch once then find/read_saved obtains middle evidence and parent adopts a view after child completion", async () => {
	const keyword = "中間の集合時刻は10時です。";
	const h = await replay(
		[
			() => invoke("web.lookup", { query: "合成資料 集合時刻" }),
			() => invoke("web.read", { url }),
			(d) => {
				expect(
					d.observations.some((s) =>
						s.excerpts.some((e) => e.quote.includes(keyword)),
					),
				).toBe(false);
				return invoke("web.find", {
					sourceRef: d.observations.find((s) => s.basis === "page")!.sourceRef,
					query: "集合時刻",
				});
			},
			(d) =>
				invoke("web.read_saved", {
					sourceRef: d.observations.find((s) => s.basis === "page")!.sourceRef,
					cursor: d.operations.find((o) => o.notes?.matches)?.notes!
						.matches![0]!.cursor,
				}),
			(d) => finish(d, keyword),
		],
		{
			acquire: syntheticAcquisition({
				[url]:
					"無関係な序文".repeat(3000) + keyword + "無関係な末尾".repeat(3000),
			}),
			parent: () => keyword,
		},
	);
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "合成資料の集合時刻をWeb検索で調べて",
		});
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
		).toBe("completed");
		h.assertConsumed();
		expect(h.acquisitions).toBe(2);
		const report = h.toolchain.agents.report(
			h.dialogue.get(run.id)!.agentTaskId!,
		)!;
		expect(report.claims[0]!.evidence[0]!.quote).toContain(keyword);
		expect(report.sources[0]!.viewId).toBeTruthy();
		expect(report.sources[0]!.sourceRevision).toBeTruthy();
		expect(report.sources[0]!.acquisitionTruncated).toBe(false);
		expect(h.dialogue.answerText(run.id)).toBe(keyword);
		const inputs = JSON.stringify(h.inputs);
		expect(inputs.length).toBeLessThan(40000);
		expect(h.parentContexts.at(-1)).not.toContain("無関係な序文".repeat(5));
	} finally {
		await h.close();
	}
});
test("R4/R5: mismatched first page advances to another candidate and a changed lookup within the original budget", async () => {
	let lookups = 0;
	const a = "https://example.com/wrong",
		b = "https://example.com/right",
		keyword = "大阪の10月10日の集合は11時";
	const acquire: ReturnType<typeof syntheticAcquisition> = async (
		req,
		signal,
	) => {
		if (req.operation === "lookup") lookups++;
		return syntheticAcquisition(
			lookups === 1 ? { [a]: "東京の10月9日の集合は8時" } : { [b]: keyword },
		)(req, signal);
	};
	const h = await replay(
		[
			() => invoke("web.lookup", { query: "集合時刻" }),
			() => invoke("web.read", { url: a }),
			() => invoke("web.lookup", { query: "大阪 10月10日 集合時刻" }),
			() => invoke("web.read", { url: b }),
			(d) => finish(d, keyword),
		],
		{ acquire, parent: () => keyword },
	);
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "大阪の10月10日の集合時刻を調べて",
		});
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
		).toBe("completed");
		h.assertConsumed();
		expect(h.acquisitions).toBe(4);
		expect(
			h.toolchain.agents
				.report(h.dialogue.get(run.id)!.agentTaskId!)!
				.sources.map((s) => s.url),
		).toEqual([b]);
	} finally {
		await h.close();
	}
});
test("R6: successful normalized duplicate lookup is replayed, and finishes without another external fetch", async () => {
	const h = await replay(
		[
			() => invoke("web.lookup", { query: "ＡＢＣ  検索" }),
			() => invoke("web.lookup", { query: "abc 検索" }),
			() => ({
				action: "finish",
				report: {
					outcome: "not_found",
					summary: "確認範囲では見つからなかった",
					claims: [],
					limitations: ["本文未確認"],
				},
			}),
		],
		{
			acquire: syntheticAcquisition({ [url]: "資料" }),
			parent: () => "確認範囲では見つからなかった",
		},
	);
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "ABCを検索して",
		});
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
		).toBe("completed");
		h.assertConsumed();
		expect(h.acquisitions).toBe(1);
		expect(h.workerContexts.at(-1)).not.toContain("operation_repeated");
		expect(
			h.toolchain.agents.report(h.dialogue.get(run.id)!.agentTaskId!)!.outcome,
		).toBe("not_found");
	} finally {
		await h.close();
	}
});
test("H1/H8: history search/read, without Memory or Web, answers from preserved raw messages with speaker/time and no fabricated URL", async () => {
	const keyword = "集合時刻は9時";
	const h = await replay(
		[
			() => invoke("history.search", { query: "集合時刻" }),
			(d) =>
				invoke("history.read", {
					messageRef: d.observations[0]!.messageRef,
					before: 1,
					after: 1,
				}),
			(d) => finish(d, keyword),
		],
		{ history: true, parent: () => "以前の発言では9時に集合です。" },
	);
	try {
		await h.conversation.append({
			id: "previous",
			conversationId: "main",
			text: keyword,
			role: "user",
			createdAt: "2026-10-05T00:00:00Z",
			runId: null,
		});
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "先週決めた集合時刻を会話履歴で確認して",
		});
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
		).toBe("completed");
		h.assertConsumed();
		expect(h.acquisitions).toBe(0);
		const report = h.toolchain.agents.report(
			h.dialogue.get(run.id)!.agentTaskId!,
		)!;
		expect(report.sources[0]!.messageId).toBe("previous");
		expect(report.sources[0]!.url).toBeUndefined();
		expect(report.claims[0]!.evidence[0]!.quote).toBe("");
		expect(
			JSON.parse(h.parentContexts.at(-1)!)
				.map((m: { content: string }) => m.content)
				.join("\n"),
		).toContain('"speaker":"user"');
		expect(h.parentContexts.at(-1)).toContain("2026-10-05T00:00:00Z");
		expect(
			h.inputs.every((d) =>
				d.observations.every((s) => s.basis === "conversation"),
			),
		).toBe(true);
	} finally {
		await h.close();
	}
});
for (const mutation of ["correction", "withdrawal", "cancellation"] as const)
	test(`H4/R8: ${mutation} during final inference refuses old completed text and voice`, async () => {
		let h: Awaited<ReturnType<typeof replay>>;
		let activeRunId = "";
		h = await replay(
			[
				() => invoke("history.search", { query: "集合時刻" }),
				(d) =>
					invoke("history.read", { messageRef: d.observations[0]!.messageRef }),
				(d) => finish(d, "集合時刻は9時"),
			],
			{
				history: true,
				parent: async () => {
					if (mutation === "correction")
						await h.conversation.correct({
							messageId: "previous",
							text: "集合時刻は10時",
						});
					else if (mutation === "withdrawal")
						await h.conversation.retract({ messageId: "previous" });
					else {
						await h.dialogue.cancel(activeRunId);
					}
					return "古い回答、9時";
				},
			},
		);
		try {
			await h.conversation.append({
				id: "previous",
				conversationId: "main",
				text: "集合時刻は9時",
				role: "user",
				createdAt: "2026-10-05T00:00:00Z",
				runId: null,
			});
			const run = await h.dialogue.submit({
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: "集合時刻を会話履歴で確認して",
			});
			activeRunId = run.id;
			const result = await h.dialogue.waitForTerminal(run.id, {
				timeoutMs: 5000,
			});
			h.assertConsumed();
			expect(result?.status).not.toBe("completed");
			expect(h.dialogue.answerText(run.id)).toBeNull();
			expect(
				h.conversation
					.get("main")
					.messages.some((m) => m.text === "古い回答、9時"),
			).toBe(false);
		} finally {
			await h.close();
		}
	});

test("H7: one stale-history retry uses the original budget and adopts only the fresh scope", async () => {
	let h: Awaited<ReturnType<typeof replay>>;
	h = await replay(
		[
			() => invoke("history.search", { query: "集合時刻" }),
			async (d) => {
				await h.conversation.correct({
					messageId: "concurrent",
					text: "別件の更新",
				});
				return invoke("history.read", {
					messageRef: d.observations[0]!.messageRef,
				});
			},
			() => invoke("history.search", { query: "集合時刻" }),
			(d) =>
				invoke("history.read", {
					messageRef: d.observations.at(-1)!.messageRef,
				}),
			(d) =>
				finish(
					{ ...d, observations: d.observations.slice(-1) },
					"集合時刻は9時",
				),
		],
		{ history: true, parent: () => "以前の発言では集合時刻は9時です。" },
	);
	try {
		await h.conversation.append({
			id: "concurrent",
			conversationId: "main",
			role: "user",
			text: "別件",
			createdAt: "2026-10-04T00:00:00Z",
			runId: null,
		});
		await h.conversation.append({
			id: "previous",
			conversationId: "main",
			role: "user",
			text: "集合時刻は9時",
			createdAt: "2026-10-05T00:00:00Z",
			runId: null,
		});
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "集合時刻を会話履歴で確認して",
		});
		const state = await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 });

		expect(state?.status).toBe("completed");
		h.assertConsumed();
		const child = h.toolchain.agents
			.list(run.id)
			.find((t) => t.kind === "worker")!;
		expect(child.modelCalls).toBe(6);
		expect(child.toolCalls).toBe(4);
		expect(h.acquisitions).toBe(0);
		expect(
			h.workerContexts.some((c) => c.includes("history_cursor_stale")),
		).toBe(true);
	} finally {
		await h.close();
	}
});
