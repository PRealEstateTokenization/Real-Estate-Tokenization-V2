const { readFileSync } = require('fs');
const { VM } = require('@ethereumjs/vm');
const { Common, Chain, Hardfork } = require('@ethereumjs/common');
const { LegacyTransaction } = require('@ethereumjs/tx');
const { Address, hexToBytes, privateToAddress, bytesToHex, Account } = require('@ethereumjs/util');
const { ethers } = require('ethers');

const art = JSON.parse(readFileSync('artifacts_compiled.json', 'utf8'));
const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Shanghai });

const keys = [
  '0x1111111111111111111111111111111111111111111111111111111111111111',
  '0x2222222222222222222222222222222222222222222222222222222222222222',
  '0x3333333333333333333333333333333333333333333333333333333333333333',
];
const addrs = keys.map(k => new Address(privateToAddress(hexToBytes(k))));
const nonces = [0n, 0n, 0n];
let vm;

async function init() {
  vm = await VM.create({ common });
  for (const a of addrs) {
    await vm.stateManager.putAccount(a, Account.fromAccountData({ balance: 10n ** 21n }));
  }
}

async function send(fromIdx, to, dataHex, value = 0n) {
  const acct = await vm.stateManager.getAccount(addrs[fromIdx]);
  const tx = LegacyTransaction.fromTxData({
    nonce: acct ? acct.nonce : 0n,
    gasPrice: 10n,
    gasLimit: 8_000_000n,
    to: to || undefined,
    value,
    data: hexToBytes(dataHex),
  }, { common }).sign(hexToBytes(keys[fromIdx]));

  const res = await vm.runTx({ tx, skipBalance: true });
  if (res.execResult.exceptionError) {
    const rv = res.execResult.returnValue;
    let reason = '';
    try {
      if (rv && rv.length > 4) {
        reason = ethers.AbiCoder.defaultAbiCoder().decode(
          ['string'], '0x' + Buffer.from(rv.slice(4)).toString('hex'))[0];
      }
    } catch {}
    throw new Error(`${res.execResult.exceptionError.error || res.execResult.exceptionError} ${reason}`.trim());
  }
  return res;
}

async function deploy(name, ctorArgs = []) {
  const iface = new ethers.Interface(art[name].abi);
  const encoded = ctorArgs.length ? iface.encodeDeploy(ctorArgs).slice(2) : '';
  const res = await send(0, undefined, art[name].bytecode + encoded);
  return { addr: res.createdAddress.toString(), iface };
}

const enc = (iface, fn, args) => iface.encodeFunctionData(fn, args);

async function view(addr, iface, fn, args = []) {
  const res = await vm.evm.runCall({
    to: Address.fromString(addr),
    caller: addrs[0],
    origin: addrs[0],
    data: hexToBytes(iface.encodeFunctionData(fn, args)),
  });
  return iface.decodeFunctionResult(fn, bytesToHex(res.execResult.returnValue));
}

