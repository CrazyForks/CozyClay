#!/usr/bin/env node
/**
 * Ground-truth renderer (#428): cskel27 motion npz -> GVHMR-ready videos
 * rendered by the real CozyClay Studio from ONE fixed, known camera, with the
 * exact camera and joint ground truth written next to every video.
 *
 *   node tools/gt-render/render.mjs --out <dir> [options] <motion.npz ...>
 *
 * Per motion it starts (or reuses, --url) a Vite dev server of this checkout
 * and a headless Chrome, loads the take through `?motion=`, and:
 *   1. pre-pass: scrubs every timeline frame, CPU-skins every drawable vertex
 *      of the rig and reduces it (plus the joints) to five support values;
 *   2. solves the closest static camera at the requested azimuth/elevation and
 *      integer GVHMR f-mm that keeps every vertex of every frame inside the
 *      margin box (camera-math.mjs), identical for all variants;
 *   3. renders every timeline frame at 832x480 through the Studio's export
 *      capture (`window.__cozyclay.captureFraming`), encodes H.264 yuv420p
 *      24 fps, and writes camera.json, joints.json and meta.json.
 *
 * Variants: `shaded` (part colours, shaded palette, what GVHMR's palette
 * detector expects), `skin` (part colours off), `hue+N` / `hue-N` (the shaded
 * frames through ffmpeg's `hue=h=N` filter; it rotates the chroma plane of
 * EVERY pixel by the same N degrees, so all hues shift uniformly and neutral
 * greys stay put. It does not reshuffle parts: the palette's relative layout is
 * preserved).
 *
 * Output per motion:
 *   <out>/<motion>/plate.png           the same framing with the character hidden
 *   <out>/<motion>/mask/NNNNNN.png     exact per-frame silhouette (gray, 255 = character),
 *                                      the character re-drawn unlit in one colour
 *   <out>/<motion>/<variant>/{video.mp4,camera.json,joints.json,meta.json}
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { installSignalCleanup } from "../process-supervisor.mjs";
import { openStudioClean, startChrome, startVite, terminateAll, waitFor } from "./browser.mjs";
import { buildCamera, mergeSupports, projectPoint, supportArgs, supportValues } from "./camera-math.mjs";
import { installPageHelpers, MASK_RGB, RIG_JOINTS } from "./page.mjs";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const WIDTH = 832;
const HEIGHT = 480;
const FPS = 24;
const CACHE_DIR = join(ROOT, "node_modules/.cache/gt-render");

const USAGE = `usage: node tools/gt-render/render.mjs --out <dir> [options] <motion.npz ...>

  --out <dir>          output root; each motion goes to <dir>/<npz basename>/<variant>/
  --variants <list>    comma list of shaded, skin, hue+N, hue-N (default shaded)
  --f-mm <int>         GVHMR --f-mm the camera is built for (default 35)
  --azimuth <deg>      camera azimuth around the subject; 0 = on +Z looking -Z (default 0)
  --elevation <deg>    camera elevation; positive looks down (default 5)
  --margin <frac>      fraction of each image side kept clear of the body (default 0.08)
  --crf <int>          libx264 CRF (default 12)
  --keep-frames        keep the rendered PNG frames in <variant>/frames/
  --url <origin>       reuse a running Vite dev server of THIS checkout (default: start one)
  --port <n>           Vite port when starting one (default 5191)
  --cdp-port <n>       headless Chrome DevTools port (default 9231)

writes <dir>/<motion>/{plate.png,mask/NNNNNN.png} and
<dir>/<motion>/<variant>/{video.mp4,camera.json,joints.json,meta.json}`;

function parseOptions(argv) {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			out: { type: "string" },
			variants: { type: "string", default: "shaded" },
			"f-mm": { type: "string", default: "35" },
			azimuth: { type: "string", default: "0" },
			elevation: { type: "string", default: "5" },
			margin: { type: "string", default: "0.08" },
			crf: { type: "string", default: "12" },
			"keep-frames": { type: "boolean", default: false },
			url: { type: "string" },
			port: { type: "string", default: "5191" },
			"cdp-port": { type: "string", default: "9231" },
			help: { type: "boolean", short: "h", default: false },
		},
	});
	if (values.help) {
		console.log(USAGE);
		process.exit(0);
	}
	const fail = (message) => {
		console.error(`${message}\n\n${USAGE}`);
		process.exit(2);
	};
	if (!values.out) fail("--out is required");
	if (!positionals.length) fail("at least one motion npz is required");
	const number = (name, integer = false) => {
		const value = Number(values[name]);
		if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) fail(`--${name} must be ${integer ? "an integer" : "a number"}, got ${values[name]}`);
		return value;
	};
	const variants = values.variants.split(",").map((entry) => entry.trim()).filter(Boolean).map((name) => {
		if (name === "shaded" || name === "skin") return { name, kind: name };
		const hue = /^hue([+-]\d+(?:\.\d+)?)$/.exec(name);
		if (hue) return { name, kind: "hue", degrees: Number(hue[1]) };
		return fail(`unknown variant ${name}`);
	});
	if (new Set(variants.map((variant) => variant.name)).size !== variants.length) fail("duplicate variant");
	const motions = positionals.map((file) => resolve(file));
	for (const file of motions) if (!existsSync(file)) fail(`no such motion: ${file}`);
	const names = motions.map((file) => basename(file, ".npz"));
	if (new Set(names).size !== names.length) fail(`two motions share an output name: ${names.join(", ")}`);
	return {
		out: resolve(values.out),
		variants,
		fMm: number("f-mm", true),
		azimuthDeg: number("azimuth"),
		elevationDeg: number("elevation"),
		margin: number("margin"),
		crf: number("crf", true),
		keepFrames: values["keep-frames"],
		url: values.url?.replace(/\/$/, "") ?? null,
		port: number("port", true),
		cdpPort: number("cdp-port", true),
		motions,
	};
}

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;
const triples = (flat, digits = 6) => Array.from({ length: flat.length / 3 }, (_, i) => [round(flat[i * 3], digits), round(flat[i * 3 + 1], digits), round(flat[i * 3 + 2], digits)]);

function toolVersion() {
	const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
	try {
		const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
		const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim() !== "";
		return `${pkg.version}+${commit}${dirty ? "-dirty" : ""}`;
	} catch {
		return pkg.version;
	}
}

function encode(framesDir, output, { crf, filter }) {
	execFileSync("ffmpeg", [
		"-hide_banner", "-loglevel", "error", "-y",
		"-framerate", String(FPS), "-i", join(framesDir, "%06d.png"),
		...(filter ? ["-vf", filter] : []),
		"-c:v", "libx264", "-preset", "slow", "-crf", String(crf),
		"-pix_fmt", "yuv420p", "-colorspace", "smpte170m", "-color_primaries", "smpte170m", "-color_trc", "smpte170m", "-color_range", "tv",
		"-r", String(FPS), "-movflags", "+faststart", output,
	], { stdio: ["ignore", "inherit", "inherit"] });
}

/** Magenta-on-scene mask captures -> gray PNGs, 255 where the pixel is at
 * least half character (the MSAA edge blends linearly with the scene). */
