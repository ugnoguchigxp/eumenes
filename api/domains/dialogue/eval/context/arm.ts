/**
 * The arm seam. An arm turns the materialized (identical) content of a case into the message list a model
 * is called with. Only the format may differ between arms; later `render(assembly)` arms plug in here.
 */
import { createHash } from "node:crypto";
import type { ChatMessage } from "../../service/context";
import type { Materialized } from "./materialize";
import { canonicalJson } from "./prefix-stability";

export type ArmOutput = {
	/** The messages exactly as sent; the current user input is the last one. */
	messages: ChatMessage[];
	/** Seed parts (see `Materialized.carried`) this arm did not place into `messages`. */
	unsupportedSeeds: string[];
};

export type ContextArm = {
	id: string;
	build(m: Materialized): ArmOutput;
};

/** What the production prepare phase does with the compiled context before an ordinary call (without operation results). */
function baselineMessages(m: Materialized): ChatMessage[] {
	const messages = [...m.compiled.messages];
	// Notices, prefetch and the World hint land right before the current input.
	messages.splice(
		messages.length - 1,
		0,
		...m.compiled.sections.tail,
		...(m.worldHint ? [m.worldHint] : []),
	);
	return messages;
}

export const BASELINE_ARM_ID = "baseline-compile";
/** Today's production assembly: compileContext sections as generation-prepare places them. */
export const baselineCompileArm: ContextArm = {
	id: BASELINE_ARM_ID,
	build(m) {
		return {
			messages: baselineMessages(m),
			unsupportedSeeds: Object.keys(m.carried).sort(),
		};
	},
};

/** The same build under another id: an A/A control whose paired difference must be noise. */
export const baselineAaArm: ContextArm = {
	id: "baseline-compile-aa",
	build: baselineCompileArm.build,
};

export const builtinArms: readonly ContextArm[] = [
	baselineCompileArm,
	baselineAaArm,
];

/** sha256 of the canonical JSON of a message list: the identity of a prompt. */
export const promptHash = (messages: readonly ChatMessage[]) =>
	createHash("sha256").update(canonicalJson(messages)).digest("hex");
