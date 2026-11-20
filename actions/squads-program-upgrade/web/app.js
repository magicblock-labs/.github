// Devnet approval page for Squads v4 multisigs: the browser twin of
// approve.mjs. Decoding and every check come from review.mjs, so whatever the
// CLI refuses to approve or execute is refused here too. Devnet only. The
// member's own wallet signs, and the page stores nothing but addresses, the
// RPC URL and the CI hashes it has already looked up.

import * as multisig from "@sqds/multisig";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { confirmSignature } from "../confirm.mjs";
import {
  DEVNET_GENESIS,
  EXECUTE_UNITS,
  PERMISSIONS,
  VOTE_UNITS,
  assess,
  createReviewer,
  permissionNames,
  short,
} from "../review.mjs";
import { findBuild, githubRepo } from "./ci.js";
import * as wallets from "./wallet.js";

const DEFAULT_RPC = "https://rpc.magicblock.app/devnet";
const DEFAULT_MULTISIG = {
  address: "GSyqP2jfyoEPHWcRNUBa251HtkZMXTHqFPHzeNjhCspr",
  label: "MagicBlock program upgrades",
};
const STORAGE_KEY = "squads-devnet-approvals";
const MIN_FEE_BALANCE = 10_000; // lamports, the same floor approve.mjs uses
const MAX_AGE_DAYS = 30; // older open proposals are hidden, not acted on

const $ = (id) => document.getElementById(id);
const explorer = (kind, id) => `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;
const isoTime = (seconds) => new Date(seconds * 1000).toISOString().replace(".000", "");
const BASE58_KEY = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
const clip = (text) => `${text.slice(0, 4)}…${text.slice(-4)}`;
const RECHECK_MS = 5 * 60_000; // how long a fruitless CI lookup is trusted before asking GitHub again

// Builds DOM from text only: on-chain strings never reach innerHTML.
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (name.startsWith("on")) el.addEventListener(name.slice(2), value);
    else if (name === "class") el.className = value;
    else el.setAttribute(name, value === true ? "" : value);
  }
  return fill(el, ...children);
}
// replaceChildren, skipping empty slots and flattening nested lists like h().
function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return el;
}
const link = (href, text) => h("a", { href, target: "_blank", rel: "noopener noreferrer" }, text);
const addressLink = (key, text = short(key)) => link(explorer("address", key.toBase58()), text);

// --- settings ---------------------------------------------------------------

function isAddress(value) {
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
  } catch {
    // private window or blocked storage: run on defaults
  }
  const multisigs = (Array.isArray(saved.multisigs) ? saved.multisigs : [])
    .filter((m) => isAddress(m?.address) && m.address !== DEFAULT_MULTISIG.address)
    .map((m) => ({ address: m.address, label: typeof m.label === "string" ? m.label : "" }));
  return {
    rpc: typeof saved.rpc === "string" && saved.rpc ? saved.rpc : DEFAULT_RPC,
    multisigs,
    selected: isAddress(saved.selected) ? saved.selected : DEFAULT_MULTISIG.address,
    wallet: typeof saved.wallet === "string" ? saved.wallet : null,
  };
}

const settings = loadSettings();
function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // not persisted; everything still works for this visit
  }
}
const allMultisigs = () => [DEFAULT_MULTISIG, ...settings.multisigs];

// --- state ------------------------------------------------------------------

const state = {
  connection: null,
  multisigPda: null,
  ms: null,
  reviewer: null,
  proposals: [], // { index, proposal, decoded, error, timelock }
  hiddenOld: 0, // open proposals left out for age
  hashes: new Map(), // "<multisig>#<index>" -> executable hash, from CI or pasted
  ci: new Map(), // "<multisig>#<index>" -> { status: loading|found|missing|error, hash, runUrl, reason }
  wallet: null,
  account: null, // Wallet Standard account
  key: null, // its PublicKey
  balance: null,
  unwatch: () => {},
  busy: false,
};

const memberEntry = () => (state.key && state.ms?.members.find((m) => m.key.equals(state.key))) || null;
const can = (name) => Boolean(memberEntry()?.permissions.mask & PERMISSIONS[name]);
const keyOf = (index) => `${state.multisigPda?.toBase58()}#${index}`;
const hashFor = (index) => state.hashes.get(keyOf(index))?.trim().toLowerCase() || undefined;

// --- status line ------------------------------------------------------------

