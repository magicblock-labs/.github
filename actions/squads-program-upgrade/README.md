# Squads Program Upgrade

Opens a Squads v4 proposal that upgrades a Solana program from a verifiable build.

1. **Preflight** (read-only): the proposer is a multisig member with Initiate, and the program's upgrade authority is the Squads vault.
2. **Build** with `solana-verify` in the pinned `solana-verifiable-build` image, and check the binary fits the current ProgramData allocation.
3. **Upload** the buffer and check its on-chain hash equals the build.
4. **Simulate** the exact bundle the vault will execute: buffer handover, `Upgrade`, and the otter-verify PDA write. This includes the rent the vault pays on first verification.
5. Only then **propose**: hand the buffer to the vault, then `vaultTransactionCreate` and `proposalCreate` in one transaction.

Members approve and execute in Squads, or on devnet with the bundled [command-line tools](#approving-and-managing-the-multisig-devnet). Upgrade and verification land atomically. If anything fails before the handover, the buffer is closed and its rent returned.

## Usage

Configure one GitHub environment per cluster, with the same names in each:

| Kind | Name | Value |
|---|---|---|
| secret | `RPC_URL` | RPC endpoint for the cluster |
| secret | `SQUADS_PROPOSER_KEYPAIR` | JSON keypair of an Initiate-only multisig member |
| variable | `SQUADS_MULTISIG_PDA` | Multisig whose vault is the upgrade authority |

For mainnet, restrict the environment to the default branch and add required reviewers. Keep the proposer keypair out of repository-level secrets.

```yaml
name: Propose Program Upgrade

on:
  workflow_dispatch:
    inputs:
      cluster:
        type: choice
        options: [devnet, mainnet]
      dry_run:
        type: boolean
        default: false

concurrency: program-upgrade-${{ inputs.cluster }}

permissions:
  contents: read

jobs:
  propose:
    runs-on: ubuntu-latest
    environment: ${{ inputs.cluster }}-program-upgrade
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: magicblock-labs/.github/actions/squads-program-upgrade@<sha>
        with:
          rpc-url: ${{ secrets.RPC_URL }}
          proposer-keypair: ${{ secrets.SQUADS_PROPOSER_KEYPAIR }}
          multisig: ${{ vars.SQUADS_MULTISIG_PDA }}
          program-id: <PROGRAM_ID>
          library-name: <crate_lib_name>
          dry-run: ${{ inputs.dry_run }}
```

See [`action.yml`](action.yml) for every input and output. Start each new setup with `dry-run: true`: it builds, uploads and simulates, then closes the buffer.

## Approving and managing the multisig (devnet)

On mainnet, members approve in the [Squads app](https://app.squads.so). Devnet has no app, so this folder ships two command-line tools that members run **on their own machine with their own keypair**:

| Script | Does |
|---|---|
| `approve.mjs` | lists open proposals, decodes one, then approves, rejects or executes it |
| `configure.mjs` | proposes adding or removing members, or changing the threshold or timelock |

Both refuse any cluster but devnet, refuse to run in CI (so voting keys never sit in a workflow), and sign nothing until you type the action word.

### Setup (once per member)

```sh
git clone https://github.com/magicblock-labs/.github magicblock-github
cd magicblock-github/actions/squads-program-upgrade
git checkout <sha>          # the same commit the workflow pins
npm ci --ignore-scripts
```

Each member needs a funded devnet keypair: a little SOL pays fees, and about 0.01 SOL more pays a config proposal's rent.

### Approving an upgrade

1. Run the workflow without `dry_run`. Its job summary shows the proposal number and the **executable hash** of the build.
2. Each member reviews it and votes:

   ```sh
   node approve.mjs --multisig <MULTISIG> --keypair ~/keys/me.json list
   node approve.mjs --multisig <MULTISIG> --keypair ~/keys/me.json <#> --hash <executable hash>
   ```

   The proposal is decoded before you're asked anything:
   - the upgraded program, its buffer, and where the buffer's lamports are refunded;
   - the buffer's hash, compared with `--hash`;
   - the verify-PDA record (repository, commit, build arguments);
   - other loader instructions, such as SetAuthority or Extend.

   Anything else is flagged **NOT DECODED, review manually**. If the buffer hash doesn't match, approval is blocked, but you can still reject. Approving an upgrade with no hash at all needs an explicit `--no-hash-check`.
3. Once the threshold is reached, any member with Execute runs the same command and types `execute`. That can be the last approver, in the same session.

You can also check the build hash independently: `solana-verify get-buffer-hash <buffer> -u devnet`.

### Adding a member or changing the rules

Any member with Initiate proposes the change. Members then approve and execute it like any other proposal:

```sh
# add an approver who can also execute, and raise the threshold
node configure.mjs --multisig <MULTISIG> --keypair ~/keys/me.json \
  --add <PUBKEY>:vote+execute --threshold 2

# remove a member, or set a timelock (seconds)
node configure.mjs --multisig <MULTISIG> --keypair ~/keys/me.json --remove <PUBKEY>
node configure.mjs --multisig <MULTISIG> --keypair ~/keys/me.json --timelock 3600

# then, per member
node approve.mjs --multisig <MULTISIG> --keypair ~/keys/me.json <#>
```

Flags can be combined and repeated in one proposal. `--add` takes permissions as `initiate`, `vote` and `execute` joined with `+`, and defaults to all three. Before signing, the script prints the resulting member list and refuses a change that would leave fewer voters than the threshold, or nobody able to initiate or execute.

Executing a config change makes every still-open proposal **stale**: it can no longer be voted on. Re-run the workflow for any upgrade that was pending.

### Roles

| Role | Permissions | Key lives |
|---|---|---|
| CI proposer | Initiate only | GitHub environment secret |
| Approver | Vote (+ Execute) | the member's machine, never GitHub |

Never give the CI key Vote or Execute. With them, anyone who can run the workflow could upgrade the program alone.

## Notes

- **Vault funding.** The vault pays about 0.003 SOL of rent the first time the otter-verify PDA is written. If it can't, the simulation fails and the error names the vault.
- **Program size.** A binary larger than the current allocation needs a separate extend proposal first. The error states how many bytes.
- **Verify PDA.** The PDA records the repository, commit, library name and base image used for the build, so `solana-verify remote submit-job` rebuilds the same binary. Remote verification is mainnet-only; on other clusters the PDA is written but not checked by OtterSec. Set `write-verify-pda: false` to skip it.
