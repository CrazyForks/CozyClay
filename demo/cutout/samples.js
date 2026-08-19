/**
 * Sample cutouts, drawn in the page.
 *
 * A demo that only works if you have a PNG with alpha lying around is a demo
 * nobody runs. These three are drawn to a canvas with real transparency and
 * then handed to the SAME import path a picked file goes through — they are
 * not a shortcut around it.
 */

const SAMPLES = [
	{
		name: "Doorway",
		metres: 2.05,
		width: 420,
		height: 900,
		note: "A door is the reference everyone can measure against.",
		draw(ctx, w, h) {
			const frame = w * 0.08;
			ctx.fillStyle = "#8d9599";
			ctx.fillRect(0, 0, w, h);
			ctx.clearRect(frame, frame, w - frame * 2, h - frame);
			ctx.fillStyle = "#2f3a40";
			ctx.fillRect(frame, frame, w - frame * 2, h - frame);
			// a sliver of light down the opening edge
			const light = ctx.createLinearGradient(frame, 0, w * 0.45, 0);
			light.addColorStop(0, "rgba(231,181,87,0.85)");
			light.addColorStop(1, "rgba(231,181,87,0)");
			ctx.fillStyle = light;
			ctx.fillRect(frame, frame, w * 0.4, h - frame);
			ctx.fillStyle = "#c2c6c8";
			ctx.fillRect(w - frame * 2.2, h * 0.52, frame * 0.7, frame * 0.7);
		},
	},
	{
		name: "Street tree",
		metres: 4.6,
		width: 640,
		height: 900,
		note: "The shape that tells you whether the actor is hidden.",
		draw(ctx, w, h) {
			ctx.fillStyle = "#6a5a49";
			ctx.beginPath();
			ctx.moveTo(w * 0.46, h);
			ctx.lineTo(w * 0.54, h);
			ctx.lineTo(w * 0.53, h * 0.42);
			ctx.lineTo(w * 0.47, h * 0.42);
			ctx.closePath();
			ctx.fill();
			const canopy = [
				[0.5, 0.3, 0.26],
				[0.33, 0.4, 0.19],
				[0.68, 0.39, 0.2],
				[0.42, 0.19, 0.16],
				[0.6, 0.2, 0.15],
			];
			for (const [x, y, r] of canopy) {
				ctx.fillStyle = y < 0.25 ? "#7f9a7a" : "#5f7a63";
				ctx.beginPath();
				ctx.arc(w * x, h * y, w * r, 0, Math.PI * 2);
				ctx.fill();
			}
		},
	},
	{
		name: "Counter",
		metres: 1.05,
		width: 900,
		height: 420,
		note: "Wide and low: the thing an eyeline has to clear.",
		draw(ctx, w, h) {
			ctx.fillStyle = "#b9855d";
			ctx.fillRect(0, h * 0.12, w, h * 0.88);
			ctx.fillStyle = "#cf9d72";
			ctx.fillRect(0, 0, w, h * 0.14);
			ctx.fillStyle = "rgba(0,0,0,0.16)";
			for (let i = 1; i < 5; i++) ctx.fillRect((w / 5) * i, h * 0.16, 3, h * 0.84);
		},
	},
];

/** Draw one sample and hand it back as a File, exactly as a picker would. */
export async function sampleFile(index) {
	const sample = SAMPLES[index];
	const canvas = document.createElement("canvas");
	canvas.width = sample.width;
	canvas.height = sample.height;
	const ctx = canvas.getContext("2d");
	sample.draw(ctx, sample.width, sample.height);
	const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
	return new File([blob], `${sample.name}.png`, { type: "image/png" });
}

export { SAMPLES };
