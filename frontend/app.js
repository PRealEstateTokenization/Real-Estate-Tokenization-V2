/* ============================================================
   Parcel — app.js
   Real self-custody build: users connect their own MetaMask
   wallet on Sepolia and sign their own transactions. Known team
   wallets are shown by name; any other wallet shows its address.
   Ownership is recorded on-chain; payment/rent are rupees off-chain.
   ============================================================ */

let CONFIG = null, ABIS = null, provider = null;      // provider = read-only (Sepolia RPC)
let session = null;                                    // { name, role, address, signer }

/* ---- Known team wallets -> friendly name/role.
   Lowercase the address keys. Any wallet not listed here still works;
   it just shows as its shortened address. FILL IN when addresses arrive. ---- */
const NAMES = {
  "0x38331533814a12e238d8d7329d56fdeb9b46a6a4": { name:"Arya",    role:"Property Owner" },
  "0x4df0b8779cd4ea20f1bd27e114b7cd4bf756b0c3": { name:"Ronan",   role:"Investor" },
  // "0xRISHABH_ADDRESS_LOWERCASE": { name:"Rishabh", role:"Investor" },
};

const SEPOLIA_CHAIN_ID = "0xaa36a7"; // 11155111 in hex

/* ---------------- boot ---------------- */
async function boot(){
  try{
    const [addr, abis] = await Promise.all([
      fetch('./addresses.json').then(r=>r.json()),
      fetch('./abis.json').then(r=>r.json()),
    ]);
    CONFIG = addr; ABIS = abis;
    // read-only provider for viewing the chain without a wallet connected
    provider = new ethers.JsonRpcProvider(CONFIG.rpc);
  }catch(e){
    document.getElementById('app').innerHTML =
      '<div class="page container"><div class="status show err">Could not load contract config. '+
      'Make sure addresses.json and abis.json are in frontend/.</div></div>';
    return;
  }

  // react to the user switching accounts or networks in MetaMask
  if(window.ethereum){
    window.ethereum.on('accountsChanged', ()=>{ session=null; connectWallet(true); });
    window.ethereum.on('chainChanged', ()=>window.location.reload());
  }

  window.addEventListener('hashchange', render);
  render();
}

/* ---------------- contract helpers ---------------- */
const CONFIG_KEY = { Whitelist:'whitelist', PropertyTokenFactory:'factory', Marketplace:'marketplace' };
function contract(name, addrOverride){
  const addr = addrOverride || CONFIG[CONFIG_KEY[name]];
  if(!addr) throw new Error('No address configured for '+name+'.');
  // writes use the connected wallet's signer; reads can use the plain provider
  const signerOrProvider = session ? session.signer : provider;
  return new ethers.Contract(addr, ABIS[name], signerOrProvider);
}
function short(a){ return a.slice(0,6)+'\u2026'+a.slice(-4); }
function initials(name){ return name.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2); }
function rupee(n){ return '\u20B9'+Number(n).toLocaleString('en-IN'); }
function nameFor(addr){
  const known = NAMES[addr.toLowerCase()];
  return known ? known.name : short(addr);
}
function roleFor(addr){
  const known = NAMES[addr.toLowerCase()];
  return known ? known.role : 'Investor';
}

/* ---------------- wallet connect (replaces login) ---------------- */
async function connectWallet(silent){
  if(!window.ethereum){
    if(!silent) alert('MetaMask not found. Please install the MetaMask browser extension, then reload.');
    return { ok:false, error:'no-metamask' };
  }
  try{
    const accounts = await window.ethereum.request({ method:'eth_requestAccounts' });
    if(!accounts || !accounts.length) return { ok:false, error:'no-account' };

    const chainId = await window.ethereum.request({ method:'eth_chainId' });
    if(chainId !== SEPOLIA_CHAIN_ID){
      try{
        await window.ethereum.request({
          method:'wallet_switchEthereumChain',
          params:[{ chainId: SEPOLIA_CHAIN_ID }],
        });
      }catch(switchErr){
        if(!silent) alert('Please switch MetaMask to the Sepolia test network, then connect again.');
        return { ok:false, error:'wrong-network' };
      }
    }

    const browserProvider = new ethers.BrowserProvider(window.ethereum);
    const signer = await browserProvider.getSigner();
    const address = await signer.getAddress();

    session = { name:nameFor(address), role:roleFor(address), address, signer };
    render();
    return { ok:true };
  }catch(e){
    if(!silent){
      const msg = (e && e.code === 4001) ? 'Connection request was rejected.' : (e.message || 'Could not connect.');
      alert(msg);
    }
    return { ok:false, error:e };
  }
}
function logout(){ session = null; location.hash = '#/'; render(); }
function requireLogin(){
  if(!session){ connectWallet(false); return false; }
  return true;
}

