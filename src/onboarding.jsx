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
	const steps = [
		{
			id: "camera",
			label: "Set the camera",
			detail: "Choose a shot preset or move the shot camera.",
			done: cameraConfigured,
		},
		{
			id: "pose",
			label: "Choose a pose",
			detail: "Select the body pose your subject should hold.",
			done: poseConfigured,
		},
		{
			id: "describe",
			label: "Describe the scene",
			detail: "Edit the subject or environment description.",
			done: descriptionConfigured,
		},
		...(mode === "video"
			? [{
				id: "keys",
				label: "Key the camera move",
				detail: cameraKeyCount === 1
					? "Add one more key on the Camera timeline lane."
					: "Add start and end keys on the Camera timeline lane.",
				done: cameraKeyCount >= 2,
			}]
			: []),
		{
			id: "generate",
			label: "Generate the shot",
			detail: "Generate builds the frame and copies the prompt for you.",
			done: hasGenerated,
		},
		{
			id: "deliver",
			label: "Take it to your AI",
			detail: mode === "video"
				? "Copy the prompt or download the conditioning frames."
				: "Copy the prompt or download the blocking frame.",
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
			<aside className="onboarding-guide onboarding-guide-collapsed" aria-label="First shot guide">
				<button
					type="button"
					className="onboarding-summary"
					onClick={() => updatePreferences({ collapsed: false })}
					aria-label="Expand first shot guide"
				>
					<span className="onboarding-summary-mark" aria-hidden="true">{allComplete ? "✓" : "→"}</span>
					<span>
						<strong>{allComplete ? "First shot complete" : `Next: ${nextStep.label}`}</strong>
						<small>{doneCount}/{steps.length} steps</small>
					</span>
				</button>
				<button
					type="button"
					className="onboarding-dismiss"
					onClick={() => updatePreferences({ dismissed: true })}
					aria-label="Dismiss first shot guide"
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
					<span className="onboarding-kicker">First shot · {mode}</span>
					<h2 id="onboarding-title">Build it in this order</h2>
				</div>
				<div className="onboarding-head-actions">
					<button type="button" onClick={() => updatePreferences({ collapsed: true })} aria-label="Collapse first shot guide">
						−
					</button>
					<button type="button" onClick={() => updatePreferences({ dismissed: true })} aria-label="Dismiss first shot guide">
						✕
					</button>
				</div>
			</header>

			<div className="onboarding-progress" aria-live="polite">
				<span>{doneCount} of {steps.length} complete</span>
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
					Review the latest export
				</button>
			)}
		</aside>
	);
}
