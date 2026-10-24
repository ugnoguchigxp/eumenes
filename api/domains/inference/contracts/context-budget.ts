/**
 * The token estimate and the budgets of a window (the ContextWindow design, sections 4.4 and 5.6). They live in
 * the lowest layer, which LARM and memory can reach too; inference publishes them with its other contracts.
 */
export {
	MIN_SECTION_ROOM_TOKENS,
	OUTPUT_RESERVE_DEFAULT_TOKENS,
	PLANNING_WINDOW_SHARE,
	REFERENCE_WINDOW_TOKENS,
	EVENT_SHARE_OF_LOG,
	SECTION_LIMITS,
	WORK_AREA_MIN_SHARE,
	TOKEN_ESTIMATE,
	estimateJsonTokens,
	estimateMessageTokens,
	estimateTextTokens,
	headWithin,
	logTargets,
	planWindow,
	type LogTargets,
	type SectionName,
	type WindowPlan,
} from "../../../infrastructure/context-budget";
