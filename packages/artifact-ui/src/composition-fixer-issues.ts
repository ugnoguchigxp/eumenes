/** The generic repairs of the composition fixer, driven by the zod issues of a part's schema. */
import {
	at,
	isObj,
	isRequired,
	roundToStep,
	setAt,
	truncate,
	valueAt,
	type Check,
	type Issue,
	type Obj,
} from "./composition-fixer-support";

/** Bounds the repair loops; every repair changes the node, so they end long before. */
const maxRepairs = 1000;

// --- generic repairs driven by the zod issues of the part's own schema ---

/**
 * A union reports every branch; follow the one meant: the branch of the part's own view, then
 * the first whose value had the right kind of type. Without such a branch the union itself
 * is the (unfixable) issue.
 */
export function resolveIssue(issue: Issue): Issue {
	if (issue.code !== "invalid_union" || !issue.errors?.length) return issue;
	const branches = issue.errors.filter((branch) => branch.length > 0);
	const own = branches.filter(
		(branch) =>
			!branch.some((i) => i.path.length === 1 && i.path[0] === "view"),
	);
	const typed = (own.length > 0 ? own : branches).find(
		(branch) =>
			!(branch[0]!.code === "invalid_type" && branch[0]!.path.length === 0),
	);
	if (!typed) return issue;
	const inner = resolveIssue(typed[0]!);
	return { ...inner, path: [...issue.path, ...inner.path] };
}

export function dropModelEntry(
	layout: Obj,
	kind: string,
	name: string,
	fixes: string[],
) {
	const model = layout.model;
	const entries = isObj(model) ? model[kind] : undefined;
	if (!isObj(entries)) return;
	delete entries[name];
	fixes.push(
		`drop_${kind === "state" ? "state" : "computed"}:model/${kind}/${name}`,
	);
}

/** Repairs of the checks written as refinements; false when the message is not known. */
function fixCustom(
	node: Obj,
	issue: Issue,
	base: readonly string[],
	fixes: string[],
): boolean {
	const path = issue.path.map(String);
	const target = valueAt(node, path);
	if (!isObj(target)) return false;
	const drop = (key: string) => {
		if (target[key] === undefined) return false;
		delete target[key];
		fixes.push(`drop_optional:${at([...base, ...path, key])}`);
		return true;
	};
	if (issue.message.endsWith("needs image")) return drop("variant");
	if (issue.message === "highlightColumn out of range")
		return drop("highlightColumn");
	// "stat needs value or expr": with both given the second (the formula) goes.
	const either = /^[\w-]+ needs (\w+) or (\w+)$/.exec(issue.message);
	if (either) return target[either[1]!] !== undefined && drop(either[2]!);
	const most = /^at most (\d+) (?:states|computed values)$/.exec(issue.message);
	if (most) {
		const keys = Object.keys(target).slice(Number(most[1]));
		for (const key of keys) delete target[key];
		fixes.push(`trim_record:${at([...base, ...path])}`);
		return keys.length > 0;
	}
	return false;
}

/** Nothing to fix the value with: drop the optional key, or the model entry, else the part. */
function unfixable(
	node: Obj,
	issue: Issue,
	base: readonly string[],
	fixes: string[],
	check: Check,
): string | null {
	const path = issue.path.map(String);
	const [head, kind, name] = path;
	const required = path.length === 0 || isRequired(node, path, check);
	if (
		head === "model" &&
		(kind === "state" || kind === "computed") &&
		name !== undefined &&
		(path.length === 3 || required)
	) {
		dropModelEntry(node, kind, name, fixes);
		return null;
	}
	if (!required && isObj(valueAt(node, path.slice(0, -1)))) {
		delete (valueAt(node, path.slice(0, -1)) as Obj)[path[path.length - 1]!];
		fixes.push(`drop_optional:${at([...base, ...path])}`);
		return null;
	}
	const missing =
		issue.code === "invalid_type" &&
		issue.message.includes("received undefined");
	return `${missing ? "missing" : "invalid"}:${at(path)}`;
}

/** Applies the repair for one issue; null when the node changed, else the reason to drop it. */
function applyIssue(
	node: Obj,
	issue: Issue,
	base: readonly string[],
	fixes: string[],
	check: Check,
): string | null {
	const path = issue.path.map(String);
	const full = at([...base, ...path]);
	const value = valueAt(node, path);
	switch (issue.code) {
		case "unrecognized_keys":
			if (!isObj(value)) break;
			for (const key of issue.keys ?? []) {
				delete value[key];
				fixes.push(`drop_key:${full}:${key}`);
			}
			return null;
		case "too_big": {
			const max = Number(issue.maximum);
			if (typeof value === "string") {
				setAt(node, path, truncate(value, max));
				fixes.push(`truncate:${full}`);
				return null;
			}
			if (Array.isArray(value)) {
				value.length = max;
				fixes.push(`trim_array:${full}`);
				return null;
			}
			if (typeof value === "number" && issue.inclusive !== false) {
				setAt(node, path, max);
				fixes.push(`clamp:${full}`);
				return null;
			}
			break;
		}
		case "too_small":
			if (typeof value === "number" && issue.inclusive !== false) {
				setAt(node, path, Number(issue.minimum));
				fixes.push(`clamp:${full}`);
				return null;
			}
			break;
		case "not_multiple_of":
			if (typeof value !== "number") break;
			setAt(node, path, roundToStep(value, Number(issue.divisor)));
			fixes.push(`round:${full}`);
			return null;
		case "invalid_type":
			if (issue.expected !== "int" || typeof value !== "number") break;
			setAt(node, path, Math.round(value));
			fixes.push(`round:${full}`);
			return null;
		case "invalid_value": {
			const values = issue.values ?? [];
			const same =
				typeof value === "string"
					? values.find(
							(candidate) =>
								typeof candidate === "string" &&
								candidate.toLowerCase() === value.trim().toLowerCase(),
						)
					: undefined;
			if (same !== undefined) {
				setAt(node, path, same);
				fixes.push(`enum:${full}`);
				return null;
			}
			if (
				path.length > 0 &&
				isObj(valueAt(node, path.slice(0, -1))) &&
				!isRequired(node, path, check)
			) {
				delete (valueAt(node, path.slice(0, -1)) as Obj)[
					path[path.length - 1]!
				];
				fixes.push(`drop_optional:${full}`);
				return null;
			}
			if (values.length === 0 || path.length === 0) break;
			setAt(node, path, values[0]);
			fixes.push(`enum:${full}`);
			return null;
		}
		case "custom":
			if (fixCustom(node, issue, base, fixes)) return null;
			break;
	}
	return unfixable(node, issue, base, fixes, check);
}

/**
 * Repairs the node in place, one issue at a time (zod reports issues incrementally).
 * Null when the node is valid at the end, else the reason it must be dropped.
 */
export function repairNode(
	node: Obj,
	base: readonly string[],
	check: Check,
	fixes: string[],
): string | null {
	for (let round = 0; round < maxRepairs; round += 1) {
		const issues = check(node);
		if (issues.length === 0) return null;
		const before = JSON.stringify(node);
		const reason = applyIssue(
			node,
			resolveIssue(issues[0]!),
			base,
			fixes,
			check,
		);
		if (reason !== null) return reason;
		if (JSON.stringify(node) === before) return "invalid:no_progress";
	}
	return "invalid:too_many_fixes";
}
