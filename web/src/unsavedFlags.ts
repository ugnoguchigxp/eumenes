/** Unsaved-work flags kept per owner so one panel's save or unmount never clears another's. */
export type UnsavedOwner = "settings" | "routes";
export function createUnsavedFlags() {
	const flags: Record<UnsavedOwner, boolean> = {
		settings: false,
		routes: false,
	};
	return {
		set(owner: UnsavedOwner, dirty: boolean) {
			flags[owner] = dirty;
		},
		any: () => flags.settings || flags.routes,
		reset() {
			flags.settings = false;
			flags.routes = false;
		},
	};
}
