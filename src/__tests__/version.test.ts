/** @jest-environment node */
// Guards the hand-synced VERSION constant against the versions npm and the
// MCP registry actually publish. If any of these fail, bump them together.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../index.js";

const CLI_DIR = join(__dirname, "..", "..");

describe("version guard", () => {
  it("VERSION matches cli/package.json", () => {
    const pkg = JSON.parse(readFileSync(join(CLI_DIR, "package.json"), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  it("VERSION matches both versions in cli/server.json", () => {
    const server = JSON.parse(readFileSync(join(CLI_DIR, "server.json"), "utf8")) as {
      version: string;
      packages: { version: string }[];
    };
    expect(server.version).toBe(VERSION);
    expect(server.packages.map((p) => p.version)).toEqual([VERSION]);
  });
});
