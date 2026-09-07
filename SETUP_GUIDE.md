# Demo Setup — No Wallet, Runs Offline

A proper multi-page real estate tokenisation platform: Home, Login/Signup, browse Properties, a Property Detail page (shares, marketplace, rent), a Dashboard, and a Register/List Property page — all on a **local blockchain**, with **no MetaMask** and **no cryptocurrency**.

The blockchain records **ownership only**. Payment and rent are in **₹ rupees, handled off-chain** — the chain just records who owns what and each owner's rent entitlement.

The contracts are unchanged from the previously tested version (KYC gating, fractional shares, ownership transfer, pro-rata yield — all already verified on a real EVM). Only the frontend changed: real pages, real navigation, a real login screen.

Setup is ~10 minutes and needs no internet once installed.

---

## What you need
Node.js only. No wallet, no faucet, no test ETH, no internet during the demo itself.

## Step 1 — Install
```
npm install
```

## Step 2 — Start the local blockchain (leave running)
```
npx hardhat node
```

## Step 3 — Deploy (in a SECOND terminal)
```
npx hardhat run scripts/deploy.js --network localhost
```
This deploys the contracts, whitelists the marketplace, KYC-approves the three demo users, and seeds a sample property owned by Alice.

## Step 4 — Wire the frontend
```
cp frontend-config/addresses.json frontend/addresses.json
cp frontend-config/abis.json frontend/abis.json
```

## Step 5 — Open the app
```
cd frontend
npx serve .
```
Open the printed URL. You'll land on the **Home page**.

---

## Login credentials

The Login page has a real email/password form, plus one-click demo account chips underneath for speed:

| Name | Role | Email | Password |
|---|---|---|---|
| Alice Menon | Property Owner | `alice@parcel.demo` | `demo1234` |
| Bob Iyer | Investor | `bob@parcel.demo` | `demo1234` |
| Carol Reddy | Investor | `carol@parcel.demo` | `demo1234` |

Clicking a demo chip logs in instantly. Typing the credentials manually works identically — useful to show it's a real form.

The **Sign Up** tab is present and functional as a page, but for the demo it explains that new accounts are queued for verification and directs to the demo accounts — this avoids fabricating a live signup-to-blockchain pipeline the night before a presentation.

---

## Pages

- **Home** — hero, feature highlights, a preview of properties.
- **Login / Signup** — the credentials above.
- **Properties** — browse every tokenised property as cards.
- **Property Detail** (`/#/properties/0x...`) — your position in that property, listing shares for resale, the marketplace for that property (sellers settle sales here), and — if you're the owner — distributing rent.
- **Dashboard** — your holdings across all properties, total claimable rent, and your active listings.
- **List Property** — register a new property (tokenise it), requires login.

---

## The demo flow (practice it once tonight)

1. **Home** → Browse Properties → click the seeded property to show the detail page.
2. **Log in as Alice** (owner). Go to that property's page.
3. **List shares** — list e.g. 400 shares at ₹5000 each. Two on-chain confirmations happen automatically (approve, then list).
4. **Settle a sale** — in the Marketplace section on that page, pick Bob as buyer, enter a quantity (e.g. 150), click Settle. Ownership moves — no money on-chain.
5. **Log out, log in as Bob** (click his demo chip). Go to Dashboard — his new holding is there.
6. **Log in as Alice again.** On the property page, Distribute Rent — e.g. ₹100000. It splits pro-rata.
7. **Switch between Alice and Bob** — each sees their claimable rent on the property page or Dashboard, and can Claim.

That's the full story across real pages: register → list → settle → distribute → claim, with a real login screen throughout.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Cannot reach the local blockchain" | The `npx hardhat node` terminal must stay running. |
| Blank page / nothing loads | Serve it (`npx serve .`), don't open the file directly. |
| "Could not load contract config" | You skipped Step 4 — copy `addresses.json` and `abis.json` into `frontend/`. |
| Restarted the chain, now errors | Re-run Step 3 and Step 4 — a fresh chain needs fresh addresses. |
| Wrong login error | Check for typos — emails/passwords are case-sensitive on password, not on email. |

---

## What to say when presenting
- A full platform experience — home, login, browse, property detail, dashboard — not just a raw contract test page.
- The blockchain records and verifies **ownership** and each owner's **rent entitlement**, pro-rata to shares held.
- **No cryptocurrency is used.** Payments and rent are in ₹ rupees, off-chain. The chain never holds or moves money.
- This is a focused demonstrator of the mechanism, running on a local chain for a reliable offline presentation; the fuller system (rupee payment rails, the indexer backend, real user accounts) is the team's ongoing build.
