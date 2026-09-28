// Cast commands: a named character's root waypoints and IK key layer. They
// name their character explicitly, so they run the same way whichever
// character is active and whatever mode the editor is in.
import { STUDIO_IK_CHAIN_TRACKS, studioActionDeclaration } from "../studio-actions.js";
import { characterOf, fail } from "./shared.js";

export const declarations = Object.freeze(["character.addWaypoint", "character.moveWaypoint", "character.removeWaypoint", "character.clearWaypoints", "character.setIkKey", "character.removeIkKey", "character.clearIkKeys"].map(studioActionDeclaration));

export function register(registry, ports) {
	const castAction = (id, run) => registry.register({ ...studioActionDeclaration(id),
		available: state => state.characters.length > 0 || "There are no characters in this scene; add one with arrange_characters.",
		run: args => {
			const character = characterOf(ports, args.characterId);
			return { affectedIds: [character.id], summary: run(args, character.subject || character.id) };
		} });
	const pin = waypoint => `frame ${waypoint.frame} (x ${waypoint.x}, z ${waypoint.z})`;
	const warned = warnings => warnings.length ? `; warning: ${warnings[0]}` : "";
	castAction("character.addWaypoint", ({ characterId, position, frame }, name) => {
		const { waypoint, index, warnings } = ports.addCharacterWaypoint(characterId, position, frame ?? null);
		ports.setWaypointMode(true);
		return `Added ${name}'s root waypoint ${index + 1} at ${pin(waypoint)}${warned(warnings)}.`;
	});
	castAction("character.moveWaypoint", ({ characterId, frame, position }, name) => {
		const { waypoint, warnings } = ports.moveCharacterWaypoint(characterId, frame, position);
		ports.setWaypointMode(true);
		return `Moved ${name}'s root waypoint to ${pin(waypoint)}${warned(warnings)}.`;
	});
	castAction("character.removeWaypoint", ({ characterId, frame }, name) => {
		ports.removeCharacterWaypoint(characterId, frame);
		return `Removed ${name}'s root waypoint at frame ${frame}.`;
	});
	castAction("character.clearWaypoints", ({ characterId }, name) => {
		const count = ports.clearCharacterWaypoints(characterId);
		return count ? `Cleared ${name}'s root path (${count} waypoint${count === 1 ? "" : "s"}).` : `${name} has no root waypoints; nothing changed.`;
	});
	// The declared schema carries the key's shape; the per-track counts and the
	// timeline bound are checked here, before anything is recorded.
	castAction("character.setIkKey", ({ characterId, frame, tracks }, name) => {
		const { frameCount } = ports.state(), named = Object.keys(tracks);
		if (frame >= frameCount) fail("INVALID_RANGE", `Frame ${frame} is outside the timeline (0-${frameCount - 1}).`);
		if (!named.length) fail("INVALID_ARGUMENT", "Name at least one track in tracks.");
		for (const track of named) {
			const key = tracks[track], chain = STUDIO_IK_CHAIN_TRACKS.includes(track), bones = chain ? 3 : 1;
			if (!key.q && !key.p) fail("INVALID_ARGUMENT", `tracks.${track} needs q (bone rotations) or p (a local position).`);
			if (key.chainP && !chain) fail("INVALID_ARGUMENT", `tracks.${track}.chainP is for chain tracks only.`);
			for (const field of ["q", "baseQ", "chainP"]) {
				if (key[field] && key[field].length !== bones) fail("INVALID_ARGUMENT", `tracks.${track}.${field} needs ${bones} entr${bones === 1 ? "y" : "ies"}, one per bone.`);
			}
			if ([...(key.q ?? []), ...(key.baseQ ?? [])].some(q => Math.hypot(q.x, q.y, q.z, q.w) < 1e-6)) fail("INVALID_ARGUMENT", `tracks.${track} has a zero-length quaternion.`);
		}
		ports.setCharacterIkKey(characterId, frame, tracks);
		return `Keyed ${name}'s IK layer at frame ${frame}: ${named.join(", ")}.`;
	});
	castAction("character.removeIkKey", ({ characterId, frame }, name) => {
		ports.removeCharacterIkKey(characterId, frame);
		return `Deleted ${name}'s IK key at frame ${frame}.`;
	});
	castAction("character.clearIkKeys", ({ characterId }, name) => {
		const count = ports.clearCharacterIkKeys(characterId);
		return count ? `Cleared ${name}'s IK layer (${count} key${count === 1 ? "" : "s"}).` : `${name} has no IK keys; nothing changed.`;
	});
}
