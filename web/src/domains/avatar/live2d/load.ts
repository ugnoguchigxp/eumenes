let loading: Promise<void> | undefined;
/** The official Core is a classic script. One copy serves successive mounts. */
export function loadCubismCore(): Promise<void> {
	return (loading ??= new Promise<void>((resolve, reject) => {
		const script = document.createElement("script");
		script.src = "/live2d/live2dcubismcore.min.js";
		script.onload = () => resolve();
		script.onerror = () => {
			script.remove();
			loading = undefined;
			reject(new Error("avatar_core_unavailable"));
		};
		document.head.append(script);
	}));
}
