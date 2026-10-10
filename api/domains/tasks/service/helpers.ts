import { canonicalJson } from "../../../infrastructure/digest";
import type { TaskReceipt, WorkTask } from "../contracts";
import type { TrustedTaskContext } from "../types";

export const terminal = (s: WorkTask["state"]) =>
	["completed", "failed", "cancelled"].includes(s);
export const iso = (ms: number) => new Date(ms).toISOString();
export function syncHook(value: unknown) {
	if (
		value !== null &&
		(typeof value === "object" || typeof value === "function") &&
		"then" in value &&
		typeof value.then === "function"
	) {
		void Promise.resolve(value).catch(() => {});
		throw new Error("invalid_async_transaction_callback");
	}
}
export const canonical = (value: unknown) =>
	canonicalJson(value, { omitUndefined: false, keyOrder: "locale" });
export const receipt = (t: WorkTask): TaskReceipt => ({
	taskId: t.id,
	state: t.state,
	revision: t.revision,
	authorityEpoch: t.authorityEpoch,
	executionGeneration: t.executionGeneration,
});
export const transitions: Partial<
	Record<WorkTask["state"], WorkTask["state"][]>
> = {
	queued: ["active", "reconciling", "failed"],
	active: ["active", "waiting_user", "reconciling", "completed", "failed"],
	reconciling: ["active", "waiting_user", "completed", "failed"],
};
export const manual: TrustedTaskContext = { origin: { source: "manual" } };