function report(kind, ...parts) {
  fill($("status"), h("div", { class: `notice ${kind}` }, ...parts));
}

function reportError(prefix, err) {
  const logs = err?.logs ?? err?.transactionLogs ?? [];
  report("error", `${prefix}: ${err?.message ?? err}`, logs.length ? h("pre", {}, logs.join("\n")) : null);
}

// --- RPC and multisig -------------------------------------------------------

async function useRpc(url) {
  $("rpc").value = url;
  $("rpc-state").textContent = "checking…";
  $("rpc-state").className = "muted";
  try {
    const connection = new Connection(url, "confirmed");
    const genesis = await connection.getGenesisHash();
    if (genesis !== DEVNET_GENESIS) {
      throw new Error(`not devnet (genesis ${genesis}). This page only works on devnet; use the Squads app elsewhere`);
    }
    state.connection = connection;
    settings.rpc = url;
    saveSettings();
    $("rpc-state").textContent = "devnet";
    $("rpc-state").className = "ok";
    return true;
  } catch (err) {
    // Keep working on the last good RPC, if there is one.
    const reason = err.message.startsWith("not devnet") ? err.message : `unreachable: ${err.message.split("\n")[0]}`;
    const still = state.connection ? `; still using ${settings.rpc}` : "";
    $("rpc-state").textContent = `${url} refused: ${reason}${still}`;
    $("rpc-state").className = "bad";
    return false;
  }
}

function renderPicker() {
  fill($("multisig"), ...allMultisigs().map((m) =>
    h("option", { value: m.address, selected: m.address === settings.selected },
      `${m.label ? `${m.label} · ` : ""}${short(new PublicKey(m.address))}`)));
  $("remove").hidden = settings.selected === DEFAULT_MULTISIG.address;
}

async function load() {
  if (!state.connection) return;
  const address = settings.selected;
  state.multisigPda = new PublicKey(address);
  fill($("proposals"), h("p", { class: "muted" }, "Loading proposals…"));
  try {
    const ms = await multisig.accounts.Multisig.fromAccountAddress(state.connection, state.multisigPda, "confirmed");
    if (settings.selected !== address) return; // switched while loading
    state.ms = ms;
    state.reviewer = createReviewer({ connection: state.connection, multisigPda: state.multisigPda, ms });
    state.proposals = await openProposals();
    if (settings.selected !== address) return;
    await refreshBalance();
    render();
    for (const entry of state.proposals) lookUpBuild(entry);
  } catch (err) {
    state.ms = null;
    fill($("members"));
    fill($("members-summary"));
    fill($("proposals"), h("p", { class: "bad" }, `Could not load multisig ${address}: ${err.message}`));
  }
}

// Active and approved proposals newer than the last config change (the range
// `approve.mjs list` shows; older ones are stale and can't execute), minus any
// whose status hasn't changed in MAX_AGE_DAYS. Proposal accounts are fetched
// in batches rather than one request per index.
async function openProposals() {
  const { reviewer, ms, connection, multisigPda } = state;
  const stale = BigInt(ms.staleTransactionIndex.toString());
  const last = BigInt(ms.transactionIndex.toString());
  const cutoff = Date.now() / 1000 - MAX_AGE_DAYS * 86_400;
  const indexes = [];
  for (let index = last; index > stale; index--) indexes.push(index);

  const open = [];
  state.hiddenOld = 0;
  for (let i = 0; i < indexes.length; i += 100) {
    const batch = indexes.slice(i, i + 100);
    const pdas = batch.map((index) => multisig.getProposalPda({ multisigPda, transactionIndex: index })[0]);
    const infos = await connection.getMultipleAccountsInfo(pdas, "confirmed");
    for (const [j, info] of infos.entries()) {
      if (!info) continue;
      const [proposal] = multisig.accounts.Proposal.fromAccountInfo(info);
      const status = proposal.status.__kind;
      if (status !== "Active" && status !== "Approved") continue;
      // Active: when it was proposed. Approved: when it reached the threshold.
      if (Number(proposal.status.timestamp) < cutoff) {
        state.hiddenOld++;
        continue;
      }
      open.push({ index: batch[j], proposal, decoded: null, error: null, timelock: null });
    }
  }
  for (const entry of open) {
    try {
      entry.decoded = await reviewer.decode(entry.index);
    } catch (err) {
      entry.error = err.message;
    }
    if (entry.proposal.status.__kind === "Approved") entry.timelock = await reviewer.timelock(entry.index);
  }
  return open;
}

