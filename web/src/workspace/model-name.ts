const separator = " / ";
const shortLength = 8;

/** The model part of a "<connection> / <model>" label, cut to a few characters for the status bar. */
export function shortModelName(label: string) {
	const at = label.lastIndexOf(separator);
	const model = at < 0 ? label : label.slice(at + separator.length);
	return model.length > shortLength
		? `${model.slice(0, shortLength)}..`
		: model;
}
