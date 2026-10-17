import {
	TOKEN_ESTIMATE,
	contextBudgets,
	estimateJsonTokens,
	estimateTextTokens,
	outputReserveTokens,
	type ContextBlock,
	type ContextSource,
} from "../../inference";
import { getLogger } from "../../../infrastructure/logger";
import type { ContextAssembly } from "./context-assembly";

const log = getLogger("dialogue");

/** The room a block's frame sentence takes beyond its body (the frames are short and fixed). */
const FRAME_TOKENS = 40;

/** Volatile blocks that memory made: they count against the memory and history budget, the rest against the task. */
const MEMORY_VOLATILE: ReadonlySet<ContextSource> = new Set([
	"memory.notice",
	"memory.recall",
]);

/** The estimated tokens of a block as the prompt carries it. */
export function blockTokens(block: ContextBlock): number {
	const { body } = block;
	switch (body.kind) {
		case "text":
			return FRAME_TOKENS + estimateTextTokens(body.text);
		case "json":
			return FRAME_TOKENS + estimateJsonTokens(body.value);
		case "lines":
			return (
				FRAME_TOKENS +
				estimateTextTokens(
					[
						body.header ?? "",
						...body.sections.flatMap((section) => [
							section.heading ?? "",
							...section.items,
						]),
					].join("\n"),
				)
			);
	}
}

/** The tokens of one history message (its text and the role framing). */
export const turnTokens = (content: string) =>
	TOKEN_ESTIMATE.messageOverheadTokens + estimateTextTokens(content);

const omitted = (chars: number) => `（省略：約${chars}文字）`;

/** The first characters of a text with an omission mark, `tokens` shorter than it was (at least). */
function clipText(text: string, reduceBy: number): string {
	const chars = [...text];
	const target = Math.max(0, estimateTextTokens(text) - reduceBy);
	let low = 0;
	let high = chars.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (estimateTextTokens(chars.slice(0, mid).join("")) <= target) low = mid;
		else high = mid - 1;
	}
	return `${chars.slice(0, low).join("")}${omitted(chars.length - low)}`;
}

/** The longest string inside a JSON value, as a way to set it. */
function longestString(
	value: unknown,
): { get: () => string; set: (text: string) => void } | null {
	let best: { get: () => string; set: (text: string) => void } | null = null;
	let bestLength = 0;
	const visit = (node: unknown, assign: (text: string) => void) => {
		if (typeof node === "string") {
			if (node.length > bestLength) {
				bestLength = node.length;
				best = { get: () => node, set: assign };
			}
		} else if (Array.isArray(node))
			node.forEach((item, index) =>
				visit(item, (text) => {
					node[index] = text;
				}),
			);
		else if (node && typeof node === "object")
			for (const key of Object.keys(node))
				visit((node as Record<string, unknown>)[key], (text) => {
					(node as Record<string, unknown>)[key] = text;
				});
	};
	visit(value, () => undefined);
	return best;
}

/**
 * The block with `reduceBy` fewer tokens (about), cut from the end so the start of it stays: a text keeps its
 * first characters, lines drop items from the last section's end, JSON shortens its longest strings. An
 * omission mark says that something was left out. The block it is given is not changed.
 */
export function clipBlock(block: ContextBlock, reduceBy: number): ContextBlock {
	const { body } = block;
	switch (body.kind) {
		case "text":
			return { ...block, body: { kind: "text", text: clipText(body.text, reduceBy) } };
		case "lines": {
			const sections = body.sections.map((section) => ({
				...section,
				items: [...section.items],
			}));
			let removed = 0;
			let count = 0;
			while (removed < reduceBy) {
				const last = [...sections].reverse().find((s) => s.items.length > 0);
				const item = last?.items.pop();
				if (item === undefined) break;
				removed += estimateTextTokens(item) + 1;
				count++;
			}
			const target = [...sections].reverse().find((s) => s.items.length > 0);
			if (count > 0)
				(target ?? sections.at(-1))?.items.push(`- （省略：${count}件）`);
			return { ...block, body: { ...body, sections } };
		}
		case "json": {
			const value = structuredClone(body.value);
			let remaining = reduceBy;
			for (let guard = 0; guard < 64 && remaining > 0; guard++) {
				const leaf = longestString(value);
				if (!leaf || leaf.get().length <= omitted(0).length + 8) break;
				const before = estimateTextTokens(leaf.get());
				leaf.set(clipText(leaf.get(), remaining));
				remaining -= before - estimateTextTokens(leaf.get());
			}
			return { ...block, body: { kind: "json", value } };
		}
	}
}

