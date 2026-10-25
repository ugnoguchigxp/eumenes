import { afterEach, expect, test, vi } from "vitest";
import { openDocling } from "./open";

afterEach(() => vi.restoreAllMocks());
const url = `http://localhost:28765/auth/exchange?ticket=${"t".repeat(43)}`;
function tab() {
	return {
		opener: {},
		closed: false,
		location: { replace: vi.fn() },
		close: vi.fn(),
	};
}

test("reserves a tab during the click, navigates only after ticket and severs opener", async () => {
	const window = tab(),
		open = vi.fn(() => window as unknown as Window);
	let resolve!: (value: { url: string; expiresIn: number }) => void;
	const client = {
		doclingTicket: vi.fn(
			() =>
				new Promise<{ url: string; expiresIn: number }>((r) => {
					resolve = r;
				}),
		),
	};
	const result = openDocling(
		client,
		"http://localhost:28765",
		new AbortController(),
		open,
	);
	expect(open).toHaveBeenCalledOnce();
	expect(window.opener).toBeNull();
	expect(window.location.replace).not.toHaveBeenCalled();
	resolve({ url, expiresIn: 60 });
	expect((await result).status).toBe("accepted");
	expect(window.location.replace).toHaveBeenCalledWith(url);
	expect(client.doclingTicket).toHaveBeenCalledOnce();
});

test("popup refusal does not issue a ticket; cancellation discards a late response", async () => {
	const client = { doclingTicket: vi.fn(async () => ({ url, expiresIn: 60 })) };
	expect(
		(
			await openDocling(
				client,
				"http://localhost:28765",
				new AbortController(),
				() => null,
			)
		).status,
	).toBe("rejected");
	expect(client.doclingTicket).not.toHaveBeenCalled();
	const window = tab(),
		controller = new AbortController();
	const pending = openDocling(
		client,
		"http://localhost:28765",
		controller,
		() => window as unknown as Window,
	);
	controller.abort();
	expect((await pending).status).toBe("rejected");
	expect(window.location.replace).not.toHaveBeenCalled();
	expect(window.close).toHaveBeenCalled();
});

test("a foreign origin or failed API never navigates or retries", async () => {
	for (const value of ["https://other.invalid/auth/exchange?ticket=x", null]) {
		const window = tab();
		const client = {
			doclingTicket: vi.fn(async () => {
				if (value === null) throw new Error("docling_auth_failed");
				return { url: value, expiresIn: 60 };
			}),
		};
		expect(
			(
				await openDocling(
					client,
					"http://localhost:28765",
					new AbortController(),
					() => window as unknown as Window,
				)
			).status,
		).toBe("rejected");
		expect(window.location.replace).not.toHaveBeenCalled();
		expect(window.close).toHaveBeenCalled();
		expect(client.doclingTicket).toHaveBeenCalledOnce();
	}
});
