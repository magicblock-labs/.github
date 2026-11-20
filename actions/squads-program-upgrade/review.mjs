// Decodes and checks Squads v4 proposals before anyone votes on them. Shared
// by approve.mjs and the devnet approval page in web/, so the terminal and the
// browser apply exactly the same rules. Runs in Node and in the browser: no
// node: imports, hashing through WebCrypto.

import * as multisig from "@sqds/multisig";
import { ComputeBudgetProgram, PublicKey } from "@solana/web3.js";

export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const PERMISSIONS = { Initiate: 1, Vote: 2, Execute: 4 };
// Votes are cheap. Executing replays the proposal, so it gets the same ceiling
// the workflow simulated the upgrade with.
export const VOTE_UNITS = 200_000;
export const EXECUTE_UNITS = 1_400_000;

const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const OTTER_VERIFY = "verifycLy8mB96wd9wqq3WDXQwM4oU6r42Th37Db9fC";
const COMPUTE_BUDGET = ComputeBudgetProgram.programId.toBase58();
const BUFFER_HEADER = 37; // u32 tag + Option<Pubkey>
// otter-verify Anchor discriminators, as used by solana-verify.
const VERIFY_KINDS = {
  "afaf6d1f0d989bed": "initialize",
  "dbc858b09e3ffd7f": "update",
  "62a5c9b16c41ce60": "close",
};

export const short = (key) => `${key.toBase58().slice(0, 4)}…${key.toBase58().slice(-4)}`;
export const permissionNames = (mask) =>
  Object.keys(PERMISSIONS).filter((n) => mask & PERMISSIONS[n]).join("+") || "none";

// --- decoding ---------------------------------------------------------------

async function bufferHash(data) {
  let end = data.length;
  while (end > BUFFER_HEADER && data[end - 1] === 0) end--;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data.subarray(BUFFER_HEADER, end));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
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

// Every upgrade must match the CI build unless the check is waived explicitly.
export function assess(decoded, { hash, noHashCheck = false } = {}) {
  const problems = [...decoded.problems];
  for (const upgrade of decoded.upgrades) {
    if (hash) {
      if (upgrade.hash !== hash) problems.push(`buffer hash ${upgrade.hash} does not match --hash ${hash}`);
    } else if (!noHashCheck) {
      problems.push("upgrade without --hash: pass the executable hash from the CI job summary (or --no-hash-check)");
    }
  }
  return problems;
}

// Everything that reads one multisig. `ms` is its account as last fetched.
export function createReviewer({ connection, multisigPda, ms }) {
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
        const hash = await bufferHash(account.data);
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

  function votes(proposal) {
    const names = (keys) => keys.map(short).join(", ") || "-";
    return `${proposal.approved.length}/${ms.threshold} approved [${names(proposal.approved)}], ` +
      `${proposal.rejected.length} rejected [${names(proposal.rejected)}]`;
  }

  // An approved proposal only becomes executable once the timelock has passed.
  // Squads checks the timelock current at execution, so this reads it fresh.
  async function timelock(index) {
    const { timeLock } = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda, "confirmed");
    const approvedAt = Number((await proposalAt(index)).status.timestamp);
    const now = await connection.getBlockTime(await connection.getSlot());
    return { timeLock, now, readyAt: approvedAt + timeLock };
  }

  function voteInstruction(choice, index, member) {
    const build = choice === "approve" ? multisig.instructions.proposalApprove : multisig.instructions.proposalReject;
    return build({ multisigPda, transactionIndex: index, member });
  }

  // Returns { instructions, lookupTables } that execute an approved proposal.
  async function executeInstructions(index, decoded, member) {
    if (decoded.kind === "config") {
      const spendingLimits = decoded.actions.flatMap((a) =>
        a.__kind === "AddSpendingLimit" ? [multisig.getSpendingLimitPda({ multisigPda, createKey: a.createKey })[0]]
          : a.__kind === "RemoveSpendingLimit" ? [a.spendingLimit] : []);
      return {
        instructions: [multisig.instructions.configTransactionExecute({
          multisigPda, transactionIndex: index, member, rentPayer: member, spendingLimits,
        })],
        lookupTables: [],
      };
    }
    const { instruction, lookupTableAccounts } = await multisig.instructions.vaultTransactionExecute({
      connection, multisigPda, transactionIndex: index, member,
    });
    return { instructions: [instruction], lookupTables: lookupTableAccounts };
  }

  return { decode, proposalAt, votes, timelock, voteInstruction, executeInstructions };
}
