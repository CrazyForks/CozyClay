import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const readyPath = process.argv[2];
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
	stdio: "ignore",
});
writeFileSync(readyPath, JSON.stringify({ parent: process.pid, grandchild: grandchild.pid }));
setInterval(() => {}, 1000);
