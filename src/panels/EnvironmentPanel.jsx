import { ko } from "../locale.js";
import Foldout from "./Foldout.jsx";
import { Field } from "../ui.jsx";
import ReferenceImageField from "./ReferenceImageField.jsx";

export default function EnvironmentPanel(props) {
	return (
<Foldout hidden={props.selectedHierarchyId !== "environment"} title={ko("Environment", "환경")}>
						<label className="check">
							<input type="checkbox" checked={props.hasEnvSheet} onChange={(event) => { props.recordCharacterUndo(); props.setHasEnvSheet(event.target.checked); }} />
						<span>{ko("I have an environment sheet", "환경 시트가 있어요")}</span>
						</label>
						{!props.hasEnvSheet && (
						<Field label={ko("Environment description", "환경 설명")}>
								<input type="text" value={props.environment} onChange={(event) => { props.recordSessionUndo(props.environmentTextSessionRef, "environment:description"); props.setEnvironment(event.target.value); }} />
							</Field>
						)}
					<Field label={ko("Look / style", "룩 / 스타일")}>
							<input type="text" value={props.style} onChange={(event) => { props.recordSessionUndo(props.environmentTextSessionRef, "environment:style"); props.setStyle(event.target.value); }} />
						</Field>
						<ReferenceImageField
							label={ko("Environment reference", "환경 참고 이미지")}
							hint={ko(
								"A picture of this location. It travels with every framing capture so a render takes its materials, palette and lighting from the real place.",
								"이 장소의 사진입니다. 모든 프레이밍 캐프처에 함께 실려 재질·색감·조명을 실제 장소에서 가져옵니다.",
							)}
							value={props.environmentImage}
							alt={ko("Environment reference", "환경 참고 이미지")}
							inputProps={{ "data-environment-image-input": "" }}
							onPick={(dataUrl) => {
								props.changeEnvironmentImage(dataUrl);
								props.setToast(ko("Environment reference set", "환경 참고 이미지를 설정했어요"));
							}}
							onClear={() => props.changeEnvironmentImage(null)}
						/>
					</Foldout>
	);
}