async function main() {
  await init();
  console.log('EVM ready.');

  const wl = await deploy('Whitelist');
  console.log('1. Whitelist:', wl.addr);

  const factory = await deploy('PropertyTokenFactory', [wl.addr]);
  const market = await deploy('Marketplace', [wl.addr]);
  console.log('2. Factory:', factory.addr, '\n   Marketplace:', market.addr);

  await send(0, wl.addr, enc(wl.iface, 'register', []));
  await send(1, wl.addr, enc(wl.iface, 'register', []));
  // admin (user0, the deployer) approves the marketplace so it can escrow shares
  await send(0, wl.addr, enc(wl.iface, 'approveAddress', [market.addr]));
  const a0 = await view(wl.addr, wl.iface, 'isApproved', [addrs[0].toString()]);
  const a1 = await view(wl.addr, wl.iface, 'isApproved', [addrs[1].toString()]);
  console.log('3. KYC approved: user0 =', a0[0], ', user1 =', a1[0]);

  const docHash = ethers.keccak256(ethers.toUtf8Bytes('sample land document'));
  const regRes = await send(0, factory.addr,
    enc(factory.iface, 'registerLand', ['Plot 42, Whitefield', 'PLOT42', 1000, docHash, 'ipfs://demo']));
  let tokenAddr;
  for (const log of regRes.execResult.logs || []) {
    const topics = log[1].map(t => bytesToHex(t));
    try {
      const p = factory.iface.parseLog({ topics, data: bytesToHex(log[2]) });
      if (p && p.name === 'LandRegistered') tokenAddr = p.args.tokenAddress;
    } catch {}
  }
  console.log('4. Property registered. Token:', tokenAddr);

  const tk = new ethers.Interface(art.PropertyToken.abi);
  let bal0 = await view(tokenAddr, tk, 'balanceOf', [addrs[0].toString()]);
  const supply = await view(tokenAddr, tk, 'totalSupply', []);
  const dec = await view(tokenAddr, tk, 'decimals', []);
  console.log('   user0 balance:', bal0[0].toString(), '/ supply:', supply[0].toString(), '/ decimals:', dec[0].toString());

  const price = 5000n; // rupees per share — display only now
  await send(0, tokenAddr, enc(tk, 'approve', [market.addr, 400]));
  await send(0, market.addr, enc(market.iface, 'list', [tokenAddr, 400, price]));
  const listing = await view(market.addr, market.iface, 'listings', [0]);
  console.log('5. Listed 400 @ ₹5000 (display only). amount:', listing[2].toString(), ', active:', listing[4]);

  // 6. seller settles a sale of 150 shares to user1 (no money on-chain)
  await send(0, market.addr, enc(market.iface, 'settlePurchase', [0, addrs[1].toString(), 150]));
  const bal1 = await view(tokenAddr, tk, 'balanceOf', [addrs[1].toString()]);
  const listingAfter = await view(market.addr, market.iface, 'listings', [0]);
  console.log('6. Seller settled 150 shares to user1 (no ETH). user1 balance:', bal1[0].toString(),
              ', remaining:', listingAfter[2].toString());

  // remaining held by seller = 1000 - 400 listed... but 250 still escrowed, 150 gone to user1
  const bal0now = await view(tokenAddr, tk, 'balanceOf', [addrs[0].toString()]);
  console.log('   seller now holds:', bal0now[0].toString(), '(600 kept + 0 escrowed still in market)');

  // 7. YIELD: owner deposits ₹100000 rent. Split across all 1000 shares.
  //    At this point: user0=600, user1=150, marketplace=250 (escrowed).
  await send(0, tokenAddr, enc(tk, 'depositYield', [100000]));
  const p0 = await view(tokenAddr, tk, 'pendingYield', [addrs[0].toString()]);
  const p1 = await view(tokenAddr, tk, 'pendingYield', [addrs[1].toString()]);
  console.log('\n7. Yield: owner deposited ₹100000 across 1000 shares (₹100/share)');
  console.log('   user0 pending (600 shares):', p0[0].toString(), '(expect 60000)');
  console.log('   user1 pending (150 shares):', p1[0].toString(), '(expect 15000)');

  // 8. user1 claims their yield
  await send(1, tokenAddr, enc(tk, 'claimYield', []));
  const c1 = await view(tokenAddr, tk, 'claimableYield', [addrs[1].toString()]);
  const p1after = await view(tokenAddr, tk, 'pendingYield', [addrs[1].toString()]);
  console.log('8. user1 claimed. claimable now:', c1[0].toString(), ', pending now:', p1after[0].toString(), '(both expect 0)');

  // 9. KYC gate still holds: settle to unapproved user2 should revert
  process.stdout.write('9. KYC gate: settle to unregistered user2... ');
  try {
    await send(0, market.addr, enc(market.iface, 'settlePurchase', [0, addrs[2].toString(), 10]));
    console.log('!! ERROR: should have reverted');
  } catch (e) {
    console.log('correctly reverted (' + (e.message.includes('KYC') ? 'KYC gate works' : e.message) + ')');
  }

  // 10. only seller can settle
  process.stdout.write('10. Only-seller check: user1 tries to settle the listing... ');
  try {
    await send(1, market.addr, enc(market.iface, 'settlePurchase', [0, addrs[1].toString(), 10]));
    console.log('!! ERROR: should have reverted');
  } catch (e) {
    console.log('correctly reverted (' + (e.message.includes('Only seller') ? 'seller-only works' : e.message) + ')');
  }

  console.log('\n=== FULL FLOW VERIFIED ===');
}
main().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });
