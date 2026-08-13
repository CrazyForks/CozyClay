// The Hierarchy lists what EXISTS in the 3D scene — camera, characters
// (with their rig groups, which have viewport handles), environment, props.
// Workflow surfaces (shot settings, prompt, ARDY motion, prompt blocks,
// root path, IK keys) are NOT scene entities: they live in the right
// sidebar's Shot and Motion tabs, keyed by `sidebarTab` in App.jsx.
export const HIERARCHY_NODES = [
	{
		id: "shot",
		label: "SHOT 01",
		kind: "shot",
		children: [
			{ id: "camera", label: "Camera", kind: "camera" },
			{
				id: "characters",
				label: "Characters",
				kind: "group",
				children: [
					{
						id: "characterA",
						label: "Character 1",
						kind: "character",
						children: [
							{
								id: "characterA.rig",
								label: "Rig",
								kind: "rig",
								children: [
									{ id: "rig.hips", label: "Root / Hips", kind: "bone" },
									{ id: "rig.spine", label: "Spine", kind: "bone" },
									{ id: "rig.leftArm", label: "Left Arm", kind: "bone" },
									{ id: "rig.rightArm", label: "Right Arm", kind: "bone" },
									{ id: "rig.leftLeg", label: "Left Leg", kind: "bone" },
									{ id: "rig.rightLeg", label: "Right Leg", kind: "bone" },
								],
							},
						],
					},
					{
						id: "characterB",
						label: "Character 2",
						kind: "character",
						optional: "showB",
					},
				],
			},
			{ id: "environment", label: "Environment", kind: "environment" },
			{ id: "props", label: "Props", kind: "props" },
		],
	},
];

export function buildHierarchyNodes(sceneObjects = []) {
	const clone = (node) => {
		const next = { ...node };
		if (node.id === "props") {
			next.children = sceneObjects.map((object) => ({
				id: `object:${object.id}`,
				label: object.name,
				kind: "object",
			}));
		} else if (node.children) {
			next.children = node.children.map(clone);
		}
		return next;
	};
	return HIERARCHY_NODES.map(clone);
}
