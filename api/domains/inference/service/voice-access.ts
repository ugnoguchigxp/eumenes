import type { SettingsService, Settings } from "../../settings";
import type { LarmPort } from "../../larm";
import type { SpeechPreparation } from "../../delivery";
import type { Receipt, SpeechOverride } from "../contracts";
import { getLogger } from "../../../infrastructure/logger";
const log = getLogger("inference");

/** One synthesis that several callers asking for the same speech share while it is not yet made. */
type Flight = {
	key: string;
	result: Promise<Receipt>;
	controller: AbortController;
	waiters: number;
	/** Requests that joined after the first. */
	joined: number;
};

export function createVoiceAccess({
	settings,
	port,
	standaloneReceipt,
}: {
	settings: SettingsService;
	port: (s: Settings) => LarmPort;
	standaloneReceipt: (
		purpose: "tts",
		text: string,
		signal: AbortSignal,
		delta?: (text: string) => void,
		override?: SpeechOverride,
		preparation?: SpeechPreparation,
	) => Promise<Receipt>;
}) {
	const flights = new Map<string, Flight>();
	function join(flight: Flight, signal: AbortSignal): Promise<Receipt> {
		flight.waiters++;
		return new Promise((resolve, reject) => {
			let left = false;
			const leave = () => {
				if (left) return false;
				left = true;
				signal.removeEventListener("abort", abort);
				flight.waiters--;
				return true;
			};
			function abort() {
				if (!leave()) return;
				// The synthesis stops only when nobody waits for it any more.
				if (!flight.waiters) {
					if (flights.get(flight.key) === flight) flights.delete(flight.key);
					flight.controller.abort(signal.reason);
				}
				reject(signal.reason);
			}
			signal.addEventListener("abort", abort, { once: true });
			flight.result.then(
				(receipt) => {
					if (leave()) resolve(receipt);
				},
				(error) => {
					if (leave()) reject(error);
				},
			);
		});
	}
	/** The same speech asked again before it is made joins that synthesis instead of sending another (§4.5). */
	function synthesize(
		text: string,
		signal: AbortSignal,
		override?: SpeechOverride,
		preparation?: SpeechPreparation,
	): Promise<Receipt> {
		signal.throwIfAborted();
		const key = JSON.stringify([
			settings.get().revision,
			text,
			override ?? null,
			preparation ?? null,
		]);
		const running = flights.get(key);
		if (running) {
			running.joined++;
			return join(running, signal);
		}
		const controller = new AbortController();
		const flight: Flight = {
			key,
			controller,
			waiters: 0,
			joined: 0,
			result: standaloneReceipt(
				"tts",
				text,
				controller.signal,
				undefined,
				override,
				preparation,
			),
		};
		flights.set(key, flight);
		flight.result
			.then((receipt) => {
				if (flight.joined)
					log.info("inference.speech_joined", {
						inferenceId: receipt.requestId,
						count: flight.joined + 1,
					});
			})
			.finally(() => {
				if (flights.get(key) === flight) flights.delete(key);
			})
			.catch(() => {});
		return join(flight, signal);
	}
	return {
		voices: async (signal: AbortSignal, language?: "ja" | "en") => {
			const snapshot = settings.get();
			const value = await port(snapshot).voices?.(signal, language);
			if (!value) throw new Error("larm_voice_discovery_unsupported");
			if (JSON.stringify(snapshot.larm) !== JSON.stringify(settings.get().larm))
				throw new Error("stale_voice_settings");
			return value;
		},
		speak: async (
			text: string,
			signal: AbortSignal,
			override?: SpeechOverride,
		) => (await synthesize(text, signal, override)).value as Uint8Array,
		speakWithDelivery: async (
			text: string,
			signal: AbortSignal,
			preparation?: SpeechPreparation,
		) => {
			const receipt = await synthesize(text, signal, undefined, preparation);
			return { wav: receipt.value as Uint8Array, delivery: receipt.delivery };
		},
	};
}
