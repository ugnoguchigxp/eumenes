import type { ToolchainCard } from "../../capabilities";
import { candidateOf } from "../service/executor-context";
import { toolResultText } from "../service/result-text";

/** The dialogue's candidate presentation for scripted router fixtures, without truncating a whole catalog. */
export function candidateLines(cards: readonly ToolchainCard[]): string[] {
	return cards.map((card) =>
		toolResultText("find_toolchain", {
			candidates: [candidateOf(card, null)],
		}),
	);
}
