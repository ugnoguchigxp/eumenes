import { bundleFiles } from "../service/bundle-files";

/** A session binding over the shipped timer package and artifact (a fixture, not a product bundle). */
export function sessionBundle(targetSchemaRef?: string) {
	const timers = structuredClone(
		bundleFiles().find((f) => f.name === "timers.bundle.json")!.raw,
	) as any;
	const command = timers.bindings.at(-1);
	const toolchain = structuredClone(timers.definitions.at(-1));
	toolchain.revision = 7;
	toolchain.bindingRevisionId = "binding:timers.session@1";
	return {
		formatVersion: 1,
		bundleId: "timers-session-fixture",
		pins: timers.pins,
		definitions: [toolchain],
		bindings: [
			{
				kind: "binding",
				id: "timers.session",
				revision: 1,
				execution: "session",
				adapterRef: command.adapterRef,
				availabilityRef: command.availabilityRef,
				tools: command.tools,
				artifactRevisionId: command.artifactRevisionId,
				session: targetSchemaRef ? { targetSchemaRef } : {},
			},
		],
		artifacts: [],
		schemas: [],
	};
}

/** The shipped timer command binding with an `agent.turn`, as a newer revision (a fixture). */
export function commandAgentBundle() {
	const timers = structuredClone(
		bundleFiles().find((f) => f.name === "timers.bundle.json")!.raw,
	) as any;
	const binding = structuredClone(timers.bindings.at(-1));
	binding.revision = 8;
	binding.agent = { turn: { maxModelCalls: 12, retries: { default: 1 } } };
	const toolchain = structuredClone(timers.definitions.at(-1));
	toolchain.revision = 8;
	toolchain.bindingRevisionId = "binding:timers.command@8";
	return {
		formatVersion: 1,
		bundleId: "timers-command-agent-fixture",
		pins: timers.pins,
		definitions: [toolchain],
		bindings: [binding],
		artifacts: [],
		schemas: [],
	};
}
