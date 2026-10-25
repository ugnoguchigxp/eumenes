import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import type { ReactNode } from "react";
import type { EumenesClient } from "../../../../client";
import type { ResourceLauncher } from "./present";

/** The transport only talks to loopback; the host proxy adds credentials in the app. */
export const testClient = {
	identity: "http://127.0.0.1:5173",
} as unknown as EumenesClient;

export const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

export type Call = { path: string; method: string; body?: unknown };

/** Replaces `fetch` with a router over `path?query`; unmatched requests are a failed test. */
export function stubApi(
	routes: Record<string, (call: Call) => Response | Promise<Response>>,
) {
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: URL | string, init?: RequestInit) => {
			const url = new URL(String(input));
			const call: Call = {
				path: `${url.pathname}${url.search}`,
				method: init?.method ?? "GET",
				...(typeof init?.body === "string"
					? { body: JSON.parse(init.body) }
					: {}),
			};
			calls.push(call);
			const route = Object.entries(routes).find(
				([pattern]) =>
					call.path === pattern ||
					(pattern.endsWith("*") && call.path.startsWith(pattern.slice(0, -1))),
			);
			if (!route)
				throw new Error(`unexpected request ${call.method} ${call.path}`);
			return route[1](call);
		}),
	);
	return calls;
}

export function queryWrapper() {
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return {
		cache,
		wrapper: ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={cache}>{children}</QueryClientProvider>
		),
	};
}

/** A launcher that records the order of what the screen is asked to do. */
export function recordingLauncher(
	options: {
		opens?: boolean;
		focus?: boolean;
		play?: () => Promise<void>;
		hasPlay?: boolean;
	} = {},
) {
	const events: string[] = [];
	const launcher: ResourceLauncher = {
		open: vi.fn(async (adapterRef: string, targetRef: string) => {
			events.push(`open ${adapterRef} ${targetRef}`);
			return options.opens ?? true;
		}),
		screen: () => ({
			focus: async (targetRef: string) => {
				events.push(`focus ${targetRef}`);
				return options.focus ?? true;
			},
			...(options.hasPlay === false
				? {}
				: {
						play: async (targetRef: string) => {
							events.push(`play ${targetRef}`);
							await options.play?.();
						},
					}),
		}),
	};
	return { launcher, events };
}
