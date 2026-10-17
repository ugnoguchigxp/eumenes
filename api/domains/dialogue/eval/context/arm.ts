/**
 * The arm seam. An arm turns the product `ContextAssembly` of a case (identical content for every arm) into the
 * message list a model is called with. Only the format may differ between arms. The baseline arm is the product's
 * own `renderContext(assembly, "current")`; candidate arms live in the experiment directory.
 */
import { createHash } from "node:crypto";
import type { RenderedContext } from "../../../inference";
import type { ChatMessage } from "../../service/context";
import type { ContextAssembly } from "../../service/context-assembly";
import { renderContext } from "../../service/context-render";
import { canonicalJson } from "./prefix-stability";

/** The messages exactly as sent, and what the render decided about them (the session split, the request). */
export type ArmOutput = {
	/** The current user input is `messages[currentRequestIndex]`. */
	messages: ChatMessage[];
	/** The leading messages that are instructions, and the messages that are ledger history. */
	sessionContext: { instructionCount: number; historyCount: number };
	currentRequestIndex: number;
};

export type ContextArm = {
	id: string;
	/**
	 * A candidate format wraps every user-role message outside the history in its own envelope; this says whether a
	 * message is so wrapped (render invariant 2). Absent for the `current` format, whose operation and research
	 * results are bare JSON user messages by design (they are what a wrapping format is compared against).
	 */
	wrapped?: (content: string) => boolean;
	/**
	 * The block sources a text names through this format's envelopes. Used after a serialization that removes
	 * message boundaries: every source of the original messages must still be readable from the flattened text.
	 */
	sourcesIn?: (text: string) => string[];
	build(assembly: ContextAssembly): ArmOutput;
};

export const armOutputOf = (
	rendered: RenderedContext<ChatMessage>,
): ArmOutput => ({
	messages: rendered.messages,
	sessionContext: rendered.sessionContext,
	currentRequestIndex: rendered.currentRequestIndex,
});

export const BASELINE_ARM_ID = "A0";
/** The product's current format: `renderContext(assembly, "current")`. */
export const baselineArm: ContextArm = {
	id: BASELINE_ARM_ID,
	build: (assembly) => armOutputOf(renderContext(assembly, "current")),
};

/** The same build under another id: an A/A control whose paired difference must be noise. */
export const baselineAaArm: ContextArm = {
	id: "A0-aa",
	build: baselineArm.build,
};

export const builtinArms: readonly ContextArm[] = [baselineArm, baselineAaArm];

/** sha256 of the canonical JSON of a message list: the identity of a prompt. */
export const promptHash = (messages: readonly ChatMessage[]) =>
	createHash("sha256").update(canonicalJson(messages)).digest("hex");
