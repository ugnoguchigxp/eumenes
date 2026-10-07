import "@testing-library/jest-dom";

console.log("Test setup running...");

// Defines pointer capture methods for Radix UI
// biome-ignore lint/suspicious/noExplicitAny: Patching global prototypes requires any
function patchElementPrototype(elementProto: any) {
	if (!elementProto) return;

	if (!elementProto.hasPointerCapture) {
		elementProto.hasPointerCapture = () => false;
	}
	if (!elementProto.setPointerCapture) {
		elementProto.setPointerCapture = () => {};
	}
	if (!elementProto.releasePointerCapture) {
		elementProto.releasePointerCapture = () => {};
	}

	if (!elementProto.scrollIntoView) {
		elementProto.scrollIntoView = () => {};
	}
}

if (typeof Element !== "undefined") {
	patchElementPrototype(Element.prototype);
}

if (typeof HTMLElement !== "undefined") {
	patchElementPrototype(HTMLElement.prototype);
}

// Ensure global window instance also gets patched if it differs
if (typeof window !== "undefined" && window.Element) {
	patchElementPrototype(window.Element.prototype);
}
if (typeof window !== "undefined" && window.HTMLElement) {
	patchElementPrototype(window.HTMLElement.prototype);
}

// Polyfill for ResizeObserver
class ResizeObserverPolyfill {
	observe() {}
	unobserve() {}
	disconnect() {}
}

if (typeof ResizeObserver === "undefined") {
	global.ResizeObserver = ResizeObserverPolyfill;
}
if (typeof window !== "undefined" && !window.ResizeObserver) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(window as unknown as Record<string, unknown>).ResizeObserver =
		ResizeObserverPolyfill;
}
