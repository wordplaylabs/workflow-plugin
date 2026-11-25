// **The project's Claude on GitHub**: the queue writes issues, comments, labels
// and pull requests as the project's own GitHub App, never under a person's
// name. Its id and private key reach the container as `GH_TOKEN` does,
// `WORKFLOW_APP_ID` and `WORKFLOW_APP_KEY`, or in the file
// `WORKFLOW_SECRETS_FILE` names, which the queue's `secret()` reads; an
// installation token is minted from them here, for an hour, and kept in
// `.claude/app-token.json` until five minutes before it ends. `node:` modules
// only; `fetch` is Node's own.
import { createSign } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const API = "https://api.github.com";
/** The REST API's version every call names (GitHub's "API versions"). */
const API_VERSION = "2022-11-28";
/** A cached token is minted again this long before it ends. */
const TOKEN_MARGIN = 5 * 60_000;

const base64url = (value) =>
  Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

/**
 * The key as the variable holds it: a PEM's text, its line ends as written or
 * as `\n` escapes, which a one-line environment value often carries.
 */
function keyOf(text = "") {
  return /\n/.test(text) ? text : text.replace(/\\n/g, "\n");
}

/**
 * **The app's JSON Web Token** (GitHub's "Generating a JSON Web Token"):
 * RS256, issued a minute back for the clock's drift, ending ten minutes on,
 * GitHub's longest, its issuer the app's id.
 */
export function appJwt(id, pem, now = Date.now()) {
  const at = Math.floor(now / 1000);
  const head = `${base64url({ alg: "RS256", typ: "JWT" })}.${base64url({ iat: at - 60, exp: at + 600, iss: String(id) })}`;
  const signature = createSign("RSA-SHA256").update(head).end().sign(keyOf(pem), "base64url");
  return `${head}.${signature}`;
}

function readCache(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeCache(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, file);
}

async function call(fetch, method, path, jwt) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "workflow-plugin",
    },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    // No JSON: the status says it.
  }
  if (!response.ok)
    throw new Error(
      `${method} ${path} answered ${response.status}${body?.message ? `: ${body.message}` : ""}`,
    );
  return body;
}

/**
 * **An installation token for the repository** (GitHub's "Generating an
 * installation access token"): the cached one while more than five minutes
 * of it are left and it is this repository's, else the installation read from
 * `GET /repos/{owner}/{repo}/installation` and a token minted for it, an hour
 * long, cached with its end. Throws with GitHub's answer when either call fails.
 */
export async function installationToken({
  owner,
  repo,
  id,
  key,
  cacheFile,
  fetch = globalThis.fetch,
  now = Date.now(),
}) {
  const name = `${owner}/${repo}`;
  const cached = cacheFile ? readCache(cacheFile) : null;
  if (
    cached?.token &&
    cached.repo === name &&
    String(cached.app) === String(id) &&
    Date.parse(cached.expiresAt) - now > TOKEN_MARGIN
  )
    return cached.token;
  const jwt = appJwt(id, key, now);
  const installation = await call(fetch, "GET", `/repos/${name}/installation`, jwt);
  const minted = await call(
    fetch,
    "POST",
    `/app/installations/${installation.id}/access_tokens`,
    jwt,
  );
  if (cacheFile)
    writeCache(cacheFile, {
      token: minted.token,
      expiresAt: minted.expires_at,
      repo: name,
      app: String(id),
    });
  return minted.token;
}

/** **The app's slug** (`GET /app`, with the app's JWT), which a mention of it names: `@<slug>`. */
export async function appSlug({ id, key, fetch = globalThis.fetch, now = Date.now() }) {
  const app = await call(fetch, "GET", "/app", appJwt(id, key, now));
  return app?.slug || "";
}

/** `owner/repo` from a GitHub remote's address, https or ssh; null for another host. */
export function repoOfRemote(url = "") {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * **What the app has**: its registration, `GET /app`, and its installation
 * on the repository, `GET /repos/{owner}/{repo}/installation`, each with the
 * permissions and events GitHub gives, the installation's with its address,
 * where its owner accepts new permissions. One JWT for both; throws as
 * either call does.
 */
export async function appStanding({
  owner,
  repo,
  id,
  key,
  fetch = globalThis.fetch,
  now = Date.now(),
}) {
  const jwt = appJwt(id, key, now);
  const app = await call(fetch, "GET", "/app", jwt);
  const inst = await call(fetch, "GET", `/repos/${owner}/${repo}/installation`, jwt);
  return {
    slug: app?.slug || "",
    app: { permissions: app?.permissions || {}, events: app?.events || [] },
    installation: {
      permissions: inst?.permissions || {},
      events: inst?.events || [],
      url: inst?.html_url || "",
    },
  };
}

/**
 * **What a failed run needs that a grant lacks**: Actions read or write, and
 * the Workflow run event. An app with Actions read is sent every run; only its
 * rerun is refused, which the assistant already turns into a short plan.
 */
function runsLack({ permissions = {}, events = [] } = {}) {
  const lacks = [];
  if (!["read", "write"].includes(permissions.actions)) lacks.push("Actions read and write");
  if (!events.includes("workflow_run")) lacks.push("the Workflow run event");
  return lacks;
}

/**
 * **Where the app cannot send a failed run**: its registration, else its
 * installation, whose new permissions wait on the account's owner; null when
 * both have what it takes.
 */
export function appLacks(standing) {
  const registered = runsLack(standing.app);
  if (registered.length) return { where: "app", what: registered, slug: standing.slug };
  const installed = runsLack(standing.installation);
  if (installed.length)
    return {
      where: "installation",
      what: installed,
      slug: standing.slug,
      url: standing.installation.url,
    };
  return null;
}

/**
 * **Where the app cannot attach a screenshot** (decisions.md#screenshots-attach):
 * gh's `--attach` uploads as the app, which takes Contents read and write, on
 * its registration, else on its installation, whose new permissions wait on
 * the account's owner; null when both have it.
 */
export function attachLacks(standing) {
  const what = ["Contents read and write"];
  if (standing.app?.permissions?.contents !== "write")
    return { where: "app", what, slug: standing.slug };
  if (standing.installation?.permissions?.contents !== "write")
    return { where: "installation", what, slug: standing.slug, url: standing.installation.url };
  return null;
}
