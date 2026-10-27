import { afterAll, describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configuredProjects, testInventory } from "./test-inventory";
import { verificationRevision } from "./verification-inputs";
import {
	createReport,
	distRevision,
	executeVerification,
	type VerificationReport,
} from "./verification-run";
import {
	acceptanceFiles,
	groupTests,
	parseSelection,
	runnerFor,
	selectionPaths,
	sourceFiles,
	testCommand,
	testPattern,
} from "./verification-selection";
import { verificationPlan } from "./verify";
import { waitFor } from "../api/infrastructure/wait-for";

const root = resolve(import.meta.dir, "..");
const temporary: string[] = [];
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-verify-"));
	temporary.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});
function reportFor(dir: string): VerificationReport {
	const report = createReport(root, { all: false, selected: ["ocr"] });
	report.revision = verificationRevision(dir);
	return report;
}
function outputs(dir: string) {
	const dist = join(dir, "packages/design-system/dist");
	mkdirSync(dist, { recursive: true });
	for (const file of [
		"index.js",
		"index.mjs",
		"index.d.ts",
		"design-system.css",
	])
		writeFileSync(join(dist, file), file);
	return dist;
}
describe("verification selection and runner coverage", () => {
	test("repeated domains form a union, with strict argument validation and legacy support", () => {
		expect(
			parseSelection([
				"--domain",
				"ocr",
				"--domain",
				"google-accounts",
				"--domain",
				"ocr",
			]).selected,
		).toEqual(["ocr", "google-accounts"]);
		expect(parseSelection(["ocr", "upload"], true).sub).toBe("upload");
		for (const args of [
			[],
			["--domain"],
			["--domain", "toString"],
			["--all", "--domain", "ocr"],
			["--domain", "ocr", "ignored"],
			["--all", "--all"],
			["--affected"],
		])
			expect(() => parseSelection(args)).toThrow();
		expect(() => parseSelection(["ocr", "../escape"], true)).toThrow();
		expect(() => parseSelection(["ocr", "upload", "extra"], true)).toThrow();
	});
	test("owned DS tests dispatch once to the unit project", () => {
		const paths = selectionPaths(["ocr", "google-accounts", "ocr"]);
		expect(new Set(paths).size).toBe(paths.length);
		const tests = paths
			.flatMap((path) => sourceFiles(root, path))
			.filter((path) => testPattern.test(path));
		const groups = groupTests([...tests, ...tests]);
		expect(groups["design-system"].length).toBeGreaterThan(0);
		expect(
			runnerFor(
				"packages/design-system/src/components/OcrWorkspace/new.test.tsx",
			),
		).toBe("design-system");
		expect(
			runnerFor("packages/artifact-ui/src/composition-model.test.tsx"),
		).toBe("bun");
		expect(
			groups["design-system"].some((p) => p.includes("GoogleAccounts")),
		).toBe(true);
		expect(Object.values(groups).flat().length).toBe(new Set(tests).size);
		const command = testCommand("design-system", groups["design-system"]);
		expect(command).toContain("packages/design-system");
		expect(command.some((arg) => arg.startsWith("src/"))).toBe(true);
		expect(() => groupTests(["unknown/new.test.ts"])).toThrow();
	});
	test("inventory includes generated Storybook sources and explicit browser exclusions", () => {
		const inventory = testInventory(root);
		const stories = inventory.projects.find((p) => p.project === "storybook");
		expect(stories?.sources?.length).toBeGreaterThan(0);
		expect(stories?.route).toBeNull();
		expect(inventory.excludedFromVerifyAll.every((item) => item.reason)).toBe(
			true,
		);
		for (const path of acceptanceFiles) expect(runnerFor(path)).toBe("bun");
		expect(runnerFor("scripts/dots-oauth/provider.test.mjs")).toBe("bun");
		expect(runnerFor("tests/acceptance/nl/driver.test.ts")).toBeUndefined();
		expect(runnerFor("tests/browser/ocr.spec.ts")).toBeUndefined();
		expect(
			configuredProjects(
				'const config={test:{projects:[{test:{name:"new"}}]}}',
			),
		).toEqual(["new"]);
		expect(() =>
			configuredProjects("const config={test:{projects:[external]}}"),
		).toThrow();
	});
	test("production plan builds DS before root check/tests and never rebuilds at web build", () => {
		const report = createReport(root, { all: true, selected: [] });
		const plan = verificationPlan(root, fixture(), report);
		const names = plan.map((step) => step.name);
		const order = [
			"format",
			"lint",
			"design-system typecheck",
			"design-system build",
			"typecheck",
			"bun tests",
			"web tests",
			"design-system tests",
			"web build",
			"bundle-budget",
		];
		for (let i = 1; i < order.length; i++)
			expect(names.indexOf(order[i]!)).toBeGreaterThan(
				names.indexOf(order[i - 1]!),
			);
		expect(plan.find((step) => step.name === "web build")?.command).toEqual([
			process.execPath,
			"x",
			"--no-install",
			"vite",
			"build",
		]);
		const commands = plan.flatMap((step) => step.command ?? []);
		expect(commands).toContain("./scripts/dots-oauth/provider.test.mjs");
		for (const path of acceptanceFiles) expect(commands).toContain(`./${path}`);
		expect(
			commands.some(
				(arg) =>
					arg === "./tests/acceptance/nl/driver.test.ts" ||
					arg.includes("tests/browser/"),
			),
		).toBe(false);
	});
});
test("a domain run performs every static check of a full run, over the whole repository", () => {
	const statics = [
		"boundaries",
		"system-context",
		"size-budget",
		"sql-boundaries",
		"domain-docs",
		"format",
		"lint",
		"design-system typecheck",
		"typecheck",
	];
	const names = (all: boolean) =>
		verificationPlan(
			root,
			fixture(),
			createReport(root, { all, selected: all ? [] : ["ocr"] }),
		)
			.map((step) => step.name)
			.filter((name) => statics.includes(name));
	expect(names(false)).toEqual(statics);
	expect(names(false)).toEqual(names(true));
});

