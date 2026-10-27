import type { StepId } from "../../contracts";
import type { StepDefinition } from "../types";
import { consolidateGoals } from "./consolidate-goals";
import { curateGoals } from "./curate-goals";
import { curateMemory } from "./curate-memory";
import { curateWorld } from "./curate-world";
import { consolidateMemory } from "./maintenance-steps";

export const steps: Record<StepId, StepDefinition> = {
	"curate-memory": curateMemory,
	"curate-goals": curateGoals,
	"curate-world": curateWorld,
	"consolidate-memory": consolidateMemory,
	"consolidate-goals": consolidateGoals,
};

/** Upkeep steps in the order a round tries them. */
export const MAINTENANCE_ORDER = [
	"consolidate-memory",
	"consolidate-goals",
] as const satisfies readonly StepId[];
