import { readFileSync } from "node:fs";

// Source demos live in demo/; packaged entries live in dist/. In both layouts
// the parent package.json supplies the version for copyable recovery commands.
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
) as { version: string };

export const PAY_COMMAND = `npx -y @subly_fi/pay@${version}`;
