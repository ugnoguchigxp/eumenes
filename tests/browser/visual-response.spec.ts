import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cpuVisualResult,
	visualResult,
	visualImage,
} from "../../api/domains/larm/test/visual-perception.fixture";
import type { AnalysisRecord } from "../../api/domains/larm/contracts";
import { perceptionResult } from "../../api/domains/larm/contracts/visual-perception";

let directory: string;
test.beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "eumenes-visual-response-"));
	execFileSync(
		"bun",
		[
			"build",
			"tests/browser/visual-response.fixture.tsx",
			"--target=browser",
			"--format=iife",
			'--define=process.env={"NODE_ENV":"production"}',
			"--outdir",
			directory,
		],
		{ stdio: "pipe" },
	);
});
test.afterAll(() => rmSync(directory, { recursive: true, force: true }));
const modes: readonly (
	| "cpu"
	| "transformers"
	| "failure"
	| "cancel"
	| "live"
)[] = process.env.EUMENES_VISUAL_RESULT
	? ["live"]
	: ["cpu", "transformers", "failure", "cancel"];
for (const mode of modes) {
	test(`visual response ${mode} is received by the real client and displayed`, async ({
		page,
	}) => {
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		let started = false,
			reads = 0,
			posts = 0;
		const result =
			mode === "live"
				? perceptionResult.parse(
						JSON.parse(
							readFileSync(process.env.EUMENES_VISUAL_RESULT!, "utf8"),
						),
					)
				: mode === "transformers"
					? await visualResult("segmentation")
					: await cpuVisualResult();
		if (mode !== "live") result.response = "検証画像の説明結果";
		const record: AnalysisRecord = {
			id: "00000000-0000-4000-8000-000000000002",
			sourceId: "00000000-0000-4000-8000-000000000001",
			sourceRevision: 1,
			frameIndex: null,
			timestamp: null,
			actualTimestamp: null,
			sourceDigest: "fixture",
			settingsVersion: "fixture",
			options: { task: result.task, query: "説明" },
			state: "running",
			result: null,
			errorCode: null,
			releaseConfirmed: null,
			waitingMs: 1,
			inferenceMs: 1,
			elapsedMs: 2,
			createdAt: 1,
			updatedAt: 1,
		};
		await page.route("http://127.0.0.1:18701/**", async (route) => {
			const path = new URL(route.request().url()).pathname;
			if (path === "/fixture")
				return route.fulfill({
					contentType: "text/html",
					body: '<html lang="ja"><body><div id="root"></div></body></html>',
				});
			if (path.endsWith("/image") || path.includes("/masks/"))
				return route.fulfill({
					contentType: mode === "live" ? "image/jpeg" : "image/png",
					body:
						mode === "live"
							? readFileSync(
									"spec/verification/object-recognition-live-2026-10-13/bus.jpg",
								)
							: Buffer.from((await visualImage()).bytes),
				});
			if (route.request().method() === "POST") {
				if (path.endsWith("/cancel"))
					Object.assign(record, { state: "cancelled", releaseConfirmed: true });
				else {
					started = true;
					posts++;
				}
				return route.fulfill({ status: 202, json: record });
			}
			if (started && ++reads >= 3 && mode !== "cancel") {
				Object.assign(record, {
					state: mode === "failure" ? "failed" : "completed",
					result:
						mode === "failure"
							? null
							: {
									...result,
									masks: result.masks.map((mask) => ({ ...mask, data: "" })),
								},
					errorCode: mode === "failure" ? "invalid_visual_response" : null,
					releaseConfirmed: true,
					stopObservation: {
						status: "cold",
						connectionId: "fixture",
						checkedAt: Date.now(),
					},
				});
			}
			return route.fulfill({ json: started ? [record] : [] });
		});
		await page.goto("http://127.0.0.1:18701/fixture");
		await page.addScriptTag({
			content: readFileSync(
				join(directory, "visual-response.fixture.js"),
				"utf8",
			),
		});
		await expect
			.poll(
				async () => errors[0] ?? (await page.locator("#root").textContent()),
				{ timeout: 5000 },
			)
			.not.toBe("");
		expect(errors).toEqual([]);
		await page.getByRole("button", { name: /^詳細分析$/ }).click();
		await expect(page.getByRole("status")).toHaveText("解析中");
		if (mode === "cancel") {
			await page.getByRole("button", { name: /^中止$/ }).click();
			await expect(page.getByRole("status")).toHaveText("中止済み");
		} else if (mode === "failure") {
			await expect(
				page.getByRole("status").filter({ hasText: /^失敗$/ }),
			).toBeVisible();
			await expect(page.getByRole("alert")).toContainText(
				"応答形式が正しくありません",
			);
		} else {
			await expect(
				page.getByRole("status").filter({ hasText: /^完了$/ }),
			).toBeVisible();
			await expect(
				page.getByText(result.response, { exact: true }),
			).toBeVisible();
			await page.getByText("実行情報", { exact: true }).click();
			await expect(
				page.getByText(mode !== "transformers" ? /decoder非搭載/ : /float32/),
			).toBeVisible();
			if (mode === "transformers")
				await expect(page.getByLabel("マスクを重ねる")).toBeChecked();
		}
		expect(posts).toBe(1);
		expect(errors).toEqual([]);
		await page.screenshot({
			path: test.info().outputPath(`${mode}.png`),
			fullPage: true,
		});
	});
}
