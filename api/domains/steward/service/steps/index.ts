import type { ExchangeStep } from "../../../memory";
import type { StepId } from "../../contracts";
import type { StepDefinition } from "../types";
import { consolidateGoals } from "./consolidate-goals";
import { curateGoals } from "./curate-goals";
import { curateMemory } from "./curate-memory";
import { curateWorld } from "./curate-world";
import {
	disposeExchanges,
	prepareRecallStep,
	summarize,
} from "./exchange-steps";
import {
	compactHistory,
	consolidateMemory,
	refineSummary,
} from "./maintenance-steps";

export const steps: Record<StepId, StepDefinition> = {
	"curate-memory": curateMemory,
	"curate-goals": curateGoals,
	"curate-world": curateWorld,
	"dispose-exchanges": disposeExchanges,
	summarize,
	"prepare-recall": prepareRecallStep,
	"consolidate-memory": consolidateMemory,
	"consolidate-goals": consolidateGoals,
	"compact-history": compactHistory,
	"refine-summary": refineSummary,
};

/** The ledger mark a reflecting step sets on each exchange it settles. */
export const exchangeStepOf: Partial<Record<StepId, ExchangeStep>> = {
	"curate-memory": "curated",
	"dispose-exchanges": "disposed",
	summarize: "summarized",
};

/** Upkeep steps in the order a round tries them. */
export const MAINTENANCE_ORDER = [
	"consolidate-memory",
	"consolidate-goals",
	"compact-history",
	"refine-summary",
] as const satisfies readonly StepId[];
