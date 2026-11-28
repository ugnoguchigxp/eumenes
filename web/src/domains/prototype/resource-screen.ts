export const worksId = /^[a-f0-9-]{36}$/;
let selected: string | null = null;
export const worksScreen = {
	async focus(id: string) {
		if (!worksId.test(id)) return false;
		selected = id;
		window.location.hash = "works/" + id;
		return true;
	},
	viewing: () => (selected ? "eumenes://prototype/" + selected : null),
	clear: () => {
		selected = null;
	},
};
