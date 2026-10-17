import { join } from "node:path";
import {
	type ContextArm,
	builtinArms,
} from "../../api/domains/dialogue/eval/context/arm";
import type { ExperimentConfig } from "../../api/domains/dialogue/eval/context/case-loader";

/**
 * The arms an experiment declares, in its order. An arm without `module` is a harness builtin; one with
 * `module` comes from a file in the experiment directory that exports `arms: ContextArm[]`.
 */
export async function loadArms(
	experimentDir: string,
	config: ExperimentConfig,
): Promise<ContextArm[]> {
	const loaded: ContextArm[] = [];
	for (const declared of config.arms) {
		if (!declared.module) {
			const builtin = builtinArms.find((a) => a.id === declared.id);
			if (!builtin)
				throw new Error(`context_eval_unknown_builtin_arm:${declared.id}`);
			loaded.push(builtin);
			continue;
		}
		const module = (await import(join(experimentDir, declared.module))) as {
			arms?: ContextArm[];
		};
		const arm = module.arms?.find((a) => a.id === declared.id);
		if (!arm) throw new Error(`context_eval_arm_not_exported:${declared.id}`);
		loaded.push(arm);
	}
	return loaded;
}
