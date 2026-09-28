import Foldout from "./Foldout.jsx";
import { ko } from "../locale.js";
import { Vector3Row, Slider } from "../ui.jsx";

export default function CharacterTransformPanel({ workflowMode, isCharacterSelection, activeChar, changeInspectorCharacter, beginGestureUndo, endGestureUndo }) {
	return (
<Foldout
					key={workflowMode === "motion" ? "placement" : "transform"}
					hidden={!isCharacterSelection}
					defaultOpen={workflowMode === "motion"}
					title={workflowMode === "motion" ? ko("Placement", "배치") : ko("Transform", "변환")}
				>
					{workflowMode === "motion" ? (
						<div className="placement-fields">
							<p className="inspector-hint">
								{ko("Stage position — does not change the take", "무대 위치 — 테이크는 바꾸지 않습니다")}
							</p>
							<Vector3Row
								label={ko("Position", "위치")}
								fields={[
									{ axis: "X", value: activeChar.x, step: 0.05, precision: 2, scrubRange: 5, onChange: (x) => changeInspectorCharacter("x", { x }), onScrubStart: () => beginGestureUndo(`character:${activeChar.id}:x`), onScrubEnd: endGestureUndo },
									{ axis: "Z", value: activeChar.z, step: 0.05, precision: 2, scrubRange: 5, onChange: (z) => changeInspectorCharacter("z", { z }), onScrubStart: () => beginGestureUndo(`character:${activeChar.id}:z`), onScrubEnd: endGestureUndo },
								]}
							/>
							<Slider compact label={ko("Rotation", "회전")} min={-180} max={180} step={1} value={activeChar.rot ?? 0} unit="°" onChange={(rot) => changeInspectorCharacter("rot", { rot })} />
						</div>
					) : (
						<>
							<p className="inspector-hint">
								{ko("Edit the selected subject's placement, turn and size. Drag the Transform tool in the viewport for direct manipulation.", "선택한 인물의 위치·회전·크기를 편집합니다. 뷰포트의 변환 도구를 드래그해 바로 조작할 수도 있어요.")}
							</p>
							<Vector3Row
								label={ko("Position", "위치")}
								fields={[
									{ axis: "X", value: activeChar.x, step: 0.05, precision: 2, scrubRange: 5, onChange: (x) => changeInspectorCharacter("x", { x }), onScrubStart: () => beginGestureUndo(`character:${activeChar.id}:x`), onScrubEnd: endGestureUndo },
									{ axis: "Y", value: activeChar.y ?? 0, step: 0.05, precision: 2, scrubRange: 5, onChange: (y) => changeInspectorCharacter("y", { y: Math.max(0, y) }), onScrubStart: () => beginGestureUndo(`character:${activeChar.id}:y`), onScrubEnd: endGestureUndo },
									{ axis: "Z", value: activeChar.z, step: 0.05, precision: 2, scrubRange: 5, onChange: (z) => changeInspectorCharacter("z", { z }), onScrubStart: () => beginGestureUndo(`character:${activeChar.id}:z`), onScrubEnd: endGestureUndo },
								]}
							/>
							<Slider compact label={ko("Rotation", "회전")} min={-180} max={180} step={1} value={activeChar.rot ?? 0} unit="°" onChange={(rot) => changeInspectorCharacter("rot", { rot })} />
							<Slider compact label={ko("Scale", "크기")} min={0.2} max={3} step={0.05} value={activeChar.scale ?? 1} unit="×" onChange={(scale) => changeInspectorCharacter("scale", { scale })} />
						</>
					)}
				</Foldout>
	);
}
