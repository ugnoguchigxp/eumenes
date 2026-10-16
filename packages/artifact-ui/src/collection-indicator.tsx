import { useEffect, useState } from "react";
import type { CollectionResource } from "./collection-contracts";

/** A compact status from the source data; failed reads and browser offline state cannot appear green. */
export function CollectionIndicator({
	data,
	label,
	indicator,
}: {
	data: CollectionResource;
	label: string;
	indicator: { key: string; activeValue: string };
}) {
	const [connected, setConnected] = useState(
		() => typeof navigator === "undefined" || navigator.onLine,
	);
	useEffect(() => {
		const update = () => setConnected(navigator.onLine);
		window.addEventListener("online", update);
		window.addEventListener("offline", update);
		return () => {
			window.removeEventListener("online", update);
			window.removeEventListener("offline", update);
		};
	}, []);
	const online =
		connected &&
		!data.error &&
		data.rows[0]?.cells[indicator.key] === indicator.activeValue;
	const text = `${label}: ${online ? "オンライン" : "オフライン"}`;
	return (
		<output
			aria-label={text}
			title={data.error ?? text}
			className="aui-collection-indicator"
			data-online={online}
		>
			<span aria-hidden="true" />
		</output>
	);
}
