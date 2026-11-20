// Extension wallets (Phantom, Solflare, Backpack, ...) through the Wallet
// Standard: each installed wallet registers itself with the page, so there is
// no per-wallet code and no SDK. The page builds every transaction; the wallet
// only signs it.

import { getWallets } from "@wallet-standard/app";

export const CHAIN = "solana:devnet";
const CONNECT = "standard:connect";
const DISCONNECT = "standard:disconnect";
const EVENTS = "standard:events";
const SIGN = "solana:signTransaction";

const registry = getWallets();

const usable = (wallet) => CONNECT in wallet.features && SIGN in wallet.features && wallet.chains.includes(CHAIN);

export const list = () => registry.get().filter(usable);

// Wallets register as their extensions load, which can be after the page.
export function onRegister(callback) {
  registry.on("register", callback);
  registry.on("unregister", callback);
}

// Returns the first account that can sign, or null. `silent` reconnects only
// if the user already trusted this page, without a popup.
export async function connect(wallet, { silent = false } = {}) {
  const { accounts } = await wallet.features[CONNECT].connect(silent ? { silent: true } : undefined);
  return accounts.find((a) => a.features.includes(SIGN)) ?? signingAccount(wallet);
}

export const signingAccount = (wallet) => wallet.accounts.find((a) => a.features.includes(SIGN)) ?? null;

export async function disconnect(wallet) {
  await wallet.features[DISCONNECT]?.disconnect();
}

// Calls back when the user switches or removes accounts inside the wallet.
export function onAccountsChange(wallet, callback) {
  return wallet.features[EVENTS]?.on("change", ({ accounts }) => accounts && callback()) ?? (() => {});
}

export async function sign(wallet, account, transaction) {
  const feature = wallet.features[SIGN];
  if (!feature.supportedTransactionVersions?.includes(0)) {
    throw new Error(`${wallet.name} cannot sign versioned transactions`);
  }
  const [{ signedTransaction }] = await feature.signTransaction({ account, transaction, chain: CHAIN });
  return signedTransaction;
}
