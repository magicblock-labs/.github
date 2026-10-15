# Verify Program (Remote)

Asks OtterSec to rebuild a mainnet program from its otter-verify PDA, so explorers mark it **Verified Build**.

1. **Resolve the uploader** (read-only): the program's upgrade authority, read from its accounts. OtterSec trusts the PDA that key wrote.
2. **Submit** the job with `solana-verify remote submit-job` and wait for the rebuild.
3. **Check** that OtterSec's record for the uploader matches the hash of the binary deployed right now. `submit-job` exits 0 even when the rebuild fails or doesn't match, so this step is what fails the run.

Every upgrade changes the program hash, and the badge disappears until this runs again. With [`squads-program-upgrade`](../squads-program-upgrade), run it after members execute the proposal: the PDA is written in the same transaction as the upgrade.

## Usage

No secrets or keys are needed: the action reads public accounts and signs nothing.

```yaml
name: Verify Program (Remote)

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: magicblock-labs/.github/actions/verify-program-remote@<sha>
        with:
          program-id: <PROGRAM_ID>
```

See [`action.yml`](action.yml) for every input and output. The job summary shows the deployed hash, the source commit OtterSec built, and the job link.

## Notes

- **Mainnet only.** OtterSec verifies mainnet programs only; on other clusters `submit-job` stops with an error.
- **RPC.** The public endpoint is enough for the few reads. To use a private one, pass `rpc-url: ${{ secrets.<NAME> }}`.
- **No upgrade authority.** For a program whose authority was removed, set `uploader` to the key that wrote its PDA.
