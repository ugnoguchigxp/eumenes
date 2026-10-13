import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { launchDriver, LOCALE, TIMEZONE, VIEWPORT } from "./driver";
import { EVIDENCE_ROOT, makeRunId, openRunStore } from "./evidence";
import { freeze, loadFrozen, type FrozenSet } from "./frozen";
import { createHostReader } from "./host";
import { judge } from "./judge";
import {
	buildPlan,
	pilotComplete,
	tally,
	type Plan,
	type PlanEntry,
} from "./plan";
import { executeRun, type RunOutcome } from "./run";
import { startIsolated, useBaseline, type Target } from "./stack";
import { scriptedTester, type TesterAdapter } from "./tester";
import type { RunEvidence } from "./types";

const USAGE = `使い方:
  bun scripts/nl-acceptance.ts --dry-run --case <caseId> [--group <g>] [--baseline-url <url>] [--with-product-llm]
  bun scripts/nl-acceptance.ts --dry-run --pilot [--baseline-url <url>]
  bun scripts/nl-acceptance.ts --run --case <caseId> --group baseline|standard|variant-a|variant-b [--runs N]
  bun scripts/nl-acceptance.ts --run --pilot --baseline-url <url>
  bun scripts/nl-acceptance.ts --list | --freeze | --rejudge <runDir>
オプション:
  --baseline-url <url>      現行UIのorigin（baseline群）。--baseline-api-url でAPIのoriginを分けられる
  --with-product-llm        会話LLMを使うcaseを許可する（保存済みLARM設定を隔離サーバへ設定APIで保存）
  --tester larm|replay:<file>  testerアダプター（既定 larm）
  --usd-per-mtok-in/-out <n>   tester費用の単価（既定 0 = 単価なし）
  --out <dir>               証拠の保存先（既定 verification-reports/nl-acceptance）
  --headed                  ブラウザを表示する`;

const repoRoot = resolve(import.meta.dir, "../..");

function printPlan(frozen: FrozenSet, plan: Plan, pilot: boolean) {
	const lines = [
		`凍結ファイル: ${Object.keys(frozen.digests).length} 件（lock 検証済み）`,
		`実行計画: ${plan.entries.length} run、予算上限の合計 ${plan.maxCostUSD} USD${plan.totalCapUSD !== null ? `（総上限 ${plan.totalCapUSD} USD）` : ""}`,
		pilot ? "pilot: 失敗しても自動で再実行しない" : "",
	].filter(Boolean);
	console.log(lines.join("\n"));
	for (const entry of plan.entries)
		console.log(
			`  ${entry.caseId} / ${entry.group} / r${entry.runIndex}  target=${entry.target}  ${entry.budget.wallSeconds}s・${entry.budget.maxActions}操作・${entry.budget.maxModelCalls}呼出し・${entry.budget.maxCostUSD}USD${entry.requiresProductLlm ? "  [--with-product-llm]" : ""}`,
		);
	for (const warning of plan.warnings)
		console.log(`  注意: ${warning}（実行時は拒否されます）`);
	console.log("dry-run: ブラウザ・サーバ・LARM は起動していません。");
}

async function createTester(
	spec: string,
	rates: { inUsdPerMTok: number; outUsdPerMTok: number },
): Promise<TesterAdapter> {
	if (spec.startsWith("replay:"))
		return scriptedTester(
			JSON.parse(
				readFileSync(spec.slice("replay:".length), "utf8"),
			) as string[],
			"replay",
		);
	if (spec !== "larm") throw new Error("unknown_tester");
	const { createLarmTester } = await import("./tester-larm");
	return createLarmTester(rates);
}

