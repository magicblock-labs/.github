# Squads Program Upgrade

Opens a Squads v4 proposal that upgrades a Solana program from a verifiable build.

1. **Preflight** (read-only): the proposer is a multisig member with Initiate, and the program's upgrade authority is the Squads vault.
2. **Build** with `solana-verify` in the pinned `solana-verifiable-build` image, and check the binary fits the current ProgramData allocation.
3. **Upload** the buffer and check its on-chain hash equals the build.
4. **Simulate** the exact bundle the vault will execute: buffer handover, `Upgrade`, and the otter-verify PDA write. This includes the rent the vault pays on first verification.
5. Only then **propose**: hand the buffer to the vault, `vaultTransactionCreate`, `proposalCreate`.

Members approve and execute in Squads. Upgrade and verification land atomically. If anything fails before the handover, the buffer is closed and its rent returned.

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

## Notes

- **Vault funding.** The vault pays about 0.003 SOL of rent the first time the otter-verify PDA is written. If it can't, the simulation fails and the error names the vault.
- **Program size.** A binary larger than the current allocation needs a separate extend proposal first. The error states how many bytes.
- **Verify PDA.** The PDA records the repository, commit, library name and base image used for the build, so `solana-verify remote submit-job` rebuilds the same binary. Remote verification is mainnet-only; on other clusters the PDA is written but not checked by OtterSec. Set `write-verify-pda: false` to skip it.
