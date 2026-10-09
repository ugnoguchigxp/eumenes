// react-lang 0.3.0 auto-mounts Inspect in development. Its welcome overlay
// captures Escape before artifact dialogs. The host supplies its own inspector.
if (typeof document !== "undefined") {
	(globalThis as Record<symbol, unknown>)[
		Symbol.for("openui.devtools.autoMount")
	] = true;
}
