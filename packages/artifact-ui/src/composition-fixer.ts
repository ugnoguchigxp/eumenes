/**
 * Deterministic repair of a UI studio composition definition, run before the strict checks
 * (`parseDefinition`, `validateComposition`). It fixes small slips (a wrapped or bare root, an
 * alias for a view name, a text one character too long, an unknown enum value, a bind without a
 * state), never invents content and drops what it cannot fix. Every change is recorded in `fixes`
 * as a short code. A definition that is already valid comes back unchanged with `fixes: []`.
 */
import { z } from "zod";
import {
	compositionDirections,
	compositionViews,
	imageSpec,
} from "./composition-contracts";
import { validateComposition } from "./composition-validate";
import {
	layoutSchema,
	maxDefinitionBytes,
	parseDefinition,
	viewRegistry,
} from "./contracts";

export type FixResult =
	| { ok: true; definition: Record<string, unknown>; fixes: string[] }
	| { ok: false; fixes: string[] };

type Obj = Record<string, unknown>;
/** The parts of a zod issue the repairs read (union branches are nested issue lists). */
type Issue = {
	code: string;
	path: PropertyKey[];
	message: string;
	errors?: Issue[][];
	keys?: string[];
	values?: unknown[];
	maximum?: number | bigint;
	minimum?: number | bigint;
	inclusive?: boolean;
	divisor?: number | bigint;
	expected?: string;
};
/** The issues the schema reports for a node; empty when the node is valid. */
type Check = (node: Obj) => Issue[];

const maxDepth = 6;
const maxParts = 240;
const maxChildren = 48;
const maxForms = 1;
/** Bounds the repair loops; every repair changes the node, so they end long before. */
const maxRepairs = 1000;
const maxVerifications = 500;
const maxStates = 32;
/** Layout keys of the settings screens, never of a composition. */
const settingsLayoutKeys = [
	"tabs",
	"headerChildren",
	"headerLayout",
	"draftSource",
];
const allowedViews = new Set<string>(["layout", ...compositionViews]);
const allowedDirections = new Set<string>(compositionDirections);
/** Views not listed here (button, list, video, iframe, ...) are not aliased and are dropped. */
const viewAliases: Record<string, string> = {
	heading: "text-block",
	headline: "text-block",
	title: "text-block",
	subtitle: "text-block",
	text: "text-block",
	paragraph: "text-block",
	card: "info-card",
	img: "image",
	picture: "image",
	photo: "image",
	metric: "stat",
	kpi: "stat",
	statistic: "stat",
	pricing: "pricing-card",
	feature: "feature-card",
	cta: "cta-banner",
	quote: "testimonial",
	switch: "toggle",
	range: "slider",
	number: "number-input",
	container: "layout",
	section: "layout",
	page: "layout",
	group: "layout",
	stack: "layout",
};
/** The key holding an image spec, by view. */
const imageKeys: Record<string, string> = {
	hero: "image",
	image: "image",
	"media-card": "image",
	"product-card": "image",
	"cta-banner": "image",
	testimonial: "avatar",
};
/** The state type a bind of each (view, key) needs. */
const bindTypes: Record<string, "number" | "text" | "boolean"> = {
	"number-input/bind": "number",
	"slider/bind": "number",
	"stepper/bind": "number",
	"calculator/resultBind": "number",
	"diagram/stepBind": "number",
	"choice/bind": "text",
	"toggle/bind": "boolean",
};
/** A child standing in for the real ones, so a layout's own keys can be checked alone. */
const stubChild = { view: "text-block", title: "x" };

const isObj = (value: unknown): value is Obj =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isLayout = (value: unknown): value is Obj & { children: unknown[] } =>
	isObj(value) && value.view === "layout" && Array.isArray(value.children);
const at = (path: readonly string[]) => path.join("/") || ".";
const byteLength = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value)).length;

