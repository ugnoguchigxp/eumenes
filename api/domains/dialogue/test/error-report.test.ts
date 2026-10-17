import { afterEach, expect, test } from "bun:test";
import { homedir } from "node:os";
import { errorReportSchema } from "../contracts/error-report";
import { ERROR_REPORT_LIMIT } from "../service/error-report";
import {
	BOOT,
	OTHER_RUN,
	ROOT,
	STEP,
	TASK,
	asUtc,
	cleanup,
	controlFailure,
	entry,
	scenario,
	task,
} from "./error-report.fixture";

afterEach(cleanup);

test("records written in UTC before the JST format and JST records mix in one correct timeline", async () => {
	const s = await scenario({
		error: "invalid_conversation_operation",
		tasks: [
			task({
				id: ROOT,
				kind: "coordinator",
				status: "failed",
				phase: "failed",
				errorCode: "invalid_control_json",
			}),
			task({
				id: TASK,
				kind: "worker",
				status: "failed",
				phase: "search",
				errorCode: "invalid_control_json",
			}),
		],
		rotated: (ids) =>
			controlFailure(ids)
				.slice(0, 3)
				.map((line) => asUtc(line)),
		lines: (ids) => controlFailure(ids).slice(3),
	});
	try {
		const text = (await s.report()) as string;
		expect(text).toContain("- 発生: 2026-10-17 21:19:24 JST");
		expect(text).not.toContain("12:19:24");
		expect(text).toMatch(/\| 33\.0s \| agent\.control_rejected/);
	} finally {
		await s.close();
	}
});

test("a worker's control failure is reported in the fixed form with the first failure and its reference", async () => {
	const s = await scenario({
		error: "invalid_conversation_operation",
		tasks: [
			task({
				id: ROOT,
				kind: "coordinator",
				status: "failed",
				phase: "failed",
				errorCode: "invalid_control_json",
			}),
			task({
				id: TASK,
				kind: "worker",
				status: "failed",
				phase: "search",
				errorCode: "invalid_control_json",
			}),
		],
		lines: (ids) => [
			...controlFailure(ids),
			entry(
				"info",
				0,
				"dialogue",
				"dialogue.accepted",
			)({ runId: OTHER_RUN, requestId: crypto.randomUUID() }),
			entry(
				"warn",
				5,
				"dialogue",
				"dialogue.operation_rejected",
			)({ runId: OTHER_RUN, reason: "other_run_reason" }),
			entry(
				"warn",
				100,
				"inference",
				"inference.cloud_selected",
			)({ runId: ids.run, reason: "cloud_only" }),
		],
	});
	try {
		const text = (await s.report()) as string;
		expect(text.startsWith("# Eumenes エラーレポート\n")).toBe(true);
		expect(text).toContain("## 概要");
		expect(text).toContain("- 発生: 2026-10-17 21:19:24 JST  boot: " + BOOT);
		expect(text).toContain("- 結果: failed / invalid_conversation_operation");
		expect(text).toContain(
			"- 失敗した段階: サブエージェント（web.search / worker / search）",
		);
		expect(text).toContain("## 経過（正常系は集約）");
		expect(text).toContain(
			"| 6.0s | R1 依頼分析 | live_info / toolchain（5.9s） |",
		);
		expect(text).toContain("| 6.1s | 候補検索 | 4件（embedding） |");
		expect(text).toContain("| 12.0s | 選定 | toolchain web.search |");
		// The two rejections of the same reason fold into one row that shows the status change.
		expect(text).toMatch(
			/\| 33\.0s \| agent\.control_rejected \[be29f86c\] \| control_schema_invalid.*status: repair_scheduled→failed.*×2/,
		);
		expect(text).toMatch(
			/agent\.control_validation_issue .* unknown\.0 invalid_type object→string.*×2/,
		);
		expect(text).toMatch(
			/agent\.state_changed \[be29f86c\] \| invalid_control_json.*status=failed/,
		);
		expect(text).toContain("## 最初の失敗");
		expect(text).toContain(
			"- component: agent-runtime  event: agent.control_rejected",
		);
		expect(text).toContain(
			"- reason: control_schema_invalid  validationPath: unknown.0  validationCode: invalid_type  expected: object  actual: string",
		);
		expect(text).toContain("- 参考: docs/logging.md「調査失敗の原因」");
		expect(text).toContain("## 追跡用");
		expect(text).toContain(`bun run logs -- --id ${s.ids.run} --json`);
		expect(text).toContain(`bun run logs -- --id ${TASK} --level warn --json`);
		expect(text).toContain(`stepId: ${STEP}`);
		// Another run's records and a notice-level warning are not failures of this run.
		expect(text).not.toContain("other_run_reason");
		expect(text).not.toContain("cloud_only");
		expect(text.length).toBeLessThanOrEqual(ERROR_REPORT_LIMIT);
	} finally {
		await s.close();
	}
});

