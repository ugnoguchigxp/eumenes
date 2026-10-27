/**
 * Deterministic repair of a UI studio composition definition, run before the strict checks
 * (`parseDefinition`, `validateComposition`). It fixes small slips (a wrapped or bare root, an
 * alias for a view name, a text one character too long, an unknown enum value, a bind without a
 * state), never invents content and drops what it cannot fix. Every change is recorded in `fixes`
 * as a short code. A definition that is already valid comes back unchanged with `fixes: []`.
 */
import { z } from "zod";
import { compositionDirections, imageSpec } from "./composition-contracts";
import {
	dropModelEntry,
	repairNode,
	resolveIssue,
} from "./composition-fixer-issues";
import {
	at,
	byteLength,
	canonicalView,
	isLayout,
	isObj,
	issuesOf,
	type Issue,
	type Obj,
} from "./composition-fixer-support";
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

const maxDepth = 6;
const maxParts = 240;
const maxChildren = 48;
const maxForms = 1;
const maxVerifications = 500;
const maxStates = 32;
/** Layout keys of the settings screens, never of a composition. */
const settingsLayoutKeys = [
	"tabs",
	"headerChildren",
	"headerLayout",
	"draftSource",
];
const allowedDirections = new Set<string>(compositionDirections);
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
