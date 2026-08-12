import { useEffect, useState } from "react";

const ONBOARDING_STORAGE_KEY = "cozyclay.onboarding.v1";
const DEFAULT_PREFERENCES = { collapsed: false, dismissed: false, completed: false };

function loadPreferences() {
	try {
		const saved = JSON.parse(localStorage.getItem(ONBOARDING_STORAGE_KEY));
		return {
			collapsed: saved?.collapsed === true,
			dismissed: saved?.dismissed === true,
			completed: saved?.completed === true,
		};
	} catch {
		return DEFAULT_PREFERENCES;
	}
}

function savePreferences(preferences) {
	try {
		localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(preferences));
		return true;
	} catch {
		return false;
	}
}

export default function OnboardingChecklist({
	mode,
	cameraConfigured,
	poseConfigured,
	descriptionConfigured,
	cameraKeyCount,
	hasGenerated,
	hasDelivered,
	canReviewLatest,
	onReview,
}) {
	const [preferences, setPreferences] = useState(loadPreferences);
	const modeLabel = mode === "video" ? "영상" : "이미지";
	const steps = [
		{
			id: "camera",
			label: "카메라 설정",
			detail: "샷 프리셋을 고르거나 카메라를 직접 움직여 보세요.",
			done: cameraConfigured,
		},
		{
			id: "pose",
			label: "포즈 선택",
			detail: "인물이 취할 포즈를 골라 보세요.",
			done: poseConfigured,
		},
		{
			id: "describe",
			label: "장면 설명",
			detail: "인물이나 환경 설명을 원하는 내용으로 바꿔 보세요.",
			done: descriptionConfigured,
		},
		...(mode === "video"
			? [{
				id: "keys",
				label: "카메라 움직임 키 찍기",
				detail: cameraKeyCount === 1
					? "카메라 타임라인에 키를 하나 더 추가하세요."
					: "카메라 타임라인에 시작 키와 끝 키를 추가하세요.",
				done: cameraKeyCount >= 2,
			}]
			: []),
		{
			id: "generate",
			label: "장면 만들기",
			detail: "만들기를 누르면 프레임을 만들고 프롬프트도 자동으로 복사해요.",
			done: hasGenerated,
		},
		{
			id: "deliver",
			label: "AI로 가져가기",
			detail: mode === "video"
				? "프롬프트를 복사하거나 참고용 시작·끝 프레임을 내려받으세요."
				: "프롬프트를 복사하거나 블로킹 프레임을 내려받으세요.",
			done: hasDelivered,
		},
	];
	const doneCount = steps.filter((step) => step.done).length;
	const allComplete = doneCount === steps.length;
	const nextStep = steps.find((step) => !step.done);

	function updatePreferences(change) {
		setPreferences((current) => {
			const next = { ...current, ...change };
			savePreferences(next);
			return next;
		});
	}

	useEffect(() => {
		if (!allComplete || preferences.completed) return;
		setPreferences((current) => {
			if (current.completed) return current;
			const next = { ...current, collapsed: true, completed: true };
			savePreferences(next);
			return next;
		});
	}, [allComplete, preferences.completed]);

	if (preferences.dismissed) return null;

	if (preferences.collapsed) {
		return (
			<aside className="onboarding-guide onboarding-guide-collapsed" aria-label="첫 장면 안내">
				<button
					type="button"
					className="onboarding-summary"
					onClick={() => updatePreferences({ collapsed: false })}
					aria-label="첫 장면 안내 펼치기"
				>
					<span className="onboarding-summary-mark" aria-hidden="true">{allComplete ? "✓" : "→"}</span>
					<span>
						<strong>{allComplete ? "첫 장면 완성" : `다음: ${nextStep.label}`}</strong>
						<small>{doneCount}/{steps.length}단계 완료</small>
					</span>
				</button>
				<button
					type="button"
					className="onboarding-dismiss"
					onClick={() => updatePreferences({ dismissed: true })}
					aria-label="첫 장면 안내 닫기"
				>
					✕
				</button>
			</aside>
		);
	}

	return (
		<aside className="onboarding-guide" aria-labelledby="onboarding-title">
			<header className="onboarding-head">
				<div>
					<span className="onboarding-kicker">첫 장면 · {modeLabel}</span>
					<h2 id="onboarding-title">이 순서대로 만들어 보세요</h2>
				</div>
				<div className="onboarding-head-actions">
					<button type="button" onClick={() => updatePreferences({ collapsed: true })} aria-label="첫 장면 안내 접기">
						−
					</button>
					<button type="button" onClick={() => updatePreferences({ dismissed: true })} aria-label="첫 장면 안내 닫기">
						✕
					</button>
				</div>
			</header>

			<div className="onboarding-progress" aria-live="polite">
				<span>{doneCount}/{steps.length}단계 완료</span>
				<strong>{Math.round((doneCount / steps.length) * 100)}%</strong>
			</div>

			<ol className="onboarding-steps">
				{steps.map((step, index) => {
					const current = step === nextStep;
					return (
						<li key={step.id} className={(step.done ? "done" : "") + (current ? " current" : "")} aria-current={current ? "step" : undefined}>
							<span className="onboarding-step-mark" aria-hidden="true">{step.done ? "✓" : index + 1}</span>
							<span>
								<strong>{step.label}</strong>
								<small>{step.detail}</small>
							</span>
						</li>
					);
				})}
			</ol>

			{canReviewLatest && (
				<button type="button" className="onboarding-review" onClick={onReview}>
					최근 결과 다시 보기
				</button>
			)}
		</aside>
	);
}
