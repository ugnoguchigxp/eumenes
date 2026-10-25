import {
	renewLifetime,
	pendingRenewal,
	credentialGeneration,
} from "./renew-lifetime";
import type { Capability } from "../contracts";
import { getLogger } from "../../../infrastructure/logger";
import {
	awaitReady,
	claimProviders,
	type Control,
	type ProviderHosts,
} from "./connect";
import { readJson, record, wait } from "./guards";
import {
	protocols,
	endpoints,
	type Lease,
	type ProviderName,
} from "./profiles";

const log = getLogger("larm");
const withoutEnglish = new WeakSet<Lease>();

/** A Provider's own readiness and credential, fenced independently from its siblings. */
export async function acquireProvider(
	current: Lease,
	name: ProviderName,
	control: Control,
	hosts: ProviderHosts,
	signal: AbortSignal,
) {
	const catalog = current.catalogProviders ?? [];
	const declared = catalog.find((p) =>
		name === "tts-english"
			? p.capability === "speech.tts.english"
			: p.name === name,
	);
	if (!declared && name === "tts-english" && !withoutEnglish.has(current)) {
		const response = record(
			await readJson(
				await control(
					`/v1/agent-connections/${current.id}`,
					{ method: "GET", signal },
					[200],
				),
			),
		);
		if (["released", "expired"].includes(String(response.status)))
			throw new Error(`larm_connection_${response.status}`);
		withoutEnglish.add(current);
	}
	if (!declared)
		throw new Error(
			name === "tts-english"
				? "speech_tts_target_unavailable"
				: name === "system-one"
					? "larm_system_one_unavailable"
					: "larm_catalog_provider_missing",
		);
	const externalName = String(declared.name);
	if (
		declared.protocol !== protocols[name] ||
		declared.endpoint !== endpoints[name]
	)
		throw new Error("larm_catalog_provider_missing");
	let observedBinding = current.providers.get(name);
	const scoped: Control = (path, init, accepted) => {
		if (init.method === "GET") observedBinding = current.providers.get(name);
		return control(path, { ...init, signal }, accepted);
	};
	let state = record(
		await readJson(
			await scoped(
				`/v1/agent-connections/${current.id}`,
				{ method: "GET" },
				[200],
			),
		),
	);
	for (let attempt = 0; ; attempt++) {
		signal.throwIfAborted();
		state = await awaitReady(scoped, (ms) => wait(ms, signal), {
			id: current.id,
			created: state,
			required: [externalName],
			startedAt: current.startedAt,
			kind: name,
			profile: current.request.profile,
			agentProfile: current.agentProfile,
		}).catch((error) => {
			if (
				!signal.aborted &&
				error instanceof Error &&
				error.message === "larm_provider_failed" &&
				observedBinding &&
				current.providers.get(name) === observedBinding
			)
				current.providers.delete(name);
			throw error;
		});
		const announced = (state.providers as unknown[])
			.map(record)
			.find((p) => p.name === externalName);
		if (
			announced?.protocol !== declared.protocol ||
			announced.endpoint !== declared.endpoint
		)
			throw new Error("larm_provider_not_ready");
		const previous = current.providers.get(name);
		try {
			if (
				previous &&
				!pendingRenewal(current) &&
				(previous.expiresAt ?? current.expiresAt) > Date.now() + 180_000
			) {
				signal.throwIfAborted();
				return;
			}
			if (previous && current.expiresAt <= Date.now() + 180_000)
				await renewLifetime(current, control, signal);
			else if (pendingRenewal(current))
				await renewLifetime(current, control, signal);
			const generation = credentialGeneration(current);
			const claimed = await claimProviders(scoped, {
				id: current.id,
				created: state,
				required:
					name === "llm" || name === "asr" || name === "tts"
						? [name as Capability]
						: [],
				catalogProviders: catalog,
				fullProfile: current.request.fullProfile,
				claimNames: [externalName],
				hosts,
			});
			signal.throwIfAborted();
			if (generation !== credentialGeneration(current)) continue;
			if (current.closing) throw new Error("larm_connection_released");
			const p = claimed.providers.get(name);
			if (!p)
				throw new Error(
					name === "tts-english"
						? "speech_tts_target_unavailable"
						: "larm_system_one_unavailable",
				);
			p.expiresAt = claimed.expiresAt;
			p.startedAt = current.startedAt;
			current.providers.set(name, p);
			current.expiresAt = claimed.expiresAt;
			current.state = state;
			log.info("larm.provider_claimed", {
				connectionId: current.id,
				kind: name,
				durationMs: Math.round(
					performance.now() - (current.startedAt ?? performance.now()),
				),
			});
			return;
		} catch (error) {
			if (
				!signal.aborted &&
				previous &&
				current.providers.get(name) === previous
			)
				current.providers.delete(name);
			if (error instanceof Error && error.message === "larm_expired")
				throw new Error("larm_credential_expired");
			if (
				!(error instanceof Error && error.message === "larm_control_409") ||
				attempt >= 59
			)
				throw error;
			await wait(100, signal);
			state = record(
				await readJson(
					await scoped(
						`/v1/agent-connections/${current.id}`,
						{ method: "GET" },
						[200],
					),
				),
			);
		}
	}
}
