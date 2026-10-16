const separator = " / ";
const shortLength = 8;

/** The model part of a "<connection> / <model>" label (its last path segment), cut to a few characters for the status bar. */
export function shortModelName(label: string) {
	const at = label.lastIndexOf(separator);
	const model = at < 0 ? label : label.slice(at + separator.length);
	const name = model.slice(model.lastIndexOf("/") + 1) || model;
	return name.length > shortLength ? `${name.slice(0, shortLength)}..` : name;
}
