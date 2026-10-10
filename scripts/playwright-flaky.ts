import { existsSync, readFileSync } from "node:fs";

type PlaywrightSuite = {
	title?: string;
	file?: string;
	suites?: PlaywrightSuite[];
	specs?: Array<{
		title?: string;
		file?: string;
		tests?: Array<{ status?: string }>;
	}>;
};

export type PlaywrightJsonReport = {
	stats?: { flaky?: number };
	suites?: PlaywrightSuite[];
};

/** Titles ("file > describe > test") of tests that passed only after a retry. */
export function flakyTests(report: PlaywrightJsonReport): string[] {
	const names: string[] = [];
	const visit = (suite: PlaywrightSuite, path: string[]) => {
		const next = suite.title ? [...path, suite.title] : path;
		for (const spec of suite.specs ?? [])
			if (spec.tests?.some((test) => test.status === "flaky"))
				names.push([...next, spec.title ?? "(untitled)"].join(" > "));
		for (const child of suite.suites ?? []) visit(child, next);
	};
	for (const suite of report.suites ?? []) visit(suite, []);
	// stats.flaky is authoritative; never report 0 names when it is positive.
	if (names.length === 0 && (report.stats?.flaky ?? 0) > 0)
		names.push(`(${report.stats?.flaky} flaky test(s); names unavailable)`);
	return names;
}

/** Reads the Playwright JSON report; missing file means nothing to check. */
export function readFlakyTests(path: string): string[] {
	if (!existsSync(path)) return [];
	return flakyTests(JSON.parse(readFileSync(path, "utf8")));
}
