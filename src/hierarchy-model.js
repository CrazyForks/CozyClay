// The Hierarchy lists what EXISTS in the 3D scene — camera, characters
// (with their rig groups, which have viewport handles), environment, props.
// Workflow surfaces (shot settings, prompt, ARDY motion, prompt blocks,
// root path, IK keys) are NOT scene entities: they live in the right
// sidebar's Shot and Motion tabs, keyed by `sidebarTab` in App.jsx.
export const HIERARCHY_NODES = [
	{
		// Keep the legacy selection id until App wiring moves to the document
		// model; its visible role is a Scene, never an editorial Shot.
		id: "shot",
		label: "SCENE 01",
		kind: "scene",
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
									{
										id: "rig.torso",
										label: "Torso",
										kind: "rig",
										children: [
											{ id: "rig.hips", label: "Root / Hips", kind: "bone" },
											{ id: "rig.spine", label: "Spine", kind: "bone" },
											{ id: "rig.chest", label: "Chest", kind: "bone" },
											{ id: "rig.neck", label: "Neck", kind: "bone" },
											{ id: "rig.head", label: "Head", kind: "bone" },
										],
									},
									{
										id: "rig.leftArm",
										label: "Left Arm",
										kind: "rig",
										children: [
											{ id: "rig.leftShoulder", label: "Left Shoulder", kind: "bone" },
											{ id: "rig.leftElbow", label: "Left Elbow", kind: "bone" },
											{ id: "rig.leftHand", label: "Left Hand", kind: "bone" },
										],
									},
									{
										id: "rig.rightArm",
										label: "Right Arm",
										kind: "rig",
										children: [
											{ id: "rig.rightShoulder", label: "Right Shoulder", kind: "bone" },
											{ id: "rig.rightElbow", label: "Right Elbow", kind: "bone" },
											{ id: "rig.rightHand", label: "Right Hand", kind: "bone" },
										],
									},
									{
										id: "rig.leftLeg",
										label: "Left Leg",
										kind: "rig",
										children: [
											{ id: "rig.leftKnee", label: "Left Knee", kind: "bone" },
											{ id: "rig.leftFoot", label: "Left Foot", kind: "bone" },
										],
									},
									{
										id: "rig.rightLeg",
										label: "Right Leg",
										kind: "rig",
										children: [
											{ id: "rig.rightKnee", label: "Right Knee", kind: "bone" },
											{ id: "rig.rightFoot", label: "Right Foot", kind: "bone" },
										],
									},
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
