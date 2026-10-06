// Review and vote on Squads v4 proposals from a local keypair: the devnet
// counterpart of the Squads web app, which mainnet uses instead.
//
//   node approve.mjs --multisig <pda> [--keypair <path>] list
//   node approve.mjs --multisig <pda> --keypair <path> <index> [--hash <executable hash>]
//
// Every instruction is decoded before anything is signed. Program upgrades are
// checked against the build hash from the CI job summary. Each action must be
// typed out. Devnet only, and never in CI: approval keys stay on the machine
// of the person who holds them.

import crypto from "node:crypto";
import fs from "node:fs";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import * as multisig from "@sqds/multisig";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const OTTER_VERIFY = "verifycLy8mB96wd9wqq3WDXQwM4oU6r42Th37Db9fC";
const COMPUTE_BUDGET = ComputeBudgetProgram.programId.toBase58();
const BUFFER_HEADER = 37; // u32 tag + Option<Pubkey>
const PERMISSIONS = { Initiate: 1, Vote: 2, Execute: 4 };
// otter-verify Anchor discriminators, as used by solana-verify.
const VERIFY_KINDS = {
  "afaf6d1f0d989bed": "initialize",
  "dbc858b09e3ffd7f": "update",
  "62a5c9b16c41ce60": "close",
};

const USAGE = `Usage:
  node approve.mjs --multisig <pda> [--keypair <path>] [--rpc <url>] list
  node approve.mjs --multisig <pda> --keypair <path> [--rpc <url>] <index> [--hash <executable hash> | --no-hash-check]`;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      multisig: { type: "string" },
      keypair: { type: "string" },
      rpc: { type: "string", default: "https://api.devnet.solana.com" },
      hash: { type: "string" },
      "no-hash-check": { type: "boolean", default: false },
      "allow-localnet": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
} catch (err) {
  fail(`${err.message}\n${USAGE}`);
}
const { values: opts, positionals } = parsed;
if (opts.help || positionals.length !== 1 || !opts.multisig) {
  console.log(USAGE);
  process.exit(opts.help ? 0 : 1);
}

// --- guards -----------------------------------------------------------------

if (process.env.CI || process.env.GITHUB_ACTIONS) {
  fail("refusing to run in CI: approval keys must stay with the people who hold them");
}

const connection = new Connection(opts.rpc, "confirmed");
const genesis = await connection.getGenesisHash();
const localnet = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(opts.rpc);
if (genesis !== DEVNET_GENESIS && !(opts["allow-localnet"] && localnet)) {
  fail(`the RPC is not devnet (genesis ${genesis}); use the Squads app on other clusters`);
}

const multisigPda = new PublicKey(opts.multisig);
const ms = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda);
const staleIndex = BigInt(ms.staleTransactionIndex.toString());
const lastIndex = BigInt(ms.transactionIndex.toString());

const signer = opts.keypair
  ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(opts.keypair, "utf8"))))
  : null;
const memberEntry = signer && ms.members.find((m) => m.key.equals(signer.publicKey));
const can = (name) => Boolean(memberEntry && memberEntry.permissions.mask & PERMISSIONS[name]);
const short = (key) => `${key.toBase58().slice(0, 4)}…${key.toBase58().slice(-4)}`;
const permissionNames = (mask) => Object.keys(PERMISSIONS).filter((n) => mask & PERMISSIONS[n]).join("+") || "none";

// --- decoding ---------------------------------------------------------------

function bufferHash(data) {
  let end = data.length;
  while (end > BUFFER_HEADER && data[end - 1] === 0) end--;
  return crypto.createHash("sha256").update(data.subarray(BUFFER_HEADER, end)).digest("hex");
}

