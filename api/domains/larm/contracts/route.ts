/**
 * The router's reranker on LARM's context judgment (spec router-package-integration 2026-11-04 §1 #4): one
 * `system-one` choice over the criteria the eumenes_router package offers, answered with an independent score per
 * criterion. The contract (limits, names, answer, error codes) is the package's; the model is whatever the saved
 * router profile's claim names.
 */
export {
	ROUTE_LIMITS,
	routeCriterionName,
	routeErrors,
	type RouteAnswer,
	type RouteCriterion,
	type RouteInput,
} from "eumenes_router";
