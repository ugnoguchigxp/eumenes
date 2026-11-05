import { createRouterJudge } from "./router-judge";

/** The judge that holds a LARM port of its own: the router's reranker (LARM's context judgment). */
export function createJudges(deps: Parameters<typeof createRouterJudge>[0]) {
	const router = createRouterJudge(deps);
	return {
		/** The inference port's method: the router's reranker. */
		ports: { route: router.route },
		close: () => router.close(),
	};
}
