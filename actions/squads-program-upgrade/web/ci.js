// Finds the executable hash that CI recorded for an upgrade buffer, so
// approvers don't copy it from the job summary by hand.
//
// After proposing, the squads-program-upgrade action leaves a public
// annotation on its run: "buffer=<address> executable-hash=<sha256> commit=…".
// It counts only when it comes from a workflow_dispatch run in the proposal's
// own repository: dispatching needs write access, and the buffer address is
// made after the build, so no code in the build can forge a matching record.
// GitHub allows 60 anonymous API requests an hour; found hashes are cached.

const API = "https://api.github.com";
const WINDOW_SECONDS = 6 * 3600; // GitHub's job time limit: the run started at most this long before proposing
const CACHE_KEY = "squads-devnet-approvals:ci";

export const githubRepo = (gitUrl) =>
  /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(gitUrl ?? "")?.[1] ?? null;

function readCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function writeCache(buffer, build) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ...readCache(), [buffer]: build }));
  } catch {
    // looked up again next time
  }
}

async function get(path) {
  const response = await fetch(`${API}${path}`, { headers: { Accept: "application/vnd.github+json" } });
  if (!response.ok) {
    const limited = response.headers.get("x-ratelimit-remaining") === "0";
    throw new Error(limited ? "GitHub's 60 anonymous lookups per hour are used up" : `GitHub answered ${response.status}`);
  }
  return response.json();
}

const fieldsOf = (message) =>
  Object.fromEntries((message ?? "").split(/\s+/).map((pair) => pair.split("=")).filter((kv) => kv.length === 2));

const iso = (seconds) => new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

// Returns { hash, runUrl } or null if no run recorded this buffer.
export async function findBuild({ repo, buffer, commit, createdAt }) {
  const cached = readCache()[buffer];
  if (cached) return cached;

  const created = `${iso(createdAt - WINDOW_SECONDS)}..${iso(createdAt + 300)}`;
  const { workflow_runs: runs } =
    await get(`/repos/${repo}/actions/runs?event=workflow_dispatch&created=${encodeURIComponent(created)}&per_page=30`);
  const found = [];
  for (const run of runs) {
    if (run.event !== "workflow_dispatch" || run.head_repository?.full_name.toLowerCase() !== repo.toLowerCase()) continue;
    const { jobs } = await get(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`);
    for (const job of jobs) {
      for (const annotation of await get(`/repos/${repo}/check-runs/${job.id}/annotations?per_page=100`)) {
        const fields = fieldsOf(annotation.message);
        if (fields.buffer !== buffer || !/^[0-9a-f]{64}$/.test(fields["executable-hash"] ?? "")) continue;
        if (commit && fields.commit && fields.commit !== commit) {
          throw new Error(`CI built ${fields.commit.slice(0, 7)}, but the proposal claims ${commit.slice(0, 7)}`);
        }
        found.push({ hash: fields["executable-hash"], runUrl: job.html_url ?? run.html_url });
      }
    }
  }
  if (new Set(found.map((f) => f.hash)).size > 1) throw new Error("CI recorded different hashes for this buffer");
  if (!found.length) return null;
  writeCache(buffer, found[0]);
  return found[0];
}
