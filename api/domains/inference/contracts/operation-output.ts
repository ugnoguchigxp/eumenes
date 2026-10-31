import type { ControlContract, Messages } from "./index";

/** A grammar alone does not make descriptions visible; some deployed templates also drop later system messages. */
export function operationOutputMessages(
	messages: Messages,
	contract: ControlContract,
): Messages {
	const content =
		contract.instructions +
		"\nOUTPUT_SCHEMA=" +
		JSON.stringify(contract.outputSchema);
	if (messages[0]?.role === "system")
		return [
			{ ...messages[0], content: messages[0].content + "\n" + content },
			...messages.slice(1),
		];
	return [{ role: "system", content }, ...messages];
}