// otter-verify initialize/update: 8-byte discriminator, then Borsh
// { version: String, git_url: String, commit: String, args: Vec<String>, deployed_slot: u64 }.
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function decodeVerifyParams(data) {
  let offset = 8;
  const take = (n) => {
    if (offset + n > data.length) throw new RangeError("truncated");
    offset += n;
    return offset - n;
  };
  const string = () => {
    const length = data.readUInt32LE(take(4));
    return UTF8.decode(data.subarray(take(length), offset)); // throws on invalid UTF-8, as Borsh does
  };
  try {
    const version = string();
    const gitUrl = string();
    const commit = string();
    const count = data.readUInt32LE(take(4));
    if (count * 4 > data.length - offset) return null; // each string needs at least its 4-byte length
    const args = Array.from({ length: count }, string);
    const deployedSlot = data.readBigUInt64LE(take(8));
    if (offset !== data.length) return null; // trailing bytes: not this schema
    return { version, gitUrl, commit, args, deployedSlot };
  } catch {
    return null;
  }
}

// Returns { kind, lines, upgrades: [{ buffer, hash }], problems: [] }.
async function decode(index) {
  const [transactionPda] = multisig.getTransactionPda({ multisigPda, index });
  const info = await connection.getAccountInfo(transactionPda);
  if (!info) return { kind: "missing", lines: ["transaction account closed or never created"], upgrades: [], problems: [] };

  // Pick the account type first, so an error while decoding a vault
  // transaction surfaces as such rather than as a failed config parse.
  let vaultTx;
  try {
    [vaultTx] = multisig.accounts.VaultTransaction.fromAccountInfo(info);
  } catch {
    const [configTx] = multisig.accounts.ConfigTransaction.fromAccountInfo(info);
    return decodeConfig(configTx);
  }
  return decodeVault(vaultTx);
}

// Account keys in v0 order: static keys, then every table's writable entries,
// then every table's read-only entries. Unresolvable entries stay undefined.
async function resolveKeys(msg) {
  const writable = [];
  const readonly = [];
  for (const lookup of msg.addressTableLookups) {
    const table = (await connection.getAddressLookupTable(lookup.accountKey)).value;
    const at = (i) => table?.state.addresses[i];
    writable.push(...[...lookup.writableIndexes].map(at));
    readonly.push(...[...lookup.readonlyIndexes].map(at));
  }
  return [...msg.accountKeys, ...writable, ...readonly];
}

