import type { LlmStepId } from "../../contracts";
import type { StepDefinition } from "../types";
import { curateGoals } from "./curate-goals";
import { curateMemory } from "./curate-memory";
import { curateWorld } from "./curate-world";

/** The steps that ask the model once. The closure delete of a forget (`../forget-closure`) asks none. */
export const steps: Record<LlmStepId, StepDefinition> = {
	"curate-memory": curateMemory,
	"curate-goals": curateGoals,
	"curate-world": curateWorld,
};