test("repeated rejections of an operation fold into one row; a contract violation names the run's reason", async () => {
	const s = await scenario({
		error: "invalid_conversation_operation",
		lines: ({ run, request, job }) => {
			const base = { runId: run, requestId: request, jobId: job };
			return [
				entry(
					"info",
					0,
					"dialogue",
					"dialogue.accepted",
				)({ ...base, status: "queued" }),
				entry(
					"warn",
					40000,
					"dialogue",
					"dialogue.operation_rejected",
				)({
					...base,
					reason: "spoken_reply_too_long",
					repairAttempt: 0,
					issueCount: 1,
				}),
				entry(
					"warn",
					45000,
					"dialogue",
					"dialogue.operation_rejected",
				)({
					...base,
					reason: "spoken_reply_too_long",
					repairAttempt: 1,
					issueCount: 1,
				}),
				entry(
					"info",
					45100,
					"toolchain-history",
					"toolchain.selection_settled",
				)({
					...base,
					outcome: "failed",
					reason: "invalid_conversation_operation",
				}),
			];
		},
	});
	try {
		const text = (await s.report()) as string;
		expect(text).toContain(
			"| 40.0s | dialogue.operation_rejected | spoken_reply_too_long ×2 |",
		);
		expect(text).toContain(
			"- 失敗した段階: 会話（dialogue.operation_rejected）",
		);
		expect(text).toContain("- reason: spoken_reply_too_long");
		expect(text).not.toContain("参考:");
		expect(text).toMatch(/toolchain\.selection_settled \| .*failed/);
	} finally {
		await s.close();
	}
});

test("a research failure answered by the fixed reply is reported with the tool failure of the Web run", async () => {
	const WEB_RUN = "5eb0a15d-1111-4111-8111-000000000001";
	const WEB_JOB = "5eb0a15d-2222-4222-8222-000000000002";
	const s = await scenario({
		status: "completed",
		tasks: [
			task({
				id: ROOT,
				kind: "coordinator",
				status: "completed",
				errorCode: "web_timeout",
			}),
			task({
				id: TASK,
				kind: "worker",
				status: "failed",
				phase: "search",
				errorCode: "web_timeout",
			}),
		],
		lines: ({ run, request, job }) => {
			const base = { runId: run, requestId: request };
			return [
				entry(
					"info",
					0,
					"dialogue",
					"dialogue.accepted",
				)({ ...base, jobId: job }),
				entry(
					"info",
					12000,
					"toolchain-history",
					"toolchain.selection_recorded",
				)({
					...base,
					jobId: job,
					decision: "toolchain",
					toolchainId: "web.search",
				}),
				entry(
					"info",
					20000,
					"agent-runtime",
					"agent.tool_completed",
				)({
					...base,
					taskId: TASK,
					status: "succeeded",
					kind: "tool:web.lookup@2",
				}),
				entry(
					"warn",
					22000,
					"agent-runtime",
					"agent.tool_failed",
				)({
					...base,
					taskId: TASK,
					invocationId: "inv-1",
					operationId: WEB_RUN,
					status: "failed",
					reason: "web_timeout",
					kind: "tool:web.lookup@2",
				}),
				entry(
					"warn",
					21900,
					"web-research",
					"web.failed",
				)({
					runId: WEB_RUN,
					jobId: WEB_JOB,
					kind: "read",
					status: "failed",
					reason: "web_timeout",
				}),
				entry(
					"info",
					30000,
					"dialogue",
					"dialogue.generation_started",
				)({ ...base, jobId: job }),
			];
		},
	});
	try {
		const text = (await s.report()) as string;
		expect(text).toContain(
			"- 結果: completed / 調査失敗の固定返答 / web_timeout",
		);
		// The Web run is reached through the operationId of the tool call and comes first.
		expect(text).toContain("- component: web-research  event: web.failed");
		expect(text).toContain("- reason: web_timeout");
		expect(text).toContain("- 参考: docs/logging.md「調査失敗の原因」");
		expect(text).toContain("worker[be29f86c] failed / web_timeout");
	} finally {
		await s.close();
	}
});

