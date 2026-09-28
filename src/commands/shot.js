// Shot commands: the timeline's shot controls and the Top-View camera rail.
import { createCameraBlock } from "../camera-block.js";
import { addShotAtFrame } from "../cuts.js";
import { studioActionDeclaration } from "../studio-actions.js";
import { changedIds, fail, shotLabel, shotOf } from "./shared.js";

export const declarations = Object.freeze(["shot.create", "shot.split", "shot.duplicate", "shot.remove", "shot.setRange", "shot.setCameraRail", "shot.clearCameraRail", "shot.reorder"].map(studioActionDeclaration));

export function register(registry, ports) {
	const hasShots = state => state.shots.length > 0 || "There are no shots yet; add one with shot.create.";
	const shotAction = (id, available, run) => {
		const { label } = studioActionDeclaration(id);
		registry.register({ ...studioActionDeclaration(id), available, run: args => {
			const before = ports.state().shots;
			run(args);
			const after = ports.state().shots, affectedIds = changedIds(before, after);
			const described = affectedIds.map(shotId => {
				const shot = after.find(row => row.id === shotId);
				return shot ? shotLabel(shot) : `${before.find(row => row.id === shotId)?.name ?? shotId} removed`;
			});
			return { affectedIds, summary: affectedIds.length ? `${label}: ${described.join("; ")}.` : `${label}: nothing changed.` };
		} });
	};
	shotAction("shot.create", state => addShotAtFrame(state.shots, state.frame, state.frameCount, null) !== state.shots
		|| `There is no free room for a new shot at the playhead (frame ${state.frame}); move it with operate_studio { frame } or shorten a shot.`,
	() => ports.addTimelineShot());
	shotAction("shot.split", state => state.shots.some(shot => state.frame > shot.startFrame && state.frame <= shot.endFrame)
		|| `The playhead (frame ${state.frame}) is not inside a shot after its first frame; move it with operate_studio { frame }.`,
	({ shotId }) => {
		const shot = shotOf(ports, shotId), { frame } = ports.state();
		if (frame <= shot.startFrame || frame > shot.endFrame) fail("TARGET_NOT_READY", `The playhead (frame ${frame}) is not inside ${shot.name} after its first frame.`);
		ports.splitTimelineShot(shotId);
	});
	shotAction("shot.duplicate", hasShots, ({ shotId }) => { shotOf(ports, shotId); ports.duplicateTimelineShot(shotId); });
	shotAction("shot.remove", hasShots, ({ shotId }) => { shotOf(ports, shotId); ports.removeTimelineShot(shotId); });
	shotAction("shot.setRange", hasShots, ({ shotId, range }) => { shotOf(ports, shotId); ports.setTimelineShotRange(shotId, range.startFrame, range.endFrameExclusive - 1); });
	shotAction("shot.setCameraRail", hasShots, ({ shotId, points }) => { shotOf(ports, shotId); ports.setShotCameraRail(shotId, points); });
	shotAction("shot.clearCameraRail", state => state.shots.some(shot => createCameraBlock(shot.camera).cameraRail) || "No shot has a camera rail; lay one with shot.setCameraRail.",
		({ shotId }) => { shotOf(ports, shotId); ports.clearShotCameraRail(shotId); });
	shotAction("shot.reorder", hasShots, ({ shotId, startFrame }) => { shotOf(ports, shotId); ports.moveTimelineShot(shotId, startFrame); });
}
