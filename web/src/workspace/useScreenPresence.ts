import { useEffect, useRef, useState } from "react";
import type { EumenesClient } from "../../../client";

/** Pressing or typing reports the screen again at most this often; the latest press is what counts. */
const GESTURE_REPORT_MS = 5_000;
/** Change notices come with every commit; asking once a second is enough to follow the playback screen. */
const CHANGE_ASK_MS = 1_000;

/**
 * Only the main workspace mounts this owner; the backend expires it if final delivery is lost. A
 * hidden screen keeps reporting, so it stays the one that plays sound while the user is elsewhere
 * (spec tts-single-lane §4.2): the one with the voice session, else the one touched last.
 */
export function useScreenPresence(
	client: Pick<
		EumenesClient,
		"screenPresence" | "playbackScreen" | "subscribeChanges"
	>,
	voiceSession = false,
) {
	const [screenId] = useState(() => crypto.randomUUID());
	const [playbackScreen, setPlaybackScreen] = useState(false);
	const session = useRef(voiceSession);
	const report = useRef<() => void>(() => {});
	// Kept across effect runs: the id outlives a StrictMode re-run, so must its ordering.
	const revision = useRef(0);
	useEffect(() => {
		let leaving = false;
		let unmounted = false;
		let gestureAt = 0;
		let gestureSentAt = Number.NEGATIVE_INFINITY;
		// Answers can arrive out of order; only the newest report's (or a later query's) counts.
		let answered = 0;
		function send(active: boolean) {
			const sent = ++revision.current;
			void client
				.screenPresence(
					screenId,
					sent,
					active,
					Date.now(),
					AbortSignal.timeout(15_000),
					{
						// Elapsed time, not a clock reading: screens on other devices keep other clocks.
						...(gestureAt ? { gestureAgeMs: Date.now() - gestureAt } : {}),
						voiceSession: session.current,
						leaving,
					},
				)
				.then(({ playbackScreen }) => {
					if (unmounted || sent < answered) return;
					answered = sent;
					setPlaybackScreen(playbackScreen && !leaving);
				})
				.catch(() => {
					// Retry on the next notification. Connection status is owned by the backend.
				});
		}
		function update() {
			send(!leaving && document.visibilityState === "visible");
		}
		report.current = update;
		function pagehide() {
			leaving = true;
			setPlaybackScreen(false);
			update();
		}
		function pageshow() {
			leaving = false;
			update();
		}
		function gesture() {
			gestureAt = Date.now();
			if (gestureAt - gestureSentAt < GESTURE_REPORT_MS) return;
			gestureSentAt = gestureAt;
			update();
		}
		update();
		const timer = setInterval(() => {
			if (!leaving) update();
		}, 30_000);
		let asking: ReturnType<typeof setTimeout> | undefined;
		const unsubscribe = client.subscribeChanges(() => {
			if (leaving || asking) return;
			asking = setTimeout(() => {
				asking = undefined;
				if (leaving) return;
				const asked = revision.current;
				void client
					.playbackScreen(screenId, AbortSignal.timeout(15_000))
					.then(({ playbackScreen }) => {
						if (unmounted || leaving || asked < answered) return;
						answered = asked;
						setPlaybackScreen(playbackScreen);
					})
					.catch(() => {});
			}, CHANGE_ASK_MS);
		});
		document.addEventListener("visibilitychange", update);
		document.addEventListener("pointerdown", gesture, { capture: true });
		document.addEventListener("keydown", gesture, { capture: true });
		window.addEventListener("pagehide", pagehide);
		window.addEventListener("pageshow", pageshow);
		window.addEventListener("online", update);
		return () => {
			clearInterval(timer);
			clearTimeout(asking);
			unsubscribe();
			document.removeEventListener("visibilitychange", update);
			document.removeEventListener("pointerdown", gesture, { capture: true });
			document.removeEventListener("keydown", gesture, { capture: true });
			window.removeEventListener("pagehide", pagehide);
			window.removeEventListener("pageshow", pageshow);
			window.removeEventListener("online", update);
			leaving = true;
			report.current = () => {};
			send(false);
			unmounted = true;
		};
	}, [client, screenId]);
	useEffect(() => {
		if (session.current === voiceSession) return;
		session.current = voiceSession;
		report.current();
	}, [voiceSession]);
	return { screenId, playbackScreen };
}