test("a cancellation and the failure it causes are reported with the cancellation first", async () => {
	const s = await scenario({
		error: "cancel_requested",
		lines: ({ run, request, job }) => {
			const base = { runId: run, requestId: request, jobId: job };
			return [
				entry("info", 0, "dialogue", "dialogue.accepted")(base),
				entry("info", 8000, "dialogue", "dialogue.cancel_requested")(base),
				entry(
					"warn",
					8100,
					"inference",
					"inference.attempt_failed",
				)({
					...base,
					attemptId: "att-1",
					purpose: "llm",
					reason: "cancelled",
					durationMs: 8000,
					errorFrames: [
						`${process.cwd()}/api/domains/queue/service/runner.ts:721:57`,
						"/elsewhere/lib.ts:1:1",
					],
				}),
				entry(
					"info",
					8200,
					"agent-runtime",
					"agent.state_changed",
				)({
					...base,
					taskId: TASK,
					status: "cancelled",
					kind: "worker",
					reason: "cancel_requested",
				}),
			];
		},
	});
	try {
		const text = (await s.report()) as string;
		expect(text).toContain(
			"- component: dialogue  event: dialogue.cancel_requested",
		);
		expect(text).toContain(
			"| 8.1s | inference.attempt_failed | cancelled（kind=llm）".replace(
				"kind=llm",
				"purpose=llm",
			),
		);
		expect(text).toMatch(
			/agent\.state_changed \[be29f86c\] \| cancel_requested|agent\.state_changed \[be29f86c\] \| cancelled/,
		);
		expect(text).toContain("- 結果: failed / cancel_requested");
	} finally {
		await s.close();
	}
});

test("an inference failure shows where it happened (without the checkout's path)", async () => {
	const s = await scenario({
		error: "inference_failed",
		lines: ({ run, request, job }) => [
			entry(
				"warn",
				100,
				"inference",
				"inference.attempt_failed",
			)({
				runId: run,
				requestId: request,
				jobId: job,
				purpose: "llm",
				reason: "larm_inference_429",
				status: 429,
				durationMs: 6,
				errorFrames: [
					`${process.cwd()}/api/domains/inference/service/execute.ts:303:9`,
					`${homedir()}/.bun/install/lib.ts:1:1`,
				],
			}),
		],
	});
	try {
		const text = (await s.report()) as string;
		expect(text).toContain(
			"- 場所: api/domains/inference/service/execute.ts:303:9 ← ~/.bun/install/lib.ts:1:1",
		);
		expect(text).toContain("- 失敗した段階: 推論（inference.attempt_failed）");
		expect(text).toContain("larm_inference_429");
	} finally {
		await s.close();
	}
});

test("a repaired violation of the first round is a row of the table, not the failure the worker ended with", async () => {
	const s = await scenario({
		error: "invalid_control_json",
		tasks: [
			task({
				id: ROOT,
				kind: "coordinator",
				status: "failed",
				phase: "failed",
				errorCode: "invalid_control_json",
			}),
		],
		lines: ({ run, request, job }) => {
			const base = { runId: run, requestId: request, jobId: job };
			return [
				entry("info", 0, "dialogue", "dialogue.accepted")(base),
				entry(
					"warn",
					1000,
					"dialogue",
					"dialogue.operation_rejected",
				)({
					...base,
					reason: "spoken_reply_too_long",
					repairAttempt: 0,
					issueCount: 1,
				}),
				entry(
					"info",
					2000,
					"dialogue",
					"dialogue.request_analyzed",
				)({ ...base, kind: "live_info", next: "toolchain", durationMs: 2000 }),
				entry(
					"warn",
					9000,
					"agent-runtime",
					"agent.control_rejected",
				)({
					...base,
					taskId: TASK,
					stepId: STEP,
					kind: "worker",
					phase: "search",
					repairAttempt: 1,
					status: "failed",
					controlAction: "invoke",
					reason: "control_schema_invalid",
				}),
			];
		},
	});
	try {
		const text = (await s.report()) as string;
		expect(text).toContain(
			"- 失敗した段階: サブエージェント（worker / search）",
		);
		expect(text).toContain(
			"- component: agent-runtime  event: agent.control_rejected",
		);
		expect(text).toContain("- reason: control_schema_invalid");
		expect(text).toContain(`stepId: ${STEP}`);
		// The repaired violation stays in the table.
		expect(text).toContain(
			"| 1.0s | dialogue.operation_rejected | spoken_reply_too_long |",
		);
	} finally {
		await s.close();
	}
});