async function decodeVault(vaultTx) {
  const msg = vaultTx.message;
  const [vault] = multisig.getVaultPda({ multisigPda, index: vaultTx.vaultIndex });
  const keys = await resolveKeys(msg);
  const lines = [`vault ${vaultTx.vaultIndex} transaction by ${vaultTx.creator.toBase58()}`];
  const upgrades = [];
  const verifies = [];
  const problems = [];
  const others = []; // instructions that are neither an upgrade, a verify write nor compute budget
  if (msg.addressTableLookups.length) {
    lines.push(`uses ${msg.addressTableLookups.length} address lookup table(s), resolved below`);
  }
  if (keys.some((k) => !k)) problems.push("some lookup-table accounts could not be resolved");
  for (const [i, ix] of msg.instructions.entries()) {
    const program = keys[ix.programIdIndex]?.toBase58() ?? `lookup#${ix.programIdIndex}`;
    const accounts = [...ix.accountIndexes].map((a) => keys[a]?.toBase58() ?? `lookup#${a}`);
    const data = Buffer.from(ix.data);
    const tag = data.length >= 4 ? data.readUInt32LE(0) : -1;

    if (program === LOADER && tag === 3) {
      if (accounts.length < 7) {
        problems.push(`instruction ${i}: malformed loader Upgrade (${accounts.length} accounts, expected 7)`);
        lines.push(`${i}. UPGRADE: MALFORMED, review manually`);
        continue;
      }
      const [, programId, buffer, spill] = accounts;
      lines.push(`${i}. UPGRADE program ${programId}`, `   buffer ${buffer}, lamports refunded to ${spill}`);
      if (buffer.startsWith("lookup#")) {
        problems.push(`upgrade buffer ${buffer} could not be resolved`);
        continue;
      }
      const account = await connection.getAccountInfo(new PublicKey(buffer), "confirmed");
      if (!account) {
        problems.push(`buffer ${buffer} does not exist`);
        continue;
      }
      // The hash only means something if nobody but the vault can rewrite the
      // buffer: it must be a loader Buffer whose authority is already the vault.
      const isBuffer = account.owner.toBase58() === LOADER && account.data.length >= BUFFER_HEADER &&
        account.data.readUInt32LE(0) === 1;
      const authority = isBuffer && account.data[4] === 1 ? new PublicKey(account.data.subarray(5, 37)) : null;
      if (!isBuffer) {
        problems.push(`${buffer} is not a loader buffer`);
        continue;
      }
      if (!authority?.equals(vault)) {
        problems.push(`buffer authority is ${authority?.toBase58() ?? "none"}, not the vault ${vault.toBase58()}: ` +
          "its contents could still change after review");
      }
      lines.push(`   buffer authority ${authority?.toBase58() ?? "none"}`);
      const hash = bufferHash(account.data);
      upgrades.push({ buffer, hash, programId });
      lines.push(`   buffer hash ${hash}`);
    } else if (program === LOADER && tag === 4) {
      others.push(i);
      lines.push(`${i}. SET AUTHORITY of ${accounts[0]} -> ${accounts[2] ?? "none (makes it immutable)"}`);
    } else if (program === LOADER && tag === 6) {
      others.push(i);
      if (data.length < 8 || accounts.length < 2) {
        problems.push(`instruction ${i}: malformed loader Extend`);
        lines.push(`${i}. EXTEND: MALFORMED, review manually`);
      } else {
        lines.push(`${i}. EXTEND program ${accounts[1]} by ${data.readUInt32LE(4)} bytes`);
      }
    } else if (program === OTTER_VERIFY) {
      const kind = VERIFY_KINDS[data.subarray(0, 8).toString("hex")];
      const [pda, authority, target] = accounts;
      if (!kind) {
        problems.push(`instruction ${i}: unknown otter-verify instruction`);
        lines.push(`${i}. otter-verify: UNKNOWN instruction, review manually`);
        continue;
      }
      const p = kind === "close" ? null : decodeVerifyParams(data);
      verifies.push({ i, kind, pda, authority, target, gitUrl: p?.gitUrl, commit: p?.commit });
      if (kind === "close") others.push(i);
      if (kind !== "close" && !p) problems.push(`instruction ${i}: malformed otter-verify ${kind} payload`);
      lines.push(`${i}. VERIFY PDA ${kind.toUpperCase()} for program ${target}` +
        (p ? `: ${p.gitUrl} @ ${p.commit}, args [${p.args.join(" ")}], solana-verify ${p.version}` : ""));
    } else if (program === COMPUTE_BUDGET) {
      lines.push(`${i}. compute budget`);
    } else {
      others.push(i);
      lines.push(`${i}. ${program}: ${data.length} bytes of data, ${accounts.length} accounts; NOT DECODED, review manually`);
    }
  }
  // An upgrade proposal may contain only the upgrade, its verify record and
  // compute budget. Anything else riding along must go in its own proposal.
  if (upgrades.length) {
    for (const i of others) problems.push(`instruction ${i} is not allowed in an upgrade proposal`);
  }
  // A verification record must describe a program this proposal upgrades,
  // written by this vault at the address otter-verify derives for that pair.
  const upgraded = new Set(upgrades.map((u) => u.programId));
  for (const v of verifies) {
    if (upgrades.length && !upgraded.has(v.target)) {
      problems.push(`instruction ${v.i}: verify record targets ${v.target}, which this proposal does not upgrade`);
    }
    if (v.authority !== vault.toBase58()) {
      problems.push(`instruction ${v.i}: verify record signed by ${v.authority}, not the vault ${vault.toBase58()}`);
    }
    let expected = null;
    try {
      [expected] = PublicKey.findProgramAddressSync(
        [Buffer.from("otter_verify"), new PublicKey(v.authority).toBuffer(), new PublicKey(v.target).toBuffer()],
        new PublicKey(OTTER_VERIFY),
      );
    } catch {
      // unresolved lookup-table placeholder: already reported
    }
    if (!expected || expected.toBase58() !== v.pda) {
      problems.push(`instruction ${v.i}: verify record address ${v.pda} is not the PDA for ${v.target}`);
    }
  }
  return { kind: "vault", lines, upgrades, verifies, problems };
}