describe("verification evidence and integrity", () => {
	test("warnings outside the selection pass the step and are recorded", async () => {
		const dir = fixture();
		const report = reportFor(dir);
		const result = await executeVerification(
			dir,
			join(dir, "verification-reports"),
			report,
			[{ name: "static", action: () => ({ warnings: ["other: finding"] }) }],
		);
		expect(result).toBe(0);
		expect(report.steps[0]).toMatchObject({
			status: "pass",
			warnings: ["other: finding"],
		});
	});
	test("failed preparation blocks consumers and preserves earlier reports", async () => {
		const dir = fixture();
		const reports = join(dir, "verification-reports");
		const first = reportFor(dir);
		const result = await executeVerification(dir, reports, first, [
			{ name: "build", command: [process.execPath, "-e", "process.exit(7)"] },
			{
				name: "consumer",
				command: [process.execPath, "-e", "throw Error('must not run')"],
			},
		]);
		expect(result).toBe(1);
		expect(first.steps.map((s) => s.status)).toEqual(["fail", "not_run"]);
		expect(first.steps[0]?.exitCode).toBe(7);
		const second = reportFor(dir);
		expect(
			await executeVerification(dir, reports, second, [
				{ name: "ok", command: [process.execPath, "-e", "process.exit(0)"] },
			]),
		).toBe(0);
		expect(
			JSON.parse(readFileSync(join(reports, "latest.json"), "utf8")).runId,
		).toBe(second.runId);
		expect(
			JSON.parse(
				readFileSync(join(reports, "runs", first.runId, "report.json"), "utf8"),
			).result,
		).toBe("fail");
	});
	test("output hash covers names and bytes, rejects missing outputs", () => {
		const dir = fixture();
		const dist = outputs(dir);
		const before = distRevision(dist);
		writeFileSync(join(dist, "extra.js"), "extra");
		expect(distRevision(dist)).not.toBe(before);
		const added = distRevision(dist);
		renameSync(join(dist, "extra.js"), join(dist, "renamed.js"));
		expect(distRevision(dist)).not.toBe(added);
		rmSync(join(dist, "index.d.ts"));
		expect(() => distRevision(dist)).toThrow("Missing build output");
	});
	test("a successful consumer cannot pass after dist changes or disappears", async () => {
		for (const remove of [false, true]) {
			const dir = fixture();
			const dist = outputs(dir);
			const report = reportFor(dir);
			report.build.distAfterBuild = distRevision(dist);
			const code = await executeVerification(
				dir,
				join(dir, "verification-reports"),
				report,
				[
					{
						name: "consumer",
						action() {
							if (remove) rmSync(join(dist, "index.mjs"));
							else writeFileSync(join(dist, "index.mjs"), "another build");
						},
					},
				],
			);
			expect(code).toBe(1);
			expect(report.result).toBe("invalidated");
			expect(report.integrityErrors.length).toBe(1);
		}
	});
	test("source edits invalidate results even if all commands succeeded", async () => {
		const dir = fixture();
		writeFileSync(join(dir, "source.ts"), "before");
		const report = reportFor(dir);
		await executeVerification(dir, join(dir, "verification-reports"), report, [
			{
				name: "consumer",
				action() {
					writeFileSync(join(dir, "source.ts"), "after");
				},
			},
		]);
		expect(report.result).toBe("invalidated");
		expect(report.finalRevision).not.toBe(report.revision);
	});
	test("SIGTERM records interruption and never launches later commands", async () => {
		const dir = fixture();
		const reports = join(dir, "verification-reports");
		writeFileSync(
			join(dir, "fixture.ts"),
			`import { executeVerification } from ${JSON.stringify(join(root, "scripts/verification-run.ts"))};\nimport { verificationRevision } from ${JSON.stringify(join(root, "scripts/verification-inputs.ts"))};\nconst report = JSON.parse(await Bun.file('input.json').text()); report.revision=verificationRevision(process.cwd()); process.exitCode=await executeVerification(process.cwd(), 'verification-reports', report, [{name:'waiting', command:[process.execPath, '-e', "await Bun.write('ready', 'yes'); setInterval(()=>{},1000)"]},{name:'later',command:[process.execPath,'-e',"await Bun.write('unexpected', 'yes')"]}]);`,
		);
		writeFileSync(join(dir, "input.json"), JSON.stringify(reportFor(dir)));
		const child = Bun.spawn([process.execPath, "fixture.ts"], {
			cwd: dir,
			stdout: "ignore",
			stderr: "pipe",
		});
		try {
			await waitFor(() => Bun.file(join(dir, "ready")).exists(), {
				timeout: 10000,
			});
			child.kill("SIGTERM");
			expect(await child.exited).toBe(143);
			const report = JSON.parse(
				readFileSync(join(reports, "latest.json"), "utf8"),
			);
			expect(report.result).toBe("interrupted");
			expect(report.steps.map((s: { status: string }) => s.status)).toEqual([
				"interrupted",
				"not_run",
			]);
			expect(await Bun.file(join(dir, "unexpected")).exists()).toBe(false);
		} finally {
			child.kill("SIGKILL");
		}
	}, 15000);
});