test("a warning the run went on from is not the failure; the record with the run's failure code is", async () => {
	const s = await scenario({
		error: "inference_failed",
		lines: ({ run, request, job }) => {
			const base = { runId: run, requestId: request, jobId: job };
			return [
				entry("info", 0, "dialogue", "dialogue.accepted")(base),
				entry(
					"warn",
					500,
					"dialogue",
					"dialogue.recall_failed",
				)({ ...base, reason: "recall_failed" }),
				entry(
					"warn",
					4000,
					"inference",
					"inference.attempt_failed",
				)({
					...base,
					purpose: "llm",
					reason: "inference_failed",
					durationMs: 3,
				}),
			];
		},
	});
	try {
		const text = (await s.report()) as string;
		expect(text).toContain("- 失敗した段階: 推論（inference.attempt_failed）");
		expect(text).toContain(
			"- component: inference  event: inference.attempt_failed",
		);
		expect(text).toContain("| 0.5s | dialogue.recall_failed | recall_failed |");
	} finally {
		await s.close();
	}
});

test("records from the rotated generations and the other IDs of the run are read", async () => {
	const s = await scenario({
		error: "invalid_conversation_operation",
		rotated: ({ run, request, job }) => [
			entry(
				"warn",
				1000,
				"dialogue",
				"dialogue.operation_rejected",
			)({
				runId: run,
				requestId: request,
				jobId: job,
				reason: "rotated_reason",
			}),
		],
		lines: ({ run, request, job }) => [
			entry(
				"info",
				0,
				"dialogue",
				"dialogue.accepted",
			)({ runId: run, requestId: request, jobId: job }),
			// Only the job ID names the run: reached through the IDs of its own records.
			entry(
				"info",
				2000,
				"queue",
				"queue.settled",
			)({ jobId: job, attempt: 1, status: "failed", reason: "late_reason" }),
		],
	});
	try {
		const text = (await s.report()) as string;
		expect(text).toContain("rotated_reason");
		expect(text).toContain("late_reason");
		expect(text).toContain(
			"- component: dialogue  event: dialogue.operation_rejected",
		);
	} finally {
		await s.close();
	}
});

test("a missing log still gives the overview from the run's own state", async () => {
	const s = await scenario({
		error: "deadline_exceeded",
		noLog: true,
		tasks: [
			task({
				id: ROOT,
				kind: "coordinator",
				status: "failed",
				errorCode: "deadline_exceeded",
			}),
		],
	});
	try {
		const text = (await s.report()) as string;
		expect(text).toContain("- 結果: failed / deadline_exceeded");
		expect(text).toContain(
			"ログに失敗の記録が見つかりません（ログを読めません）",
		);
		expect(text).toContain("- reason: deadline_exceeded");
		expect(text).toContain("coordinator[aa29f86c] failed / deadline_exceeded");
	} finally {
		await s.close();
	}
});

