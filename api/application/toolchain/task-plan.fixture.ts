/** Scripted model plans for integration fixtures; production must obtain these from the model. */
export const taskPlan = (...requests: string[]) => ({
	name: "set_plan",
	arguments: {
		expectedPlanRevision: 0,
		items: requests.map((request, index) => ({
			request,
			dependsOn: index ? [index - 1] : [],
		})),
	},
});
export const taskItem = (
	packet: { plan: { items: Array<{ stepRef: string }> } },
	index = 0,
) => packet.plan.items[index]!.stepRef;
