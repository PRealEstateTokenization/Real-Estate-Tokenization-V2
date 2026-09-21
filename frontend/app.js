/* ============================================================
   Parcel — app.js
   Real self-custody build: users connect their own MetaMask
   wallet on Sepolia and sign their own transactions.
   Ownership is recorded on-chain; payment/rent are rupees off-chain.
   Buying is real-time: shares are escrowed at listing, so a buyer
   completes a purchase in one click from their own wallet.

   Transaction reliability:
   - Every write is pre-flighted through the Alchemy read provider
     (simulates the call, estimates gas, surfaces revert reasons such
     as "not KYC-approved" BEFORE MetaMask is involved).
   - MetaMask is asked for exactly ONE thing: eth_sendTransaction
     (the signature popup), with gas already filled in.
   - Confirmation is watched through Alchemy, not through MetaMask.
   - Timeouts everywhere, and [tx] logs in the browser console.
   ============================================================ */

let CONFIG = null, ABIS = null, provider = null;   // provider = read-only (Alchemy / Sepolia RPC)
let session = null;                                 // { name, role, address }

/* ---- Known team wallets -> friendly name/role (lowercase keys) ---- */
const NAMES = {
  "0x38331533814a12e238d8d7329d56fdeb9b46a6a4": { name:"Arya",  role:"Property Owner" },
  "0x4df0b8779cd4ea20f1bd27e114b7cd4bf756b0c3": { name:"Ronan", role:"Investor" },
  // "0xrishabh_address_lowercase": { name:"Rishabh", role:"Investor" },
};

const SEPOLIA_CHAIN_ID = "0xaa36a7"; // 11155111

/* ---------------- boot ---------------- */
async function boot(){
  try{
    const [addr, abis] = await Promise.all([
      fetch('./addresses.json', { cache:'no-store' }).then(r=>r.json()),
      fetch('./abis.json',      { cache:'no-store' }).then(r=>r.json()),
    ]);
    CONFIG = addr; ABIS = abis;
    provider = new ethers.JsonRpcProvider(CONFIG.rpc, 11155111, { staticNetwork: true });
    console.log('[parcel] config loaded', CONFIG);
  }catch(e){
    document.getElementById('app').innerHTML =
      '<div class="page container"><div class="status show err">Could not load contract config. '+
      'Make sure addresses.json and abis.json are in frontend/.</div></div>';
    return;
  }

  if(window.ethereum){
    window.ethereum.on('accountsChanged', (accs)=>{
      session = null;
      if(accs && accs.length) connectWallet(true); else render();
    });
    window.ethereum.on('chainChanged', ()=>window.location.reload());
    // silently restore an existing connection (no popup)
    try{
      const accs = await window.ethereum.request({ method:'eth_accounts' });
      if(accs && accs.length) await connectWallet(true);
    }catch{}
  }

  window.addEventListener('hashchange', render);
  render();
}

