/** Independent SDK protocol shares the package's public contract boundary. */
export { sdkId, sdkSpecSchema, sdkTerminal } from "./sdk-contracts";
export type {
	SdkSpec,
	SdkState,
	SdkReceipt,
	SdkActivity,
} from "./sdk-contracts";
export { sdkEventsSchema } from "./sdk-schema";
export type {
	SdkGitRemote,
	SdkGitResult,
	SdkSnapshot,
} from "./sdk-git-contracts";

/** Protocol digests use code-point ordering, independent of the host's locale. */
export function canonicalJSON(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.entries(value)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, v]) => `${JSON.stringify(key)}:${canonicalJSON(v)}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "null";
}
