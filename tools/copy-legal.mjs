#!/usr/bin/env node

import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const legal = resolve(root, "dist/legal");
mkdirSync(legal, { recursive: true });
cpSync(resolve(root, "THIRD_PARTY_NOTICES.md"), resolve(legal, "THIRD_PARTY_NOTICES.md"));
cpSync(resolve(root, "licenses"), resolve(legal, "licenses"), { recursive: true });
