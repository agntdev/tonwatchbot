// Local wrapper around the toolkit's harness CLI. Sets the env vars the
// gate CLI requires (AGNTDEV_BOT_MODULE, AGNTDEV_SPECS_FILE,
// AGNTDEV_COMMANDS_FILE, AGNTDEV_GATE_NONCE) using absolute paths derived
// from the current working directory. The platform's CI sets the same
// env vars externally — this script is just for `npm test` locally.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const env = {
  ...process.env,
  AGNTDEV_BOT_MODULE: resolve(root, "dist/harness-entry.js"),
  AGNTDEV_SPECS_FILE: resolve(root, "tests/specs.json"),
  AGNTDEV_COMMANDS_FILE: resolve(root, "tests/commands.json"),
  AGNTDEV_GATE_NONCE: "local",
};

const cli = resolve(root, "node_modules/@agntdev/bot-toolkit/dist/harness/cli.js");
const r = spawnSync(process.execPath, [cli], { stdio: "inherit", env });
process.exit(r.status ?? 1);
