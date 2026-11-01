import {
	createLarm,
	type LarmPort,
	type RouteAnswer,
	type RouteFieldsAnswer,
	type RouteFieldsInput,
	type RouteInput,
} from "../../larm";
import type { Settings } from "../../settings";
import { stableLarmClient } from "./configured-larm";
import type { InferenceOptions } from "./execute-types";

/**
 * The router's own LARM port (spec toolchain-router-redesign 2026-11-01 §3.2): a connection of the saved router
 * profile that carries the decision provider alone, held while the router is not `off`, and released when the
 * profile, the LARM origin or the mode changes and when inference closes. It never serves the intent judge or the
 * speaking-attitude judge, and the conversation's port never serves it. The caller bounds each call; this holds no
 * timeout. Its client is stable across restarts, so a host that stopped without releasing gets the same connection
 * back instead of holding a second one.
 */
export function createRouterJudge(deps: {
	settings: {
		get(): Settings;
		onChange(fn: () => void): () => void;
		derivedKey(purpose: string): Uint8Array | undefined;
	};
	options: InferenceOptions;
}) {
	let held: { key: string; port: LarmPort } | undefined;
	const closing = new Set<Promise<void>>();
	let closed = false;
	const keyOf = (s: Settings) =>
		s.router.mode !== "off" && s.router.profile && s.larm.baseUrl
			? JSON.stringify([s.larm.baseUrl, s.router.profile, s.larm.audience])
			: null;
	function drop() {
		if (!held) return;
		const done = held.port.close();
		held = undefined;
		closing.add(done);
		void done.finally(() => closing.delete(done)).catch(() => {});
	}
	function port(s: Settings, key: string) {
		if (held?.key !== key) {
			drop();
			const client = stableLarmClient(
				deps.settings.derivedKey("larm.router-client"),
				{
					baseUrl: s.larm.baseUrl,
					profile: s.router.profile,
					audience: s.larm.audience,
				},
			);
			held = {
				key,
				port:
					deps.options.routerLarmFactory?.(s, client) ??
					createLarm({
						decisionOnly: true,
						keepAlive: true,
						client,
						baseUrl: s.larm.baseUrl ?? undefined,
						token: deps.options.token,
						providerHosts: deps.options.providerHosts,
						profile: s.router.profile,
						audience: s.larm.audience,
					}),
			};
		}
		return held.port;
	}
	/** A configured router's connection is made ahead of the first utterance, so it does not spend that turn's bound. */
	function warm() {
		const s = deps.settings.get();
		const key = keyOf(s);
		if (key && !closed)
			void port(s, key)
				.connect()
				.catch(() => {});
	}
	const unsubscribe = deps.settings.onChange(() => {
		if (held && keyOf(deps.settings.get()) !== held.key) drop();
		warm();
	});
	warm();
	/** The held port of the saved settings. */
	function ready() {
		if (closed) throw new Error("router_closed");
		const s = deps.settings.get();
		if (!s.router.profile) throw new Error("router_profile_missing");
		const key = keyOf(s);
		if (!key) throw new Error("router_unconfigured");
		return port(s, key);
	}
	return {
		/** One routing with the saved settings; an unconfigured router is an error the caller falls back from. */
		async route(input: RouteInput, signal: AbortSignal): Promise<RouteAnswer> {
			const route = ready().route;
			if (!route) throw new Error("router_unconfigured");
			return route(input, signal);
		},
		/** The chosen candidate's fields on the same connection. */
		async routeFields(
			input: RouteFieldsInput,
			signal: AbortSignal,
		): Promise<RouteFieldsAnswer> {
			const routeFields = ready().routeFields;
			if (!routeFields) throw new Error("router_unconfigured");
			return routeFields(input, signal);
		},
		async close() {
			closed = true;
			unsubscribe();
			drop();
			await Promise.allSettled(closing);
		},
	};
}
