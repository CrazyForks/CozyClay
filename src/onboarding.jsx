import { useEffect, useMemo, useState } from "react";

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

function StepInstructions({ items }) {
	return (
		<ol className="onboarding-instructions">
			{items.map((item) => <li key={item}>{item}</li>)}
		</ol>
	);
}

export default function OnboardingChecklist({
	mode,
	cameraConfigured,
	poseConfigured,
	descriptionConfigured,
	cameraKeyCount,
	pathConfigured = false,
	pathWarning = "",
	hasGenerated,
	hasDelivered,
	canReviewLatest,
	onReview,
	onAction,
}) {
	const [preferences, setPreferences] = useState(loadPreferences);
	const modeLabel = mode === "video" ? "영상" : "이미지";
	const steps = useMemo(() => [
		{
			id: "camera",
			label: "카메라 구도 잡기",
			detail: "왼쪽 계층에서 샷 01을 열고, 오른쪽 샷 종류에서 구도를 고르세요.",
			instructions: [
				"왼쪽 계층에서 ‘샷 01’을 누르세요.",
				"오른쪽 속성의 ‘샷 종류’에서 미디엄·와이드·클로즈업 중 하나를 누르세요.",
				"구도를 더 다듬으려면 왼쪽 계층에서 ‘카메라’를 누른 뒤 ‘렌즈 (FOV)’를 움직이세요.",
			],
			recovery: "카메라가 너무 멀어졌다면 오른쪽 카메라 속성의 ‘피사체 다시 맞추기’를 누르세요.",
			action: "camera",
			actionLabel: "샷 설정 열기",
			done: cameraConfigured,
		},
		{
			id: "pose",
			label: "포즈 고르기",
			detail: "캐릭터를 열고 포즈 드롭다운이나 포즈 스튜디오에서 자세를 고르세요.",
			instructions: [
				"왼쪽 계층에서 ‘캐릭터 1’을 누르세요.",
				"오른쪽 속성의 ‘포즈’ 드롭다운에서 원하는 자세를 고르세요.",
				"더 자세히 고르려면 인물 카드의 포즈 버튼을 눌러 포즈 스튜디오를 열고, 타일을 고른 뒤 ‘포즈 적용’을 누르세요.",
			],
			recovery: "원래대로 돌리려면 포즈 스튜디오에서 ‘포즈 초기화’를 누르세요.",
			action: "pose",
			actionLabel: "포즈 고르기",
			done: poseConfigured,
		},
		{
			id: "describe",
			label: "장면 설명 쓰기",
			detail: "샷의 프롬프트에서 인물·환경·스타일을 내 장면에 맞게 바꾸세요.",
			instructions: [
				"왼쪽 계층에서 ‘샷 01’을 누르세요.",
				"오른쪽 속성의 ‘프롬프트’에서 ‘인물’, ‘환경’, ‘룩 / 스타일’을 찾아 입력하세요.",
				"기본 문장을 그대로 두면 완료되지 않아요. 캐릭터 시트나 환경 시트가 있으면 해당 체크박스를 켜도 됩니다.",
			],
			recovery: "무엇을 써야 할지 모르겠다면 ‘인물은 누구인지 · 어디에 있는지 · 어떤 분위기인지’ 순서로 한 문장만 써 보세요.",
			action: "describe",
			actionLabel: "장면 설정 열기",
			done: descriptionConfigured,
		},
		...(mode === "video" ? [{
			id: "root-path",
			label: "루트 경로 선택",
			detail: "선택 단계예요. 인물이 걸어갈 길이 필요하면 바닥에 루트 경로를 찍으세요.",
			instructions: [
				"왼쪽 계층에서 ‘루트 경로’를 누르고 ‘루트 경로 편집’을 켜세요.",
				"샷 뷰의 세트 바닥을 시작 위치에서 끝 위치 순서로 클릭하세요. 핀 번호가 이동 순서예요.",
				"정확한 타이밍이 필요하면 타임라인의 ‘2D 루트’ 레인에서 먼저 프레임을 고른 뒤 바닥을 클릭하세요.",
				"탑뷰에서 번호 핀을 드래그해 경로를 다듬으세요. 생성된 모션은 이 경로를 대략 따라가며 걷기나 방향 전환은 AI가 자연스럽게 채워요.",
			],
			recovery: pathWarning || "움직임이 필요 없거나 한 자리 연기라면 이 단계는 건너뛰어도 됩니다.",
			action: "root-path",
			actionLabel: "루트 경로 열기",
			done: Boolean(pathConfigured),
			optional: true,
		}] : []),
		...(mode === "video" ? [{
			id: "keys",
			label: "카메라 시작·끝 키 찍기",
			detail: "영상 모드에서는 타임라인 카메라 레인에 시작과 끝 구도를 저장하세요.",
			instructions: [
				"오른쪽 프롬프트의 모드를 ‘영상’으로 바꾸세요.",
				"타임라인의 ‘카메라’ 레인에서 시작 프레임을 클릭해 키를 찍으세요.",
				"재생 헤드를 다른 프레임으로 옮긴 뒤 같은 레인을 한 번 더 클릭하세요. 점을 드래그하면 시간을 바꿀 수 있어요.",
			],
			recovery: "잘못 찍은 점은 카메라 레인의 점에서 오른쪽 클릭하면 삭제할 수 있어요.",
			action: "keys",
			actionLabel: "영상 카메라 열기",
			done: cameraKeyCount >= 2,
		}] : []),
		{
			id: "generate",
			label: "장면 만들기",
			detail: "프롬프트를 확인한 뒤 오른쪽 아래 ‘만들기’를 누르세요.",
			instructions: [
				"왼쪽 계층에서 ‘샷 01’을 누르고 프롬프트 내용을 한 번 확인하세요.",
				"오른쪽 프롬프트 카드 맨 아래의 ‘만들기’를 누르세요.",
				"장면 프레임과 프롬프트가 결과 창에 함께 나타나면 완료예요.",
			],
			recovery: "프레임이 비어 있으면 잠시 기다린 뒤 ‘만들기’를 다시 누르세요.",
			action: "generate",
			actionLabel: "만들기 열기",
			done: hasGenerated,
		},
		{
			id: "deliver",
			label: "AI에 넣기",
			detail: "결과 창에서 프롬프트와 프레임을 챙겨 AI 서비스에 넣으세요.",
			instructions: [
				"결과 창의 ‘프롬프트 복사’를 누르고 AI 서비스 입력창에 붙여 넣으세요.",
				"‘프레임 다운로드’를 눌러 저장한 PNG를 AI 서비스의 이미지 첨부 버튼으로 올리세요.",
				"프롬프트와 이미지를 함께 넣으면 AI가 이 장면의 구도와 분위기를 더 잘 따라와요.",
			],
			recovery: "결과 창을 닫았다면 이 단계의 ‘최근 결과 다시 보기’로 다시 열 수 있어요.",
			action: "deliver",
			actionLabel: canReviewLatest ? "결과 다시 열기" : "결과 창 열기",
			done: hasDelivered,
		},
	], [mode, cameraConfigured, poseConfigured, descriptionConfigured, pathConfigured, pathWarning, cameraKeyCount, hasGenerated, hasDelivered, canReviewLatest]);
	const requiredSteps = steps.filter((step) => !step.optional);
	const doneCount = requiredSteps.filter((step) => step.done).length;
	const allComplete = doneCount === requiredSteps.length;
	const nextStep = steps.find((step) => !step.done && (step.id === "root-path" || !step.optional));

	function updatePreferences(change) {
		setPreferences((current) => {
			const next = { ...current, ...change };
			savePreferences(next);
			return next;
		});
	}

	function resetPreferences() {
		savePreferences(DEFAULT_PREFERENCES);
		window.location.reload();
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
						<small>{doneCount}/{requiredSteps.length}단계 완료</small>
					</span>
				</button>
				<button
					type="button"
					className="onboarding-summary"
					data-onboarding-reset="true"
					onClick={resetPreferences}
					aria-label="처음부터 다시 보기"
				>
					<span className="onboarding-summary-mark" aria-hidden="true">↺</span>
					<span>
						<strong>처음부터 다시 보기</strong>
						<small>안내 초기화</small>
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

	const currentStep = nextStep ?? steps.at(-1);
	return (
		<aside className="onboarding-guide onboarding-guide-coach" aria-labelledby="onboarding-title">
			<header className="onboarding-head">
				<div>
					<span className="onboarding-kicker">처음 장면 · {modeLabel} · 끝까지 따라 하기</span>
					<h2 id="onboarding-title">{allComplete ? "첫 장면을 완성했어요" : "처음 장면을 함께 만들어 볼게요"}</h2>
				</div>
				<div className="onboarding-head-actions">
					<button type="button" onClick={() => updatePreferences({ collapsed: true })} aria-label="첫 장면 안내 접기">−</button>
					<button type="button" onClick={() => updatePreferences({ dismissed: true })} aria-label="첫 장면 안내 닫기">✕</button>
				</div>
			</header>

			<div className="onboarding-progress" aria-live="polite">
				<span>{doneCount}/{requiredSteps.length}단계 완료</span>
				<strong>{Math.round((doneCount / requiredSteps.length) * 100)}%</strong>
			</div>

			<ol className="onboarding-steps" aria-label="첫 장면 만들기 단계">
				{steps.map((step, index) => {
					const current = step.id === currentStep.id;
					return (
						<li key={step.id} className={(step.done ? "done " : "") + (current ? "current" : "")} aria-current={current ? "step" : undefined} data-onboarding-step={step.id} data-onboarding-optional={step.optional ? "true" : undefined}>
							<span className="onboarding-step-mark" aria-hidden="true">{step.done ? "✓" : index + 1}</span>
							<span>
								<strong>{step.label}{step.optional ? " · 선택" : ""}</strong>
								<small>{step.done ? "완료했어요" : step.detail}</small>
							</span>
						</li>
					);
				})}
			</ol>

			<section className="onboarding-coach-card" aria-live="polite" data-onboarding-coach-step={currentStep.id}>
				<div className="onboarding-coach-title">
					<span className="onboarding-coach-label">{currentStep.done ? "다시 확인하기" : "지금 할 일"}</span>
					<strong>{currentStep.label}</strong>
				</div>
				<p className="onboarding-coach-detail">{currentStep.detail}</p>
				<StepInstructions items={currentStep.instructions} />
				<p className="onboarding-recovery"><strong>막히면</strong> {currentStep.recovery}</p>
			<button type="button" className="onboarding-action" data-guide-action={currentStep.action} data-onboarding-action={currentStep.action} onClick={() => {
					if (currentStep.action === "deliver" && canReviewLatest) onReview();
					else onAction?.(currentStep.action);
				}}>
					{currentStep.action === "generate" ? "만들기 버튼 위치 보기" : currentStep.actionLabel}
				</button>
			</section>

			{canReviewLatest && (
				<button type="button" className="onboarding-review" onClick={onReview}>
					최근 결과 다시 보기
				</button>
			)}
			<button type="button" className="onboarding-review" data-onboarding-reset="true" onClick={resetPreferences}>
				처음부터 다시 보기
			</button>
		</aside>
	);
}