// The commit a proposal's verify record says the upgrade was built from.
function sourceOf(decoded) {
  const [upgrade] = decoded?.upgrades ?? [];
  const record = upgrade && decoded.verifies?.find((v) => v.target === upgrade.programId && v.commit);
  const repo = githubRepo(record?.gitUrl);
  return repo ? { repo, commit: record.commit } : null;
}

// Fills in the CI hash for single-upgrade proposals, from the run's annotation.
async function lookUpBuild(entry) {
  const key = keyOf(entry.index);
  const source = sourceOf(entry.decoded);
  const known = state.ci.get(key);
  if (entry.decoded?.upgrades.length !== 1 || !source) return;
  if (known?.status === "found" || known?.status === "loading") return;
  if (known && Date.now() - known.checkedAt < RECHECK_MS) return;
  state.ci.set(key, { status: "loading" });
  try {
    const [transactionPda] = multisig.getTransactionPda({ multisigPda: state.multisigPda, index: entry.index });
    const signatures = await state.connection.getSignaturesForAddress(transactionPda, { limit: 1000 }, "confirmed");
    const createdAt = signatures.at(-1)?.blockTime;
    if (!createdAt) throw new Error("could not tell when the proposal was created");
    const build = await findBuild({ ...source, buffer: entry.decoded.upgrades[0].buffer, createdAt });
    if (build) {
      state.ci.set(key, { status: "found", ...build });
      state.hashes.set(key, build.hash);
    } else {
      state.ci.set(key, { status: "missing", checkedAt: Date.now() });
    }
  } catch (err) {
    state.ci.set(key, { status: "error", reason: err.message, checkedAt: Date.now() });
  }
  if (keyOf(entry.index) === key) render(); // still showing this multisig
}

async function refreshBalance() {
  state.balance = state.key && state.connection ? await state.connection.getBalance(state.key) : null;
}

// --- wallet -----------------------------------------------------------------

async function connectWallet(wallet, { silent = false } = {}) {
  try {
    const account = await wallets.connect(wallet, { silent });
    if (!account) {
      if (!silent) report("error", `${wallet.name} has no account that can sign transactions.`);
      return;
    }
    useAccount(wallet, account);
    settings.wallet = wallet.name;
    saveSettings();
    state.unwatch();
    state.unwatch = wallets.onAccountsChange(wallet, async () => {
      const next = wallets.signingAccount(wallet);
      if (!next) return disconnectWallet();
      useAccount(wallet, next);
      await refreshBalance();
      render();
    });
    await refreshBalance();
    render();
  } catch (err) {
    if (!silent) reportError(`Could not connect ${wallet.name}`, err);
  }
}

function useAccount(wallet, account) {
  Object.assign(state, { wallet, account, key: new PublicKey(account.address) });
}

async function disconnectWallet() {
  const { wallet } = state;
  state.unwatch();
  Object.assign(state, { wallet: null, account: null, key: null, balance: null, unwatch: () => {} });
  settings.wallet = null;
  saveSettings();
  render();
  try {
    await wallets.disconnect(wallet);
  } catch {
    // the page has already forgotten the account
  }
}

function renderWallet() {
  const box = $("wallet");
  if (state.account) {
    const member = memberEntry();
    fill(box,
      h("span", { class: "who" },
        h("span", { class: "mono" }, short(state.key)),
        h("span", { class: `tag ${member ? "ok" : "bad"}` }, member ? permissionNames(member.permissions.mask) : "not a member"),
        state.balance != null ? h("span", { class: "muted" }, `${(state.balance / 1e9).toFixed(2)} SOL`) : null),
      h("button", { class: "quiet", onclick: disconnectWallet }, "Disconnect"),
    );
    return;
  }
  const available = wallets.list();
  if (!available.length) {
    fill(box, h("span", { class: "muted" }, "No Solana wallet extension found"));
    return;
  }
  const menu = h("details", { class: "menu" },
    h("summary", { class: "button primary" }, "Connect wallet"),
    h("div", { class: "menu-list" }, available.map((w) =>
      h("button", { onclick: () => { menu.open = false; connectWallet(w); } },
        h("img", { src: w.icon, alt: "", width: 18, height: 18 }), w.name))));
  fill(box, menu);
}

