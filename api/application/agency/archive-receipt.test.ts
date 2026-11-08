import { expect, test } from "bun:test";
import { harness } from "../toolchain/toolchain.fixture";
import { actionHost } from "./action-host.fixture";
import { waitFor } from "../../infrastructure/wait-for";

test("restoring an archived tool receipt permits another scope to checkpoint", async () => {
	const h = await harness({
		everyday: true,
		timers: true,
		memory: true,
		discoveryTarget: () => "timer",
		command: () =>
			JSON.stringify({ action: "invoke", tool: "timer.list", arguments: {} }),
	});
	const a = actionHost(
		h,
		{ id: "timers.manage", question: "登録済みの予定を確認する" },
		{ speakFirst: true, discover: true },
	);
	try {
		await a.start();
		await waitFor(() => a.host.inspect("agency-action")?.idle.unanswered === 1);
		await waitFor(() => !a.host.status("agency-action").busy);
		await a.advance(61_000);
		await waitFor(() =>
			a.host
				.inspect("agency-action")!
				.snapshot.observations.some((o) => o.kind === "action.observed"),
		);
		await waitFor(() => !a.host.status("agency-action").busy);
		await a.restart();
		await expect(a.host.attend("another-scope")).resolves.toMatchObject({
			tracked: true,
		});
		expect(a.host.status("agency-action").tracked).toBe(true);
		await expect(a.host.attend("agency-action")).resolves.toMatchObject({
			tracked: true,
		});
	} finally {
		await a.close();
		await h.close();
	}
}, 15000);