function decodeConfig(configTx) {
  const lines = [`config transaction by ${configTx.creator.toBase58()}`];
  for (const [i, action] of configTx.actions.entries()) {
    switch (action.__kind) {
      case "AddMember":
        lines.push(`${i}. ADD MEMBER ${action.newMember.key.toBase58()} (${permissionNames(action.newMember.permissions.mask)})`);
        break;
      case "RemoveMember":
        lines.push(`${i}. REMOVE MEMBER ${action.oldMember.toBase58()}`);
        break;
      case "ChangeThreshold":
        lines.push(`${i}. CHANGE THRESHOLD ${ms.threshold} -> ${action.newThreshold}`);
        break;
      case "SetTimeLock":
        lines.push(`${i}. SET TIMELOCK ${ms.timeLock}s -> ${action.newTimeLock}s`);
        break;
      case "SetRentCollector":
        lines.push(`${i}. SET RENT COLLECTOR -> ${action.newRentCollector?.toBase58?.() ?? "none"}`);
        break;
      case "AddSpendingLimit": {
        // Delegates spend without any vote, so who and where must be visible.
        const mint = action.mint.equals(PublicKey.default) ? "SOL" : action.mint.toBase58();
        const period = typeof action.period === "object" ? action.period.__kind : ["OneTime", "Day", "Week", "Month"][action.period];
        lines.push(`${i}. ADD SPENDING LIMIT on vault ${action.vaultIndex}: ${action.amount.toString()} of ${mint} per ${period}`);
        lines.push(`   spenders (no vote needed): ${action.members.map((k) => k.toBase58()).join(", ") || "none"}`);
        lines.push(action.destinations.length
          ? `   destinations: ${action.destinations.map((k) => k.toBase58()).join(", ")}`
          : "   destinations: ANY address (no restriction)");
        break;
      }
      case "RemoveSpendingLimit":
        lines.push(`${i}. REMOVE SPENDING LIMIT ${action.spendingLimit.toBase58()}`);
        break;
      default:
        lines.push(`${i}. ${action.__kind}: NOT DECODED, review manually`);
    }
  }
  return { kind: "config", lines, upgrades: [], problems: [], actions: configTx.actions };
}

async function proposalAt(index) {
  const [proposalPda] = multisig.getProposalPda({ multisigPda, transactionIndex: index });
  try {
    return await multisig.accounts.Proposal.fromAccountAddress(connection, proposalPda, "confirmed");
  } catch {
    return null;
  }
}

// --- signing ----------------------------------------------------------------

// Votes are cheap. Executing replays the proposal, so it gets the same ceiling
// the workflow simulated the upgrade with.
const VOTE_UNITS = 200_000;
const EXECUTE_UNITS = 1_400_000;

async function send(instructions, label, { units = VOTE_UNITS, lookupTables = [] } = {}) {
  const latest = await connection.getLatestBlockhash();
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: latest.blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }), ...instructions],
  }).compileToV0Message(lookupTables));
  tx.sign([signer]);
  let signature;
  try {
    signature = await connection.sendTransaction(tx);
  } catch (err) {
    const logs = err.transactionLogs ?? err.logs ?? [];
    fail(`${label} rejected: ${err.transactionMessage ?? err.message}${logs.length ? `\n${logs.join("\n")}` : ""}`);
  }
  const result = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  if (result.value.err) fail(`${label} failed (${signature}): ${JSON.stringify(result.value.err)}`);
  console.log(`${label}: ${signature}`);
}

// One reader for the whole run, so several answers can be typed (or piped)
// without the first prompt swallowing the rest.
const lines = [];
const waiting = [];
let inputClosed = false;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => (waiting.length ? waiting.shift()(line) : lines.push(line)));
rl.on("close", () => {
  inputClosed = true;
  while (waiting.length) waiting.shift()(null);
});
const nextLine = () =>
  lines.length ? Promise.resolve(lines.shift())
    : inputClosed ? Promise.resolve(null)
      : new Promise((resolve) => waiting.push(resolve));

