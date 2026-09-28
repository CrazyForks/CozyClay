import Foldout from "./Foldout.jsx";
import { ko } from "../locale.js";
import { defaultCharacterTint } from "../app-stage.jsx";
import SubjectBox from "./SubjectBox.jsx";

export default function SubjectsPanel({
	isCharacterSelection, showB, characters, updateCharacterAt, openStudio, posing, removeCharacter,
	recordSessionUndo, tintSessionRef, setShowB,
}) {
	return (
<Foldout hidden={!isCharacterSelection} title={showB ? ko("Subjects", "인물들") : ko("Subject", "인물")}>
						<div className={"subjects-row" + (showB ? "" : " single")}>
							{characters.map((entry, index) => entry.hidden ? null : (
								<SubjectBox
									key={entry.id}
									label={ko(`Subject ${index + 1}`, `인물 ${index + 1}`)}
									value={entry}
									onChange={(next) => updateCharacterAt(index, next)}
									onPose={() => openStudio(entry.id)}
									posing={posing === entry.id}
									onRemove={index > 0 ? () => removeCharacter(entry.id) : undefined}
									color={entry.tint ?? defaultCharacterTint(entry, index)}
									/* A colour picker streams values while it is open, so the
									   whole picking session is one Ctrl+Z entry. */
									onColorEditStart={() => recordSessionUndo(tintSessionRef, `tint:${entry.id}`)}
									onColorChange={(tint) => updateCharacterAt(index, { tint })}
								/>
							))}
						</div>
						{!showB && (
							<button type="button" className="add-subject" onClick={() => setShowB(true)}>
								<span className="as-plus">＋</span>
								<span>{ko("Add second subject", "두 번째 인물 추가")}</span>
							</button>
						)}
					</Foldout>
	);
}
