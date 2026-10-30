import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createClient } from "../client";
import { readApiToken } from "../api/infrastructure/auth-config";
import { waitFor } from "../api/infrastructure/wait-for";
import { openFromLauncher } from "../tests/browser/artifact-launcher";

if (!process.argv.includes("--run")) throw new Error("use --run");
const client = createClient("http://127.0.0.1:8787", readApiToken(process.env));
const out = resolve("verification-reports/visual-response-app-live");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
page.setDefaultTimeout(20000);
const report: {
	fixture: false;
	serverStarted: false;
	http: unknown[];
	results: unknown[];
	pageErrors: string[];
	sourceId?: string;
} = {
	fixture: false,
	serverStarted: false,
	http: [],
	results: [],
	pageErrors: [],
};
const save = () =>
	writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
page.on("pageerror", (error) => report.pageErrors.push(error.name));
page.on("response", (response) => {
	const path = new URL(response.url()).pathname;
	if (path.startsWith("/api/object-recognition"))
		report.http.push({
			path,
			method: response.request().method(),
			status: response.status(),
			requestId: response.headers()["x-request-id"],
		});
});
let sourceId: string | undefined;
try {
	await page.goto("http://127.0.0.1:5173");
	await openFromLauncher(page, "映っている物を調べる");
	const workspace = page.getByRole("region", {
		name: "映っている物を調べる",
		exact: true,
	});
	const uploaded = page.waitForResponse(
		(response) =>
			response.request().method() === "POST" &&
			new URL(response.url()).pathname === "/api/object-recognition",
	);
	await workspace
		.getByLabel("画像・動画を選ぶ")
		.setInputFiles(
			"spec/verification/object-recognition-live-2026-10-13/bus.jpg",
		);
	sourceId = (await (await uploaded).json()).id;
	report.sourceId = sourceId;
	await waitFor(
		async () => (await client.recognitionGet(sourceId!)).state === "completed",
		{ timeout: 125000, interval: 500 },
	);
	const source = await client.recognitionGet(sourceId!);
	report.results.push({ phase: "normal", state: source.state });
	save();
	const panel = workspace.locator(".visual-analysis-panel");
	const request = () =>
		page.waitForResponse(
			(response) =>
				response.request().method() === "POST" &&
				new URL(response.url()).pathname ===
					`/api/object-recognition/${sourceId}/analyses`,
		);
	const started = request();
	await workspace.getByRole("button", { name: /^詳細分析$/ }).click();
	const first = await (await started).json();
	await waitFor(
		async () =>
			["completed", "failed"].includes(
				(
					await client.analysisGet(
						"object-recognition",
						sourceId!,
						first.id,
						"main",
					)
				).state,
			),
		{ timeout: 350000, interval: 1000 },
	);
	const result = await client.analysisGet(
		"object-recognition",
		sourceId!,
		first.id,
		"main",
	);
	if (result.state !== "completed" || !result.result)
		throw new Error(result.errorCode ?? "description_not_completed");
	await expect(
		panel.getByText(result.result.response, { exact: true }),
	).toBeVisible({ timeout: 15000 });
	await panel.getByText("実行情報", { exact: true }).click();
	await expect(panel.getByText(/decoder非搭載/)).toBeVisible();
	await page.screenshot({ path: `${out}/description.png`, fullPage: true });
	report.results.push({
		phase: "describe",
		analysisId: result.id,
		state: result.state,
		responseDisplayed: true,
		decoderAbsenceDisplayed: true,
	});
	save();
	await panel.getByLabel("分析の用途").selectOption("detection");
	const failed = request();
	await panel.getByRole("button", { name: "分析する", exact: true }).click();
	const second = await (await failed).json();
	await waitFor(
		async () =>
			(
				await client.analysisGet(
					"object-recognition",
					sourceId!,
					second.id,
					"main",
				)
			).state === "failed",
		{ timeout: 180000, interval: 1000 },
	);
	await expect(
		panel.getByRole("status").filter({ hasText: /^失敗$/ }),
	).toBeVisible();
	const failure = await client.analysisGet(
		"object-recognition",
		sourceId!,
		second.id,
		"main",
	);
	report.results.push({
		phase: "failure",
		analysisId: failure.id,
		errorCode: failure.errorCode,
		releaseConfirmed: failure.releaseConfirmed,
		displayed: true,
	});
	save();
	await panel.getByLabel("分析の用途").selectOption("describe");
	const cancellation = request();
	await panel.getByRole("button", { name: "分析する", exact: true }).click();
	const third = await (await cancellation).json();
	await expect(
		panel.getByRole("status").filter({ hasText: /^解析中$/ }),
	).toBeVisible({ timeout: 150000 });
	await page.waitForTimeout(500);
	await panel.getByRole("button", { name: /^中止$/ }).click();
	await expect(
		panel.getByRole("status").filter({ hasText: /^中止済み$/ }),
	).toBeVisible();
	await waitFor(
		async () =>
			(
				await client.analysisGet(
					"object-recognition",
					sourceId!,
					third.id,
					"main",
				)
			).stopObservation?.status === "cold",
		{ timeout: 40000, interval: 500 },
	);
	const cancelled = await client.analysisGet(
		"object-recognition",
		sourceId!,
		third.id,
		"main",
	);
	if (
		cancelled.state !== "cancelled" ||
		cancelled.result !== null ||
		!cancelled.releaseConfirmed
	)
		throw new Error("cancellation_not_confirmed");
	report.results.push({
		phase: "cancel",
		analysisId: cancelled.id,
		state: cancelled.state,
		resultDiscarded: cancelled.result === null,
		releaseConfirmed: cancelled.releaseConfirmed,
		stop: cancelled.stopObservation?.status,
	});
	await page.screenshot({ path: `${out}/cancelled.png`, fullPage: true });
	save();
} finally {
	save();
	await browser.close();
}
console.log(JSON.stringify(report.results));
