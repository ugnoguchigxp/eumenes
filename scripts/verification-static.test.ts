import { expect, test } from "bun:test";
import {
	boundaryFindings,
	contextFindings,
	formatFindings,
	lintFindings,
	partition,
	sizeBudgetFindings,
	sqlBoundaryFindings,
	typecheckFindings,
	type StaticScope,
} from "./verification-static";

const ocr: StaticScope = {
	all: false,
	domains: ["ocr"],
	paths: ["api/domains/ocr", "web/src/domains/ocr"],
};

test("findings of the selection fail; other domains and shared files only warn", () => {
	const { failing, outside } = partition(
		[
			{ text: "a", path: "api/domains/ocr/service/index.ts" },
			{ text: "b", path: "api/domains/ocr-extra/index.ts" },
			{ text: "c", path: "api/application/server-core.ts" },
			{ text: "d", domain: "ocr" },
			{ text: "e", domain: "settings" },
			{ text: "f" },
		],
		ocr,
	);
	expect(failing.map((f) => f.text)).toEqual(["a", "d", "f"]);
	expect(outside.map((f) => f.text)).toEqual(["b", "c", "e"]);
	expect(
		partition([{ text: "c", path: "api/application/x.ts" }], {
			...ocr,
			all: true,
		}).failing,
	).toHaveLength(1);
});

test("tool output is attributed to files and domains", () => {
	expect(
		typecheckFindings(
			[
				"api/domains/ocr/a.ts(339,28): error TS2769: No overload matches this call.",
				"  The last overload gave the following error.",
				"web/src/x.tsx(1,2): error TS2339: Property 'y' does not exist.",
				"Found 2 errors in 2 files, checked 2,675 files [483.80ms]",
			].join("\n"),
		),
	).toEqual([
		{
			text: "api/domains/ocr/a.ts(339,28): error TS2769: No overload matches this call.\n  The last overload gave the following error.",
			path: "api/domains/ocr/a.ts",
		},
		{
			text: "web/src/x.tsx(1,2): error TS2339: Property 'y' does not exist.",
			path: "web/src/x.tsx",
		},
	]);
	expect(
		lintFindings(
			"$ oxlint --deny-warnings --format unix\nweb/src/workspace/ErrorReportDialog.tsx:91:8: Cannot access refs during render [Error/react(refs)]\n",
		).map((f) => f.path),
	).toEqual(["web/src/workspace/ErrorReportDialog.tsx"]);
	expect(
		formatFindings(
			[
				"Checking formatting...",
				"",
				"api/domains/continuity/repository/events.ts (0ms)",
				"  x Unterminated regular expression",
				"    ,-[api/domains/dialogue/service/input-text.ts:35:12]",
				"Error occurred when checking code style in the above files.",
			].join("\n"),
		).map((f) => f.path),
	).toEqual([
		"api/domains/continuity/repository/events.ts",
		"api/domains/dialogue/service/input-text.ts",
	]);
	expect(
		sizeBudgetFindings(
			[
				"size-budget: new file over 800 lines: api/application/agency/host.ts (973)",
				"size-budget: new function over 300 lines: api/domains/dialogue/service/index.ts#createDialogueService (304)",
				"size-budget: api/domains/settings/test/settings.test.ts grew 1143 -> 1218 (limit 1000)",
			].join("\n"),
		).map((f) => f.path),
	).toEqual([
		"api/application/agency/host.ts",
		"api/domains/dialogue/service/index.ts",
		"api/domains/settings/test/settings.test.ts",
	]);
	expect(
		sqlBoundaryFindings(
			"sql boundary: inference accesses table settings_document owned by settings (use the owner's API)",
		).map((f) => f.domain),
	).toEqual(["inference"]);
	expect(
		boundaryFindings([
			"client/visual-analysis.ts: client import ../api/domains/larm/contracts/visual-perception must use api/domains/<domain>/contracts",
			"unused dependency voice-dialogue -> settings (api)",
			"cycle from ocr (api)",
			"something new",
		]),
	).toEqual([
		{
			text: "client/visual-analysis.ts: client import ../api/domains/larm/contracts/visual-perception must use api/domains/<domain>/contracts",
			path: "client/visual-analysis.ts",
		},
		{
			text: "unused dependency voice-dialogue -> settings (api)",
			domain: "voice-dialogue",
		},
		{ text: "cycle from ocr (api)", domain: "ocr" },
		{ text: "something new" },
	]);
	expect(
		contextFindings(
			'$ s11tnext build --check\n/repo/.s11tnext/catalog.json: error S11TNEXT_BUILD_STALE: Generated output is missing or stale\nerror: script "context:check" exited with code 1',
			"/repo",
		),
	).toEqual([
		{
			text: "/repo/.s11tnext/catalog.json: error S11TNEXT_BUILD_STALE: Generated output is missing or stale",
			path: ".s11tnext/catalog.json",
		},
	]);
});

test("a failure the parsers cannot attribute is kept as a repository finding", () => {
	const repository = (findings: { path?: string; domain?: string }[]) =>
		findings.filter((f) => f.path === undefined && f.domain === undefined);
	const typecheck = typecheckFindings(
		[
			"web/src/x.tsx(1,2): error TS2339: Property 'y' does not exist.",
			"error TS5023: Unknown compiler option 'z'.",
			"Found 2 errors in 1 file, checked 10 files [1ms]",
			"",
			"  1  web/src/x.tsx:1",
		].join("\n"),
	);
	expect(typecheck[0]!.text).not.toContain("web/src/x.tsx:1");
	expect(repository(typecheck)).toHaveLength(1);
	expect(partition(typecheck, ocr).failing).toHaveLength(1);
	expect(
		repository(
			lintFindings(
				"a.ts:1:1: unused [Error/x]\nconfig could not load\n2 problems\n",
			),
		),
	).toHaveLength(1);
	expect(
		repository(
			formatFindings(
				"a.ts (0ms)\nb.ts (1.2s)\nc.ts ???\nFormat issues found in above 3 files. Run without `--check` to fix.",
			),
		),
	).toHaveLength(1);
	expect(
		repository(sizeBudgetFindings("size-budget: something unexpected")),
	).toHaveLength(1);
	expect(
		repository(sqlBoundaryFindings("sql boundary: unexpected wording")),
	).toHaveLength(1);
});
