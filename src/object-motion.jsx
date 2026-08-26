/**
 * The prop motion panel — object animation on its own surface.
 *
 * The Animation strip belongs to the performer and the camera: prompt blocks,
 * the full-body lane, the 2D root and the shot cuts. A prop's travel is a
 * different subject on the same clock, and stacking it into those lanes made
 * every row ambiguous. So it lives here instead, with nothing on screen that
 * belongs to the character or the camera, and the Animation tab goes back to
 * being exactly what its name says.
 */
import { useMemo, useRef } from "react";
import { ko } from "./locale.js";
import { pathMetrics } from "./object-path.js";

/** Frames the object is actually travelling for, given its speed. */
function travelSpan(path, frameCount, fps) {
	if (!path) return null;
	const metrics = pathMetrics(path);
	if (!metrics || metrics.length <= 0) return null;
	// Speed 0 means "fill the take", which is the path's default timing.
	if (!path.speed) return { start: 0, end: Math.max(1, frameCount - 1), fills: true };
	const frames = (metrics.length / path.speed) * fps;
	return { start: 0, end: Math.min(Math.max(1, frameCount - 1), Math.round(frames)), fills: false };
}

export function ObjectMotionPanel({
	object,
	frame,
	frameCount,
	fps,
	pathDraw,
	onScrub,
	onPathDrawToggle,
	onPathChange,
	onPathClear,
}) {
	const laneRef = useRef(null);
	const path = object?.path ?? null;
	const span = useMemo(() => travelSpan(path, frameCount, fps), [path, frameCount, fps]);
	const metrics = useMemo(() => (path ? pathMetrics(path) : null), [path]);

	if (!object) {
		return (
			<div className="objmo-empty">
				<p>{ko("Pick a prop in the scene to route it.", "세트의 소품을 고르면 이동 경로를 만들 수 있어요.")}</p>
				<p className="objmo-empty-sub">
					{ko(
						"Props travel on their own track. The character's prompts and the camera's shots stay in Animation.",
						"소품은 자기 트랙에서 움직입니다. 캐릭터 프롬프트와 카메라 샷은 애니메이션 탭에 그대로 있어요.",
					)}
				</p>
			</div>
		);
	}

	const patch = (change) => onPathChange?.({ ...path, ...change });
	const scrubTo = (event) => {
		const lane = laneRef.current;
		if (!lane || !onScrub) return;
		const rect = lane.getBoundingClientRect();
		if (rect.width < 2) return;
		const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
		onScrub(Math.round(ratio * (frameCount - 1)));
	};

	return (
		<div className="objmo">
			<header className="objmo-head">
				<span className="tl-subject-kind">{ko("PROP", "소품")}</span>
				<strong className="objmo-name">{object.name}</strong>
				<button
					type="button"
					className={"tl-camera-tool" + (pathDraw ? " active" : "")}
					onClick={() => onPathDrawToggle?.()}
				>
					{pathDraw ? ko("Drawing…", "그리는 중…") : path ? ko("Redraw path", "경로 다시 그리기") : ko("Draw path", "경로 그리기")}
				</button>
				{path && (
					<>
						<label title={ko("Metres per second; 0 spreads the route across the whole take", "초당 미터; 0이면 전체 길이에 맞춰 이동합니다")}>
							<span>{ko("Speed", "속도")}</span>
							<input
								type="range"
								min={0}
								max={20}
								step={0.1}
								value={path.speed ?? 0}
								onChange={(event) => patch({ speed: Number(event.currentTarget.value) })}
							/>
							<output className="tl-camera-metric">
								{(path.speed ?? 0) === 0 ? ko("take", "전체") : `${Number(path.speed).toFixed(1)} m/s`}
							</output>
						</label>
						<button
							type="button"
							className={"tl-camera-tool" + (path.faceTravel ? " active" : "")}
							aria-pressed={!!path.faceTravel}
							title={ko("Turn to face the direction of travel", "진행 방향을 바라보게 합니다")}
							onClick={() => patch({ faceTravel: !path.faceTravel })}
						>
							{path.faceTravel ? ko("Faces travel", "진행 방향 봄") : ko("Fixed facing", "방향 고정")}
						</button>
						<button
							type="button"
							className={"tl-camera-tool" + (path.extend ? " active" : "")}
							aria-pressed={!!path.extend}
							title={ko("Keep going in the last direction after the route ends", "경로가 끝나도 마지막 방향으로 계속 갑니다")}
							onClick={() => patch({ extend: !path.extend })}
						>
							{ko("Keep going", "계속 가기")}
						</button>
						<button
							type="button"
							className={"tl-camera-tool" + (path.loop ? " active" : "")}
							aria-pressed={!!path.loop}
							onClick={() => patch({ loop: !path.loop })}
						>
							{ko("Loop", "반복")}
						</button>
						<button
							type="button"
							className="tl-camera-tool danger"
							title={ko("Delete this route; the object stands still again", "경로를 지웁니다. 오브젝트는 다시 제자리에 섭니다")}
							onClick={() => onPathClear?.()}
						>
							{ko("Delete path", "경로 삭제")}
						</button>
					</>
				)}
			</header>

			{!path ? (
				<p className="objmo-hint">
					{ko(
						"Draw a route on the Top-View map. Then double-click the line to add a point, and drag a point in the scene to lift it.",
						"위에서 본 지도에 경로를 그리세요. 그다음 선을 더블클릭하면 점이 추가되고, 씬에서 점을 끌면 높이가 올라갑니다.",
					)}
				</p>
			) : (
				<>
					<p className="objmo-hint">
						{ko(
							`${metrics.length.toFixed(1)} m · ${path.points.length} points · double-click the line to add one · Delete removes the selected one`,
							`${metrics.length.toFixed(1)} m · 점 ${path.points.length}개 · 선을 더블클릭하면 점 추가 · 점 선택 후 Delete로 삭제`,
						)}
					</p>
					<div className="objmo-lane-row">
						<span className="objmo-lane-label">{ko("Travel", "이동")}</span>
						<div
							className="objmo-lane"
							ref={laneRef}
							role="slider"
							tabIndex={0}
							aria-label={ko("Scrub the take", "타임라인 탐색")}
							aria-valuemin={0}
							aria-valuemax={Math.max(0, frameCount - 1)}
							aria-valuenow={frame}
							onPointerDown={(event) => {
								// Scrub first: capture is a nicety for the drag that follows,
								// and a refused capture must not swallow the press itself.
								scrubTo(event);
								try {
									event.currentTarget.setPointerCapture?.(event.pointerId);
								} catch {
									/* a pointer that is already gone needs no capture */
								}
							}}
							onPointerMove={(event) => {
								if (event.buttons !== 1) return;
								scrubTo(event);
							}}
						>
							{span && (
								<div
									className={"objmo-travel" + (span.fills ? " fills" : "")}
									style={{
										left: `${(span.start / Math.max(1, frameCount - 1)) * 100}%`,
										width: `${((span.end - span.start) / Math.max(1, frameCount - 1)) * 100}%`,
									}}
								>
									{path.loop ? ko("loops", "반복") : path.extend ? ko("keeps going", "계속 감") : ko("travels", "이동")}
								</div>
							)}
							<div className="objmo-playhead" style={{ left: `${(frame / Math.max(1, frameCount - 1)) * 100}%` }} />
						</div>
					</div>
				</>
			)}
		</div>
	);
}
