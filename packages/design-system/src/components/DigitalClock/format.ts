/** Display-only formatting. Callers own the remaining-time calculation. */
export function formatClockSeconds(
	seconds: number,
	format: "mm:ss" | "hh:mm:ss" | "auto" = "auto",
): string {
	const safe =
		Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
	const showHours =
		format === "hh:mm:ss" || (format === "auto" && safe >= 3600);
	const hours = Math.floor(safe / 3600);
	const minutes = showHours
		? Math.floor((safe % 3600) / 60)
		: Math.floor(safe / 60);
	const secs = safe % 60;
	const pad = (value: number) => String(value).padStart(2, "0");
	return showHours
		? `${pad(hours)}:${pad(minutes)}:${pad(secs)}`
		: `${pad(minutes)}:${pad(secs)}`;
}

export function clockAccessibleLabel(seconds: number): string {
	const safe =
		Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
	const hours = Math.floor(safe / 3600);
	const minutes = Math.floor((safe % 3600) / 60);
	const secs = safe % 60;
	const parts: string[] = [];
	if (hours) parts.push(`${hours}時間`);
	if (minutes) parts.push(`${minutes}分`);
	if (secs || parts.length === 0) parts.push(`${secs}秒`);
	return `残り${parts.join("")}`;
}
