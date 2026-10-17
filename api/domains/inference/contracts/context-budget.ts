/**
 * The token estimate and the budgets of a window (the ContextWindow design, sections 4.4 and 5.6). They live in
 * the lowest layer, which LARM and memory can reach too; inference publishes them with its other contracts.
 */
export {
	MEMORY_HISTORY_MAX_TOKENS,
	OUTPUT_RESERVE_MAX_TOKENS,
	REFERENCE_WINDOW_TOKENS,
	TOKEN_ESTIMATE,
	contextBudgets,
	estimateJsonTextTokens,
	estimateJsonTokens,
	estimateMessageTokens,
	estimateTextTokens,
	outputReserveTokens,
	type ContextBudgets,
} from "../../../infrastructure/context-budget";
