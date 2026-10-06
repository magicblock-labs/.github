// Propose a change to a Squads v4 multisig's members or settings. The change
// is a config proposal: members approve and execute it with approve.mjs.
//
//   node configure.mjs --multisig <pda> --keypair <path> \
//     [--add <pubkey>[:vote+execute]]… [--remove <pubkey>]… [--threshold <n>] [--timelock <seconds>]
//
// --add takes permissions as a +-separated list of initiate, vote and execute
// (default: all three). The resulting configuration is checked before
// anything is signed. Devnet only, never in CI.

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
const PERMISSIONS = { initiate: 1, vote: 2, execute: 4 };

const USAGE = `Usage:
  node configure.mjs --multisig <pda> --keypair <path> [--rpc <url>]
    [--add <pubkey>[:initiate+vote+execute]]… [--remove <pubkey>]… [--threshold <n>] [--timelock <seconds>]`;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

let parsed;
try {
  parsed = parseArgs({
    options: {
      multisig: { type: "string" },
      keypair: { type: "string" },
      rpc: { type: "string", default: "https://api.devnet.solana.com" },
      add: { type: "string", multiple: true, default: [] },
      remove: { type: "string", multiple: true, default: [] },
      threshold: { type: "string" },
      timelock: { type: "string" },
      memo: { type: "string" },
      "allow-localnet": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
} catch (err) {
  fail(`${err.message}\n${USAGE}`);
}
const { values: opts } = parsed;
if (opts.help || !opts.multisig || !opts.keypair) {
  console.log(USAGE);
  process.exit(opts.help ? 0 : 1);
}

// --- guards -----------------------------------------------------------------

if (process.env.CI || process.env.GITHUB_ACTIONS) {
  fail("refusing to run in CI: member keys must stay with the people who hold them");
}

const connection = new Connection(opts.rpc, "confirmed");
const genesis = await connection.getGenesisHash();
const localnet = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(opts.rpc);
if (genesis !== DEVNET_GENESIS && !(opts["allow-localnet"] && localnet)) {
  fail(`the RPC is not devnet (genesis ${genesis}); use the Squads app on other clusters`);
}

const multisigPda = new PublicKey(opts.multisig);
const ms = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda);
const signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(opts.keypair, "utf8"))));
const self = ms.members.find((m) => m.key.equals(signer.publicKey));
if (!self || !(self.permissions.mask & PERMISSIONS.initiate)) {
  fail(`${signer.publicKey.toBase58()} must be a member with Initiate to propose changes`);
}

// --- the change -------------------------------------------------------------

const names = (mask) => Object.keys(PERMISSIONS).filter((n) => mask & PERMISSIONS[n]).join("+") || "none";
const parseKey = (text) => {
  try {
    return new PublicKey(text);
  } catch {
    fail(`not a public key: ${text}`);
  }
};

const actions = [];
const members = new Map(ms.members.map((m) => [m.key.toBase58(), m.permissions.mask]));

for (const spec of opts.remove) {
  const key = parseKey(spec);
  if (!members.delete(key.toBase58())) fail(`${spec} is not a member`);
  actions.push({ __kind: "RemoveMember", oldMember: key });
}
for (const spec of opts.add) {
  const [keyText, permText = "initiate+vote+execute"] = spec.split(":");
  const key = parseKey(keyText);
  let mask = 0;
  for (const name of permText.toLowerCase().split("+")) {
    if (!PERMISSIONS[name]) fail(`unknown permission '${name}' (use initiate, vote, execute)`);
    mask |= PERMISSIONS[name];
  }
  if (members.has(key.toBase58())) fail(`${keyText} is already a member; remove it first to change its permissions`);
  members.set(key.toBase58(), mask);
  actions.push({ __kind: "AddMember", newMember: { key, permissions: { mask } } });
}
let threshold = ms.threshold;
if (opts.threshold !== undefined) {
  threshold = Number(opts.threshold);
  if (!Number.isInteger(threshold) || threshold < 1) fail("--threshold must be a positive integer");
  actions.push({ __kind: "ChangeThreshold", newThreshold: threshold });
}
if (opts.timelock !== undefined) {
  const seconds = Number(opts.timelock);
  if (!Number.isInteger(seconds) || seconds < 0) fail("--timelock must be a non-negative number of seconds");
  actions.push({ __kind: "SetTimeLock", newTimeLock: seconds });
}
if (!actions.length) fail(`nothing to change\n${USAGE}`);

// The multisig must stay operable after the change.
const count = (bit) => [...members.values()].filter((mask) => mask & bit).length;
if (count(PERMISSIONS.vote) < threshold) {
  fail(`threshold ${threshold} would exceed the ${count(PERMISSIONS.vote)} members able to vote`);
}
if (!count(PERMISSIONS.initiate)) fail("no member would be left with Initiate");
if (!count(PERMISSIONS.execute)) fail("no member would be left with Execute");

console.log(`Multisig ${multisigPda.toBase58()}: proposed change`);
for (const a of actions) {
  if (a.__kind === "AddMember") console.log(`  ADD MEMBER ${a.newMember.key.toBase58()} (${names(a.newMember.permissions.mask)})`);
  if (a.__kind === "RemoveMember") console.log(`  REMOVE MEMBER ${a.oldMember.toBase58()}`);
  if (a.__kind === "ChangeThreshold") console.log(`  CHANGE THRESHOLD ${ms.threshold} -> ${a.newThreshold}`);
  if (a.__kind === "SetTimeLock") console.log(`  SET TIMELOCK ${ms.timeLock}s -> ${a.newTimeLock}s`);
}
console.log(`Resulting members (${threshold}-of-${members.size}):`);
for (const [key, mask] of members) console.log(`  ${key}  ${names(mask)}`);
console.log("Proposals still open when this executes become stale and can no longer be voted on.");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const answer = (await rl.question("Type 'propose' to create the config proposal (anything else aborts): ")).trim();
rl.close();
if (answer !== "propose") {
  console.log("Aborted; nothing signed.");
  process.exit(0);
}

// --- create the proposal ----------------------------------------------------

if ((await connection.getBalance(signer.publicKey)) < 10_000_000) {
  fail(`${signer.publicKey.toBase58()} needs ~0.01 SOL to pay the proposal rent and fees`);
}
const transactionIndex = BigInt(ms.transactionIndex.toString()) + 1n;
const latest = await connection.getLatestBlockhash();
const tx = new VersionedTransaction(new TransactionMessage({
  payerKey: signer.publicKey,
  recentBlockhash: latest.blockhash,
  instructions: [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    multisig.instructions.configTransactionCreate({
      multisigPda, transactionIndex, creator: signer.publicKey, actions, memo: opts.memo,
    }),
    multisig.instructions.proposalCreate({ multisigPda, transactionIndex, creator: signer.publicKey }),
  ],
}).compileToV0Message());
tx.sign([signer]);

let signature;
try {
  signature = await connection.sendTransaction(tx);
} catch (err) {
  const logs = err.transactionLogs ?? err.logs ?? [];
  fail(`proposal rejected: ${err.transactionMessage ?? err.message}${logs.length ? `\n${logs.join("\n")}` : ""}`);
}
const result = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
if (result.value.err) fail(`proposal failed (${signature}): ${JSON.stringify(result.value.err)}`);

console.log(`Config proposal #${transactionIndex} created: ${signature}`);
console.log(`Members approve and execute it with:\n  node approve.mjs --multisig ${multisigPda.toBase58()} --keypair <path> ${transactionIndex}`);