// --- signing ----------------------------------------------------------------

// The wallet signs; the page simulates exactly what was signed, then sends it
// through its own RPC and confirms by polling. Some RPCs forward transactions
// without any preflight, and some have no websocket: neither matters here.
async function send(label, instructions, { units, lookupTables = [] }) {
  const { connection } = state;
  const latest = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: state.key,
    recentBlockhash: latest.blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }), ...instructions],
  }).compileToV0Message(lookupTables);
  const signed = await wallets.sign(state.wallet, state.account, new VersionedTransaction(message).serialize());
  const simulation = await connection.simulateTransaction(VersionedTransaction.deserialize(signed), {
    sigVerify: true,
    commitment: "confirmed",
  });
  if (simulation.value.err) {
    throw Object.assign(new Error(`simulation failed, nothing sent: ${JSON.stringify(simulation.value.err)}`),
      { logs: simulation.value.logs ?? [] });
  }
  const signature = await connection.sendRawTransaction(signed, { skipPreflight: true, maxRetries: 5 });
  report("info", `${label}: sent `, link(explorer("tx", signature), clip(signature)),
    ", waiting for confirmation…");
  const { err } = await confirmSignature(connection, signature, latest.lastValidBlockHeight);
  if (err) throw new Error(`${signature} failed on-chain: ${JSON.stringify(err)}`);
  return signature;
}

// What gets signed is what was just checked: decode and assess again first.
async function recheck(entry) {
  const decoded = await state.reviewer.decode(entry.index);
  const problems = assess(decoded, { hash: hashFor(entry.index) });
  if (problems.length) throw new Error(`the proposal no longer passes review: ${problems.join("; ")}`);
  return decoded;
}

const ACTIONS = {
  approve: { label: "Approve", done: "Approved" },
  "approve+execute": { label: "Approve + execute", done: "Approved and executed" },
  execute: { label: "Execute", done: "Executed" },
  reject: { label: "Reject", done: "Rejected" },
};

async function act(entry, action) {
  if (state.busy) return;
  state.busy = true;
  render();
  const { index } = entry;
  const { reviewer, key } = state;
  report("info", `#${index}: confirm “${ACTIONS[action].label}” in ${state.wallet.name}…`);
  try {
    let instructions;
    let options = { units: VOTE_UNITS };
    if (action === "reject") {
      instructions = [reviewer.voteInstruction("reject", index, key)];
    } else if (action === "approve") {
      await recheck(entry);
      instructions = [reviewer.voteInstruction("approve", index, key)];
    } else {
      if (action === "execute") {
        const { timeLock, now, readyAt } = await reviewer.timelock(index);
        if (now < readyAt) throw new Error(`the ${timeLock}s timelock ends at ${isoTime(readyAt)}`);
      }
      const decoded = await recheck(entry);
      const execute = await reviewer.executeInstructions(index, decoded, key);
      // Approving and executing in one transaction: both happen or neither.
      instructions = action === "execute"
        ? execute.instructions
        : [reviewer.voteInstruction("approve", index, key), ...execute.instructions];
      options = { units: EXECUTE_UNITS, lookupTables: execute.lookupTables };
    }
    const signature = await send(`#${index}`, instructions, options);
    report("ok", `${ACTIONS[action].done} #${index}: `, link(explorer("tx", signature), signature));
  } catch (err) {
    reportError(`#${index}: ${ACTIONS[action].label.toLowerCase()} failed`, err);
  } finally {
    state.busy = false;
    await load();
  }
}

// --- rendering --------------------------------------------------------------

function render() {
  renderWallet();
  if (!state.ms) return;
  const { ms } = state;
  fill($("proposals"),
    ...(state.proposals.length ? state.proposals.map(card) : [h("p", { class: "empty" }, "No open proposals.")]),
    state.hiddenOld
      ? h("p", { class: "muted small" }, `${state.hiddenOld} older open proposal${state.hiddenOld === 1 ? " is" : "s are"} ` +
        `hidden (no activity in ${MAX_AGE_DAYS} days); approve.mjs lists ${state.hiddenOld === 1 ? "it" : "them"}.`)
      : null);
  const [vault] = multisig.getVaultPda({ multisigPda: state.multisigPda, index: 0 });
  fill($("members-summary"),
    `${ms.threshold} of ${ms.members.length} · timelock ${ms.timeLock}s · vault `, addressLink(vault));
  fill($("members"), ...ms.members.map((m) => {
    const you = state.key && m.key.equals(state.key);
    return h("li", { class: you ? "you" : null },
      addressLink(m.key, m.key.toBase58()),
      h("span", { class: "tag" }, permissionNames(m.permissions.mask)),
      you ? h("span", { class: "tag ok" }, "you") : null);
  }));
}