test("only fixed fields and identifier-like values are printed; text, settings and unknown fields never are", async () => {
	const secret = "ユーザーの依頼文とAPIキー sk-secret";
	const s = await scenario({
		error: "invalid_conversation_operation",
		lines: ({ run, request, job }) => [
			entry(
				"warn",
				100,
				"agent-runtime",
				"agent.control_rejected",
			)({
				runId: run,
				requestId: request,
				jobId: job,
				taskId: TASK,
				stepId: STEP,
				kind: "worker",
				phase: "search",
				reason: "control_schema_invalid",
				text: secret,
				prompt: secret,
				goal: secret,
				apiKey: secret,
				unknownField: secret,
				rawResponse: secret,
				controlAction: secret,
			}),
			entry(
				"warn",
				200,
				"agent-runtime",
				"agent.control_validation_issue",
			)({
				runId: run,
				requestId: request,
				jobId: job,
				taskId: TASK,
				stepId: STEP,
				reason: "control_schema_invalid",
				validationPath: "arguments.query",
				validationCode: "invalid_type",
				expectedType: "string",
				actualType: secret,
				secretField: secret,
			}),
			entry(
				"warn",
				300,
				"web-research",
				"web.failed",
			)({ runId: run, kind: "read", reason: secret }),
		],
	});
	try {
		const text = (await s.report()) as string;
		for (const word of [
			"sk-secret",
			"ユーザーの依頼文",
			"ひみつの依頼文",
			"unknownField",
			"rawResponse",
			"secretField",
			"apiKey",
		])
			expect(text).not.toContain(word);
		expect(text).toContain("arguments.query");
	} finally {
		await s.close();
	}
});

test("a long run stays within the limit: the oldest normal rows go first and the omission is stated", async () => {
	const s = await scenario({
		error: "invalid_conversation_operation",
		tasks: [
			task({
				id: ROOT,
				kind: "coordinator",
				status: "failed",
				errorCode: "invalid_control_json",
			}),
		],
		lines: ({ run, request, job }) => {
			const base = { runId: run, requestId: request, jobId: job };
			const lines: string[] = [];
			for (let n = 0; n < 60; n++) {
				lines.push(
					entry(
						"info",
						n * 100,
						"agent-runtime",
						"agent.tool_completed",
					)({
						...base,
						taskId: TASK,
						status: "succeeded",
						kind: `tool:web.tool${n}@2`,
					}),
				);
				lines.push(
					entry(
						"info",
						n * 100 + 1,
						"agent-runtime",
						"agent.state_changed",
					)({
						...base,
						taskId: `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
						status: "running",
						kind: "worker",
					}),
				);
				lines.push(
					entry(
						"info",
						n * 100 + 2,
						"dialogue",
						"dialogue.body_policy",
					)({ ...base, kind: "held" }),
				);
			}
			for (let n = 0; n < 40; n++)
				lines.push(
					entry(
						"warn",
						10_000 + n,
						"web-research",
						"web.failed",
					)({
						runId: run,
						jobId: `job-${n}`,
						kind: "read",
						reason: `web_reason_${n}`,
					}),
				);
			return lines;
		},
	});
	try {
		const text = (await s.report()) as string;
		expect(text.length).toBeLessThanOrEqual(ERROR_REPORT_LIMIT);
		expect(text).toMatch(/古い行を \d+ 件省略/);
		expect(text).toContain("その他の正常系 60 行は集約・省略");
		// The first failure is never dropped.
		expect(text).toContain("- reason: web_reason_0");
		expect(text).toContain("## 追跡用");
	} finally {
		await s.close();
	}
});

test("the route returns the report, 404 for an unknown run and 409 for a run that did not fail", async () => {
	const failed = await scenario({
		error: "invalid_conversation_operation",
		lines: controlFailure,
		tasks: [
			task({
				id: ROOT,
				kind: "coordinator",
				status: "failed",
				errorCode: "invalid_control_json",
			}),
		],
	});
	try {
		const ok = await failed.app.request(
			`/api/runs/${failed.ids.run}/error-report`,
		);
		expect(ok.status).toBe(200);
		const body = errorReportSchema.parse(await ok.json());
		expect(body.runId).toBe(failed.ids.run);
		expect(body.text).toBe((await failed.report()) as string);
		expect(
			(await failed.app.request("/api/runs/missing/error-report")).status,
		).toBe(404);
	} finally {
		await failed.close();
	}
	for (const options of [
		{ status: "completed" as const },
		{ status: "queued" as const },
		{
			status: "completed" as const,
			tasks: [
				task({
					id: ROOT,
					kind: "coordinator",
					errorCode: "clarification_required",
				}),
			],
		},
	]) {
		const s = await scenario(options);
		try {
			const response = await s.app.request(
				`/api/runs/${s.ids.run}/error-report`,
			);
			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({
				error: "error_report_not_applicable",
			});
			expect(await s.dialogue.errorReport(s.ids.run)).toEqual({
				ok: false,
				reason: "not_applicable",
			});
		} finally {
			await s.close();
		}
	}
});