async function runEntry(
	frozen: FrozenSet,
	entry: PlanEntry,
	tester: TesterAdapter,
	options: {
		out: string;
		baselineUrl?: string;
		baselineApiUrl?: string;
		headed: boolean;
		costMetering: string;
	},
): Promise<RunOutcome> {
	const caseDef = frozen.cases.get(entry.caseId)!;
	const criteria = frozen.criteria.get(caseDef.criteriaRef)!;
	const fixture = frozen.fixtures.get(caseDef.initialStateRef)!;
	const runId = makeRunId(entry.caseId, entry.group, entry.runIndex);
	const store = openRunStore(options.out, runId);
	let target: Target | null = null;
	let driver: Awaited<ReturnType<typeof launchDriver>> | null = null;
	try {
		target =
			entry.group === "baseline"
				? await useBaseline({
						baselineUrl: options.baselineUrl!,
						apiUrl: options.baselineApiUrl,
						fixture,
					})
				: await startIsolated({
						group: entry.group,
						fixture,
						dir: join(store.dir, "stack"),
					});
		driver = await launchDriver({
			startUrl: target.startUrl,
			faults: fixture.faults,
			headed: options.headed,
			surface: caseDef.allowedSurface,
		});
		let productModel: unknown = { llm: "none (fixture)" };
		if (fixture.stack === "product") {
			const { liveLarmSettings } = await import("../live-larm");
			productModel = {
				llm: "saved LARM settings",
				profile: liveLarmSettings().profile,
				costMetered: false,
			};
		}
		return await executeRun({
			runId,
			group: entry.group,
			runIndex: entry.runIndex,
			caseDef,
			criteria,
			fixture,
			digests: frozen.digests,
			tester,
			driver,
			host: createHostReader({
				baseUrl: target.hostUrl,
				token: target.hostToken,
			}),
			store,
			productModel,
			repoRoot,
			costMetering: options.costMetering,
			viewport: VIEWPORT,
			locale: LOCALE,
			timezone: TIMEZONE,
		});
	} catch (error) {
		// Setup failed before the tester could act: environment, never a product verdict.
		const evidence: RunEvidence = {
			caseId: entry.caseId,
			hostSeries: [],
			receipts: [],
			screens: [],
			reloads: [],
			faultsTriggered: [],
			termination: {
				reason: "environment_error",
				detail:
					error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
						? error.message
						: "setup_failed",
			},
		};
		const result = judge(criteria, evidence);
		store.json("evidence.json", evidence);
		store.json("result.json", result);
		store.json("manifest.json", {
			runId,
			caseId: entry.caseId,
			group: entry.group,
			termination: evidence.termination,
			verdict: result.verdict,
			failureClass: result.failureClass,
		});
		return {
			runId,
			group: entry.group,
			result,
			termination: evidence.termination,
			costUSD: 0,
			dir: store.dir,
		};
	} finally {
		await driver?.close();
		await target?.stop();
	}
}

