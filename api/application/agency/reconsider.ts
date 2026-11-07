import type { HostTopic, InputContext } from "eumenes-agency";
import { sha256Hex } from "../../infrastructure/digest";
import type { Conv } from "./host-types";

/** Feed existing native wake gates; a consumed version is never offered on every timer tick. */
export function offerReconsideration(
	c: Conv,
	now: number,
	topics: readonly HostTopic[],
	current: (input: InputContext) => boolean,
) {
	const snapshot = c.runtime.snapshot();
	const known = new Set([
		...snapshot.observations.map((o) => o.id),
		...(snapshot.forgottenRefs ?? []),
		...(snapshot.scheduling?.wake.events ?? []),
		...(snapshot.scheduling?.wake.recall ?? []),
	]);
	const inputs = new Map(snapshot.provenance?.entries);
	for (const interest of snapshot.state.interests ?? []) {
		if (interest.status !== "active" && interest.status !== "emerging")
			continue;
		const input = inputs.get(`interest:${interest.id}`);
		const id = `recall:${sha256Hex(JSON.stringify([interest.id, interest.revision, interest.lastEngagedAt]))}`;
		if (known.has(id) || !input?.complete || !current(input)) continue;
		c.runtime.observe(
			{
				id,
				kind: "recall.offered",
				actor: "host",
				occurredAt: now,
				text: "保持している関心を再検討できます。現在の価値と条件は判断してください。",
				refs: [`interest:${interest.id}`],
			},
			input,
		);
	}
	for (const topic of topics) {
		const input = topic.input;
		const id = `memory-context:${sha256Hex(JSON.stringify([topic.id, topic.text, input]))}`;
		if (known.has(id) || !input?.complete || !current(input)) continue;
		c.runtime.observe(
			{
				id,
				kind: "external.event",
				actor: "host",
				occurredAt: now,
				text: `公開された記憶の話題: ${topic.text}`,
			},
			input,
		);
	}
}