/* ---------------- helpers ---------------- */
const CONFIG_KEY = { Whitelist:'whitelist', PropertyTokenFactory:'factory', Marketplace:'marketplace' };
function addrFor(name, addrOverride){
  const addr = addrOverride || CONFIG[CONFIG_KEY[name]];
  if(!addr) throw new Error('No address configured for '+name+'.');
  return addr;
}
function readContract(name, addrOverride){
  return new ethers.Contract(addrFor(name, addrOverride), ABIS[name], provider);
}
function short(a){ return a.slice(0,6)+'\u2026'+a.slice(-4); }
function initials(name){ return name.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2); }
function rupee(n){ return '\u20B9'+Number(n).toLocaleString('en-IN'); }
function nameFor(addr){ const k=NAMES[addr.toLowerCase()]; return k?k.name:short(addr); }
function roleFor(addr){ const k=NAMES[addr.toLowerCase()]; return k?k.role:'Investor'; }
function esc(s){ return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function withTimeout(p, ms, msg){
  let t; return Promise.race([p, new Promise((_,rej)=>{ t=setTimeout(()=>rej(new Error(msg)), ms); })])
    .finally(()=>clearTimeout(t));
}

/* ---------------- the one write path ----------------
   1) simulate + estimate gas via Alchemy (no MetaMask)
   2) ask MetaMask ONLY to sign & send (eth_sendTransaction)
   3) wait for the receipt via Alchemy                         */
async function sendTx(statusId, label, contractName, addrOverride, method, args){
  if(!session) throw new Error('Connect your wallet first.');
  const to = addrFor(contractName, addrOverride);
  const readC = new ethers.Contract(to, ABIS[contractName], provider);
  if(typeof readC[method] !== 'function') throw new Error(method+' is not a function');

  // make sure MetaMask is still on Sepolia
  const chainId = await withTimeout(window.ethereum.request({ method:'eth_chainId' }), 10000,
    'MetaMask is not responding. Click the MetaMask icon to unlock it, then try again.');
  if(chainId !== SEPOLIA_CHAIN_ID) throw new Error('MetaMask is not on Sepolia. Switch network and try again.');

  console.log('[tx]', label, '\u2014 preflight via RPC\u2026', method, args);
  setSt(statusId, label+' \u2014 checking\u2026', 'info');
  const gas = await withTimeout(readC[method].estimateGas(...args, { from: session.address }), 20000,
    'Network check timed out. Check your internet connection and try again.');
  const gasLimit = gas * 13n / 10n;
  const data = readC.interface.encodeFunctionData(method, args);
  console.log('[tx]', label, '\u2014 preflight OK, gas', gas.toString(), '\u2014 requesting signature');

  setSt(statusId, label+' \u2014 confirm in MetaMask\u2026', 'info');
  const hash = await withTimeout(
    window.ethereum.request({
      method: 'eth_sendTransaction',
      params: [{ from: session.address, to, data, gas: ethers.toQuantity(gasLimit) }],
    }),
    120000,
    'MetaMask did not respond. Click the MetaMask icon (a request may be waiting there), or reload the page and reconnect.');
  console.log('[tx]', label, '\u2014 sent', hash);

  setSt(statusId, label+' \u2014 waiting for Sepolia confirmation (~15s)\u2026', 'info');
  const rc = await provider.waitForTransaction(hash, 1, 180000).catch(()=>null);
  if(!rc) throw new Error('Sent but not confirmed yet. Check sepolia.etherscan.io/tx/'+hash);
  if(rc.status === 0) throw new Error('Transaction reverted on-chain. See sepolia.etherscan.io/tx/'+hash);
  console.log('[tx]', label, '\u2014 confirmed in block', rc.blockNumber);
  return rc;
}

/* ---------------- wallet connect ---------------- */
async function connectWallet(silent){
  if(!window.ethereum){
    if(!silent) alert('MetaMask not found. Install the MetaMask extension, then reload.');
    return { ok:false };
  }
  try{
    const accounts = await window.ethereum.request({ method: silent ? 'eth_accounts' : 'eth_requestAccounts' });
    if(!accounts || !accounts.length) return { ok:false };

    const chainId = await window.ethereum.request({ method:'eth_chainId' });
    if(chainId !== SEPOLIA_CHAIN_ID){
      if(silent) return { ok:false };
      try{
        await window.ethereum.request({ method:'wallet_switchEthereumChain', params:[{ chainId: SEPOLIA_CHAIN_ID }] });
      }catch{
        alert('Please switch MetaMask to the Sepolia test network, then connect again.');
        return { ok:false };
      }
    }
    const address = ethers.getAddress(accounts[0]);
    session = { name:nameFor(address), role:roleFor(address), address };
    console.log('[parcel] connected', address);
    render();
    return { ok:true };
  }catch(e){
    if(!silent){
      alert(e && e.code === 4001 ? 'Connection request was rejected.'
        : e && e.code === -32002 ? 'A MetaMask request is already open. Click the MetaMask icon to finish it.'
        : (e.message || 'Could not connect.'));
    }
    return { ok:false };
  }
}
function logout(){ session = null; location.hash = '#/'; render(); }
function requireLogin(){ if(!session){ connectWallet(false); return false; } return true; }

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
    return renderPropertyDetail(decodeURIComponent(hash.split('/properties/')[1]));
  }
  (routes[hash] || renderHome)();
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
          ? `<div class="user-chip"><span class="avatar">${initials(session.name)}</span>${esc(session.name)}
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
          ${session?'':'<button class="btn ghost" onclick="connectWallet(false)">Connect Wallet</button>'}
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

/* ================= PROPERTIES ================= */
function renderProperties(){
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
    let all = await withTimeout(readContract('PropertyTokenFactory').getAllTokens(), 15000,
      'Timed out reaching Sepolia. Check the rpc URL in addresses.json.');
    all = [...all].reverse();               // newest first
    if(limit) all = all.slice(0, limit);
    if(!el) return;
    if(all.length===0){
      el.innerHTML = '<div class="empty">No properties registered yet. Be the first to <a href="#/list-property" style="color:var(--blue);font-weight:600">list one</a>.</div>';
      return;
    }
    const cards = await Promise.all(all.map(async t=>{
      const tk = new ethers.Contract(t, ABIS.PropertyToken, provider);
      let name='Property', supply=0n, symbol='';
      try{ [name, supply, symbol] = await Promise.all([tk.name(), tk.totalSupply(), tk.symbol()]); }catch{}
      return `<div class="prop-card" onclick="location.hash='#/properties/${t}'">
        <div class="thumb">${esc(symbol||'PARCEL')}</div>
        <div class="body">
          <h3>${esc(name)}</h3>
          <div class="meta">${short(t)}</div>
          <div class="prop-stats">
            <div><span>Total Shares</span><b>${supply.toString()}</b></div>
            <div><span>Token</span><b>${esc(symbol)}</b></div>
          </div>
        </div>
      </div>`;
    }));
    el.innerHTML = cards.join('');
  }catch(e){
    if(el) el.innerHTML = '<div class="empty" style="color:#b3261e">Could not load properties: '+esc(e.shortMessage||e.message||e)+'</div>';
  }
}

/* ================= PROPERTY DETAIL ================= */
async function renderPropertyDetail(tokenAddr){
  const app = document.getElementById('app');
  app.innerHTML = '<div class="page container"><div class="loading">Loading property\u2026</div></div>';
  try{
    const tk = new ethers.Contract(tokenAddr, ABIS.PropertyToken, provider);
    const [name, symbol, supply, docHash, registrant] = await withTimeout(Promise.all([
      tk.name(), tk.symbol(), tk.totalSupply(), tk.docHash(), tk.registrant()
    ]), 15000, 'Timed out reaching Sepolia.');

    const me = session ? session.address : null;
    const [myBalance, myPending] = me
      ? await Promise.all([tk.balanceOf(me), tk.pendingYield(me)])
      : [0n, 0n];
    const isOwner = me && me.toLowerCase()===registrant.toLowerCase();

    const market = readContract('Marketplace');
    const n = Number(await market.nextListingId());
    const all = await Promise.all(Array.from({length:n}, (_,i)=>market.listings(i)));

    let listingRows = '';
    all.forEach((l,i)=>{
      if(l[1].toLowerCase() !== tokenAddr.toLowerCase()) return;
      const [seller, , remaining, price, active] = l;
      const isSeller = me && seller.toLowerCase()===me.toLowerCase();
      let action = '\u2014';
      if(active){
        if(!me) action = `<button class="btn small outline" onclick="connectWallet(false)">Connect to buy</button>`;
        else if(isSeller) action = `<button class="btn small outline" onclick="handleCancel(${i}, '${tokenAddr}')">Cancel listing</button>`;
        else action = `<button class="btn small gold" onclick="openBuy(${i}, '${remaining}', '${price}', '${tokenAddr}')">Buy</button>`;
      }
      listingRows += `<tr>
        <td>${esc(nameFor(seller))}${isSeller?' <span class="tag-onchain">you</span>':''}</td>
        <td>${remaining.toString()}</td>
        <td class="rupee">${rupee(price)}</td>
        <td>${active?'<span class="pill active">active</span>':'<span class="pill closed">closed</span>'}</td>
        <td>${action}</td>
      </tr>`;
    });

    const safeName = String(name).replace(/['"\\]/g,'');
    app.innerHTML = `
      <div class="page container">
        <a href="#/properties" class="back-link">&larr; All Properties</a>
        <div class="page-head">
          <span class="kicker">${esc(symbol)}</span>
          <h1>${esc(name)}</h1>
          <p>${supply.toString()} total shares &middot; registered by ${esc(nameFor(registrant))}${isOwner?' (you)':''} &middot; document hash <span class="badge">${docHash.slice(0,14)}\u2026</span></p>
          <button id="dlBtn" class="btn outline small" style="margin-top:14px" onclick="downloadHistory('${tokenAddr}', '${esc(safeName)}', '${esc(symbol)}')">&darr; Download Ownership History (CSV)</button>
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
            <div class="section-sub">${myBalance>0n?'Offer some of your shares for resale. They are held in escrow until sold or cancelled.':'You need shares in this property to list them.'}</div>
            ${session && myBalance>0n ? `
              <label>Shares to list (you hold ${myBalance.toString()})</label>
              <input id="listAmt" type="number" min="1" max="${myBalance}" value="${myBalance>50n?50:1}" />
              <label>Price per share (\u20B9)</label>
              <input id="listPrice" type="number" min="1" value="5000" />
              <button class="btn block" style="margin-top:14px" onclick="handleList('${tokenAddr}')">Approve &amp; List</button>
              <div id="listStatus" class="status"></div>
            ` : `<div class="note">${session?'No shares to list.':'Connect your wallet first.'}</div>`}
          </div>
        </div>

        ${isOwner?`
        <div class="card">
          <div class="section-title">Distribute Rent</div>
          <div class="section-sub">As the property owner, record a rent distribution in rupees. It splits automatically, pro-rata, across every shareholder.</div>
          <div class="grid-2">
            <div><label>Amount to distribute (\u20B9)</label><input id="yieldAmt" type="number" min="1" value="100000" /></div>
            <div style="display:flex;align-items:flex-end"><button class="btn gold block" onclick="handleDeposit('${tokenAddr}')">Distribute Rent</button></div>
          </div>
          <div id="yieldStatus" class="status"></div>
        </div>`:''}

        <div class="card">
          <div class="section-title">Marketplace Listings</div>
          <div class="section-sub">Buying is instant: listed shares are held in escrow, so a purchase transfers them straight to your wallet. Payment is settled in rupees, off-chain &mdash; no money moves on-chain.</div>
          <table>
            <thead><tr><th>Seller</th><th>Shares</th><th>Price/Share</th><th>Status</th><th>Action</th></tr></thead>
            <tbody>${listingRows || '<tr><td colspan=5 class="empty">No listings for this property yet.</td></tr>'}</tbody>
          </table>
          <div id="cancelStatus" class="status"></div>
        </div>

        <div id="buyPanelWrap"></div>
      </div>`;
  }catch(e){
    app.innerHTML = '<div class="page container"><div class="status show err">Could not load this property: '+esc(e.shortMessage||e.message||e)+'</div></div>';
  }
}

/* ---------------- write actions ---------------- */
async function handleList(tokenAddr){
  if(!requireLogin()) return;
  try{
    const amount = BigInt(document.getElementById('listAmt').value || '0');
    const price  = BigInt(document.getElementById('listPrice').value || '0');
    if(amount<=0n || price<=0n) throw new Error('Invalid amount');
    const tk = new ethers.Contract(tokenAddr, ABIS.PropertyToken, provider);
    const allowance = await tk.allowance(session.address, CONFIG.marketplace);
    if(allowance < amount){
      await sendTx('listStatus','Step 1/2: approving escrow','PropertyToken',tokenAddr,'approve',[CONFIG.marketplace, amount]);
    }
    await sendTx('listStatus','Step 2/2: creating listing','Marketplace',null,'list',[tokenAddr, amount, price]);
    setSt('listStatus','Listed '+amount+' shares at '+rupee(price)+' each.','ok');
    setTimeout(()=>renderPropertyDetail(tokenAddr), 800);
  }catch(e){ console.error('[tx] list failed', e); setSt('listStatus', prettyErr(e), 'err'); }
}

async function handleCancel(id, tokenAddr){
  if(!requireLogin()) return;
  try{
    await sendTx('cancelStatus','Cancelling listing','Marketplace',null,'cancel',[id]);
    setSt('cancelStatus','Listing cancelled. Unsold shares returned to your wallet.','ok');
    setTimeout(()=>renderPropertyDetail(tokenAddr), 800);
  }catch(e){ console.error('[tx] cancel failed', e); setSt('cancelStatus', prettyErr(e), 'err'); }
}

function openBuy(listingId, remainingStr, priceStr, tokenAddr){
  const remaining = BigInt(remainingStr), price = BigInt(priceStr);
  const defaultQty = remaining < 10n ? remaining : 10n;
  const wrap = document.getElementById('buyPanelWrap');
  wrap.innerHTML = `
    <div class="card" style="border:1.5px solid var(--gold)">
      <div class="section-title">Buy Shares &mdash; Listing #${listingId}</div>
      <div class="section-sub">${remaining} shares available at ${rupee(price)} each.</div>
      <label>Quantity (max ${remaining})</label>
      <input id="buyQty" type="number" min="1" max="${remaining}" value="${defaultQty}"
             oninput="updateBuyTotal('${priceStr}')" />
      <div class="field-note" id="buyTotal">Total: ${rupee(defaultQty*price)} (settled in rupees, off-chain)</div>
      <div style="display:flex;gap:10px;margin-top:16px">
        <button class="btn gold" onclick="confirmBuy(${listingId}, '${tokenAddr}', '${remainingStr}')">Confirm Purchase</button>
        <button class="btn ghost" onclick="document.getElementById('buyPanelWrap').innerHTML=''">Close</button>
      </div>
      <div id="buyStatus" class="status"></div>
    </div>`;
  wrap.scrollIntoView({behavior:'smooth', block:'center'});
}
function updateBuyTotal(priceStr){
  const qty = BigInt(document.getElementById('buyQty').value || '0');
  document.getElementById('buyTotal').textContent =
    'Total: ' + rupee(qty*BigInt(priceStr)) + ' (settled in rupees, off-chain)';
}
async function confirmBuy(listingId, tokenAddr, remainingStr){
  if(!requireLogin()) return;
  try{
    const qty = BigInt(document.getElementById('buyQty').value || '0');
    if(qty<=0n || qty>BigInt(remainingStr)) throw new Error('Invalid amount');
    await sendTx('buyStatus','Buying shares','Marketplace',null,'buy',[listingId, qty]);
    setSt('buyStatus','Done \u2014 '+qty+' shares are now in your wallet.','ok');
    setTimeout(()=>renderPropertyDetail(tokenAddr), 1000);
  }catch(e){ console.error('[tx] buy failed', e); setSt('buyStatus', prettyErr(e), 'err'); }
}

async function handleDeposit(tokenAddr){
  if(!requireLogin()) return;
  try{
    const amt = BigInt(document.getElementById('yieldAmt').value || '0');
    if(amt<=0n) throw new Error('Invalid amount');
    await sendTx('yieldStatus','Distributing rent','PropertyToken',tokenAddr,'depositYield',[amt]);
    setSt('yieldStatus','Distributed '+rupee(amt)+' pro-rata across all shareholders.','ok');
    setTimeout(()=>renderPropertyDetail(tokenAddr), 800);
  }catch(e){ console.error('[tx] deposit failed', e); setSt('yieldStatus', prettyErr(e), 'err'); }
}

async function handleClaim(tokenAddr){
  if(!requireLogin()) return;
  try{
    await sendTx('claimStatus','Claiming rent','PropertyToken',tokenAddr,'claimYield',[]);
    setSt('claimStatus','Claimed. (Rupee payout happens off-chain; this records the entitlement as settled.)','ok');
    setTimeout(()=>renderPropertyDetail(tokenAddr), 900);
  }catch(e){ console.error('[tx] claim failed', e); setSt('claimStatus', prettyErr(e), 'err'); }
}

/* ================= OWNERSHIP HISTORY CSV =================
   Alchemy's free tier only allows eth_getLogs over 10 blocks per call,
   so: (1) find the block the token was created in (binary search on
   getCode — ~25 cheap calls), then (2) scan Transfer logs from there to
   the latest block in 10-block chunks, several chunks in parallel.     */
async function findDeployBlock(addr, latest){
  let lo = 0, hi = latest;
  while(lo < hi){
    const mid = Math.floor((lo+hi)/2);
    const code = await provider.getCode(addr, mid);
    if(code && code !== '0x') hi = mid; else lo = mid + 1;
  }
  return lo;
}
async function downloadHistory(tokenAddr, name, symbol){
  const btn = document.getElementById('dlBtn');
  const label = btn ? btn.innerHTML : '';
  const prog = t => { if(btn) btn.textContent = t; };
  try{
    if(btn) btn.disabled = true;
    prog('Finding creation block\u2026');
    const latest = await provider.getBlockNumber();
    const start = await findDeployBlock(tokenAddr, latest);

    const topic = ethers.id('Transfer(address,address,uint256)');
    const CHUNK = 10, PAR = 8;
    const ranges = [];
    for(let b=start; b<=latest; b+=CHUNK) ranges.push([b, Math.min(b+CHUNK-1, latest)]);

    const iface = new ethers.Interface(ABIS.PropertyToken);
    const logs = [];
    for(let i=0; i<ranges.length; i+=PAR){
      prog('Reading chain\u2026 '+Math.min(100, Math.round(i*100/ranges.length))+'%');
      const batch = ranges.slice(i, i+PAR).map(([f,t])=>
        provider.getLogs({ address: tokenAddr, topics:[topic], fromBlock:f, toBlock:t }));
      for(const r of await Promise.all(batch)) logs.push(...r);
    }
    logs.sort((a,b)=> a.blockNumber-b.blockNumber || a.index-b.index);

    const ZERO = ethers.ZeroAddress;
    const csvCell = s => { s = String(s); return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; };
    const tag = a => a.toLowerCase()===CONFIG.marketplace.toLowerCase() ? a+' (Marketplace escrow)' : a;
    const rows = logs.map((lg,i)=>{
      const p = iface.parseLog(lg);
      const from = p.args[0], to = p.args[1], value = p.args[2];
      const isMint = from === ZERO;
      return [ i+1, isMint ? 'Mint (initial issue)' : 'Transfer',
        isMint ? '(newly minted)' : tag(from), tag(to), value.toString(), lg.blockNumber, lg.transactionHash ];
    });
    const meta = [
      ['Property', name], ['Token Symbol', symbol], ['Token Contract', tokenAddr],
      ['Network', CONFIG.network || 'sepolia'], ['Exported', new Date().toLocaleString()],
      ['Total Records', rows.length], [],
    ];
    const header = ['#','Type','From','To','Shares','Block','Transaction Hash'];
    const csv = [...meta, header, ...rows].map(r => r.map(csvCell).join(',')).join('\n');

    const url = URL.createObjectURL(new Blob([csv], { type:'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url; a.download = `${symbol||'property'}_ownership_history.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }catch(e){
    console.error('[history] failed', e);
    alert('Could not export history: ' + (e.shortMessage || e.message || e));
  }finally{
    if(btn){ btn.disabled = false; btn.innerHTML = label; }
  }
}

