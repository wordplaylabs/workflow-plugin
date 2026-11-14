import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");

/**
 * **The repository is public**: no tracked file names a host's address, a
 * personal email, the home lab's own domain, the projects the workflow
 * runs in (but for the repository's own address, which holds the first
 * one's name), or a GitHub token (a line naming `GH_TOKEN` is the most a file
 * holds); the README says "the author's projects", never which. This test
 * is the one tracked file that spells those names, as patterns.
 */

/** Files a person does not read as prose, or that hold addresses on purpose. */
const SKIPPED = [
  // Binaries and fonts: no text to read.
  /\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf|pdf|mp4|webm|zip|gz)$/i,
  // Resolved package URLs and integrity hashes, never written by hand.
  /(^|\/)package-lock\.json$/,
];

const IPV4 = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.]*\d)(\/\d{1,2})?/g;

/** Addresses that name no machine of ours. */
function allowedAddress(match: RegExpExecArray): boolean {
  const [whole, a, b, c, d, bits] = match;
  const octets = [a, b, c, d].map(Number);
  // Four numbers above 255 are not an address (an SVG path, a version).
  if (octets.some((n) => n > 255)) return true;
  // A range, which names no one machine.
  if (bits) return true;
  // Loopback and "every interface", which every compose file and doc names.
  if (whole.startsWith("127.") || whole === "0.0.0.0") return true;
  // RFC 5737's documentation ranges, for examples.
  return ["192.0.2.", "198.51.100.", "203.0.113."].some((p) => whole.startsWith(p));
}

/** Personal mail providers; a founder's address is the company's or GitHub's noreply. */
const PERSONAL_EMAIL = /[A-Za-z0-9._%+-]+@(gmail\.com|yandex\.ru|[a-z0-9.-]*ethz\.ch)\b/i;
/** The home lab's own domain, written here as a name and nowhere else. */
const HOME_LAB = /javinieto/i;
/** The project the workflow was first written in, which this repository names only in its own address. */
const FIRST_PROJECT = /wordplay/i;
/**
 * The repository's own address, the one place the first project's name may
 * stand (Javi, 14 November 2026): the address shows it to anyone who opens
 * the repository. Owner and name in this spelling, as a whole word; what
 * follows inside the repository (`#main`, `.git`, a path) is the same address;
 * another dotted suffix (`.wiki`, `.private`) is another repository, refused.
 */
const REPOSITORY = /(?<![\w.-])wordplaylabs\/workflow-plugin(?:\.git)?(?![\w-]|\.\w)/g;
/** A GitHub token: classic, OAuth, user, server, refresh, or fine-grained. */
const TOKEN = /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/;

/** What one line holds that a public repository may not, in the order a reader meets the kinds. */
function faults(line: string): string[] {
  const found: string[] = [];
  for (const match of line.matchAll(IPV4)) {
    if (!allowedAddress(match as RegExpExecArray)) found.push(match[0]);
  }
  if (PERSONAL_EMAIL.test(line)) found.push("a personal email");
  if (HOME_LAB.test(line)) found.push("the home lab's domain");
  if (FIRST_PROJECT.test(line.replace(REPOSITORY, " "))) found.push("the first project's name");
  if (TOKEN.test(line)) found.push("a GitHub token");
  return found;
}

function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
  return out
    .split("\0")
    .filter(Boolean)
    .filter((path) => !SKIPPED.some((rule) => rule.test(path)))
    .filter((path) => path !== "test/public.test.ts");
}

describe("a tracked file", () => {
  it("names no host address, personal email, home lab, first project or GitHub token in a tracked file", () => {
    const found: string[] = [];
    for (const path of trackedFiles()) {
      let text: string;
      try {
        text = readFileSync(join(root, path), "utf8");
      } catch {
        continue; // deleted in the working tree, or a submodule
      }
      text.split("\n").forEach((line, i) => {
        const where = `${path}:${i + 1}`;
        for (const fault of faults(line)) found.push(`${where}: ${fault}`);
      });
    }
    expect(found).toEqual([]);
  });
});

describe("the repository's own address", () => {
  it("allows the repository's own address, written exactly", () => {
    const lines = [
      "Install the workflow plugin from https://github.com/wordplaylabs/workflow-plugin by following its INSTALL.md.",
      "claude plugin marketplace add wordplaylabs/workflow-plugin#main",
      '"source": { "source": "github", "repo": "wordplaylabs/workflow-plugin", "ref": "main" },',
      "gh repo clone wordplaylabs/workflow-plugin <path>`, which uses the signed-in login.",
      "git clone https://github.com/wordplaylabs/workflow-plugin.git",
    ];
    for (const line of lines) expect(faults(line), line).toEqual([]);
  });

  it("still refuses the first project's name beside the address or in any other form", () => {
    const lines = [
      "https://github.com/wordplaylabs",
      "https://github.com/wordplaylabs/another-repository",
      "wordplaylabs/workflow-plugins",
      "wordplaylabs/workflow-plugin-docs",
      "wordplaylabs/workflow-plugin.wiki",
      "https://github.com/wordplaylabs/workflow-plugin.private",
      "WordplayLabs/workflow-plugin",
      "docs.wordplaylabs/workflow-plugin",
      "the plugin Wordplay was built with",
      "claude plugin marketplace add wordplaylabs/workflow-plugin#main, for Wordplay",
    ];
    for (const line of lines) expect(faults(line), line).toEqual(["the first project's name"]);
  });
});
