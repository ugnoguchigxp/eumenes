import { expect, test } from "vitest";
import { presentOnScreen } from "./present";
import { recordingLauncher } from "./test-support";

const target = { adapterRef: "adapter:x@1", targetRef: "t1" } as const;

test("open fronts the screen, then points at the item, and does not play", async () => {
	const { launcher, events } = recordingLauncher();
	await expect(
		presentOnScreen(launcher, { ...target, action: "open" }),
	).resolves.toBe("done");
	expect(events).toEqual(["open adapter:x@1 t1", "focus t1"]);
});

test("play starts after the screen is open and the item is pointed at", async () => {
	const { launcher, events } = recordingLauncher();
	await expect(
		presentOnScreen(launcher, { ...target, action: "play" }),
	).resolves.toBe("done");
	expect(events).toEqual(["open adapter:x@1 t1", "focus t1", "play t1"]);
});

test("a browser refusal to play is blocked, any other failure is unavailable", async () => {
	const refused = recordingLauncher({
		play: async () => {
			throw new DOMException("blocked", "NotAllowedError");
		},
	});
	await expect(
		presentOnScreen(refused.launcher, { ...target, action: "play" }),
	).resolves.toBe("blocked");
	const broken = recordingLauncher({
		play: async () => {
			throw new Error("player_unavailable");
		},
	});
	await expect(
		presentOnScreen(broken.launcher, { ...target, action: "play" }),
	).resolves.toBe("unavailable");
});

test("no screen, no such item, or a screen that cannot play is unavailable", async () => {
	const noScreen = recordingLauncher({ opens: false });
	await expect(
		presentOnScreen(noScreen.launcher, { ...target, action: "open" }),
	).resolves.toBe("unavailable");
	expect(noScreen.events).toEqual(["open adapter:x@1 t1"]);
	const noItem = recordingLauncher({ focus: false });
	await expect(
		presentOnScreen(noItem.launcher, { ...target, action: "play" }),
	).resolves.toBe("unavailable");
	expect(noItem.events).not.toContain("play t1");
	const cannotPlay = recordingLauncher({ hasPlay: false });
	await expect(
		presentOnScreen(cannotPlay.launcher, { ...target, action: "play" }),
	).resolves.toBe("unavailable");
});