function writeMasks(rawDir, maskDir) {
	rmSync(maskDir, { recursive: true, force: true });
	mkdirSync(maskDir, { recursive: true });
	const [r, g, b] = MASK_RGB;
	if (!(r === 255 && g === 0 && b === 255)) throw new Error("writeMasks expects the magenta mask colour");
	const test = "255*gt(r(X,Y)-g(X,Y),127)*gt(b(X,Y)-g(X,Y),127)";
	execFileSync("ffmpeg", [
		"-hide_banner", "-loglevel", "error", "-y",
		"-framerate", String(FPS), "-i", join(rawDir, "%06d.png"),
		"-vf", `format=gbrp,geq=r='${test}':g='${test}':b='${test}',format=gray`,
		"-start_number", "0", join(maskDir, "%06d.png"),
	], { stdio: ["ignore", "inherit", "inherit"] });
}

function cameraRecord(camera, shotCam) {
	return {
		width: camera.width,
		height: camera.height,
		fovDeg: camera.fovDeg,
		fx: camera.fx,
		fy: camera.fy,
		cx: camera.cx,
		cy: camera.cy,
		K: [[camera.fx, 0, camera.cx], [0, camera.fy, camera.cy], [0, 0, 1]],
		gvhmrFMm: camera.gvhmrFMm,
		position: camera.position,
		yaw: camera.yaw,
		pitch: camera.pitch,
		rotationOrder: "YXZ",
		azimuthDeg: camera.azimuthDeg,
		elevationDeg: camera.elevationDeg,
		margin: camera.margin,
		bindingAxis: camera.bindingAxis,
		near: shotCam.near,
		far: shotCam.far,
		static: true,
		worldToCamera: camera.worldToCameraCv,
		worldToCameraGl: camera.worldToCameraGl,
		cameraToWorldRotationThree: [camera.cameraToWorldRotation.slice(0, 3), camera.cameraToWorldRotation.slice(3, 6), camera.cameraToWorldRotation.slice(6, 9)],
		convention: {
			world: "CozyClay Studio / Three.js scene: right-handed, +Y up, metres. The character's front is +Z at azimuth 0.",
			worldToCamera: "OpenCV: [X Y Z 1]^T = worldToCamera * [x y z 1]^T, camera x right, y DOWN, z forward (depth).",
			projection: "u = fx * X / Z + cx, v = fy * Y / Z + cy. Square pixels, no distortion, no skew.",
			image: "Pixels continuous from the top-left corner of the top-left pixel: u right, v DOWN; pixel (col,row) covers [col,col+1)x[row,row+1) and its centre is (col+0.5,row+0.5); cx = width/2, cy = height/2.",
			worldToCameraGl: "Three/OpenGL view matrix (camera.matrixWorldInverse): x right, y up, looking down -z.",
			threeCamera: "PerspectiveCamera(fov = fovDeg vertical, aspect = width/height), position, rotation.set(pitch, yaw, 0) with order YXZ (radians); rendered through the Studio export capture.",
			gvhmr: "Run GVHMR with --f-mm gvhmrFMm: f_px = sqrt(W^2 + H^2) / sqrt(24^2 + 36^2) * f_mm equals fx = fy here.",
		},
	};
}

