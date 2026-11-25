// **A picture's upload with the owner's own login**
// (decisions.md#screenshots-attach): the one place the owner's gh login writes
// anything, and what it writes is a stored image, never a post. `plans gh … --attach`
// sends each picture to GitHub by the one request gh's own `--attach` makes
// (gh's `internal/attachments/client.go`), with the token `gh auth token`
// gives, puts the address GitHub answers into the text, and runs gh as the
// project's app without the flag, so the pull request, issue or comment is
// the app's. The upload endpoint takes a person's token and only some apps',
// which is why the app's is not used. `node:` modules only; `fetch` is Node's own.
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";

/** The kinds of picture GitHub takes, by extension: gh's list, its video kinds left out. */
export const IMAGE_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

const UPLOADS = "https://uploads.github.com/user-attachments/assets";

/** `plans gh`'s line when a picture did not go up: nothing was posted. */
export function notUploaded(cause) {
  return `Screenshots not uploaded, so nothing was posted: ${cause}. Post it once more without --attach; the pictures stay where they are.`;
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function sizeOf(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** A file's alt text when the command gives none: its base name without the extension, dots as spaces. */
function altOf(path) {
  const name = basename(path);
  const ext = extname(name);
  return (ext ? name.slice(0, -ext.length) : name).replace(/\./g, " ");
}

/**
 * **The words of a `plans gh` call with `--attach`**: `files`, one `{ path,
 * given, alt, type }` per `--attach <value>` or `--attach=<value>`, the path
 * absolute and a file named twice once; a value that is an existing file is
 * the path, else it splits at its last `#` into path and alt, as gh's
 * `SplitFileArg` does. `body`: where in `rest` the text is (`at`, `count`
 * words), the text, and the folder its references are read from, the body
 * file's or `cwd`. `repo`: `-R` or `--repo`, or "". `rest`: the words without
 * the attach ones. `fault`: the first cause found, or "".
 */
export function attachWords(args = [], { cwd = process.cwd() } = {}) {
  const rest = [];
  const files = [];
  let body = null;
  let repo = "";
  const words = args.map(String);
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const attach = /^--attach(?:=(.*))?$/s.exec(word);
    if (attach && (attach[1] !== undefined || i + 1 < words.length)) {
      const value = attach[1] ?? words[++i];
      let given = value;
      let alt = "";
      if (!isFile(resolve(cwd, value)) && value.includes("#")) {
        const cut = value.lastIndexOf("#");
        given = value.slice(0, cut);
        alt = value.slice(cut + 1);
      }
      const path = resolve(cwd, given);
      if (files.some((file) => file.path === path)) continue;
      const type = IMAGE_TYPES[extname(path).slice(1).toLowerCase()] || "";
      files.push({ path, given, alt: alt || altOf(path), type });
      continue;
    }
    const named = /^(--body-file|--body|--repo)=(.*)$/s.exec(word);
    const flag = named ? named[1] : word;
    const short = { "-F": "--body-file", "-b": "--body", "-R": "--repo" }[flag] || flag;
    if (["--body-file", "--body", "--repo"].includes(short) && (named || i + 1 < words.length)) {
      const value = named ? named[2] : words[i + 1];
      const count = named ? 1 : 2;
      if (short === "--repo") repo = value;
      else if (!body) {
        if (short === "--body") body = { at: rest.length, count, text: value, dir: cwd };
        else body = { at: rest.length, count, file: value, dir: cwd };
      }
      rest.push(...words.slice(i, i + count));
      i += count - 1;
      continue;
    }
    rest.push(word);
  }
  let fault = "";
  for (const file of files) {
    if (!isFile(file.path)) fault = `${file.given} is not there`;
    else if (!sizeOf(file.path)) fault = `${file.given} is empty`;
    else if (!file.type)
      fault = `${file.given} is not an image GitHub takes (png, jpg, jpeg, gif, webp or svg)`;
    if (fault) break;
  }
  if (!fault && !body) fault = "the command has no --body-file or --body for them to go in";
  if (!fault && body.file !== undefined) {
    const path = resolve(cwd, body.file);
    if (body.file === "-")
      fault =
        "the text is read from stdin (--body-file -), which plans gh does not read: give it as a file";
    else if (!isFile(path)) fault = `${body.file} is not there`;
    else {
      try {
        body.text = readFileSync(path, "utf8");
        body.dir = dirname(path);
      } catch (error) {
        fault = `${body.file} could not be read (${error.message})`;
      }
    }
  }
  return { rest, files, body, repo, fault };
}

/** A destination as written: its angle brackets or escapes off, its percent signs decoded. */
function destinationOf(written) {
  const bare = written.startsWith("<")
    ? written.slice(1, -1)
    : written.replace(/\\([^A-Za-z0-9\s])/g, "$1");
  try {
    return decodeURIComponent(bare);
  } catch {
    return bare;
  }
}

/**
 * **The text with GitHub's addresses**: outside fenced blocks (``` or ~~~),
 * each inline image `![alt](destination)` whose destination, read against
 * `dir` and then `cwd`, is a file's path takes that file's `url`, the alt text
 * kept as written; each file no reference named is appended, a blank line
 * before it, as `![<alt>](<url>)`.
 */
export function withAddresses(text = "", files = [], dir = process.cwd(), cwd = process.cwd()) {
  const named = new Set();
  const byPath = new Map(files.map((file) => [file.path, file]));
  // A code span first, left as written; then an inline image, its
  // destination in angle brackets or bare, with one level of parentheses.
  const image =
    /(`+).*?(?<!`)\1(?!`)|!\[((?:\\.|[^\\\]])*)\]\(([ \t]*)(<[^<>\n]*>|(?:[^\s()<>\\]|\\.|\([^\s()<>]*\))+)((?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'))?[ \t]*)\)/g;
  const swap = (line) =>
    line.replace(image, (whole, code, alt, before, written, after) => {
      if (code) return whole;
      const destination = destinationOf(written);
      const file = byPath.get(resolve(dir, destination)) || byPath.get(resolve(cwd, destination));
      if (!file) return whole;
      named.add(file.path);
      return `![${alt}](${before}${file.url}${after})`;
    });
  let fence = null;
  const lines = text.split("\n").map((line) => {
    const mark = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (mark && mark[1][0] === fence[0] && mark[1].length >= fence.length) fence = null;
      return line;
    }
    if (mark) {
      fence = mark[1];
      return line;
    }
    return swap(line);
  });
  let out = lines.join("\n");
  for (const file of files) {
    if (named.has(file.path)) continue;
    const alt = file.alt.replace(/[\\[\]]/g, "\\$&").replace(/\r?\n|\r/g, " ");
    out = `${out.replace(/\s+$/, "")}${out.trim() ? "\n\n" : ""}![${alt}](${file.url})`;
    named.add(file.path);
  }
  return out;
}

/** **The owner's own gh login**: `gh auth token`, the environment as it is; "" on any failure. */
export function ownerToken({ env = process.env, run = spawnSync } = {}) {
  try {
    const done = run(env.WORKFLOW_GH || "gh", ["auth", "token", "--hostname", "github.com"], {
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (done.error || done.status !== 0) return "";
    return String(done.stdout || "").trim();
  } catch {
    return "";
  }
}

/**
 * **One picture up**, as gh's `postAsset` sends it: the file's bytes to
 * `uploads.github.com/user-attachments/assets`, with the owner's token. Gives
 * the address GitHub answers; throws an error with GitHub's `status` and
 * `message`, or one without `status` when the request never arrived.
 */
export async function uploadAsset({ file, repositoryId, token, fetch = globalThis.fetch }) {
  const query = new URLSearchParams({
    name: basename(file.path),
    content_type: file.type,
    repository_id: String(repositoryId),
  });
  let response;
  try {
    response = await fetch(`${UPLOADS}?${query}`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `token ${token}`,
        "Content-Type": "application/octet-stream",
        "User-Agent": "workflow-plugin",
      },
      body: readFileSync(file.path),
    });
  } catch (error) {
    throw new Error(error?.message || String(error));
  }
  let answer = null;
  try {
    answer = await response.json();
  } catch {
    // No JSON: the status says it.
  }
  if (!response.ok || !answer?.url) {
    const error = new Error(answer?.message || "");
    error.status = response.status;
    throw error;
  }
  return answer.url;
}
