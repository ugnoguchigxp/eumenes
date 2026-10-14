import type { ActionBindingV1 } from "../../../../api/domains/capabilities/contracts";

/** One destination of a navigate binding, with the id a screen uses to ask for it. */
export type NavigationTarget = { id: string; artifactId: string };

/**
 * The registered destinations of a navigate binding: one fixed artifact (named by the action),
 * or the closed map of `byValue` (the event's string value picks the artifact, e.g. a hub).
 */
export function navigationTargets(
	binding: ActionBindingV1,
): NavigationTarget[] {
	const to = binding.navigateTo;
	if (!to) return [];
	if ("artifactId" in to)
		return [{ id: binding.actionId, artifactId: to.artifactId }];
	return Object.entries(to.artifacts).map(([id, artifactId]) => ({
		id,
		artifactId,
	}));
}

/** The artifact an event navigates to, or undefined when its value is not a registered one. */
export function navigationDestination(
	binding: ActionBindingV1,
	values: Readonly<Record<string, string | boolean>>,
): string | undefined {
	const to = binding.navigateTo;
	if (!to) return undefined;
	if ("artifactId" in to) return to.artifactId;
	const picked = values[to.byValue];
	return typeof picked === "string" && Object.hasOwn(to.artifacts, picked)
		? to.artifacts[picked]
		: undefined;
}