export async function main(argv: string[]): Promise<number> {
	process.chdir(repoRoot);
	const { values } = parseArgs({
		args: argv,
		options: {
			"dry-run": { type: "boolean" },
			run: { type: "boolean" },
			pilot: { type: "boolean" },
			list: { type: "boolean" },
			freeze: { type: "boolean" },
			rejudge: { type: "string" },
			case: { type: "string" },
			group: { type: "string" },
			runs: { type: "string" },
			"baseline-url": { type: "string" },
			"baseline-api-url": { type: "string" },
			"with-product-llm": { type: "boolean" },
			tester: { type: "string", default: "larm" },
			"usd-per-mtok-in": { type: "string", default: "0" },
			"usd-per-mtok-out": { type: "string", default: "0" },
			out: { type: "string" },
			headed: { type: "boolean" },
		},
		strict: true,
	});
	if (values.freeze) {
		const lock = freeze();
		console.log(
			`frozen.lock.json を更新しました（${Object.keys(lock.files).length} ファイル）`,
		);
		return 0;
	}
	const { set: frozen, issues } = loadFrozen();
	if (values.rejudge) {
		if (!frozen) {
			console.error(issues.join("\n"));
			return 1;
		}
		const dir = resolve(values.rejudge);
		const manifest = JSON.parse(
			readFileSync(join(dir, "manifest.json"), "utf8"),
		);
		const caseDef = frozen.cases.get(manifest.caseId);
		const criteria = caseDef && frozen.criteria.get(caseDef.criteriaRef);
		if (!criteria) {
			console.error("unknown_case_in_manifest");
			return 1;
		}
		const evidence = JSON.parse(
			readFileSync(join(dir, "evidence.json"), "utf8"),
		) as RunEvidence;
		console.log(JSON.stringify(judge(criteria, evidence), null, 2));
		return 0;
	}
	if (!frozen || issues.length) {
		console.error(
			`凍結ファイルを検証できないため起動しません:\n${issues.map((i) => `  - ${i}`).join("\n")}`,
		);
		return 1;
	}
	if (values.list) {
		for (const c of frozen.cases.values())
			console.log(
				`${c.caseId}@${c.version}  ${c.requires.productLlm ? "[--with-product-llm] " : ""}${c.goal}`,
			);
		return 0;
	}
	if (!values["dry-run"] && !values.run) {
		console.error(USAGE);
		return 2;
	}
	const pilot = values.pilot === true;
	const plan = buildPlan(frozen, {
		pilot,
		caseId: values.case,
		group: values.group,
		runs: values.runs ? Number(values.runs) : undefined,
		baselineUrl: values["baseline-url"],
		withProductLlm: values["with-product-llm"] === true,
		dryRun: values["dry-run"] === true,
	});
	if (plan.issues.length) {
		console.error(
			`実行計画を作れません:\n${plan.issues.map((i) => `  - ${i}`).join("\n")}`,
		);
		return 1;
	}
	if (values["dry-run"]) {
		printPlan(frozen, plan, pilot);
		return 0;
	}

	const rates = {
		inUsdPerMTok: Number(values["usd-per-mtok-in"]),
		outUsdPerMTok: Number(values["usd-per-mtok-out"]),
	};
	const costMetering =
		rates.inUsdPerMTok || rates.outUsdPerMTok
			? "token-rate-configured"
			: "tokens-only (no price configured)";
	const tester = await createTester(values.tester!, rates);
	const out = resolve(values.out ?? EVIDENCE_ROOT);
	mkdirSync(out, { recursive: true });
	const outcomes: RunOutcome[] = [];
	let spent = 0;
	try {
		for (const entry of plan.entries) {
			// The plan was checked against the cap; an actual overspend still stops the rest.
			if (
				plan.totalCapUSD !== null &&
				spent + entry.budget.maxCostUSD > plan.totalCapUSD
			) {
				console.log(`総上限 ${plan.totalCapUSD} USD のため残りを実行しません`);
				break;
			}
			const outcome = await runEntry(frozen, entry, tester, {
				out,
				baselineUrl: values["baseline-url"],
				baselineApiUrl: values["baseline-api-url"],
				headed: values.headed === true,
				costMetering,
			});
			outcomes.push(outcome);
			spent += outcome.costUSD;
			console.log(
				`${outcome.runId}: ${outcome.result.verdict}${outcome.result.failureClass ? `/${outcome.result.failureClass}` : ""} (${outcome.result.reasonCode}) 停止=${outcome.termination.reason} 費用=${outcome.costUSD.toFixed(4)}USD`,
			);
		}
	} finally {
		await tester.close();
	}
	const counts = tally(
		plan.entries,
		outcomes.map((o) => ({ group: o.group, verdict: o.result.verdict })),
	);
	const summary = {
		pilot,
		ranRuns: outcomes.length,
		plannedRuns: plan.entries.length,
		spentUSD: spent,
		counts,
		complete: pilot
			? pilotComplete(counts) && outcomes.length === plan.entries.length
			: null,
		runs: outcomes.map((o) => ({
			runId: o.runId,
			verdict: o.result.verdict,
			failureClass: o.result.failureClass,
			dir: o.dir,
		})),
	};
	const summaryPath = join(
		out,
		`summary-${new Date().toISOString().replace(/[-:.]/g, "")}.json`,
	);
	writeFileSync(summaryPath, `${JSON.stringify(summary, null, "\t")}\n`);
	console.log(`集計: ${summaryPath}`);
	if (pilot)
		console.log(
			summary.complete
				? "pilot: 全群 成功"
				: "pilot: 未完了（failure/inconclusive が残る、または未実行）",
		);
	return 0;
}
