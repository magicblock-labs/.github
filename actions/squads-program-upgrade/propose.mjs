// Squads v4 program-upgrade proposer.
//
//   node propose.mjs preflight   read-only checks before anything is spent
//   node propose.mjs propose     simulate the bundle, then hand the buffer to
//                                the vault and open the Squads proposal
//
// Every input arrives through the environment (see action.yml).

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import * as multisig from "@sqds/multisig";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

const LOADER_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const COMPUTE_BUDGET_ID = ComputeBudgetProgram.programId.toBase58();
const PROGRAMDATA_HEADER = 45; // u32 tag + u64 slot + Option<Pubkey>
const PACKET_SIZE = 1232;
const INITIATE = 1; // Squads v4 permission bit

const CLUSTERS = {
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d": "mainnet-beta",
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: "devnet",
  "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY": "testnet",
};

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function output(key, value) {
  fs.appendFileSync(env("GITHUB_OUTPUT"), `${key}=${value}\n`);
  console.log(`${key}: ${value}`);
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

const connection = new Connection(env("RPC_URL"), "confirmed");
const proposer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(env("PROPOSER_KEYPAIR_PATH"), "utf8"))),
);
const multisigPda = new PublicKey(env("MULTISIG"));
const vaultIndex = Number(env("VAULT_INDEX"));
const programId = new PublicKey(env("PROGRAM_ID"));
const [vaultPda] = multisig.getVaultPda({ multisigPda, index: vaultIndex });

// --- loader account layouts -------------------------------------------------

async function readProgram() {
  const program = await connection.getAccountInfo(programId);
  if (!program || !program.owner.equals(LOADER_ID) || program.data.readUInt32LE(0) !== 2) {
    fail(`${programId.toBase58()} is not an upgradeable program on this cluster`);
  }
  const programData = new PublicKey(program.data.subarray(4, 36));
  const data = (await connection.getAccountInfo(programData)).data;
  const authority = data[12] === 1 ? new PublicKey(data.subarray(13, 45)) : null;
  return { programData, authority, capacity: data.length - PROGRAMDATA_HEADER };
}

function setBufferAuthorityIx(buffer, current, next) {
  return new TransactionInstruction({
    programId: LOADER_ID,
    data: Buffer.from([4, 0, 0, 0]),
    keys: [
      { pubkey: buffer, isWritable: true, isSigner: false },
      { pubkey: current, isWritable: false, isSigner: true },
      { pubkey: next, isWritable: false, isSigner: false },
    ],
  });
}

function upgradeIx(programData, buffer, spill) {
  return new TransactionInstruction({
    programId: LOADER_ID,
    data: Buffer.from([3, 0, 0, 0]),
    keys: [
      { pubkey: programData, isWritable: true, isSigner: false },
      { pubkey: programId, isWritable: true, isSigner: false },
      { pubkey: buffer, isWritable: true, isSigner: false },
      { pubkey: spill, isWritable: true, isSigner: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isWritable: false, isSigner: false },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isWritable: false, isSigner: false },
      { pubkey: vaultPda, isWritable: false, isSigner: true },
    ],
  });
}

// Reuse `solana-verify` to build the otter-verify PDA write, with the exact
// build arguments the binary was produced with, so the upgrade and its
// verification record land in one multisig execution.
function verifyIxs() {
  const args = [
    "export-pda-tx", env("REPOSITORY_URL"),
    "--url", env("RPC_URL"),
    "--program-id", programId.toBase58(),
    "--uploader", vaultPda.toBase58(),
    "--library-name", env("LIBRARY_NAME"),
    "--base-image", env("BASE_IMAGE"),
    "--commit-hash", env("COMMIT"),
    "--encoding", "base64",
    "--compute-unit-price", "0",
  ];
  if (process.env.MOUNT_PATH) args.push("--mount-path", process.env.MOUNT_PATH);

  const exported = execFileSync("solana-verify", args, { encoding: "utf8" })
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop();
  if (!exported) fail("solana-verify export-pda-tx produced no output");

  // Squads adds its own compute budget at execution time.
  const ixs = Transaction.from(Buffer.from(exported, "base64")).instructions
    .filter((ix) => ix.programId.toBase58() !== COMPUTE_BUDGET_ID);
  if (ixs.length === 0) fail("solana-verify export-pda-tx returned no instructions");
  return ixs;
}

// --- sending ----------------------------------------------------------------

async function buildTx(instructions) {
  const latest = await connection.getLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: proposer.publicKey,
    recentBlockhash: latest.blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(env("COMPUTE_UNIT_PRICE")) }),
      ...instructions,
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([proposer]);
  return { tx, latest };
}

