import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createClient, type EumenesClient } from "../index";

/** What the stubbed fetch saw. `body` is parsed JSON when the request sent JSON. */
export type Seen = {
	method: string;
	path: string;
	headers: Record<string, string>;
	body: unknown;
};
export type Contract = {
	name: string;
	call: (client: EumenesClient) => Promise<unknown>;
	method: "GET" | "POST";
	path: string;
	body?: unknown;
	/** Minimal JSON the backend contract allows. */
	response: unknown;
	/** What the client returns for `response` (default: `response`). */
	result?: unknown;
	/** false when the client hands the JSON through without a zod parse. */
	parsed?: boolean;
};

afterEach(() => {
	vi.unstubAllGlobals();
});

export function stubFetch(respond: () => Response): Seen[] {
	const seen: Seen[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: URL, init: RequestInit = {}) => {
			const headers = Object.fromEntries(new Headers(init.headers).entries());
			seen.push({
				method: init.method ?? "GET",
				path: input.pathname + input.search,
				headers,
				body:
					typeof init.body === "string" &&
					headers["content-type"]?.includes("json")
						? JSON.parse(init.body)
						: (init.body ?? null),
			});
			return respond();
		}),
	);
	return seen;
}
export const newClient = () =>
	createClient("http://127.0.0.1:8787", "test-token");

/**
 * Three checks per endpoint: the documented request and a parsed answer, a
 * schema-violating answer, and a 4xx `{error}` surfacing as ApiError.message.
 */
export function contracts(title: string, cases: Contract[]) {
	describe(title, () => {
		for (const c of cases) {
			it(`${c.name}: sends the documented request and returns the parsed answer`, async () => {
				const seen = stubFetch(() => Response.json(c.response));
				const result = await c.call(newClient());
				expect(result).toEqual("result" in c ? c.result : c.response);
				expect(seen).toHaveLength(1);
				expect(seen[0]).toMatchObject({ method: c.method, path: c.path });
				expect(seen[0]?.headers.authorization).toBe("Bearer test-token");
				if (c.body !== undefined) expect(seen[0]?.body).toEqual(c.body);
			});
			if (c.parsed !== false)
				it(`${c.name}: rejects an answer that violates the schema`, async () => {
					stubFetch(() => Response.json("not-the-contract"));
					await expect(c.call(newClient())).rejects.toMatchObject({
						name: "ZodError",
					});
				});
			it(`${c.name}: surfaces a 4xx {error} as ApiError`, async () => {
				stubFetch(() =>
					Response.json(
						{ error: "revision_conflict" },
						{ status: 409, headers: { "X-Request-Id": "req-1" } },
					),
				);
				const error = await c.call(newClient()).catch((e: unknown) => e);
				expect(error).toBeInstanceOf(ApiError);
				expect(error).toMatchObject({
					status: 409,
					message: "revision_conflict",
					requestId: "req-1",
				});
			});
		}
	});
}
