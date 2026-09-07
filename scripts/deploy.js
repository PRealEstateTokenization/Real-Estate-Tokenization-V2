const hre = require("hardhat");
const fs = require("fs");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const net = hre.network.name;
  console.log("Network:", net);
  console.log("Deploying with account:", deployer.address);
  console.log("Balance:", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), "ETH\n");

  const Whitelist = await hre.ethers.getContractFactory("Whitelist");
  const whitelist = await Whitelist.deploy();
  await whitelist.waitForDeployment();
  const whitelistAddr = await whitelist.getAddress();
  console.log("Whitelist deployed:", whitelistAddr);

  const Factory = await hre.ethers.getContractFactory("PropertyTokenFactory");
  const factory = await Factory.deploy(whitelistAddr);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log("PropertyTokenFactory deployed:", factoryAddr);

  const Marketplace = await hre.ethers.getContractFactory("Marketplace");
  const marketplace = await Marketplace.deploy(whitelistAddr);
  await marketplace.waitForDeployment();
  const marketplaceAddr = await marketplace.getAddress();
  console.log("Marketplace deployed:", marketplaceAddr);

  await (await whitelist.approveAddress(marketplaceAddr)).wait();
  console.log("Marketplace whitelisted for escrow\n");

  const signers = await hre.ethers.getSigners();
  const isLocal = (net === "localhost" || net === "hardhat");

  await (await whitelist.register()).wait();
  console.log("KYC: deployer approved");

  if (isLocal && signers.length >= 3) {
    for (const s of [signers[1], signers[2]]) {
      await (await whitelist.connect(s).register()).wait();
    }
    console.log("KYC: local demo users (Bob, Carol) approved");
  }

  const docHash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("Sunworth City tower - title deed"));
  await (await factory.registerLand(
    "Plot 42, Whitefield", "PLOT42", 1000n, docHash, "demo"
  )).wait();
  console.log("Seeded a sample property owned by the deployer (1000 shares)");

  const artifactsDir = "./frontend-config";
  if (!fs.existsSync(artifactsDir)) fs.mkdirSync(artifactsDir);

  const rpc = isLocal
    ? "http://127.0.0.1:8545"
    : (process.env.SEPOLIA_RPC_URL || "");

  const config = {
    network: net,
    rpc,
    whitelist: whitelistAddr,
    factory: factoryAddr,
    marketplace: marketplaceAddr,
  };
  fs.writeFileSync(`${artifactsDir}/addresses.json`, JSON.stringify(config, null, 2));

  const abis = {
    Whitelist: (await hre.artifacts.readArtifact("Whitelist")).abi,
    PropertyTokenFactory: (await hre.artifacts.readArtifact("PropertyTokenFactory")).abi,
    PropertyToken: (await hre.artifacts.readArtifact("PropertyToken")).abi,
    Marketplace: (await hre.artifacts.readArtifact("Marketplace")).abi,
  };
  fs.writeFileSync(`${artifactsDir}/abis.json`, JSON.stringify(abis, null, 2));

  console.log("Saved addresses + ABIs to ./frontend-config/");
  console.log("\n=== DEPLOYMENT COMPLETE ===");
  console.log(JSON.stringify(config, null, 2));

  if (!isLocal) {
    console.log("\nView your contracts on Sepolia Etherscan:");
    console.log("  Whitelist:   https://sepolia.etherscan.io/address/" + whitelistAddr);
    console.log("  Factory:     https://sepolia.etherscan.io/address/" + factoryAddr);
    console.log("  Marketplace: https://sepolia.etherscan.io/address/" + marketplaceAddr);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
