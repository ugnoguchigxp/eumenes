/** Retire only the named runner, after a full idle interval and with no unproven children. */
export function idleRetirement(
	options: { ms: number; exit(): void } | undefined,
	instance: string,
	busy: () => boolean,
) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let closing = false;
	return {
		closing: () => closing,
		reset() {
			clearTimeout(timer);
			timer = undefined;
		},
		request(expected: string) {
			if (!options || expected !== instance || busy())
				return { accepted: false };
			if (!timer && !closing) {
				timer = setTimeout(() => {
					timer = undefined;
					if (busy()) return;
					closing = true;
					options.exit();
				}, options.ms);
				timer.unref?.();
			}
			return { accepted: true };
		},
	};
}
