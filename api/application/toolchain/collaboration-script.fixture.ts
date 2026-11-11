/** Scripted tests may explicitly leave state unchanged; state-meaning tests provide their own update. */
function withCollaborationState(
	value: unknown,
	messages: readonly { content: string }[],
) {
	// Legacy scripted actions may keep the new state unchanged. Tests of state meaning supply
	// their own stateUpdate; this fixture never interprets the user's language.
	if (
		value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		!Object.hasOwn(value, "stateUpdate")
	) {
		const lines = messages[1]?.content.split("\n") ?? [];
		const savedLine = lines.find((line) =>
			line.startsWith("COLLABORATION_STATE="),
		);
		const registryLine = lines.find((line) =>
			line.startsWith("SOURCE_REGISTRY="),
		);
		if (savedLine && registryLine) {
			if (!lines.some((line) => line.startsWith("STATE_UPDATE_BASE=")))
				return JSON.stringify(value);
			const saved = JSON.parse(savedLine.slice("COLLABORATION_STATE=".length));
			const { host } = JSON.parse(
				registryLine.slice("SOURCE_REGISTRY=".length),
			);
			return JSON.stringify({
				...value,
				stateUpdate: {
					coreContractVersion: 1,
					sessionId: saved.sessionId,
					epoch: host.epoch,
					expectedRevision: saved.revision,
					sourceRevision: host.sourceRevision,
					work: host.work,
					upserts: [],
					removals: [],
				},
			});
		}
	}
	return typeof value === "string" ? value : JSON.stringify(value);
}

/** The provider returns the structured transport for a candidate-bearing turn. */
function structuredCollaborationScript(response: string) {
	const {
		action,
		tool,
		arguments: args,
		text,
		forward,
		stateUpdate,
	} = JSON.parse(response);
	return JSON.stringify({
		action,
		tool: tool ?? null,
		arguments: args == null ? null : JSON.stringify(args),
		text: text ? { first: text, second: null } : null,
		forward: forward ?? null,
		stateUpdate: stateUpdate == null ? null : JSON.stringify(stateUpdate),
	});
}

export function collaborationScript(
	value: unknown,
	messages: readonly { content: string }[],
) {
	const response = withCollaborationState(value, messages);
	return messages.some((message) =>
		message.content.startsWith("GUIDANCE_CANDIDATES="),
	)
		? structuredCollaborationScript(response)
		: response;
}
