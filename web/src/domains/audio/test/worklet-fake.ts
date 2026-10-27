import { vi } from "vitest";

export type FakeWorkletNode = {
	port: { onmessage: ((event: { data: Float32Array }) => void) | null };
};

/** The module loader a fake AudioContext exposes so recording can open its worklet. */
export const workletModule = { addModule: async () => {} };

/** Replaces AudioWorkletNode; every node a controller opens is collected in order. */
export function stubWorkletNode(): FakeWorkletNode[] {
	const nodes: FakeWorkletNode[] = [];
	vi.stubGlobal(
		"AudioWorkletNode",
		class {
			port: FakeWorkletNode["port"] = { onmessage: null };
			onprocessorerror: (() => void) | null = null;
			constructor() {
				nodes.push(this);
			}
			connect() {}
			disconnect() {}
		},
	);
	return nodes;
}

/** Delivers one recorder block to a node, as the worklet's port would. */
export const post = (node: FakeWorkletNode | undefined, data: Float32Array) =>
	node?.port.onmessage?.({ data });
