#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { issueSession } from "../src/auth.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function loadDevVars() {
  const values = {};
  const path = resolve(root, ".dev.vars");
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u);
      if (!match) continue;
      values[match[1]] = match[2].replace(/^['"]|['"]$/gu, "");
    }
  } catch {
    // Environment variables are sufficient in CI; the file is optional.
  }
  return values;
}

function usage() {
  console.error("usage: dev-session.mjs --account <id> [--sql]");
  process.exit(2);
}

const args = process.argv.slice(2);
let account;
let sql = false;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--account") account = args[++index];
  else if (args[index] === "--sql") sql = true;
  else usage();
}
if (!account) usage();
const vars = { ...loadDevVars(), ...process.env };
if (!vars.SESSION_SIGNING_KEY) {
  console.error("SESSION_SIGNING_KEY is required in workers/api/.dev.vars or the environment");
  process.exit(1);
}
const env = { SESSION_SIGNING_KEY: vars.SESSION_SIGNING_KEY, ENVIRONMENT: "development" };
const token = await issueSession(account, env);
const now = Date.now();
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const statement = `INSERT INTO accounts(id, created_at) VALUES (${quote(account)}, ${now}) ON CONFLICT(id) DO NOTHING;`;
process.stdout.write(`${token}\n`);
if (sql) process.stdout.write(`${statement}\n`);
else console.error(`D1 seed SQL (run with wrangler d1 execute --local): ${statement}`);
