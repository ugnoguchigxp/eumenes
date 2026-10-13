import { expect, test, vi } from "vitest";
import type { EumenesClient } from "../../../../client";
import { createRecordsSession } from "./records-session";

test("closing a host discards a late diagnostic download even after a new generation mounts", async () => {
	let complete!: (value: object) => void;
	const client = {
		settingsDiagnostics: async () => ({}),
		inferenceUsage: async () => [],
		larmDetails: () =>
			new Promise((resolve) => {
				complete = resolve;
			}),
	} as unknown as EumenesClient;
	const session = createRecordsSession(client);
	const noop = async () => {};
	session.bind({
		revision: 1,
		recipes: [],

		refresh: noop,
		query: () => {},
		refreshRecipes: noop,
	});
	const createElement = vi.spyOn(document, "createElement");
	try {
		const pending = session.dispatch({
			id: "download",
			source: "settings-records",
			revision: 1,
			action: "records-download",
			values: {},
		});
		session.dispose();
		session.mount();
		complete({});
		expect((await pending).status).toBe("rejected");
		expect(createElement).not.toHaveBeenCalled();
	} finally {
		createElement.mockRestore();
		session.dispose();
	}
});