async function main() {
	const options = parseOptions(process.argv.slice(2));
	const children = [];
	const cleanups = [];
	const runCleanups = () => {
		for (const cleanup of cleanups.splice(0)) cleanup();
	};
	const removeSignals = installSignalCleanup(() => children, () => {
		runCleanups();
		process.exit(130);
	});
	const version = toolVersion();
	try {
		const base = options.url ?? await startVite({ root: ROOT, port: options.port, children });
		const cdp = await startChrome({ port: options.cdpPort, children, cleanups });
		mkdirSync(CACHE_DIR, { recursive: true });
		for (const file of options.motions) {
			await renderMotion({ cdp, base, file, options, version });
		}
		cdp.close();
	} finally {
		removeSignals();
		await terminateAll(children);
		runCleanups();
	}
}

async function renderMotion({ cdp, base, file, options, version }) {
	const started = Date.now();
	const bytes = readFileSync(file);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const motionName = basename(file, ".npz");
	// Vite serves the checkout's files by path; an npz outside the repo is
	// copied into the (gitignored) node_modules cache so ?motion= can reach it.
	const cached = join(CACHE_DIR, `${sha256.slice(0, 16)}.npz`);
	if (!existsSync(cached)) copyFileSync(file, cached);
	const motionUrl = `/node_modules/.cache/gt-render/${sha256.slice(0, 16)}.npz`;
	const studioUrl = `${base}/app/?motion=${encodeURIComponent(motionUrl)}`;
	const log = (message) => console.log(`[${motionName}] ${message}`);

	await openStudioClean(cdp, studioUrl);
	await waitFor("studio motion load", () => cdp.evaluate("!!(window.__cozyclay && window.__cozyclay.motion && window.__cozyclay.rigA && typeof window.__cozyclay.captureFraming === 'function')"), { timeoutMs: 180000, intervalMs: 250 });
	await cdp.evaluate(`(${installPageHelpers.toString()})(${supportValues.toString()}, ${JSON.stringify(RIG_JOINTS)}, ${JSON.stringify(MASK_RGB)})`);
	const state = await cdp.evaluate("window.__gtRender.state()");
	if (state.motionUrl !== motionUrl) throw new Error(`Studio loaded ${state.motionUrl} instead of ${motionUrl}`);
	if (state.fps !== FPS) throw new Error(`timeline runs at ${state.fps} fps, expected ${FPS}`);
	const frames = state.frameCount;
	log(`loaded ${frames} frames @ ${state.fps} fps, model ${state.characterModel}`);

	// Pre-pass: the camera must see every vertex of every frame.
	const geometry = { width: WIDTH, height: HEIGHT, fMm: options.fMm, azimuthDeg: options.azimuthDeg, elevationDeg: options.elevationDeg, margin: options.margin };
	const { R, kx, ky } = supportArgs(geometry);
	await cdp.evaluate(`window.__gtRender.setOrientation(${JSON.stringify(R)}, ${kx}, ${ky})`);
	const supports = [];
	const prepassJoints = [];
	let vertexCount = 0;
	for (let frame = 0; frame < frames; frame += 1) {
		const sample = await cdp.evaluate(`window.__gtRender.sample(${frame})`);
		supports.push(sample.support);
		prepassJoints.push(sample.joints);
		vertexCount = sample.vertexCount;
	}
	const camera = buildCamera({ ...geometry, support: mergeSupports(supports) });
	const framing = { pos: camera.position, yaw: camera.yaw, pitch: camera.pitch, fovDeg: camera.fovDeg };
	const output = { width: WIDTH, height: HEIGHT };
	log(`camera at (${camera.position.x.toFixed(3)}, ${camera.position.y.toFixed(3)}, ${camera.position.z.toFixed(3)}), fov ${camera.fovDeg.toFixed(4)} deg, f ${camera.fy.toFixed(3)} px, ${camera.bindingAxis}-bound, ${vertexCount} vertices/frame`);

	// Joints projected with camera.json; the placement guarantees the margin box.
	const uv = prepassJoints.map((joints) => triples(joints).map((point) => projectPoint(point, camera)));
	let minMarginPx = Infinity;
	for (const frameUv of uv) {
		for (const [u, v] of frameUv) minMarginPx = Math.min(minMarginPx, u, v, WIDTH - u, HEIGHT - v);
	}
	const marginPx = options.margin * Math.min(WIDTH, HEIGHT);
	if (minMarginPx < marginPx - 1e-6) throw new Error(`a joint projects ${minMarginPx.toFixed(2)} px from the edge, inside the ${marginPx} px margin`);

	const motionDir = join(options.out, motionName);
	mkdirSync(motionDir, { recursive: true });
	writeFileSync(join(motionDir, "plate.png"), Buffer.from(await cdp.evaluate(`window.__gtRender.plate(${JSON.stringify(framing)}, ${JSON.stringify(output)})`), "base64"));

	const wanted = new Set(options.variants.map((variant) => variant.name));
	const needsShadedFrames = options.variants.some((variant) => variant.kind === "hue");
	const browserPasses = [
		...(wanted.has("shaded") || needsShadedFrames ? [{ name: "shaded", partColours: true }] : []),
		...(wanted.has("skin") ? [{ name: "skin", partColours: false }] : []),
	];
	const checks = { prepassVsRenderJointMaxM: 0, threeVsCameraJsonMaxPx: 0 };
	const framesDirs = {};
	const passState = {};
	const maskRawDir = join(motionDir, ".mask-raw");
	rmSync(maskRawDir, { recursive: true, force: true });
	mkdirSync(maskRawDir, { recursive: true });
	for (const [passIndex, pass] of browserPasses.entries()) {
		const withMask = passIndex === 0;
		passState[pass.name] = await cdp.evaluate(`window.__gtRender.setPartColours(${pass.partColours})`);
		const framesDir = wanted.has(pass.name) ? join(motionDir, pass.name, "frames") : join(motionDir, `.${pass.name}-frames`);
		rmSync(framesDir, { recursive: true, force: true });
		mkdirSync(framesDir, { recursive: true });
		framesDirs[pass.name] = framesDir;
		for (let frame = 0; frame < frames; frame += 1) {
			const captured = await cdp.evaluate(`window.__gtRender.capture(${frame}, ${JSON.stringify(framing)}, ${JSON.stringify(output)}, ${withMask})`);
			writeFileSync(join(framesDir, `${String(frame).padStart(6, "0")}.png`), Buffer.from(captured.png, "base64"));
			if (withMask) writeFileSync(join(maskRawDir, `${String(frame).padStart(6, "0")}.png`), Buffer.from(captured.mask, "base64"));
			for (let i = 0; i < captured.joints.length; i += 1) {
				checks.prepassVsRenderJointMaxM = Math.max(checks.prepassVsRenderJointMaxM, Math.abs(captured.joints[i] - prepassJoints[frame][i]));
			}
			triples(captured.joints, 12).forEach((point, j) => {
				const [u, v] = projectPoint(point, camera);
				checks.threeVsCameraJsonMaxPx = Math.max(checks.threeVsCameraJsonMaxPx, Math.abs(u - captured.threeUv[j * 2]), Math.abs(v - captured.threeUv[j * 2 + 1]));
			});
		}
		log(`rendered ${pass.name}: ${frames} frames`);
	}
	writeMasks(maskRawDir, join(motionDir, "mask"));
	rmSync(maskRawDir, { recursive: true, force: true });
	// The pose must not depend on the pass: joints.json is the pre-pass pose.
	if (checks.prepassVsRenderJointMaxM > 1e-6) throw new Error(`rendered pose differs from the pre-pass by ${checks.prepassVsRenderJointMaxM} m`);
	if (checks.threeVsCameraJsonMaxPx > 1e-3) throw new Error(`camera.json projection differs from the Three capture camera by ${checks.threeVsCameraJsonMaxPx} px`);

	const cameraJson = cameraRecord(camera, passState[browserPasses[0].name]?.shotCam ?? state.shotCam);
	const jointsJson = {
		convention: "world: metres in the camera.json world frame; uv: pixels in the camera.json image convention (origin top-left, v down), projected with camera.json; depth: camera-space Z in metres.",
		fps: FPS,
		frames,
		joints: RIG_JOINTS.map(({ bone, cskel27 }) => ({ name: bone.replace(/^mixamorig/, ""), bone, cskel27 })),
		note: "Rig bones of the rendered character (the pose actually drawn). Mixamo Spine/Spine1/Spine2 correspond to cskel27 Spine1/Spine2/Spine3 (src/ardy/playback.js); the Mixamo body is not congruent with cskel27 and playback scales the take's root travel to the rig's leg length, so these are NOT the npz's posed_joints: they differ by centimetres, growing with distance travelled (about 1% of it on walk-then-stop). They are the truth for what the video shows.",
		world: prepassJoints.map((joints) => triples(joints)),
		uv: uv.map((frameUv) => frameUv.map(([u, v]) => [round(u, 4), round(v, 4)])),
		depth: uv.map((frameUv) => frameUv.map(([, , z]) => round(z, 6))),
	};
	const shared = {
		tool: "tools/gt-render/render.mjs",
		toolVersion: version,
		createdAt: new Date().toISOString(),
		source: { path: file, sha256, bytes: bytes.length },
		motionName,
		frames,
		fps: FPS,
		video: { file: "video.mp4", width: WIDTH, height: HEIGHT, codec: "h264 (libx264)", pixFmt: "yuv420p", colorspace: "smpte170m, tv range", crf: options.crf },
		characterModel: state.characterModel,
		characterScale: state.characterScale,
		studio: { url: studioUrl, captureHook: "window.__cozyclay.captureFraming" },
		plate: "../plate.png (same camera, character hidden)",
		mask: "../mask/%06d.png (8-bit gray, 255 = character: the frame re-rendered with the character unlit in one colour, >= 50% pixel coverage)",
		checks: {
			...checks,
			minJointEdgeDistancePx: minMarginPx,
			framingVerticesPerFrame: vertexCount,
		},
	};
	for (const variant of options.variants) {
		const dir = join(motionDir, variant.name);
		mkdirSync(dir, { recursive: true });
		const filter = variant.kind === "hue" ? `hue=h=${variant.degrees}` : null;
		encode(variant.kind === "hue" ? framesDirs.shaded : framesDirs[variant.name], join(dir, "video.mp4"), { crf: options.crf, filter });
		writeFileSync(join(dir, "camera.json"), `${JSON.stringify(cameraJson, null, "\t")}\n`);
		writeFileSync(join(dir, "joints.json"), `${JSON.stringify(jointsJson)}\n`);
		const variantDetail = variant.kind === "hue"
			? { partColours: "shaded", postFilter: filter, note: `ffmpeg hue filter on the shaded frames: rotates every pixel's chroma by ${variant.degrees} degrees, so all hues shift uniformly and greys are unchanged.` }
			: { partColours: variant.kind === "shaded" ? "shaded" : "off", postFilter: null };
		writeFileSync(join(dir, "meta.json"), `${JSON.stringify({ ...shared, variant: variant.name, variantDetail }, null, "\t")}\n`);
		log(`wrote ${variant.name}`);
	}
	if (!options.keepFrames) for (const dir of Object.values(framesDirs)) rmSync(dir, { recursive: true, force: true });
	else if (framesDirs.shaded && !wanted.has("shaded")) rmSync(framesDirs.shaded, { recursive: true, force: true });
	log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

main().catch((error) => {
	console.error(error?.stack || String(error));
	process.exitCode = 1;
});
