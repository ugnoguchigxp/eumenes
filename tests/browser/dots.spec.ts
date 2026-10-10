import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture } from "./fixture";
import { evidencePath } from "./evidence";
import { createClient } from "../../client";
const token = "fixture-dots-api-token-0123456789";
const fixture = createFixture();
let dir: string, apiPort: number, webPort: number;
test.setTimeout(90000);
test.beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "eumenes-dots-browser-"));
	({ apiPort, webPort } = await fixture.startVoiceStack({ dir, token }));
});
test.afterAll(async () => {
	await fixture.stopAll();
	rmSync(dir, { recursive: true, force: true });
});
test("saved configuration and frozen Skills drive a real MCP task, question, answer and completion UI", async ({
	page,
}) => {
	await page.goto(`http://127.0.0.1:${webPort}`);
	await page.getByRole("button", { name: "設定", exact: true }).click();
	await page
		.getByRole("button", { name: "Codexへの委任", exact: true })
		.click();
	const root = page.locator(".dots-settings"),
		connection = root.locator("section").filter({
			has: page.getByRole("heading", { name: "dotsへの接続", exact: true }),
		});
	await connection.getByLabel("名前", { exact: true }).fill("受信担当");
	const connectionSaved = page.waitForResponse(
		(r) =>
			r.url().endsWith("/api/dots/connections") &&
			r.request().method() === "PUT",
	);
	await connection.getByRole("button", { name: "接続を保存" }).click();
	const connected = await (await connectionSaved).json();
	expect(connected.localToken).toBeTruthy();
	await root.getByRole("button", { name: "表示を閉じる", exact: true }).click();
	const client = createClient(`http://127.0.0.1:${apiPort}`, token);
	const pack = await client.configureDotsPackage({
		id: `dots.user.${crypto.randomUUID().replaceAll("-", "")}`,
		expectedToken: null,
		title: "検証担当",
		summary: "根拠を残す",
		profile: "完了条件を確認して根拠を報告する",
		enabled: true,
		skills: [
			{ title: "検証手順", body: "変更後に対象の検証を実行し結果を報告する" },
		],
	});
	// Reload gets the saved package through the same client query as the settings panel.
	await page.reload();
	await page
		.getByRole("button", { name: "Codexへの委任", exact: true })
		.click();
	const project = root.locator("section").filter({
		has: page.getByRole("heading", {
			name: "作業するプロジェクト",
			exact: true,
		}),
	});
	await project.getByLabel("名前", { exact: true }).fill("試験プロジェクト");
	await project
		.getByLabel("プロジェクトID", { exact: true })
		.fill("native-fixture-project");
	await project
		.getByRole("combobox", { name: "担当", exact: true })
		.selectOption(pack.revisionId);
	const projectSaved = page.waitForResponse(
		(r) =>
			r.url().endsWith("/api/dots/projects") && r.request().method() === "PUT",
	);
	await project.getByRole("button", { name: "プロジェクトを保存" }).click();
	const savedProject = await (await projectSaved).json();
	expect(savedProject.capabilityRevisionId).toBe(pack.revisionId);
	const tasks = root.locator("section").filter({
		has: page.getByRole("heading", { name: "委任した作業", exact: true }),
	});
	await tasks.getByText("作業を依頼", { exact: true }).click();
	await tasks
		.getByRole("combobox", { name: "プロジェクト", exact: true })
		.selectOption(savedProject.ref);
	await tasks.getByLabel("作業名", { exact: true }).fill("画面からの委任試験");
	await tasks
		.getByLabel("依頼", { exact: true })
		.fill("試験用のSessionを記録して結果を報告する");
	await tasks
		.getByLabel("完了条件（1行に1つ）", { exact: true })
		.fill("検証の根拠を記録する");
	const taskSaved = page.waitForResponse(
		(r) => r.url().endsWith("/api/tasks") && r.request().method() === "POST",
	);
	await tasks.getByRole("button", { name: "依頼を送る", exact: true }).click();
	const receipt = await (await taskSaved).json();
	await expect(
		tasks.getByRole("button", { name: /画面からの委任試験 ·/ }),
	).toBeVisible();
	await expect(tasks.getByRole("alert")).toHaveCount(0);
	const rpc = async (name: string, args: Record<string, unknown>) => {
		const method = "tools/call",
			version = "2026-07-28";
		const response = await fetch(
			`http://127.0.0.1:${apiPort}/mcp/dots/${connected.connection.id}`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${connected.localToken}`,
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					"MCP-Protocol-Version": version,
					"Mcp-Method": method,
					"Mcp-Name": name,
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: crypto.randomUUID(),
					method,
					params: {
						name,
						arguments: args,
						_meta: {
							"io.modelcontextprotocol/protocolVersion": version,
							"io.modelcontextprotocol/clientCapabilities": {},
							"io.modelcontextprotocol/clientInfo": {
								name: "browser-fixture",
								version: "1",
							},
						},
					},
				}),
			},
		);
		expect(response.ok).toBe(true);
		const body = await response.text(),
			parsed = JSON.parse(
				body.startsWith("event:") || body.startsWith("data:")
					? body
							.split("\n")
							.find((s) => s.startsWith("data:"))!
							.slice(5)
					: body,
			);
		expect(parsed.result?.isError).not.toBe(true);
		return parsed.result.structuredContent;
	};
	const pending = await rpc("list_pending_commands", {}),
		command = await rpc("get_command", {
			commandId: pending.items[0].commandId,
		});
	expect(command.snapshot.capability.package.revisionId).toBe(pack.revisionId);
	await rpc("claim_command", {
		commandId: command.commandId,
		leaseId: crypto.randomUUID(),
	});
	const session = {
		threadId: "fixture-session",
		projectId: "native-fixture-project",
		hostId: "local",
		parentThreadId: null,
	};
	const report = (
		c: typeof command,
		sourceSequence: number,
		kind: string,
		extra: Record<string, unknown> = {},
	) =>
		rpc("report_task", {
			reportId: crypto.randomUUID(),
			commandId: c.commandId,
			taskId: receipt.taskId,
			authorityEpoch: c.authorityEpoch,
			executionGeneration: c.executionGeneration,
			sourceSequence,
			kind,
			summary: "隔離環境の報告",
			...extra,
		});
	await report(command, 1, "session_started", { sessions: [session] });
	await report(command, 2, "blocked", {
		question: {
			questionId: "ui-question",
			prompt: "検証対象を選んでください",
			answerType: "text",
			choices: [],
		},
	});
	const article = tasks.getByRole("article");
	await expect(article.getByText("回答待ち", { exact: true })).toBeVisible();
	await article.getByLabel("検証対象を選んでください").fill("隔離環境");
	await article.getByRole("button", { name: "回答して続行" }).click();
	await expect(article.getByText("受領待ち", { exact: true })).toBeVisible();
	const answers = await rpc("list_pending_commands", {}),
		answer = await rpc("get_command", {
			commandId: answers.items.find(
				(c: { kind: string }) => c.kind === "answer",
			).commandId,
		});
	expect(answer.snapshot.sessions).toEqual([session]);
	await rpc("claim_command", {
		commandId: answer.commandId,
		leaseId: crypto.randomUUID(),
	});
	await report(answer, 3, "accepted");
	await report(answer, 4, "blocked", {
		question: {
			questionId: "ui-question-2",
			prompt: "次の検証対象を指定してください",
			answerType: "text",
			choices: [],
		},
	});
	await expect(
		article.getByLabel("次の検証対象を指定してください"),
	).toHaveValue("");
	await article
		.getByLabel("次の検証対象を指定してください")
		.fill("二つ目の対象");
	await article.getByRole("button", { name: "回答して続行" }).click();
	await expect(article.getByText("受領待ち", { exact: true })).toBeVisible();
	const secondAnswers = await rpc("list_pending_commands", {}),
		secondAnswer = await rpc("get_command", {
			commandId: secondAnswers.items.find(
				(c: { kind: string }) => c.kind === "answer",
			).commandId,
		});
	expect(secondAnswer.snapshot.answer.text).toBe("二つ目の対象");
	await rpc("claim_command", {
		commandId: secondAnswer.commandId,
		leaseId: crypto.randomUUID(),
	});
	await report(secondAnswer, 5, "completed", {
		evidenceRefs: ["fixture-check"],
		completionChecks: [
			{ status: "satisfied", evidenceRefs: ["fixture-check"] },
		],
	});
	await expect(
		article.getByText("完了報告あり", { exact: true }),
	).toBeVisible();
	await article.getByText("Sessionと根拠", { exact: true }).click();
	await expect(article.getByText(/fixture-session/)).toBeVisible();
	await expect(article.getByText("fixture-check")).toBeVisible();
	for (const width of [1280, 390]) {
		await page.setViewportSize({ width, height: 900 });
		await article.scrollIntoViewIfNeeded();
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
		mkdirSync(evidencePath("dots"), { recursive: true });
		await page.screenshot({ path: evidencePath(`dots/settings-${width}.png`) });
	}
});
