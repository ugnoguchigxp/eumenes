import { createIntentJudge } from "./intent-judge";
import { createRouterJudge } from "./router-judge";

/** The judges that hold a LARM port of their own (the user-intent judge and the router), as one unit. */
export function createJudges(deps: Parameters<typeof createIntentJudge>[0]) {
	const intent = createIntentJudge(deps);
	const router = createRouterJudge(deps);
	return {
		/** The inference port's methods: the intent judgement, the routing and its fields call. */
		ports: {
			judgeIntent: intent.judge,
			route: router.route,
			routeFields: router.routeFields,
		},
		async close() {
			await Promise.all([intent.close(), router.close()]);
		},
	};
}