/* ================= LIST PROPERTY (register) ================= */
function renderListProperty(){
  if(!session){
    document.getElementById('app').innerHTML = `
      <div class="page container" style="max-width:640px">
        <div class="page-head"><span class="kicker">Register</span><h1>List a New Property</h1>
          <p>Connect your wallet to register a property.</p></div>
        <button class="btn" onclick="connectWallet(false)">Connect Wallet</button>
      </div>`;
    return;
  }
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
        <label>Total shares</label><input id="pShares" type="number" min="1" value="1000" />
        <div class="field-note">Whole-number shares. Owning 50 of 1000 = 5% of the property.</div>
        <label>Document reference</label><input id="pDoc" value="Title deed and khata extract" />
        <div class="field-note">Hashed on-chain (keccak256) so the record is tamper-evident.</div>
        <button id="regBtn" class="btn block" style="margin-top:20px" onclick="handleRegister()">Register Property</button>
        <div id="regStatus" class="status"></div>
      </div>
    </div>`;
}
async function handleRegister(){
  if(!requireLogin()) return;
  const btn = document.getElementById('regBtn');
  try{
    if(btn) btn.disabled = true;
    const name = document.getElementById('pName').value.trim();
    const symbol = document.getElementById('pSymbol').value.trim();
    const shares = BigInt(document.getElementById('pShares').value || '0');
    if(!name || !symbol || shares<=0n) throw new Error('Fill in a name, symbol and a share count above 0.');
    const docHash = ethers.keccak256(ethers.toUtf8Bytes(document.getElementById('pDoc').value));

    const rc = await sendTx('regStatus','Registering property','PropertyTokenFactory',null,'registerLand',
      [name, symbol, shares, docHash, 'demo']);

    const iface = new ethers.Interface(ABIS.PropertyTokenFactory);
    let tokenAddr = null;
    for(const log of rc.logs){
      try{ const p = iface.parseLog(log); if(p && p.name==='LandRegistered') tokenAddr = p.args.tokenAddress; }catch{}
    }
    setSt('regStatus','Registered! Opening your property\u2026','ok');
    setTimeout(()=>{ location.hash = tokenAddr ? '#/properties/'+tokenAddr : '#/properties'; }, 900);
  }catch(e){
    console.error('[tx] register failed', e);
    setSt('regStatus', prettyErr(e), 'err');
  }finally{
    if(btn) btn.disabled = false;
  }
}

/* ================= DASHBOARD ================= */
async function renderDashboard(){
  const app = document.getElementById('app');
  if(!session){
    app.innerHTML = `<div class="page container"><div class="page-head"><span class="kicker">Dashboard</span>
      <h1>Your Dashboard</h1><p>Connect your wallet to see your holdings.</p></div>
      <button class="btn" onclick="connectWallet(false)">Connect Wallet</button></div>`;
    return;
  }
  app.innerHTML = '<div class="page container"><div class="loading">Loading your dashboard\u2026</div></div>';
  try{
    const me = session.address;
    const all = await withTimeout(readContract('PropertyTokenFactory').getAllTokens(), 15000, 'Timed out reaching Sepolia.');

    const holdings = await Promise.all(all.map(async t=>{
      const tk = new ethers.Contract(t, ABIS.PropertyToken, provider);
      const bal = await tk.balanceOf(me);
      if(bal===0n) return null;
      const [name, supply, pending] = await Promise.all([tk.name(), tk.totalSupply(), tk.pendingYield(me)]);
      return { t, name, supply, pending, bal };
    }));
    let totalProps=0, totalPending=0n, holdingRows='';
    for(const h of holdings){
      if(!h) continue;
      totalProps++; totalPending += h.pending;
      const pct = h.supply>0n ? (Number(h.bal)*100/Number(h.supply)).toFixed(1) : '0';
      holdingRows += `<tr>
        <td><a href="#/properties/${h.t}" style="color:var(--blue);font-weight:600">${esc(h.name)}</a></td>
        <td>${h.bal}</td><td>${pct}%</td><td class="rupee">${rupee(h.pending)}</td></tr>`;
    }

    const market = readContract('Marketplace');
    const n = Number(await market.nextListingId());
    const listings = await Promise.all(Array.from({length:n}, (_,i)=>market.listings(i)));
    let myActiveListings = 0, listingRows = '';
    for(const l of listings){
      if(l[0].toLowerCase()!==me.toLowerCase() || !l[4]) continue;
      myActiveListings++;
      let name='Property'; try{ name = await new ethers.Contract(l[1], ABIS.PropertyToken, provider).name(); }catch{}
      listingRows += `<tr>
        <td><a href="#/properties/${l[1]}" style="color:var(--blue);font-weight:600">${esc(name)}</a></td>
        <td>${l[2]}</td><td class="rupee">${rupee(l[3])}</td>
        <td><a href="#/properties/${l[1]}" style="color:var(--blue);font-size:12.5px;font-weight:600">Manage &rarr;</a></td></tr>`;
    }

    app.innerHTML = `
      <div class="page container">
        <div class="page-head">
          <span class="kicker">Dashboard</span>
          <h1>Welcome back, ${esc(session.name)}</h1>
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
          <div class="section-sub">Shares you currently have for sale (held in escrow).</div>
          <table>
            <thead><tr><th>Property</th><th>Shares Left</th><th>Price/Share</th><th></th></tr></thead>
            <tbody>${listingRows || '<tr><td colspan=4 class="empty">No active listings.</td></tr>'}</tbody>
          </table>
        </div>
      </div>`;
  }catch(e){
    app.innerHTML = '<div class="page container"><div class="status show err">Could not load dashboard: '+esc(e.shortMessage||e.message||e)+'</div></div>';
  }
}

/* ---------------- shared helpers ---------------- */
function setSt(id,msg,kind){ const el=document.getElementById(id); if(!el) return; el.textContent=msg; el.className='status show '+kind; }
function prettyErr(e){
  const m = String(e && (e.reason || (e.info && e.info.error && e.info.error.message) || e.shortMessage || e.message) || e);
  if(/KYC/i.test(m)) return 'This wallet is not KYC-approved on the current contracts. After a redeploy, run scripts/approve-wallets.js again.';
  if(m.includes('Only property owner')) return 'Only the property owner can distribute rent.';
  if(m.includes('Seller cannot buy')) return 'You cannot buy your own listing. Use Cancel instead.';
  if(m.includes('Not seller')) return 'Only the seller can cancel this listing.';
  if(m.includes('Nothing to claim')) return 'Nothing to claim yet.';
  if(m.includes('Listing not active')) return 'This listing is no longer active. Refresh the page.';
  if(m.includes('Invalid amount') || m.includes('must be > 0')) return 'Enter a valid quantity.';
  if(/insufficient funds/i.test(m)) return 'Not enough Sepolia test ETH for gas. Top up from a Sepolia faucet (free) and try again.';
  if((e && (e.code === 4001 || e.code === 'ACTION_REJECTED')) || /user (rejected|denied)/i.test(m)) return 'You rejected the request in MetaMask.';
  if(e && e.code === -32002) return 'A MetaMask request is already open. Click the MetaMask icon to finish it.';
  if(m.includes('is not a function') || m.includes('no matching fragment')) return 'The ABI is out of date. Re-copy frontend-config/abis.json into frontend/ and hard-refresh.';
  if(/could not detect network|failed to detect|network error|Failed to fetch/i.test(m)) return 'Cannot reach Sepolia. Check your connection and the rpc URL in addresses.json.';
  return m.length>180 ? m.slice(0,180)+'\u2026' : m;
}

boot();
