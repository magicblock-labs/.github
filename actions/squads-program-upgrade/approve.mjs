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
import { confirmSignature } from "./confirm.mjs";
import {
  DEVNET_GENESIS,
  EXECUTE_UNITS,
  PERMISSIONS,
  VOTE_UNITS,
  assess,
  createReviewer,
  permissionNames,
} from "./review.mjs";

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
const { decode, proposalAt, votes, timelock, voteInstruction, executeInstructions } =
  createReviewer({ connection, multisigPda, ms });

// --- signing ----------------------------------------------------------------

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
  const { err } = await confirmSignature(connection, signature, latest.lastValidBlockHeight);
  if (err) fail(`${label} failed (${signature}): ${JSON.stringify(err)}`);
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
  const { instructions, lookupTables } = await executeInstructions(index, decoded, signer.publicKey);
  await send(instructions, "executed", { units: EXECUTE_UNITS, lookupTables });
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

const assessed = (decoded) => assess(decoded, { hash: opts.hash, noHashCheck: opts["no-hash-check"] });

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

  const problems = assessed(decoded);
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
    await send([voteInstruction(choice, index, signer.publicKey)], `${choice}d`);
    const after = await proposalAt(index);
    console.log(`Now ${after.status.__kind}: ${votes(after)}`);
    if (after.status.__kind !== "Approved") return;
  }

  if (!can("Execute")) {
    console.log("\nApproved. Executing needs a member with Execute.");
    return;
  }
  if (problems.length) fail("not executing while the problems above remain");

  // Squads checks the timelock current at execution, so read it twice: once
  // before asking, and again right before sending.
  const timelockWait = async () => {
    const { timeLock, now, readyAt } = await timelock(index);
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
  const latestProblems = assessed(latest);
  if (latestProblems.length) fail(`not executed; the proposal no longer passes review:\n  ${latestProblems.join("\n  ")}`);
  await execute(index, latest);
}

const [command] = positionals;
if (command === "list") await list();
else if (/^\d+$/.test(command)) await review(BigInt(command));
else fail(`unknown command '${command}'\n${USAGE}`);
rl.close();
