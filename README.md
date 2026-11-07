# FairSplit

FairSplit helps friends and student groups track shared expenses, understand who owes whom, and settle a balance with a wallet-approved Solana Devnet payment.

## The problem

Group expenses are easy to lose track of. People pay at different times, split costs unevenly, and end up with unclear balances or awkward repeated transfers. FairSplit keeps the expense record visible, calculates each person's share, and suggests a smaller set of fair settlements.

## How it works

1. Create a group and add members. Members can add their public Solana wallet address when they are ready to receive a Devnet payment.
2. Record an expense, choose who paid, and choose who shares it. FairSplit divides the amount in cents and shows each member's net balance.
3. Review the suggested payments between members.
4. Connect Phantom on Solana Devnet, review the recipient and SOL amount, then approve the transaction in Phantom.
5. FairSplit records the settlement only after the Devnet RPC confirms the transaction. The confirmed transaction links to Solana Explorer.

Groups, expenses, and confirmed settlement records are saved in the current browser's local storage. They are not shared between browsers or devices.

## How Solana is used

FairSplit uses Solana Devnet for real, wallet-signed SOL transfers and confirmation checks. The app does not handle private keys or recovery phrases. Users can request Devnet SOL from the app's faucet action, subject to Devnet faucet availability and rate limits.

Expense amounts are tracked in USD for familiar budgeting. The user separately enters the amount of USD balance to credit and the amount of SOL to send. There is no exchange-rate feed or price oracle connecting those amounts. Devnet SOL is test currency with no cash value.

## The assistant

The expense assistant answers normal split questions with local calculations—for example, four people splitting £120 equally owe £30 each. It can also draft expenses, infer common categories, flag likely duplicates or unusually large entries, and recommend fair settlements. This is local rules-based assistance, not a generative AI model, and it does not require a wallet.

The separate Solana transaction explainer accepts only a Base58-encoded 64-byte signature. It validates the signature shape before querying Devnet RPC and explains only a transaction returned by the network; ordinary questions are never sent to RPC.

To keep the demo free of paid AI services and API keys, the assistant uses local rules and expense data in the browser. It is not a generative AI model, and no prompt or expense information is sent to an AI provider.

## What makes FairSplit different

- Shared expenses stay tied to clear participant and payer records.
- Settlement suggestions reduce a group of balances into fewer transfers.
- Solana Devnet transfers are real transactions approved by the sender's wallet, not simulated confirmations.
- The assistant helps people understand the split and the transaction rather than acting as a decorative chat window.
- The demo distinguishes expense bookkeeping from on-chain payment amounts instead of implying that USD is converted to SOL automatically.

## Technology

- React, TypeScript, and Vite
- Solana Devnet RPC and `@solana/web3.js`
- Phantom browser wallet provider
- Browser local storage for demo data
- Local, rules-based expense assistance

## Run and try the demo

1. Start the FairSplit web preview in Replit.
2. Use the included starter group to explore expense calculations and the assistant, or create a new group.
3. Install or open Phantom in the browser and switch Phantom to **Devnet**.
4. Connect a wallet. Request Devnet SOL if needed, then add the wallet's public address to the matching group member.
5. To try settlement, choose a suggested balance, enter the SOL amount to send and the USD balance credit, review the details, and approve the transfer in Phantom.
6. Check the confirmation and Devnet Explorer link after the transaction is confirmed.

Never enter a recovery phrase or private key into FairSplit. Confirm that Phantom is on Devnet before approving a transfer.

## Known limitations

- Browser-local data is not a shared group database and is not backed up across devices.
- Devnet can be slow, unavailable, or rate-limited; airdrops are not guaranteed.
- SOL-to-USD conversion is not provided. The USD balance credit is user-entered and does not represent an oracle-verified exchange value.
- The assistant is a transparent, local rules-based helper, not a connected generative model.
- FairSplit is a hackathon demonstration, not a production payment or accounting service.

## Acknowledgements

Built with Replit AI and ChatGPT assistance. Solana Devnet and Phantom provide the test-network transaction flow.
