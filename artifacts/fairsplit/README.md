# FairSplit

FairSplit is a client-side expense-sharing app for friends and student groups. Groups, members, expenses, and confirmed settlement notes persist in the browser's `localStorage`; no application server stores this ledger.

## Solana Devnet payments

- The app connects to **Solana Devnet only** through Phantom and `@solana/web3.js`.
- A SOL transfer requires an explicit Phantom wallet signature and Devnet RPC confirmation. The app only creates the local settlement record after confirmation succeeds.
- Every transfer review shows the destination, SOL amount, and a separate USD ledger credit entered by the user. **No price oracle connects these amounts. Devnet SOL is for testing and has no cash value.**
- A transaction signature links to the public Devnet explorer. Confirmed chain transfers cannot be reversed by deleting local group data.
- The app does not request, store, or transmit seed phrases or private keys. Member wallet addresses are optional public keys.
- Devnet airdrops are test funds subject to faucet availability and limits.

## Assistant

The expense helper is a **local rules-based assistant, not a generative AI model**. It extracts a typed amount, applies keyword categories, suggests an editable expense, flags similar entries and expenses at or above $500, explains equal-split cent rounding, recommends fair settlements, and looks up real confirmed Devnet transaction signatures to explain basic SOL transfers. It does not call an AI provider or send the prompt to a server. It is deliberately limited and may need user correction.

## Local data and starter group

The initial “Weekend in Lisbon” group is clearly labeled as a starter demo group with illustrative expenses to make the split calculations visible. It contains no wallet addresses or pretend transactions. All groups and records are stored in the browser under `fairsplit.v1.groups`. Clearing browser storage removes those local records.

## Development

```sh
pnpm --filter @workspace/fairsplit run dev
pnpm --filter @workspace/fairsplit run typecheck
```
