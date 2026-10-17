import { resolve } from "node:path";
import {
	type ContextArm,
	builtinArms,
} from "../../api/domains/dialogue/eval/context/arm";
import type { ExperimentConfig } from "../../api/domains/dialogue/eval/context/case-loader";
import { orderingVariant } from "../../api/domains/dialogue/eval/context/ordering";

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
		const module = (await import(resolve(experimentDir, declared.module))) as {
			arms?: ContextArm[];
		};
		const arm = module.arms?.find((a) => a.id === declared.id);
		if (!arm) throw new Error(`context_eval_arm_not_exported:${declared.id}`);
		loaded.push(arm);
	}
	return loaded;
}

/**
 * The arms whose prefix is measured: `arms`, then the ordering variants the experiment declares for them (which are
 * measured only, never called).
 */
export function withOrderingVariants(
	arms: readonly ContextArm[],
	config: ExperimentConfig,
): ContextArm[] {
	return [
		...arms,
		...config.orderingVariants.flatMap((variant) => {
			const base = arms.find((a) => a.id === variant.of);
			return base ? [orderingVariant(base, variant.id, variant.ordering)] : [];
		}),
	];
}

export async function loadMeasuredArms(
	experimentDir: string,
	config: ExperimentConfig,
): Promise<ContextArm[]> {
	return withOrderingVariants(await loadArms(experimentDir, config), config);
}
