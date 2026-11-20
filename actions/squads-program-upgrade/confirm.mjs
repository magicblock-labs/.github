// Waits for a transaction by polling its status. web3.js's confirmTransaction
// subscribes over a websocket instead: on an RPC whose websocket doesn't
// connect, it keeps reconnecting forever, so Node never exits after the work
// is done and a CI job hangs until it times out. Shared by propose.mjs,
// approve.mjs and the devnet approval page.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settled = (status) => status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized";

// Resolves to { err } like confirmTransaction's `value`, or throws if the
// blockhash expires before the transaction confirms.
export async function confirmSignature(connection, signature, lastValidBlockHeight) {
  for (;;) {
    const { value: [status] } = await connection.getSignatureStatuses([signature]);
    if (status?.err) return { err: status.err };
    if (settled(status)) return { err: null };
    if ((await connection.getBlockHeight("confirmed")) > lastValidBlockHeight) break;
    await sleep(1000);
  }
  // Expired: no new landing is possible, but one already processed can still
  // confirm, so look a few more times before giving up.
  for (let i = 0; i < 10; i++) {
    const { value: [status] } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    if (status?.err) return { err: status.err };
    if (settled(status)) return { err: null };
    if (!status) break;
    await sleep(1000);
  }
  throw new Error(`transaction ${signature} expired before it confirmed`);
}
