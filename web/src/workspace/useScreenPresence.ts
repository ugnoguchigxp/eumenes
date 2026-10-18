import { useEffect } from "react";
import type { EumenesClient } from "../../../client";

/** Only the main chat mounts this owner; the backend expires it if final delivery is lost. */
export function useScreenPresence(
	client: Pick<EumenesClient, "screenPresence">,
) {
	useEffect(() => {
		const id = crypto.randomUUID();
		let revision = 0;
		let leaving = false;
		function send(active: boolean) {
			void client
				.screenPresence(
					id,
					++revision,
					active,
					Date.now(),
					AbortSignal.timeout(15_000),
				)
				.catch(() => {
					// Retry on the next notification. Connection status is owned by the backend.
				});
		}
		function update() {
			send(!leaving && document.visibilityState === "visible");
		}
		function pagehide() {
			leaving = true;
			update();
		}
		function pageshow() {
			leaving = false;
			update();
		}
		update();
		const timer = setInterval(() => {
			if (!leaving && document.visibilityState === "visible") update();
		}, 30_000);
		document.addEventListener("visibilitychange", update);
		window.addEventListener("pagehide", pagehide);
		window.addEventListener("pageshow", pageshow);
		window.addEventListener("online", update);
		return () => {
			clearInterval(timer);
			document.removeEventListener("visibilitychange", update);
			window.removeEventListener("pagehide", pagehide);
			window.removeEventListener("pageshow", pageshow);
			window.removeEventListener("online", update);
			send(false);
		};
	}, [client]);
}
