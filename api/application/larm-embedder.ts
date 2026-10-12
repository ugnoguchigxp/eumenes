import type { LarmPlayground } from "../domains/larm";
import type { Embed } from "./toolchain-vectors";

/**
 * Bind embedding to the saved LARM connection. The client (and its catalog cache) is reused
 * until the saved connection changes; the connection target is never taken from elsewhere.
 */
export function larmEmbedder(
	create: () => LarmPlayground,
	connectionKey: () => string,
): Embed {
	let current: { key: string; client: LarmPlayground } | undefined;
	return (texts, type, signal) => {
		const key = connectionKey();
		if (current?.key !== key) current = { key, client: create() };
		return current.client.embed(texts, type, signal);
	};
}