async function ask(choices) {
  if ((await connection.getBalance(signer.publicKey)) < 10_000) {
    fail(`${signer.publicKey.toBase58()} has no SOL for fees; fund it with a little devnet SOL first`);
  }
  process.stdout.write(`Type ${choices.map((c) => `'${c}'`).join(" or ")} (anything else aborts): `);
  const answer = (await nextLine())?.trim() ?? "";
  if (!process.stdin.isTTY) process.stdout.write(`${answer}\n`);
  return choices.includes(answer) ? answer : null;
}

async function execute(index, decoded) {
  if (decoded.kind === "config") {
    const spendingLimits = decoded.actions.flatMap((a) =>
      a.__kind === "AddSpendingLimit" ? [multisig.getSpendingLimitPda({ multisigPda, createKey: a.createKey })[0]]
        : a.__kind === "RemoveSpendingLimit" ? [a.spendingLimit] : []);
    await send([multisig.instructions.configTransactionExecute({
      multisigPda, transactionIndex: index, member: signer.publicKey, rentPayer: signer.publicKey, spendingLimits,
    })], "executed", { units: EXECUTE_UNITS });
  } else {
    const { instruction, lookupTableAccounts } = await multisig.instructions.vaultTransactionExecute({
      connection, multisigPda, transactionIndex: index, member: signer.publicKey,
    });
    await send([instruction], "executed", { units: EXECUTE_UNITS, lookupTables: lookupTableAccounts });
  }
}

// --- commands ---------------------------------------------------------------

function header() {
  console.log(`Multisig ${multisigPda.toBase58()}: ${ms.threshold}-of-${ms.members.length}, timelock ${ms.timeLock}s`);
  for (const m of ms.members) {
    const you = signer && m.key.equals(signer.publicKey) ? "  <- you" : "";
    console.log(`  ${m.key.toBase58()}  ${permissionNames(m.permissions.mask)}${you}`);
  }
  if (signer && !memberEntry) console.log(`  ${signer.publicKey.toBase58()} (your keypair) is not a member`);
}

function votes(proposal) {
  const names = (keys) => keys.map(short).join(", ") || "-";
  return `${proposal.approved.length}/${ms.threshold} approved [${names(proposal.approved)}], ` +
    `${proposal.rejected.length} rejected [${names(proposal.rejected)}]`;
}

async function list() {
  header();
  let open = 0;
  for (let index = staleIndex + 1n; index <= lastIndex; index++) {
    const proposal = await proposalAt(index);
    const status = proposal?.status.__kind;
    if (status !== "Active" && status !== "Approved") continue;
    let decoded;
    let summary;
    try {
      decoded = await decode(index);
      summary = decoded.lines.slice(1).find((l) => /^\d+\. [A-Z]/.test(l)) ?? decoded.lines[0];
    } catch (err) {
      summary = `could not decode (${err.message}); review it before voting`;
    }
    console.log(`\n#${index} ${status}, ${votes(proposal)}\n  ${summary}`);
    open++;

    // For upgrades, show what to compare and the command to run. The hash is
    // the buffer's own, so it proves nothing until you match it against the
    // CI job summary: that comparison is the check.
    for (const { hash, programId } of decoded?.upgrades ?? []) {
      const source = decoded.verifies?.find((v) => v.target === programId && v.commit);
      console.log(`     buffer hash ${hash}` + (source ? ` (built from ${source.commit.slice(0, 7)})` : ""));
      if (decoded.problems.length) {
        console.log(`     review shows problems: ${decoded.problems.join("; ")}`);
        continue;
      }
      console.log(`     Compare with the executable hash in the CI job summary` +
        (source ? ` for ${source.gitUrl.replace(/^https:\/\/github\.com\//, "")}@${source.commit.slice(0, 7)}` : "") +
        "; if they match:");
      console.log(`     node approve.mjs --multisig ${multisigPda.toBase58()} --keypair ${opts.keypair ?? "<your keypair>"} ` +
        `${index} --hash ${hash}`);
    }
  }
  if (!open) console.log("\nNo open proposals.");
}

// Every upgrade must match the CI build unless the check is waived explicitly.
function assess(decoded) {
  const problems = [...decoded.problems];
  for (const { hash } of decoded.upgrades) {
    if (opts.hash) {
      if (hash !== opts.hash) problems.push(`buffer hash ${hash} does not match --hash ${opts.hash}`);
    } else if (!opts["no-hash-check"]) {
      problems.push("upgrade without --hash: pass the executable hash from the CI job summary (or --no-hash-check)");
    }
  }
  return problems;
}

