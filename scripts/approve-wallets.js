const hre = require("hardhat");
const fs = require("fs");

// ============================================================
//  approve-wallets.js
//  Approves the team wallets on the deployed Whitelist so they
//  can hold and trade shares. Run once, after everyone has a
//  funded Sepolia wallet and has sent you their address.
//
//  Usage:
//    1. Paste the wallet addresses below.
//    2. npx hardhat run scripts/approve-wallets.js --network sepolia
// ============================================================

// >>> PASTE THE TEAM WALLET ADDRESSES HERE <
const WALLETS = [
  "0x38331533814a12e238d8D7329D56FDEb9B46A6A4", // Arya (deployer — already approved, harmless to re-check)
  "0x4DF0B8779Cd4eA20f1bd27e114B7Cd4bF756B0c3",
  "PASTE_Rishabh_ADDRESS_HERE",
];

async function main() {
  const cfg = JSON.parse(fs.readFileSync("./frontend-config/addresses.json", "utf8"));
  const whitelist = await hre.ethers.getContractAt("Whitelist", cfg.whitelist);
  const [admin] = await hre.ethers.getSigners();

  console.log("Whitelist:", cfg.whitelist);
  console.log("Admin (approver):", admin.address, "\n");

  for (const w of WALLETS) {
    if (!hre.ethers.isAddress(w)) {
      console.log("SKIP (not a valid address):", w);
      continue;
    }
    const already = await whitelist.isApproved(w);
    if (already) {
      console.log("already approved:", w);
      continue;
    }
    process.stdout.write("approving " + w + " ... ");
    await (await whitelist.approveAddress(w)).wait();
    console.log("done");
  }

  console.log("\nAll set. These wallets can now hold and trade shares.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
