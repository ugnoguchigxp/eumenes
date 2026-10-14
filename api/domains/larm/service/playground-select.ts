import type { LarmTestTarget } from "../contracts/playground";

/**
 * The first service in catalog order that publishes the capability (and the protocol, when
 * given). Profile and model names are never part of the choice.
 */
export function findServiceTarget(
	targets: readonly LarmTestTarget[],
	capability: string,
	protocol?: string,
): LarmTestTarget | undefined {
	return targets.find(
		(t) =>
			t.mode === "service" &&
			t.kind !== "unsupported" &&
			t.capability === capability &&
			(protocol === undefined || t.protocol === protocol),
	);
}
