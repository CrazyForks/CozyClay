#!/usr/bin/env node
import { readNpz } from "../kimodo/read-npz.mjs";
import { motionArraysToNpzMembers, writeNpz } from "./npz.mjs";
import { smplToCskel27Motion } from "./smpl-cskel27.mjs";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
	console.error("usage: node tools/ardy/gvhmr-to-cskel27.mjs <gvhmr.npz> <motion.npz>");
	process.exit(2);
}

const motion = smplToCskel27Motion(readNpz(input));
writeNpz(output, motionArraysToNpzMembers(motion));
console.log(JSON.stringify({ output, frames: motion.frames, fps: motion.fps, boneScale: Boolean(motion.boneScale) }));