// What the proposal does, in one line: its first decoded instruction.
function titleOf(entry) {
  if (entry.error) return "Could not decode";
  const line = entry.decoded.lines.find((l) => /^\d+\. /.test(l)) ?? entry.decoded.lines[0];
  return line.replace(/^\d+\. /, "").replace(BASE58_KEY, clip)
    .replace(/^[A-Z]{2,}(?: [A-Z]{2,})*\b/, (verb) => verb[0] + verb.slice(1).toLowerCase());
}

function card(entry) {
  const { index, proposal, decoded } = entry;
  const status = proposal.status.__kind;
  const upgrades = decoded?.upgrades ?? [];
  const reviewProblems = entry.error ? [`could not decode (${entry.error}); reject it or review it by other means`]
    : decoded.problems;
  const controls = h("div", { class: "controls" });

  // Same order of checks as approve.mjs `review`.
  function update() {
    const problems = decoded ? assess(decoded, { hash: hashFor(index) }) : ["undecodable"];
    const member = memberEntry();
    const voted = state.key && [...proposal.approved, ...proposal.rejected].some((k) => k.equals(state.key));
    let blocker = !state.key ? "Connect a member's wallet to vote."
      : !member ? "The connected wallet is not a member of this multisig."
        : state.balance < MIN_FEE_BALANCE ? "The connected wallet needs a little devnet SOL for fees."
          : null;
    const button = (action, cls, enabled) =>
      h("button", { class: cls, disabled: !enabled || state.busy, onclick: () => act(entry, action) }, ACTIONS[action].label);
    let buttons;
    let note = null;
    if (status === "Active") {
      if (!blocker && voted) blocker = "You have already voted; waiting for the other members.";
      if (!blocker && !can("Vote")) blocker = `Voting needs Vote; you have ${permissionNames(member.permissions.mask)}.`;
      const approvable = !blocker && !problems.length;
      if (!blocker && !approvable) {
        note = reviewProblems.length ? "Approval is blocked by the problems above; you can still reject."
          : "Approval needs the CI build hash to match the buffer.";
      }
      // Your approval reaches the threshold and nothing makes execution wait.
      const finishes = approvable && can("Execute") && proposal.approved.length + 1 >= state.ms.threshold &&
        state.ms.timeLock === 0;
      buttons = [
        finishes ? button("approve+execute", "primary", true) : null,
        button("approve", finishes ? "" : "primary", approvable),
        button("reject", "danger", !blocker),
      ];
    } else {
      const { now, readyAt } = entry.timelock;
      if (!blocker && !can("Execute")) blocker = "Approved. Executing needs a member with Execute.";
      if (!blocker && problems.length) {
        blocker = reviewProblems.length ? "Not executable while the problems above remain."
          : "Executing needs the CI build hash to match the buffer.";
      }
      if (!blocker && now < readyAt) blocker = `Approved; the timelock ends at ${isoTime(readyAt)}. Reload then to execute.`;
      buttons = [button("execute", "primary", !blocker)];
    }
    fill(controls, ...buttons, blocker || note ? h("span", { class: "muted small" }, blocker ?? note) : null);
  }
  update();

  const votes = `${proposal.approved.length}/${state.ms.threshold} approved` +
    (proposal.rejected.length ? ` · ${proposal.rejected.length} rejected` : "");
  return h("article", { class: "card" },
    h("header", {},
      h("span", { class: "index" }, `#${index}`),
      h("span", { class: "title" }, titleOf(entry)),
      h("span", { class: `pill ${status.toLowerCase()}` }, status),
      h("span", { class: "votes muted", title: state.reviewer.votes(proposal) }, votes)),
    upgrades.length ? buildFacts(entry, update) : null,
    reviewProblems.length ? h("ul", { class: "problems" }, reviewProblems.map((p) => h("li", {}, p))) : null,
    decoded ? h("details", { class: "decoded", open: !upgrades.length || reviewProblems.length > 0 },
      h("summary", {}, "Decoded instructions"), h("pre", {}, decoded.lines.join("\n"))) : null,
    controls);
}