async function review(index) {
  if (!signer) fail("--keypair is required to vote or execute");
  if (index < 1n || index > lastIndex) fail(`no transaction #${index} (last is #${lastIndex})`);

  header();
  const proposal = await proposalAt(index);
  let decoded;
  try {
    decoded = await decode(index);
  } catch (err) {
    decoded = { kind: "undecodable", lines: [`could not decode: ${err.message}`], upgrades: [],
      problems: ["the proposal could not be decoded; reject it or review it by other means"] };
  }
  console.log(`\n#${index}: ${proposal ? `${proposal.status.__kind}, ${votes(proposal)}` : "no proposal"}`);
  for (const line of decoded.lines) console.log(`  ${line}`);

  const problems = assess(decoded);
  if (opts.hash && decoded.upgrades.length && !problems.length) console.log("  buffer hash matches the CI build");
  for (const p of problems) console.log(`  PROBLEM: ${p}`);

  const status = proposal?.status.__kind;
  if (!memberEntry) fail("your keypair is not a member of this multisig");
  if (status !== "Active" && status !== "Approved") {
    console.log(`\nNothing to do: the proposal is ${status ?? "missing"}.`);
    return;
  }

  if (status === "Active") {
    if (index <= staleIndex) fail("the proposal is stale (the multisig config changed after it was created)");
    const voted = [...proposal.approved, ...proposal.rejected].some((k) => k.equals(signer.publicKey));
    if (voted) {
      console.log("\nYou have already voted; waiting for the other members.");
      return;
    }
    if (!can("Vote")) fail(`your permissions are ${permissionNames(memberEntry.permissions.mask)}; voting needs Vote`);
    const choices = problems.length ? ["reject"] : ["approve", "reject"];
    if (problems.length) console.log("\nApproval is blocked by the problems above; you can still reject.");
    const choice = await ask(choices);
    if (!choice) return console.log("Aborted; nothing signed.");
    const build = choice === "approve" ? multisig.instructions.proposalApprove : multisig.instructions.proposalReject;
    await send([build({ multisigPda, transactionIndex: index, member: signer.publicKey })], `${choice}d`);
    const after = await proposalAt(index);
    console.log(`Now ${after.status.__kind}: ${votes(after)}`);
    if (after.status.__kind !== "Approved") return;
  }

  if (!can("Execute")) {
    console.log("\nApproved. Executing needs a member with Execute.");
    return;
  }
  if (problems.length) fail("not executing while the problems above remain");

  // An approved proposal only becomes executable once the timelock has passed.
  // Squads checks the timelock current at execution, so read it fresh: once
  // before asking, and again right before sending.
  const timelockWait = async () => {
    const { timeLock } = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda, "confirmed");
    const approvedAt = Number((await proposalAt(index)).status.timestamp);
    const now = await connection.getBlockTime(await connection.getSlot());
    const readyAt = approvedAt + timeLock;
    if (now >= readyAt) return null;
    return `the ${timeLock}s timelock ends at ${new Date(readyAt * 1000).toISOString()} (${readyAt - now}s from now). ` +
      "Run this again then to execute.";
  };
  let wait = await timelockWait();
  if (wait) return console.log(`\nApproved; ${wait}`);
  console.log("\nThe proposal is approved and can be executed.");
  if ((await ask(["execute"])) !== "execute") return console.log("Not executed.");
  wait = await timelockWait();
  if (wait) return console.log(`Not executed: the timelock changed while you were deciding; ${wait}`);
  // Decode and check again right before sending: what executes is what was just checked.
  const latest = await decode(index);
  const latestProblems = assess(latest);
  if (latestProblems.length) fail(`not executed; the proposal no longer passes review:\n  ${latestProblems.join("\n  ")}`);
  await execute(index, latest);
}

const [command] = positionals;
if (command === "list") await list();
else if (/^\d+$/.test(command)) await review(BigInt(command));
else fail(`unknown command '${command}'\n${USAGE}`);
rl.close();
