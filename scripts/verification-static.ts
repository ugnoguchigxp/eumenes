import { relative } from "node:path";

/**
 * One violation reported by a static check, with the file or domain it belongs to. A finding
 * with neither belongs to the whole repository.
 */
export type Finding = { text: string; path?: string; domain?: string };

/** Which findings fail a run. A full run fails on every finding; a domain run on its own. */
export type StaticScope = {
	all: boolean;
	domains: readonly string[];
	paths: readonly string[];
};

export function inScope(finding: Finding, scope: StaticScope): boolean {
	if (scope.all) return true;
	if (finding.domain !== undefined)
		return scope.domains.includes(finding.domain);
	const path = finding.path;
	if (path === undefined) return true;
	return scope.paths.some(
		(owned) => path === owned || path.startsWith(`${owned}/`),
	);
}

/** Findings of the selection fail the step; the rest are reported as warnings. */
export function partition(findings: readonly Finding[], scope: StaticScope) {
	const failing: Finding[] = [];
	const outside: Finding[] = [];
	for (const finding of findings)
		(inScope(finding, scope) ? failing : outside).push(finding);
	return { failing, outside };
}

/**
 * A tool's own count of problems must match the findings recognized in its output; a
 * difference is kept as a repository finding, so an unrecognized failure never passes.
 */
function reconcile(
	findings: Finding[],
	output: string,
	total: RegExp,
	tool: string,
	recognized = findings.length,
): Finding[] {
	const match = total.exec(output);
	if (!match) return findings;
	const reported = Number(match[1]!.replaceAll(",", ""));
	return reported === recognized
		? findings
		: [
				...findings,
				{ text: `${tool}: ${reported} reported, ${recognized} recognized` },
			];
}

/** `bun check --no-pretty`: `path(line,col): error ...`, continuation lines indented. */
export function typecheckFindings(output: string): Finding[] {
	const findings: Finding[] = [];
	let current: Finding | undefined;
	for (const line of output.split("\n")) {
		const head = /^(\S.*?)\(\d+,\d+\): error /.exec(line);
		if (head) findings.push((current = { text: line, path: head[1] }));
		else if (/^\s/.test(line) && line.trim() && current)
			current.text += `\n${line}`;
		// Anything else (the summary and its file table) ends the error.
		else current = undefined;
	}
	return reconcile(findings, output, /^Found ([\d,]+) errors? /m, "typecheck");
}

/** `oxlint --format unix`: `path:line:col: message [Severity/rule]`. */
export function lintFindings(output: string): Finding[] {
	const findings = output.split("\n").flatMap((line) => {
		const match = /^(\S.*?):\d+:\d+: /.exec(line);
		return match ? [{ text: line, path: match[1] }] : [];
	});
	return reconcile(findings, output, /^([\d,]+) problems?$/m, "lint");
}

/** `oxfmt --check`: one `path (Nms)` line per unformatted file, `,-[path:l:c]` for a parse error. */
export function formatFindings(output: string): Finding[] {
	const unformatted: Finding[] = [];
	const unparsed: Finding[] = [];
	for (const line of output.split("\n")) {
		const file = /^(\S.*) \(\d+(?:\.\d+)?m?s\)$/.exec(line);
		if (file)
			unformatted.push({ text: `not formatted: ${file[1]}`, path: file[1] });
		const parse = /,-\[(.+?):\d+:\d+\]/.exec(line);
		if (parse)
			unparsed.push({ text: `cannot parse: ${parse[1]}`, path: parse[1] });
	}
	return reconcile(
		[...unformatted, ...unparsed],
		output,
		/Format issues found in above ([\d,]+) files?/,
		"format",
		unformatted.length,
	);
}

/**
 * Boundary errors: `path: message` for a source file; a declaration error (`unused dependency`,
 * `unknown dependency`, `tier violation`, `cycle from`) belongs to the declaring domain. Anything
 * else is kept as a repository finding, never dropped.
 */
export function boundaryFindings(lines: readonly string[]): Finding[] {
	return lines.map((line) => {
		const declared =
			/^(?:unused dependency|unknown dependency|tier violation|cycle from) (\S+)/.exec(
				line,
			);
		if (declared) return { text: line, domain: declared[1] };
		const file = /^(\S+?): /.exec(line);
		return file ? { text: line, path: file[1] } : { text: line };
	});
}

/** s11tnext: `path: error CODE: message`, the path absolute or relative to `root`. */
export function contextFindings(output: string, root: string): Finding[] {
	return output.split("\n").flatMap((line) => {
		const match = /^(\S+): error /.exec(line);
		if (!match) return [];
		const path = match[1]!.startsWith("/")
			? relative(root, match[1]!)
			: match[1]!;
		return [{ text: line, path }];
	});
}

/**
 * `size-budget: new ... over N lines: path[#fn] (n)` or `size-budget: path[#fn] grew ...`. Any
 * other `size-budget:` line is a repository finding.
 */
export function sizeBudgetFindings(output: string): Finding[] {
	return output.split("\n").flatMap((line): Finding[] => {
		if (!line.startsWith("size-budget: ")) return [];
		const match =
			/^size-budget: new .+? over \d+ lines: ([^#\s]+)(?:#\S+)? \(\d+\)$/.exec(
				line,
			) ?? /^size-budget: ([^#\s]+)(?:#\S+)? grew /.exec(line);
		return [match ? { text: line, path: match[1] } : { text: line }];
	});
}

/** `sql boundary: <domain> accesses table ...`; any other `sql boundary:` line is a repository finding. */
export function sqlBoundaryFindings(output: string): Finding[] {
	return output.split("\n").flatMap((line): Finding[] => {
		if (!line.startsWith("sql boundary: ")) return [];
		const match = /^sql boundary: (\S+) accesses /.exec(line);
		return [match ? { text: line, domain: match[1] } : { text: line }];
	});
}