// Upgrades are approved against the executable hash CI built: the buffer's own
// hash proves nothing until it matches. The page fetches CI's record when the
// run left one, and otherwise takes the hash from the job summary by hand.
function buildFacts(entry, onHashChange) {
  const { index, decoded } = entry;
  const source = sourceOf(decoded);
  const ci = state.ci.get(keyOf(index));
  const verdict = h("span");
  const showVerdict = () => {
    const hash = hashFor(index);
    const ok = hash && decoded.upgrades.every((u) => u.hash === hash);
    verdict.textContent = !hash ? "" : ok ? "✓ matches the buffer" : "✗ does not match the buffer";
    verdict.className = ok ? "ok" : "bad";
  };

  let ciValue;
  if (ci?.status === "found") {
    ciValue = [h("span", { class: "mono" }, ci.hash), " ", verdict, " · ", link(ci.runUrl, "CI run")];
  } else {
    const input = h("input", {
      class: "mono",
      placeholder: "paste the executable hash from the CI job summary",
      spellcheck: "false",
      autocomplete: "off",
      value: state.hashes.get(keyOf(index)) ?? "",
      oninput: (e) => {
        state.hashes.set(keyOf(index), e.target.value);
        showVerdict();
        onHashChange();
      },
    });
    const why = ci?.status === "loading" ? "Looking up the CI run…"
      : ci?.status === "error" ? `Couldn't fetch it from CI: ${ci.reason}.`
        : ci?.status === "missing" ? "This run left no record (older action version, or still running)."
          : null;
    ciValue = [h("span", { class: "paste" }, input, verdict), why ? h("span", { class: "muted small" }, why) : null];
  }
  showVerdict();

  return h("dl", { class: "facts" },
    source ? [h("dt", {}, "Source"), h("dd", {},
      link(`https://github.com/${source.repo}/commit/${source.commit}`, `${source.repo}@${source.commit.slice(0, 7)}`))] : null,
    decoded.upgrades.map((u) => [h("dt", {}, "Buffer hash"), h("dd", { class: "mono" }, u.hash)]),
    h("dt", {}, "CI build"), h("dd", {}, ciValue));
}

// --- wiring -----------------------------------------------------------------

$("multisig").addEventListener("change", (e) => {
  settings.selected = e.target.value;
  saveSettings();
  renderPicker();
  load();
});

$("remove").addEventListener("click", () => {
  settings.multisigs = settings.multisigs.filter((m) => m.address !== settings.selected);
  settings.selected = DEFAULT_MULTISIG.address;
  saveSettings();
  renderPicker();
  load();
});

$("add").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const address = form.address.value.trim();
  const label = form.label.value.trim();
  if (!isAddress(address)) return report("error", `${address || "(empty)"} is not an address.`);
  if (!state.connection) return report("error", "Connect to a devnet RPC first.");
  try {
    const info = await state.connection.getAccountInfo(new PublicKey(address));
    if (!info?.owner.equals(multisig.PROGRAM_ID)) throw new Error("not owned by Squads");
    multisig.accounts.Multisig.fromAccountInfo(info);
  } catch {
    return report("error", `${address} is not a Squads v4 multisig on devnet.`);
  }
  if (!allMultisigs().some((m) => m.address === address)) settings.multisigs.push({ address, label });
  settings.selected = address;
  saveSettings();
  form.reset();
  renderPicker();
  report("ok", `Added ${label || address}.`);
  load();
});

$("rpc-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (await useRpc($("rpc").value.trim() || DEFAULT_RPC)) load();
});

$("reset-rpc").addEventListener("click", async () => {
  if (await useRpc(DEFAULT_RPC)) load();
});

$("refresh").addEventListener("click", () => load());

wallets.onRegister(() => {
  renderWallet();
  // Reconnect the wallet used last time, without a popup, once it registers.
  const last = !state.wallet && settings.wallet && wallets.list().find((w) => w.name === settings.wallet);
  if (last) connectWallet(last, { silent: true });
});

renderPicker();
renderWallet();
if (await useRpc(settings.rpc)) await load();
const last = settings.wallet && wallets.list().find((w) => w.name === settings.wallet);
if (last && !state.wallet) await connectWallet(last, { silent: true });