/** The estimated tokens the memory and history half of the budget is using: P, H, W and the memory-made V. */
export function memoryHistoryUsed(assembly: ContextAssembly): number {
	return (
		[
			...assembly.stable,
			...assembly.working,
			...assembly.volatile.filter((b) => MEMORY_VOLATILE.has(b.source)),
		].reduce((sum, block) => sum + blockTokens(block), 0) +
		assembly.history.turns.reduce(
			(sum, turn) => sum + turnTokens(turn.content),
			0,
		)
	);
}

/**
 * Clips the largest block of `blocks`, again and again, until `fixed` plus the blocks fit `budget` or nothing
 * more can be cut. The blocks themselves are not changed; each clip is logged (the amounts, never the text).
 */
function shrink(
	blocks: readonly ContextBlock[],
	fixed: number,
	budget: number,
): ContextBlock[] {
	let current = [...blocks];
	for (let round = 0; round < blocks.length + 4; round++) {
		const sizes = current.map(blockTokens);
		const excess = fixed + sizes.reduce((sum, size) => sum + size, 0) - budget;
		if (excess <= 0) break;
		const largest = sizes.indexOf(Math.max(...sizes));
		const before = sizes[largest]!;
		const clipped = clipBlock(current[largest]!, excess);
		const after = blockTokens(clipped);
		if (after >= before) break;
		log.warn("dialogue.context_block_clipped", {
			source: current[largest]!.source,
			omitted: before - after,
			limit: budget,
		});
		current = current.map((block, index) =>
			index === largest ? clipped : block,
		);
	}
	return current;
}

/**
 * Brings an assembly inside the budgets of its window. A budget that is exceeded never fails the conversation:
 * - the memory and history half (P, H, W and the memory-made V) already lost its oldest history in the
 *   compile step; if the rest still exceeds the half, its largest blocks are clipped from the end;
 * - the current task half (S, the other V, R and the answer's reservation) clips its largest V blocks.
 * The amounts are logged (never the text). `systemTokens` is S, measured by the caller.
 */
export function fitAssembly(
	assembly: ContextAssembly,
	windowTokens: number,
	systemTokens: number,
): ContextAssembly {
	const budgets = contextBudgets(windowTokens);
	const failure = assembly.volatile.some((b) => b.source === "research.failure");
	let { stable, working, volatile } = assembly;
	if (!failure) {
		const historyTokens = assembly.history.turns.reduce(
			(sum, turn) => sum + turnTokens(turn.content),
			0,
		);
		// P, W and the memory-made V as one list, so the largest of them is the one clipped.
		const all = [
			...stable,
			...working,
			...volatile.filter((b) => MEMORY_VOLATILE.has(b.source)),
		];
		const clipped = shrink(all, historyTokens, budgets.memoryHistory);
		stable = clipped.slice(0, stable.length);
		working = clipped.slice(stable.length, stable.length + working.length);
		const memory = clipped.slice(stable.length + working.length);
		let next = 0;
		volatile = volatile.map((block) =>
			MEMORY_VOLATILE.has(block.source) ? memory[next++]! : block,
		);
	}
	const task = volatile.filter((b) => !MEMORY_VOLATILE.has(b.source));
	const clipped = shrink(
		task,
		systemTokens + turnTokens(assembly.input.content),
		budgets.task - outputReserveTokens(windowTokens),
	);
	let next = 0;
	volatile = volatile.map((block) =>
		MEMORY_VOLATILE.has(block.source) ? block : clipped[next++]!,
	);
	return { ...assembly, stable, working, volatile };
}