/* ---------------- router ---------------- */
const routes = {
  '': renderHome, '/': renderHome,
  '/properties': renderProperties,
  '/dashboard': renderDashboard,
  '/list-property': renderListProperty,
};
async function render(){
  renderNav();
  const hash = location.hash.replace(/^#/,'') || '/';
  const app = document.getElementById('app');
  app.innerHTML = '<div class="loading">Loading\u2026</div>';

  if(hash.startsWith('/properties/') && hash !== '/properties/'){
    const addr = decodeURIComponent(hash.split('/properties/')[1]);
    return renderPropertyDetail(addr);
  }
  const fn = routes[hash] || renderHome;
  fn();
}

function renderNav(){
  const hash = location.hash.replace(/^#/,'') || '/';
  const isActive = p => hash===p || (p==='/properties' && hash.startsWith('/properties'));
  document.getElementById('nav').innerHTML = `
    <div class="nav-inner">
      <a href="#/" class="brand">Parcel<span class="dot">.</span></a>
      <div class="nav-links">
        <a href="#/" class="${isActive('/')?'active':''}">Home</a>
        <a href="#/properties" class="${isActive('/properties')?'active':''}">Properties</a>
        <a href="#/list-property" class="${isActive('/list-property')?'active':''}">List Property</a>
        <a href="#/dashboard" class="${isActive('/dashboard')?'active':''}">Dashboard</a>
      </div>
      <div class="nav-right">
        ${session
          ? `<div class="user-chip"><span class="avatar">${initials(session.name)}</span>${session.name}
              <button class="btn-logout" onclick="logout()">Disconnect</button></div>`
          : `<button class="btn-login-nav" onclick="connectWallet(false)">Connect Wallet</button>`}
      </div>
    </div>`;
}

/* ================= HOME ================= */
function renderHome(){
  document.getElementById('app').innerHTML = `
    <section class="hero">
      <div class="container">
        <span class="kicker">Real Estate Tokenisation</span>
        <h1>Own a share of real property, recorded on-chain.</h1>
        <p>Parcel divides verified properties into digital shares. The blockchain records exactly who owns
           what and distributes rental income pro-rata &mdash; no cryptocurrency required. Payment and rent
           are handled in rupees, off-chain.</p>
        <div class="hero-actions">
          <button class="btn gold" onclick="location.hash='#/properties'">Browse Properties</button>
          <button class="btn ghost" onclick="connectWallet(false)">Connect Wallet</button>
        </div>
      </div>
    </section>
    <section class="feature-strip">
      <div class="container grid-3">
        <div class="feature"><div class="num">01</div><h3>Verified Ownership</h3>
          <p>Every share is recorded on an immutable, independently verifiable ledger.</p></div>
        <div class="feature"><div class="num">02</div><h3>No Cryptocurrency</h3>
          <p>The chain records ownership only. Payment and rent are rupees, off-chain, always.</p></div>
        <div class="feature"><div class="num">03</div><h3>Pro-Rata Rent</h3>
          <p>Rental income is distributed automatically in proportion to shares held.</p></div>
      </div>
    </section>
    <div class="container" style="padding:50px 0">
      <div class="page-head"><h1>Featured Properties</h1><p>A sample of parcels currently tokenised on the platform.</p></div>
      <div id="homeProps" class="grid-3"><div class="loading">Loading properties\u2026</div></div>
    </div>`;
  loadPropertyCards('homeProps', 3);
}

/* ================= PROPERTIES (browse) ================= */
async function renderProperties(){
  document.getElementById('app').innerHTML = `
    <div class="page container">
      <div class="page-head">
        <span class="kicker">Marketplace</span>
        <h1>All Properties</h1>
        <p>Every parcel tokenised on the platform. Click one to view shares, listings, and rent.</p>
      </div>
      <div id="allProps" class="grid-3"><div class="loading">Loading properties\u2026</div></div>
    </div>`;
  loadPropertyCards('allProps', null);
}

async function loadPropertyCards(targetId, limit){
  const el = document.getElementById(targetId);
  try{
    const factory = contract('PropertyTokenFactory');
    let all = await factory.getAllTokens();
    if(limit) all = all.slice(0, limit);
    if(all.length===0){ el.innerHTML = '<div class="empty">No properties registered yet. Be the first to <a href="#/list-property" style="color:var(--blue);font-weight:600">list one</a>.</div>'; return; }
    let cards = '';
    for(const t of all){
      const tk = new ethers.Contract(t, ABIS.PropertyToken, provider);
      let name='Property', supply=0n, symbol='';
      try{ name=await tk.name(); supply=await tk.totalSupply(); symbol=await tk.symbol(); }catch{}
      cards += `<div class="prop-card" onclick="location.hash='#/properties/${t}'">
        <div class="thumb">${symbol||'PARCEL'}</div>
        <div class="body">
          <h3>${name}</h3>
          <div class="meta">${short(t)}</div>
          <div class="prop-stats">
            <div><span>Total Shares</span><b>${supply.toString()}</b></div>
            <div><span>Token</span><b>${symbol}</b></div>
          </div>
        </div>
      </div>`;
    }
    el.innerHTML = cards;
  }catch(e){ el.innerHTML = '<div class="empty">Could not load properties: '+(e.message||e)+'</div>'; }
}

/* ================= PROPERTY DETAIL ================= */
async function renderPropertyDetail(tokenAddr){
  const app = document.getElementById('app');
  app.innerHTML = '<div class="page container"><div class="loading">Loading property\u2026</div></div>';
  try{
    const tk = new ethers.Contract(tokenAddr, ABIS.PropertyToken, provider);
    const [name, symbol, supply, docHash, registrant] = await Promise.all([
      tk.name(), tk.symbol(), tk.totalSupply(), tk.docHash(), tk.registrant()
    ]);

    const me = session ? session.address : null;
    const myBalance = me ? await tk.balanceOf(me) : 0n;
    const myPending = me ? await tk.pendingYield(me) : 0n;
    const isOwner = me && me.toLowerCase()===registrant.toLowerCase();

    const market = contract('Marketplace');
    const n = Number(await market.nextListingId());
    let listingRows = '', myListingIdx = [];
    for(let i=0;i<n;i++){
      const l = await market.listings(i);
      if(l[1].toLowerCase() !== tokenAddr.toLowerCase()) continue;
      if(!l[4] && l[2]===0n) continue;
      const isSeller = me && l[0].toLowerCase()===me.toLowerCase();
      if(isSeller && l[4]) myListingIdx.push(i);
      listingRows += `<tr>
        <td>${short(l[0])}${isSeller?' <span class="tag-onchain">you</span>':''}</td>
        <td>${l[2].toString()}</td>
        <td class="rupee">${rupee(l[3])}</td>
        <td>${l[4]?'<span class="pill active">active</span>':'<span class="pill closed">closed</span>'}</td>
        <td>${(l[4]&&isSeller)?`
          <input id="buyer${i}" placeholder="buyer 0x..." style="width:150px;display:inline-block;padding:6px 8px;font-size:11px;margin-right:4px;font-family:monospace">
          <input id="qty${i}" type="number" placeholder="qty" style="width:56px;display:inline-block;padding:6px 8px;font-size:12px;margin-right:4px">
          <button class="btn small gold" onclick="handleSettle(${i})">Settle</button>`
          : (l[4] && me) ? `<button class="btn small outline" onclick="openBuy(${i}, '${l[2].toString()}', '${l[3].toString()}', '${l[0]}')">Buy</button>`
          : (l[4] && !me) ? `<button class="btn small outline" onclick="connectWallet(false)">Connect to buy</button>`
          : '\u2014'}</td>
      </tr>`;
    }

    app.innerHTML = `
      <div class="page container">
        <a href="#/properties" class="back-link">&larr; All Properties</a>
        <div class="page-head">
          <span class="kicker">${symbol}</span>
          <h1>${name}</h1>
          <p>${supply.toString()} total shares &middot; registered by ${short(registrant)}${isOwner?' (you)':''} &middot; document hash <span class="badge">${docHash.slice(0,14)}\u2026</span></p>
          <button class="btn outline small" style="margin-top:14px" onclick="downloadHistory('${tokenAddr}', '${name.replace(/'/g,"")}', '${symbol}')">&darr; Download Ownership History (CSV)</button>
        </div>

        <div class="grid-2">
          <div class="card">
            <div class="section-title">Your Position</div>
            <div class="section-sub">${session?'':'Connect your wallet to see your holdings for this property.'}</div>
            ${session?`
              <div class="grid-2" style="gap:14px">
                <div class="stat-card"><div class="label">Shares Held</div><div class="value">${myBalance.toString()}</div></div>
                <div class="stat-card"><div class="label">Claimable Rent</div><div class="value gold">${rupee(myPending)}</div></div>
              </div>
              ${myPending>0n?`<button class="btn gold block" style="margin-top:14px" onclick="handleClaim('${tokenAddr}')">Claim Rent</button>`:''}
              <div id="claimStatus" class="status"></div>
            `:`<button class="btn outline block" onclick="connectWallet(false)">Connect Wallet</button>`}
          </div>

          <div class="card">
            <div class="section-title">List Your Shares</div>
            <div class="section-sub">${myBalance>0n?'Offer some of your shares for resale.':'You need shares in this property to list them.'}</div>
            ${session && myBalance>0n ? `
              <label>Shares to list (you hold ${myBalance.toString()})</label>
              <input id="listAmt" type="number" value="${myBalance.toString()>50?50:1}" />
              <label>Price per share (\u20B9)</label>
              <input id="listPrice" type="number" value="5000" />
              <button class="btn block" style="margin-top:14px" onclick="handleList('${tokenAddr}')">Approve &amp; List</button>
              <div id="listStatus" class="status"></div>
            ` : `<div class="note">${session?'No shares to list.':'Log in first.'}</div>`}
          </div>
        </div>

        ${isOwner?`
        <div class="card">
          <div class="section-title">Distribute Rent</div>
          <div class="section-sub">As the property owner, record a rent distribution in rupees. It splits automatically, pro-rata, across every shareholder.</div>
          <div class="grid-2">
            <div><label>Amount to distribute (\u20B9)</label><input id="yieldAmt" type="number" value="100000" /></div>
            <div style="display:flex;align-items:flex-end"><button class="btn gold block" onclick="handleDeposit('${tokenAddr}')">Distribute Rent</button></div>
          </div>
          <div id="yieldStatus" class="status"></div>
        </div>`:''}

        <div class="card">
          <div class="section-title">Marketplace Listings</div>
          <div class="section-sub">All active and past listings for this property. Buyers see how to pay and request settlement; the seller settles once rupee payment is confirmed off-chain &mdash; no money moves on-chain.</div>
          <table>
            <thead><tr><th>Seller</th><th>Shares</th><th>Price/Share</th><th>Status</th><th>Action</th></tr></thead>
            <tbody>${listingRows || '<tr><td colspan=5 class="empty">No listings for this property yet.</td></tr>'}</tbody>
          </table>
        </div>

        <div id="buyPanelWrap"></div>
      </div>`;
  }catch(e){
    app.innerHTML = '<div class="page container"><div class="status show err">Could not load this property: '+(e.message||e)+'</div></div>';
  }
}

async function handleList(tokenAddr){
  if(!requireLogin()) return;
  try{
    const amount = BigInt(document.getElementById('listAmt').value);
    const price = BigInt(document.getElementById('listPrice').value);
    const tk = contract('PropertyToken', tokenAddr);
    setSt('listStatus','Step 1/2 \u2014 approving escrow\u2026','info');
    await (await tk.approve(CONFIG.marketplace, amount)).wait();
    setSt('listStatus','Step 2/2 \u2014 creating listing\u2026','info');
    await (await contract('Marketplace').list(tokenAddr, amount, price)).wait();
    setSt('listStatus','Listed '+amount+' shares at '+rupee(price)+' each.','ok');
    setTimeout(()=>renderPropertyDetail(tokenAddr), 700);
  }catch(e){ setSt('listStatus', prettyErr(e), 'err'); }
}
async function handleSettle(id){
  try{
    const buyer = document.getElementById('buyer'+id).value;
    const qty = BigInt(document.getElementById('qty'+id).value || '0');
    if(qty<=0n){ alert('Enter a quantity.'); return; }
    await (await contract('Marketplace').settlePurchase(id, buyer, qty)).wait();
    render();
  }catch(e){ alert(prettyErr(e)); }
}

/* Buyer-side flow (real self-custody).
   Payment is off-chain in rupees, and only the SELLER can release
   shares (the contract enforces this). So a buyer cannot complete a
   purchase by themselves. This panel gives the buyer exactly what they
   need to hand the seller: the amount to pay and their own wallet
   address. The seller then settles from their own wallet. */
function openBuy(listingId, remainingStr, priceStr, sellerAddr){
  const remaining = BigInt(remainingStr), price = BigInt(priceStr);
  const defaultQty = remaining < 10n ? remaining : 10n;
  const wrap = document.getElementById('buyPanelWrap');
  wrap.innerHTML = `
    <div class="card" style="border:1.5px solid var(--gold)">
      <div class="section-title">Buy Shares &mdash; Listing #${listingId}</div>
      <div class="section-sub">${remaining.toString()} shares available at ${rupee(price)} each.</div>
      <label>Quantity (max ${remaining.toString()})</label>
      <input id="buyQty" type="number" min="1" max="${remaining.toString()}" value="${defaultQty.toString()}"
             oninput="updateBuyTotal('${priceStr}')" />
      <div class="field-note" id="buyTotal">Amount to pay the seller: ${rupee(defaultQty*price)}</div>

      <div style="margin-top:16px;padding:14px;background:var(--cream2);border-radius:10px">
        <div style="font-weight:600;margin-bottom:8px">To complete this purchase:</div>
        <div class="field-note" style="margin-top:0">1. Pay the seller the amount above in rupees (UPI / bank transfer, off-chain).</div>
        <div class="field-note">2. Send the seller <b>your wallet address</b> (below) and the quantity.</div>
        <div class="field-note">3. The seller confirms payment and releases the shares to you from their wallet.</div>
        <label style="margin-top:12px">Your wallet address &mdash; give this to the seller</label>
        <input readonly value="${session ? session.address : 'connect your wallet first'}" onclick="this.select()"
               style="font-family:monospace;font-size:12px" />
        <div><b>Seller:</b> <span style="font-family:monospace;font-size:12px">${short(sellerAddr)}</span></div>
      </div>

      <button class="btn ghost small" style="margin-top:12px" onclick="document.getElementById('buyPanelWrap').innerHTML=''">Close</button>
    </div>`;
  wrap.scrollIntoView({behavior:'smooth', block:'center'});
}
function updateBuyTotal(priceStr){
  const price = BigInt(priceStr);
  const qty = BigInt(document.getElementById('buyQty').value || '0');
  document.getElementById('buyTotal').textContent = 'Amount to pay the seller: ' + rupee(qty*price);
}
async function handleDeposit(tokenAddr){
  try{
    const amt = BigInt(document.getElementById('yieldAmt').value);
    setSt('yieldStatus','Distributing\u2026','info');
    await (await contract('PropertyToken', tokenAddr).depositYield(amt)).wait();
    setSt('yieldStatus','Distributed '+rupee(amt)+' pro-rata across all shareholders.','ok');
    setTimeout(()=>renderPropertyDetail(tokenAddr), 700);
  }catch(e){ setSt('yieldStatus', prettyErr(e), 'err'); }
}
/* Download the full on-chain ownership history for a property as CSV.
   Reads every Transfer event directly from Sepolia via the read-only
   provider — works whether or not a wallet is connected. Each row is a
   permanent, publicly verifiable ownership change. */
async function downloadHistory(tokenAddr, name, symbol){
  try{
    const tk = new ethers.Contract(tokenAddr, ABIS.PropertyToken, provider);
    const events = await tk.queryFilter(tk.filters.Transfer(), 0, 'latest');
    const ZERO = '0x0000000000000000000000000000000000000000';

    const csvCell = s => { s = String(s); return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; };
    const header = ['#','Type','From','To','Shares','Block','Transaction Hash'];
    const rows = events.map((e,i)=>{
      const isMint = e.args.from === ZERO;
      return [
        i+1,
        isMint ? 'Mint (initial issue)' : 'Transfer',
        isMint ? '(newly minted)' : e.args.from,
        e.args.to,
        e.args.value.toString(),
        e.blockNumber,
        e.transactionHash,
      ];
    });

    const meta = [
      ['Property', name],
      ['Token Symbol', symbol],
      ['Token Contract', tokenAddr],
      ['Network', CONFIG.network || 'sepolia'],
      ['Exported', new Date().toLocaleString()],
      ['Total Records', rows.length],
      [],
    ];
    const csv = [...meta, header, ...rows].map(r => r.map(csvCell).join(',')).join('\n');

    const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${symbol||'property'}_ownership_history.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }catch(e){
    alert('Could not export history: ' + (e.message || e));
  }
}
async function handleClaim(tokenAddr){
  try{
    setSt('claimStatus','Claiming\u2026','info');
    await (await contract('PropertyToken', tokenAddr).claimYield()).wait();
    setSt('claimStatus','Claimed. (Rupee payout happens off-chain; this records the entitlement as settled.)','ok');
    setTimeout(()=>renderPropertyDetail(tokenAddr), 900);
  }catch(e){ setSt('claimStatus', prettyErr(e), 'err'); }
}

/* ================= LIST PROPERTY (register) ================= */
function renderListProperty(){
  if(!requireLogin()) return;
  document.getElementById('app').innerHTML = `
    <div class="page container" style="max-width:640px">
      <div class="page-head">
        <span class="kicker">Register</span>
        <h1>List a New Property</h1>
        <p>Tokenise a parcel into shares. You (as the registrant) receive 100% of the shares to start.</p>
      </div>
      <div class="card">
        <label>Property name</label><input id="pName" value="Puravankara, Tower A" />
        <label>Symbol</label><input id="pSymbol" value="PRVK-A" />
        <label>Total shares</label><input id="pShares" type="number" value="1000" />
        <div class="field-note">Whole-number shares. Owning 50 of 1000 = 5% of the property.</div>
        <label>Document reference</label><input id="pDoc" value="Title deed and khata extract" />
        <div class="field-note">Hashed on-chain (keccak256) so the record is tamper-evident.</div>
        <button class="btn block" style="margin-top:20px" onclick="handleRegister()">Register Property</button>
        <div id="regStatus" class="status"></div>
      </div>
    </div>`;
}
async function handleRegister(){
  try{
    const name = document.getElementById('pName').value.trim();
    const symbol = document.getElementById('pSymbol').value.trim();
    const shares = BigInt(document.getElementById('pShares').value);
    const docHash = ethers.keccak256(ethers.toUtf8Bytes(document.getElementById('pDoc').value));
    setSt('regStatus','Registering on-chain\u2026','info');
    const factory = contract('PropertyTokenFactory');
    const rc = await (await factory.registerLand(name, symbol, shares, docHash, 'demo')).wait();
    let tokenAddr;
    for(const log of rc.logs){ try{ const p=factory.interface.parseLog(log); if(p&&p.name==='LandRegistered') tokenAddr=p.args.tokenAddress; }catch{} }
    setSt('regStatus','Registered! Redirecting to your property\u2026','ok');
    setTimeout(()=>location.hash = '#/properties/'+tokenAddr, 900);
  }catch(e){ setSt('regStatus', prettyErr(e), 'err'); }
}

/* ================= DASHBOARD ================= */
async function renderDashboard(){
  if(!requireLogin()) return;
  const app = document.getElementById('app');
  app.innerHTML = '<div class="page container"><div class="loading">Loading your dashboard\u2026</div></div>';
  try{
    const factory = contract('PropertyTokenFactory');
    const all = await factory.getAllTokens();
    const me = session.address;

    let totalProps=0, totalPending=0n, holdingRows='', listingRows='';
    for(const t of all){
      const tk = new ethers.Contract(t, ABIS.PropertyToken, provider);
      const bal = await tk.balanceOf(me);
      if(bal>0n){
        totalProps++;
        let name='Property', supply=0n, pending=0n;
        try{ name=await tk.name(); supply=await tk.totalSupply(); pending=await tk.pendingYield(me); }catch{}
        totalPending += pending;
        const pct = supply>0n ? (Number(bal)*100/Number(supply)).toFixed(1) : '0';
        holdingRows += `<tr>
          <td><a href="#/properties/${t}" style="color:var(--blue);font-weight:600">${name}</a></td>
          <td>${bal.toString()}</td><td>${pct}%</td><td class="rupee">${rupee(pending)}</td>
        </tr>`;
      }
    }

    const market = contract('Marketplace');
    const n = Number(await market.nextListingId());
    let myActiveListings = 0;
    for(let i=0;i<n;i++){
      const l = await market.listings(i);
      if(l[0].toLowerCase()!==me.toLowerCase()) continue;
      if(!l[4]) continue;
      myActiveListings++;
      const tk = new ethers.Contract(l[1], ABIS.PropertyToken, provider);
      let name='Property'; try{ name = await tk.name(); }catch{}
      listingRows += `<tr>
        <td><a href="#/properties/${l[1]}" style="color:var(--blue);font-weight:600">${name}</a></td>
        <td>${l[2].toString()}</td><td class="rupee">${rupee(l[3])}</td>
        <td><a href="#/properties/${l[1]}" style="color:var(--blue);font-size:12.5px;font-weight:600">Manage &rarr;</a></td>
      </tr>`;
    }

    app.innerHTML = `
      <div class="page container">
        <div class="page-head">
          <span class="kicker">Dashboard</span>
          <h1>Welcome back, ${session.name}</h1>
          <p>${session.role} &middot; ${short(session.address)}</p>
        </div>

        <div class="grid-3" style="margin-bottom:24px">
          <div class="stat-card"><div class="label">Properties Held</div><div class="value">${totalProps}</div></div>
          <div class="stat-card"><div class="label">Claimable Rent (Total)</div><div class="value gold">${rupee(totalPending)}</div></div>
          <div class="stat-card"><div class="label">Active Listings</div><div class="value">${myActiveListings}</div></div>
        </div>

        <div class="card">
          <div class="section-title">Your Holdings</div>
          <div class="section-sub">Properties you own shares in.</div>
          <table>
            <thead><tr><th>Property</th><th>Shares</th><th>Ownership</th><th>Claimable Rent</th></tr></thead>
            <tbody>${holdingRows || '<tr><td colspan=4 class="empty">No holdings yet. <a href="#/properties" style="color:var(--blue);font-weight:600">Browse properties</a> or <a href="#/list-property" style="color:var(--blue);font-weight:600">register one</a>.</td></tr>'}</tbody>
          </table>
        </div>

        <div class="card">
          <div class="section-title">Your Active Listings</div>
          <div class="section-sub">Shares you currently have for sale.</div>
          <table>
            <thead><tr><th>Property</th><th>Shares Left</th><th>Price/Share</th><th></th></tr></thead>
            <tbody>${listingRows || '<tr><td colspan=4 class="empty">No active listings.</td></tr>'}</tbody>
          </table>
        </div>
      </div>`;
  }catch(e){
    app.innerHTML = '<div class="page container"><div class="status show err">Could not load dashboard: '+(e.message||e)+'</div></div>';
  }
}

/* ---------------- shared helpers ---------------- */
function setSt(id,msg,kind){ const el=document.getElementById(id); if(!el)return; el.textContent=msg; el.className='status show '+kind; }
function prettyErr(e){
  const m = e.reason || e.shortMessage || e.message || String(e);
  if(m.includes('KYC')) return 'This account is not verified for trading.';
  if(m.includes('Only property owner')) return 'Only the property owner can distribute rent.';
  if(m.includes('Only seller')) return 'Only the seller can settle their own listing.';
  if(m.includes('Nothing to claim')) return 'Nothing to claim yet.';
  if(m.includes('could not detect network')||m.includes('failed to detect')) return 'Cannot reach the network. Check your connection and that MetaMask is on Sepolia.';
  return m.length>140 ? m.slice(0,140)+'\u2026' : m;
}

boot();
