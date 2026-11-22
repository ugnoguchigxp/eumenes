import { expect, test } from "bun:test";
import {
	agendaFixture,
	composeSay,
	planNothing,
	type CallKind,
} from "./always-on.fixture";

test("a drafted autonomous line yields to an outstanding work confirmation at delivery", async () => {
	let planned = false;
	let drafted = 0;
	const f = await agendaFixture({
		awaitingWorkConfirmation: () => drafted > 0,
		script: (kind: CallKind) => {
			if (kind === "plan" && !planned) {
				planned = true;
				return {
					add: [
						{
							kind: "talk",
							text: "fixture thought",
							refs: ["user-a"],
							value: 4,
							reason: "fixture",
							topic: "thought",
						},
					],
					drop: [],
					focus: "thought",
				};
			}
			if (kind === "compose") {
				drafted++;
				return composeSay("fixture competing proposal");
			}
			return kind === "plan" ? planNothing() : undefined;
		},
	});
	try {
		await f.start();
		await f.user("user-a");
		for (let i = 0; i < 20 && !drafted; i++) await f.advance(15_000);
		expect(drafted).toBeGreaterThan(0);
		expect(
			f.h.conversation.get("ao").messages.filter((m) => m.role === "assistant"),
		).toHaveLength(0);
	} finally {
		await f.close();
	}
});