function valueAt(node: unknown, path: readonly string[]): unknown {
	let current = node;
	for (const key of path) {
		if (typeof current !== "object" || current === null) return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}
function setAt(node: Obj, path: readonly string[], value: unknown) {
	const parent = valueAt(node, path.slice(0, -1)) as Record<string, unknown>;
	parent[path[path.length - 1]!] = value;
}

/** The view name a part means, or null when it is none of the allowed views. */
function canonicalView(view: unknown): string | null {
	if (typeof view !== "string") return null;
	const name = view.trim().toLowerCase().replaceAll("_", "-");
	if (allowedViews.has(name)) return name;
	return Object.hasOwn(viewAliases, name) ? viewAliases[name]! : null;
}

// --- generic repairs driven by the zod issues of the part's own schema ---

/**
 * A union reports every branch; follow the one meant: the branch of the part's own view, then
 * the first whose value had the right kind of type. Without such a branch the union itself
 * is the (unfixable) issue.
 */
function resolveIssue(issue: Issue): Issue {
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

function truncate(text: string, max: number): string {
	let cut = text.slice(0, Math.max(0, max - 1));
	const last = cut.charCodeAt(cut.length - 1);
	if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
	return `${cut}…`;
}

/** The nearest multiple of `divisor`, written without float noise. */
function roundToStep(value: number, divisor: number): number {
	const decimals = (String(divisor).split(".")[1] ?? "").length;
	return Number((Math.round(value / divisor) * divisor).toFixed(decimals));
}

/** Whether removing the key at `path` makes the schema report that very path (it is required). */
function isRequired(node: Obj, path: readonly string[], check: Check): boolean {
	const copy = structuredClone(node);
	const parent = valueAt(copy, path.slice(0, -1));
	if (!isObj(parent)) return true;
	delete parent[path[path.length - 1]!];
	return check(copy).some(
		(issue) =>
			issue.path.length === path.length &&
			issue.path.every((key, index) => String(key) === path[index]),
	);
}

function dropModelEntry(
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
function repairNode(
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

const issuesOf = (result: {
	success: boolean;
	error?: { issues: unknown[] };
}): Issue[] =>
	result.success ? [] : ((result.error?.issues ?? []) as Issue[]);

// --- parts ---

/** Whether the picture can stay a picsum or placeholder picture (its smaller slips are repaired). */
function usableImage(spec: unknown): boolean {
	if (!isObj(spec)) return false;
	if (spec.provider === "placeholder") return true;
	return (
		spec.provider === "picsum" &&
		typeof spec.alt === "string" &&
		spec.alt.length > 0 &&
		imageSpec.safeParse({ ...spec, alt: "x" }).success
	);
}

/** A URL, an unknown provider or theme or a bad seed becomes a neutral placeholder. */
function fixImage(
	node: Obj,
	key: string,
	path: readonly string[],
	fixes: string[],
) {
	const spec = node[key];
	if (spec === undefined || usableImage(spec)) return;
	const alt = isObj(spec) ? spec.alt : undefined;
	node[key] = {
		provider: "placeholder",
		tone: "neutral",
		...(typeof alt === "string" && alt.length <= 480 ? { alt } : {}),
	};
	fixes.push(`image_placeholder:${at([...path, key])}`);
}

function fixLeaf(
	node: Obj,
	path: readonly string[],
	fixes: string[],
): string | null {
	const imageKey = imageKeys[node.view as string];
	if (imageKey) fixImage(node, imageKey, path, fixes);
	const schema = viewRegistry[node.view as keyof typeof viewRegistry]
		.schema as z.ZodType;
	return repairNode(node, path, (n) => issuesOf(schema.safeParse(n)), fixes);
}

function fixLayout(
	node: Obj,
	path: readonly string[],
	fixes: string[],
): string | null {
	for (const key of settingsLayoutKeys)
		if (key in node) {
			delete node[key];
			fixes.push(`drop_key:${at(path)}:${key}`);
		}
	if (
		node.direction !== undefined &&
		!allowedDirections.has(node.direction as string)
	) {
		node.direction = "stack";
		fixes.push(`enum:${at([...path, "direction"])}`);
	}
	if (!Array.isArray(node.children)) return "missing:children";
	const kept: Obj[] = [];
	node.children.forEach((child, index) => {
		const fixed = fixPart(child, [...path, "children", String(index)], fixes);
		if (fixed) kept.push(fixed);
	});
	if (kept.length === 0) return "empty";
	node.children = kept;
	return repairNode(
		node,
		path,
		(n) => issuesOf(layoutSchema.safeParse({ ...n, children: [stubChild] })),
		fixes,
	);
}

/** The repaired part, or null (and a `drop_part` code) when nothing displayable is left of it. */
function fixPart(
	raw: unknown,
	path: readonly string[],
	fixes: string[],
): Obj | null {
	const drop = (reason: string) => {
		fixes.push(`drop_part:${at(path)}:${reason}`);
		return null;
	};
	if (!isObj(raw)) return drop("not_object");
	if ("source" in raw) {
		delete raw.source;
		fixes.push(`drop_key:${at(path)}:source`);
	}
	const view = canonicalView(raw.view);
	if (view === null)
		return drop(typeof raw.view === "string" ? "unknown_view" : "no_view");
	if (view !== raw.view) {
		fixes.push(`alias:${at(path)}:${String(raw.view)}->${view}`);
		raw.view = view;
		if (view === "text-block" && raw.title === undefined) {
			const from = ["text", "content", "label"].find(
				(key) => typeof raw[key] === "string" && raw[key] !== "",
			);
			if (from) {
				raw.title = raw[from];
				delete raw[from];
				fixes.push(`move_key:${at(path)}:${from}->title`);
			}
		}
	}
	const reason =
		view === "layout" ? fixLayout(raw, path, fixes) : fixLeaf(raw, path, fixes);
	return reason === null ? raw : drop(reason);
}

// --- state ---

/** Moves the `model` of nested layouts to the outermost layout; one that collides is dropped. */
function liftModels(root: Obj, fixes: string[]) {
	const rootModel = isObj(root.model) ? root.model : undefined;
	const taken = new Set<string>();
	const namesOf = (model: Obj) => [
		...Object.keys(isObj(model.state) ? model.state : {}),
		...Object.keys(isObj(model.computed) ? model.computed : {}),
	];
	if (rootModel) for (const name of namesOf(rootModel)) taken.add(name);
	const visit = (node: Obj, path: string[]) => {
		const children = Array.isArray(node.children) ? node.children : [];
		children.forEach((child, index) => {
			if (!isObj(child) || child.view !== "layout") return;
			const here = [...path, "children", String(index)];
			if (child.model !== undefined) moveModel(child, here);
			visit(child, here);
		});
	};
	const moveModel = (layout: Obj, path: string[]) => {
		const model = layout.model;
		const names = isObj(model) ? namesOf(model) : [];
		const collides =
			!isObj(model) ||
			(root.model !== undefined && !rootModel) ||
			new Set(names).size !== names.length ||
			names.some((name) => taken.has(name));
		delete layout.model;
		if (collides) {
			fixes.push(`drop_model:${at(path)}/model`);
			return;
		}
		const target = (rootModel ?? (root.model = {})) as Obj;
		for (const kind of ["state", "computed"] as const)
			if (isObj(model[kind]))
				target[kind] = {
					...(isObj(target[kind]) ? target[kind] : {}),
					...model[kind],
				};
		for (const name of names) taken.add(name);
		fixes.push(`move_model:${at(path)}/model`);
	};
	visit(root, []);
}

/** Adds the state a bind names with a default value of the type the part needs. */
function addState(
	root: Obj,
	part: Obj,
	key: string,
	added: Set<string>,
	fixes: string[],
): boolean {
	const name = part[key];
	const type = bindTypes[`${String(part.view)}/${key}`];
	if (typeof name !== "string" || !type || added.has(name)) return false;
	const model = (isObj(root.model) ? root.model : (root.model = {})) as Obj;
	const states = (isObj(model.state) ? model.state : (model.state = {})) as Obj;
	if (Object.keys(states).length >= maxStates) return false;
	const number = (value: unknown) =>
		typeof value === "number" ? value : undefined;
	const min = number(part.min);
	const max = number(part.max);
	const range = min === undefined || max === undefined || min <= max;
	let initial = 0;
	if (range && min !== undefined && initial < min) initial = min;
	if (range && max !== undefined && initial > max) initial = max;
	states[name] =
		type === "number"
			? {
					type,
					initial,
					...(range && min !== undefined ? { min } : {}),
					...(range && max !== undefined ? { max } : {}),
				}
			: { type, initial: type === "text" ? "" : false };
	added.add(name);
	fixes.push(`add_state:model/state/${name}:${type}`);
	return true;
}

// --- limits ---

/** Layouts at depth 6 would hold parts at depth 7: their children are lifted into the parent. */
function limitDepth(
	layout: Obj,
	depth: number,
	path: string[],
	fixes: string[],
) {
	const lifted = (node: Obj): unknown[] =>
		(node.children as unknown[]).flatMap((child) =>
			isLayout(child) ? lifted(child) : [child],
		);
	layout.children = (layout.children as unknown[]).flatMap((child, index) => {
		if (!isLayout(child)) return [child];
		const here = [...path, "children", String(index)];
		if (depth + 1 < maxDepth) {
			limitDepth(child, depth + 1, here, fixes);
			return [child];
		}
		fixes.push(`lift_children:${at(here)}`);
		return lifted(child);
	});
}

function trimChildren(layout: Obj, path: string[], fixes: string[]) {
	const children = layout.children as unknown[];
	if (children.length > maxChildren) {
		children.length = maxChildren;
		fixes.push(`trim_array:${at([...path, "children"])}`);
	}
	children.forEach((child, index) => {
		if (isLayout(child))
			trimChildren(child, [...path, "children", String(index)], fixes);
	});
}

function dropExtraForms(
	layout: Obj,
	seen: { forms: number },
	path: string[],
	fixes: string[],
) {
	layout.children = (layout.children as unknown[]).filter((child, index) => {
		const here = [...path, "children", String(index)];
		if (isObj(child) && child.view === "form" && ++seen.forms > maxForms) {
			fixes.push(`drop_form:${at(here)}`);
			return false;
		}
		if (isLayout(child)) dropExtraForms(child, seen, here, fixes);
		return true;
	});
}

/** Removes layouts left without children. */
function pruneEmpty(layout: Obj, path: string[], fixes: string[]) {
	layout.children = (layout.children as unknown[]).filter((child, index) => {
		if (!isLayout(child)) return true;
		const here = [...path, "children", String(index)];
		pruneEmpty(child, here, fixes);
		if (child.children.length > 0) return true;
		fixes.push(`drop_part:${at(here)}:empty`);
		return false;
	});
}

const countParts = (node: unknown): number =>
	isLayout(node)
		? 1 +
			node.children.reduce<number>((sum, child) => sum + countParts(child), 0)
		: 1;

/** Removes the last part in document order (and the layouts it leaves empty); how many went. */
function removeLast(root: Obj & { children: unknown[] }): number {
	if (root.children.length === 0) return 0;
	const stack: Array<Obj & { children: unknown[] }> = [root];
	for (;;) {
		const current = stack[stack.length - 1]!;
		const last = current.children[current.children.length - 1];
		if (isLayout(last) && last.children.length > 0) {
			stack.push(last);
			continue;
		}
		current.children.pop();
		let removed = 1;
		while (stack.length > 1 && stack[stack.length - 1]!.children.length === 0) {
			stack.pop();
			stack[stack.length - 1]!.children.pop();
			removed += 1;
		}
		return removed;
	}
}

/** Brings the tree within depth, children, form, part and size limits; a no-op when it is. */
function enforceLimits(root: Obj & { children: unknown[] }, fixes: string[]) {
	limitDepth(root, 1, [], fixes);
	trimChildren(root, [], fixes);
	dropExtraForms(root, { forms: 0 }, [], fixes);
	pruneEmpty(root, [], fixes);
	for (const [limit, over, exceeded] of [
		[
			"over_parts",
			() => countParts(root) - maxParts,
			(excess: number) => excess > 0,
		],
		[
			"over_bytes",
			() => byteLength(root) - maxDefinitionBytes,
			(excess: number) => excess > 0,
		],
	] as const) {
		let removed = 0;
		while (exceeded(over())) {
			const count = removeLast(root);
			if (count === 0) break;
			removed += count;
		}
		if (removed > 0) fixes.push(`drop_parts:${limit}:${removed}`);
	}
}

// --- the strict checks, as the loop that drops what still fails ---

type Failure = { path: string[]; rule: string };

function failureOf(root: Obj): Failure | null {
	try {
		parseDefinition(JSON.stringify(root));
	} catch (error) {
		if (!(error instanceof z.ZodError) || !error.issues[0])
			return { path: [], rule: "schema" };
		const issue = resolveIssue(error.issues[0] as unknown as Issue);
		return { path: issue.path.map(String), rule: "schema" };
	}
	const meaning = validateComposition(root);
	if (meaning.ok) return null;
	return {
		path: meaning.path.split("/").filter((key) => key !== ""),
		rule: meaning.rule,
	};
}

/** Handles one failure by the smallest drop; false when only the root itself is at fault. */
function applyFailure(
	root: Obj & { children: unknown[] },
	failure: Failure,
	added: Set<string>,
	fixes: string[],
): boolean {
	const { path, rule } = failure;
	if (path[0] === "model") {
		const [, kind, name] = path;
		if ((kind === "state" || kind === "computed") && name !== undefined)
			dropModelEntry(root, kind, name, fixes);
		else {
			delete root.model;
			fixes.push("drop_model:model");
		}
		return true;
	}
	// The part owning the path: the deepest one reached through `children`.
	let owner: Obj = root;
	let parent: { children: unknown[] } | null = null;
	let index = 0;
	let used = 0;
	while (path[used] === "children" && isLayout(owner)) {
		const child = owner.children[Number(path[used + 1])];
		if (!isObj(child)) break;
		parent = owner as { children: unknown[] };
		index = Number(path[used + 1]);
		owner = child;
		used += 2;
	}
	const ownerPath = path.slice(0, used);
	const rest = path.slice(used);
	const key = rest[0];
	if (rest.length === 1 && key !== undefined) {
		const bare =
			(owner.view === "layout" && (key === "when" || key === "model")) ||
			((key === "min" || key === "max") && rule === "bind_range_mismatch");
		if (bare) {
			delete owner[key];
			fixes.push(`drop_key:${at(ownerPath)}:${key}`);
			return true;
		}
		if (rule === "unknown_bind" && addState(root, owner, key, added, fixes))
			return true;
	}
	if (!parent) return false;
	parent.children.splice(index, 1);
	fixes.push(`drop_part:${at(ownerPath)}:${rule}`);
	pruneEmpty(root, [], fixes);
	return true;
}

/** Repairs a definition so that it passes the strict checks; see the file comment. */
export function fixDefinition(raw: unknown): FixResult {
	const fixes: string[] = [];
	const fail = (): FixResult => ({ ok: false, fixes });
	let input: unknown;
	try {
		input = structuredClone(raw);
	} catch {
		return fail();
	}
	for (let layers = 0; layers < 4; layers += 1) {
		if (
			!isObj(input) ||
			Object.keys(input).length !== 1 ||
			!("definition" in input)
		)
			break;
		if (!isObj(input.definition) && !Array.isArray(input.definition)) break;
		input = input.definition;
		fixes.push("unwrap_definition");
	}
	if (Array.isArray(input)) {
		input = { view: "layout", direction: "stack", children: input };
		fixes.push("wrap_root");
	} else if (isObj(input) && canonicalView(input.view) !== "layout") {
		input = { view: "layout", direction: "stack", children: [input] };
		fixes.push("wrap_root");
	}
	if (!isObj(input)) return fail();
	liftModels(input, fixes);
	const root = fixPart(input, [], fixes);
	if (!root || !isLayout(root)) return fail();
	enforceLimits(root, fixes);
	const added = new Set<string>();
	for (let round = 0; round < maxVerifications; round += 1) {
		if (root.children.length === 0) return fail();
		const failure = failureOf(root);
		if (!failure) return { ok: true, definition: root, fixes };
		if (!applyFailure(root, failure, added, fixes)) return fail();
		enforceLimits(root, fixes);
	}
	return fail();
}