function serializedSize(tx) {
  try {
    return tx.serialize().length;
  } catch {
    return Infinity; // web3.js throws once the encoding overruns a packet
  }
}

async function send(instructions, label) {
  const { tx, latest } = await buildTx(instructions);
  const signature = await connection.sendTransaction(tx, { maxRetries: 10 });
  const result = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  if (result.value.err) {
    fail(`${label} failed on-chain (${signature}): ${JSON.stringify(result.value.err)}`);
  }
  console.log(`${label}: ${signature}`);
  return signature;
}

// --- commands ---------------------------------------------------------------

async function preflight() {
  const genesis = await connection.getGenesisHash();
  output("cluster", CLUSTERS[genesis] ?? `unknown (${genesis})`);

  const ms = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda);
  const member = ms.members.find((m) => m.key.equals(proposer.publicKey));
  if (!member || (member.permissions.mask & INITIATE) === 0) {
    fail(`Proposer ${proposer.publicKey.toBase58()} is not a member of ${multisigPda.toBase58()} with Initiate permission`);
  }

  const { programData, authority, capacity } = await readProgram();
  if (!authority?.equals(vaultPda)) {
    fail(`Upgrade authority is ${authority?.toBase58() ?? "none (immutable)"}, expected Squads vault ${vaultPda.toBase58()}`);
  }

  output("vault", vaultPda.toBase58());
  output("vault-balance", await connection.getBalance(vaultPda));
  output("programdata", programData.toBase58());
  output("capacity", capacity);
}

async function propose() {
  const buffer = new PublicKey(env("BUFFER"));
  const spill = new PublicKey(process.env.SPILL_ADDRESS || proposer.publicKey);
  const { programData } = await readProgram();

  const bundle = [upgradeIx(programData, buffer, spill)];
  if (env("WRITE_VERIFY_PDA") === "true") bundle.push(...verifyIxs());

  // 1. The proposal must fit in a packet, or members could never see it.
  const ms = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda);
  const transactionIndex = BigInt(ms.transactionIndex.toString()) + 1n;
  const createIx = () => multisig.instructions.vaultTransactionCreate({
    multisigPda,
    transactionIndex,
    creator: proposer.publicKey,
    vaultIndex,
    ephemeralSigners: 0,
    transactionMessage: new TransactionMessage({
      payerKey: vaultPda,
      recentBlockhash: PublicKey.default.toBase58(), // replaced by Squads at execution
      instructions: bundle,
    }),
    memo: env("PROPOSAL_NAME"),
  });
  const size = serializedSize((await buildTx([createIx()])).tx);
  if (size > PACKET_SIZE) {
    fail(`vaultTransactionCreate is ${size} bytes, over the ${PACKET_SIZE}-byte packet limit`);
  }
  console.log(`vaultTransactionCreate size: ${size}/${PACKET_SIZE} bytes`);

  // 2. Prove the bundle executes exactly as the vault would run it, including
  //    the buffer handover and any rent the vault must pay. Signatures are
  //    skipped, so the vault can appear as a signer.
  const { tx: simulation } = await buildTx([
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    setBufferAuthorityIx(buffer, proposer.publicKey, vaultPda),
    ...bundle,
  ]);
  const simulated = await connection.simulateTransaction(simulation, {
    sigVerify: false,
    replaceRecentBlockhash: true,
  });
  if (simulated.value.err) {
    console.error((simulated.value.logs ?? []).join("\n"));
    fail(`Simulated upgrade failed: ${JSON.stringify(simulated.value.err)}. ` +
      `Vault ${vaultPda.toBase58()} holds ${await connection.getBalance(vaultPda)} lamports; ` +
      "it pays the otter-verify PDA rent on first verification.");
  }
  console.log(`Simulated upgrade succeeded (${simulated.value.unitsConsumed} CU)`);

  if (env("DRY_RUN") === "true") {
    console.log("Dry run: stopping before any authority transfer or proposal");
    return;
  }

  // 3. From here the buffer belongs to the vault; only a proposal can close it.
  await send([setBufferAuthorityIx(buffer, proposer.publicKey, vaultPda)], "setBufferAuthority");
  output("authority-transferred", "true");

  await send([createIx()], "vaultTransactionCreate");
  await send([multisig.instructions.proposalCreate({
    multisigPda,
    transactionIndex,
    creator: proposer.publicKey,
  })], "proposalCreate");
  output("transaction-index", transactionIndex.toString());
}

const commands = { preflight, propose };
const command = commands[process.argv[2]];
if (!command) fail(`Usage: propose.mjs <${Object.keys(commands).join("|")}>`);
await command();
