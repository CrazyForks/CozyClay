import React, { useSyncExternalStore } from "react";
import "./platform-fit-panel.css";

const FOOT_NAMES = {
	leftFoot: ["Left foot", "왼발"],
	rightFoot: ["Right foot", "오른발"],
};

function stepLabel(step, ko) {
	if (step.status === "wall") return `${ko("Wall", "벽")} · F${step.start}`;
	const [en, kr] = FOOT_NAMES[step.foot] ?? [step.foot, step.foot];
	const foot = ko(en, kr);
	const amount = step.lift !== 0 ? step.lift : step.rise;
	const height = `${amount >= 0 ? "+" : ""}${Math.round(amount * 100)}cm`;
	return `${foot} F${step.start}–F${step.end} · ${height}`;
}

function stepHint(status, ko) {
	return status === "tooHigh" || status === "wall"
		? ko("Too high to step. Change the path, stop before it, or regenerate a climb.", "걸어서 못 올라가요. 경로를 바꾸거나, 앞에서 멈추거나, 오르는 동작을 새로 생성하세요.")
		: "";
}

export function PlatformFitPanel({ ko, disabled, running, progress: progressStore, last, applied, onRun, onRemove, onFrame }) {
	const progress = useSyncExternalStore(progressStore.subscribe, progressStore.getSnapshot);
	const steps = last?.steps.filter((step) => step.lift !== 0 || step.status !== "ok") ?? [];
	return (
		<section className="platform-fit auto-fix-card" data-testid="platform-fit-panel" aria-label={ko("Fit to platforms", "발판에 맞추기")}>
			<div className="auto-fix-card-head">
				<h4>{ko("Fit to platforms", "발판에 맞추기")}</h4>
				<p
					className="inspector-hint"
					title={ko("Lifts feet onto boxes and steps in the path and raises the body. Undo restores the original.", "경로에 있는 상자·계단 위로 발을 올리고 몸 높이를 맞춰요. 실행 취소로 원본 복구.")}
				>
					{ko("Raise the feet and body to platforms in the path.", "경로의 발판에 맞춰 발과 몸을 올립니다.")}
				</p>
			</div>
			<button
				type="button"
				data-testid="platform-fit-run"
				className="btn full primary"
				disabled={disabled || running}
				onClick={onRun}
			>
				{running ? ko(`Fitting ${progress}%`, `맞추는 중 ${progress}%`) : ko("Fit to platforms", "발판에 맞추기")}
			</button>
			{applied && (
				<button
					type="button"
					data-testid="platform-fit-remove"
					className="btn full"
					disabled={disabled || running}
					onClick={onRemove}
				>
					{ko("Remove platform fit", "발판 맞춤 제거")}
				</button>
			)}
			{running && <progress max="100" value={progress} aria-label={ko("Platform fit progress", "발판 맞춤 진행률")} />}
			{last && (
				<div data-testid="platform-fit-results" className="auto-fix-result">
					<ul className="platform-fit-results">
						{steps.map((step) => {
							const label = stepLabel(step, ko);
							const hint = stepHint(step.status, ko);
							return (
								<li key={step.id}>
									<button
										type="button"
										className="btn platform-fit-step"
										data-status={step.status}
										onClick={() => onFrame(step.start)}
										aria-label={label}
										title={hint || undefined}
									>
										<span className="platform-fit-chip" aria-hidden="true" />
										<span>{label}</span>
									</button>
								</li>
							);
						})}
					</ul>
					{steps.length === 0 && <p className="inspector-hint">{ko("No platforms in the path.", "경로에 발판이 없어요.")}</p>}
				</div>
			)}
		</section>
	);
}
