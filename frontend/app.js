/* ============================================================
   Parcel.io — app.js
   Real self-custody build: users connect their own MetaMask
   wallet on Sepolia and sign their own transactions.
   Units are recorded on-chain; payment and rent are rupees, off-chain.
   Buying is real-time: units are escrowed at listing, so a buyer
   completes a purchase in one click from their own wallet.

   Transaction reliability:
   - Every write is pre-flighted through the Alchemy read provider
     (simulates the call, estimates gas, surfaces revert reasons such
     as "not KYC-approved" BEFORE MetaMask is involved).
   - MetaMask is asked for exactly ONE thing: eth_sendTransaction
     (the signature popup), with gas already filled in.
   - Confirmation is watched through Alchemy, not through MetaMask.
   - Timeouts everywhere, and [tx] logs in the browser console.

   Off-chain (Supabase): property photos. Fill in SUPABASE_URL and
   SUPABASE_ANON_KEY below. The anon key is safe in the browser;
   never put the service_role key here.
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

/* ---------------- Supabase (property photos) ---------------- */
const SUPABASE_URL      = 'https://aeqgvrjppxzjhoxuploh.supabase.co/rest/v1/';
const SUPABASE_ANON_KEY = 'sb_publishable_BdE-SjAqpq81wSuViL1C9g_q9fYAUqI';
const BUCKET = 'property-images';
const sb = (window.supabase && SUPABASE_URL.startsWith('https') && !SUPABASE_URL.includes('YOUR-PROJECT'))
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

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
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
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
      <a href="#/" class="brand">Parcel<span class="dot">.io</span></a>
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
        <span class="kicker">Real estate for every Indian</span>
        <h1>Buy a unit. Earn the rent. Trade anytime.</h1>
        <p>Parcel.io divides rent-yielding properties into small units. The blockchain records exactly who
           holds which units and splits rental income pro-rata &mdash; no cryptocurrency required. Payment
           and rent are handled in rupees, off-chain.</p>
        <div class="hero-actions">
          <button class="btn gold" onclick="location.hash='#/properties'">Browse Properties</button>
          ${session?'':'<button class="btn ghost" onclick="connectWallet(false)">Connect Wallet</button>'}
        </div>
      </div>
    </section>
    <section class="feature-strip">
      <div class="container grid-3">
        <div class="feature"><div class="num">01</div><h3>Verified Records</h3>
          <p>Every unit is recorded on an immutable, independently verifiable ledger.</p></div>
        <div class="feature"><div class="num">02</div><h3>No Cryptocurrency</h3>
          <p>The chain records unit holdings only. Payment and rent are rupees, off-chain, always.</p></div>
        <div class="feature"><div class="num">03</div><h3>Pro-Rata Rent</h3>
          <p>Rental income is split automatically in proportion to the units each investor holds.</p></div>
      </div>
    </section>
    <div class="container" style="padding:50px 0">
      <div class="page-head"><h1>Featured Properties</h1><p>Rent-yielding properties currently on the platform.</p></div>
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
        <p>Every property tokenised on the platform. Click one to view units, listings, documents and rent.</p>
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
    const media = await getAllMedia().catch(()=>({}));
    const cards = await Promise.all(all.map(async t=>{
      const tk = new ethers.Contract(t, ABIS.PropertyToken, provider);
      let name='Property', supply=0n, symbol='';
      try{ [name, supply, symbol] = await Promise.all([tk.name(), tk.totalSupply(), tk.symbol()]); }catch{}
      const img = (media[t.toLowerCase()] || [])[0];
      const thumb = img
        ? `<div class="thumb has-photo" style="background-image:linear-gradient(180deg,rgba(0,0,0,0) 45%,rgba(0,0,0,.55)),url('${esc(img)}')">${esc(symbol||'PARCEL')}</div>`
        : `<div class="thumb">${esc(symbol||'PARCEL')}</div>`;
      return `<div class="prop-card" onclick="location.hash='#/properties/${t}'">
        ${thumb}
        <div class="body">
          <h3>${esc(name)}</h3>
          <div class="meta">${short(t)}</div>
          <div class="prop-stats">
            <div><span>Total Units</span><b>${supply.toString()}</b></div>
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
    const imgs = (((await getMedia(tokenAddr).catch(()=>null)) || {}).image_urls) || [];

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
          <p>${supply.toString()} total units &middot; registered by ${esc(nameFor(registrant))}${isOwner?' (you)':''} &middot; document hash <span class="badge">${docHash.slice(0,14)}\u2026</span></p>
          <button id="dlBtn" class="btn outline small" style="margin-top:14px" onclick="downloadHistory('${tokenAddr}', '${esc(safeName)}', '${esc(symbol)}')">&darr; Download Ownership History (CSV)</button>
        </div>

        ${imgs.length ? `<div class="gallery g${Math.min(imgs.length,3)}">${imgs.slice(0,3).map(u=>`<img src="${esc(u)}" alt="">`).join('')}</div>` : ''}

        <div class="grid-2">
          <div class="card">
            <div class="section-title">Your Position</div>
            <div class="section-sub">${session?'':'Connect your wallet to see your holdings for this property.'}</div>
            ${session?`
              <div class="grid-2" style="gap:14px">
                <div class="stat-card"><div class="label">Units Held</div><div class="value">${myBalance.toString()}</div></div>
                <div class="stat-card"><div class="label">Claimable Rent</div><div class="value gold">${rupee(myPending)}</div></div>
              </div>
              ${myPending>0n?`<button class="btn gold block" style="margin-top:14px" onclick="handleClaim('${tokenAddr}')">Claim Rent</button>`:''}
              <div id="claimStatus" class="status"></div>
            `:`<button class="btn outline block" onclick="connectWallet(false)">Connect Wallet</button>`}
          </div>

          <div class="card">
            <div class="section-title">List Your Units</div>
            <div class="section-sub">${myBalance>0n?'Offer some of your units for resale. They are held in escrow until sold or cancelled.':'You need units in this property to list them.'}</div>
            ${session && myBalance>0n ? `
              <label>Units to list (you hold ${myBalance.toString()})</label>
              <input id="listAmt" type="number" min="1" max="${myBalance}" value="${myBalance>50n?50:1}" />
              <label>Price per unit (\u20B9)</label>
              <input id="listPrice" type="number" min="1" value="5000" />
              <button class="btn block" style="margin-top:14px" onclick="handleList('${tokenAddr}')">Approve &amp; List</button>
              <div id="listStatus" class="status"></div>
            ` : `<div class="note">${session?'No units to list.':'Connect your wallet first.'}</div>`}
          </div>
        </div>

        <div class="grid-2">
          <div class="card">
            <div class="section-title">Performance</div>
            <div class="section-sub">Rebased to 100, last 12 months &mdash; this property against the NIFTY 50 and BSE SENSEX.</div>
            ${perfChartHTML(tokenAddr)}
            <div class="sample-note">Illustrative data for demonstration only &mdash; not live market data or a forecast.</div>
          </div>
          <div class="card">
            <div class="section-title">Offer Documents</div>
            <div class="section-sub">Statutory and listing documents for this property.</div>
            ${docsHTML(docHash)}
            <div class="sample-note">Sample entries &mdash; documents are published with the live offer.</div>
          </div>
        </div>

        ${isOwner && sb ? `
        <div class="card">
          <div class="section-title">Property Photos</div>
          <div class="section-sub">Add or remove photos. Changes show on the listing straight away.</div>
          <div class="photo-grid">${imgs.map(u=>`<div class="photo-tile"><img src="${esc(u)}" alt=""><button title="Remove" onclick="handleRemovePhoto('${tokenAddr}','${esc(u)}')">&times;</button></div>`).join('') || '<div class="note">No photos yet.</div>'}</div>
          <input id="addImages" type="file" accept="image/*" multiple onchange="previewPicked(this,'addPreview')" />
          <div id="addPreview" class="photo-grid"></div>
          <button class="btn" style="margin-top:6px" onclick="handleAddPhotos('${tokenAddr}')">Upload Photos</button>
          <div id="photoStatus" class="status"></div>
        </div>` : ''}

        ${isOwner?`
        <div class="card">
          <div class="section-title">Distribute Rent</div>
          <div class="section-sub">As the property owner, record a rent distribution in rupees. It splits automatically, pro-rata, across every unit holder.</div>
          <div class="grid-2">
            <div><label>Amount to distribute (\u20B9)</label><input id="yieldAmt" type="number" min="1" value="100000" /></div>
            <div style="display:flex;align-items:flex-end"><button class="btn gold block" onclick="handleDeposit('${tokenAddr}')">Distribute Rent</button></div>
          </div>
          <div id="yieldStatus" class="status"></div>
        </div>`:''}

        <div class="card">
          <div class="section-title">Marketplace Listings</div>
          <div class="section-sub">Buying is instant: listed units are held in escrow, so a purchase transfers them straight to your wallet. Payment is settled in rupees, off-chain &mdash; no money moves on-chain.</div>
          <table>
            <thead><tr><th>Seller</th><th>Units</th><th>Price/Unit</th><th>Status</th><th>Action</th></tr></thead>
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

/* ---------------- documents (sample list) ---------------- */
const SAMPLE_DOCS = [
  ['Red Herring Prospectus',       'Issue details, pricing and risk factors'],
  ['Scheme offer document',        'Filed with SEBI and the stock exchange'],
  ['Trust deed',                   'Registered trust deed and trustee details'],
  ['Valuation report',             'Independent valuation by a registered valuer'],
  ['Title deed & khata extract',   'Property title \u2014 hash recorded on-chain'],
  ['Audited financials & rent roll','SPV accounts, occupancy and tenant schedule'],
];
function docsHTML(docHash){
  return `<div class="doc-list">${SAMPLE_DOCS.map(([t,d],i)=>`
    <a class="doc-row" href="#" onclick="event.preventDefault();sampleDoc('${esc(t)}')">
      <span class="doc-ic">PDF</span>
      <span class="doc-txt"><b>${esc(t)}</b><small>${esc(d)}${i===4?` &middot; <code>${esc(docHash.slice(0,12))}\u2026</code>`:''}</small></span>
      <span class="doc-tag">Sample</span>
    </a>`).join('')}</div>`;
}
function sampleDoc(title){
  alert(title + '\n\nThis is a sample entry for the prototype. The document will be published here with the live offer.');
}

/* ---------------- performance chart (illustrative data) ----------------
   Deterministic dummy series seeded by the token address, so each
   property draws the same lines every time.                            */
function seededRand(seed){
  let h = 2166136261;
  for(let i=0;i<seed.length;i++){ h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ()=>{ h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10000) / 10000; };
}
function makeSeries(rand, drift, vol, n){
  const out = [100];
  for(let i=1;i<n;i++) out.push(out[i-1] * (1 + drift + (rand()-0.5) * vol));
  return out;
}
function perfChartHTML(tokenAddr){
  const r = seededRand(tokenAddr.toLowerCase());
  const N = 13;
  const series = [
    { name:'This property', color:'#B8643C', w:3,   data:makeSeries(r, 0.0085, 0.012, N) },
    { name:'NIFTY 50',      color:'#1D2A3C', w:2,   data:makeSeries(r, 0.0070, 0.050, N) },
    { name:'BSE SENSEX',    color:'#7FA08C', w:2,   data:makeSeries(r, 0.0065, 0.048, N) },
  ];
  const W=600, H=230, L=40, R=12, T=12, B=28;
  const vals = series.flatMap(s=>s.data);
  let lo = Math.floor((Math.min(...vals)-2)/5)*5, hi = Math.ceil((Math.max(...vals)+2)/5)*5;
  if(hi - lo < 10) hi = lo + 10;
  const x = i => L + i*(W-L-R)/(N-1);
  const y = v => T + (hi - v)*(H-T-B)/(hi - lo);
  const months = [];
  const now = new Date();
  for(let i=N-1;i>=0;i--){ const d = new Date(now.getFullYear(), now.getMonth()-i, 1); months.push(d.toLocaleString('en-IN',{month:'short'})); }
  let g = '';
  const steps = 4;
  for(let k=0;k<=steps;k++){
    const v = lo + (hi-lo)*k/steps, yy = y(v).toFixed(1);
    g += `<line x1="${L}" y1="${yy}" x2="${W-R}" y2="${yy}" stroke="#E6DFD3" stroke-width="1"/>`;
    g += `<text x="${L-8}" y="${(+yy+4).toFixed(1)}" text-anchor="end" font-size="11" fill="#7A8291">${Math.round(v)}</text>`;
  }
  months.forEach((m,i)=>{ if(i%3===0 || i===N-1) g += `<text x="${x(i).toFixed(1)}" y="${H-8}" text-anchor="middle" font-size="11" fill="#7A8291">${m}</text>`; });
  const paths = series.slice().reverse().map(s=>{
    const d = s.data.map((v,i)=>(i?'L':'M')+x(i).toFixed(1)+' '+y(v).toFixed(1)).join(' ');
    const last = s.data[N-1];
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.w}" stroke-linejoin="round" stroke-linecap="round"/>`+
           `<circle cx="${x(N-1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="3.5" fill="${s.color}"/>`;
  }).join('');
  const legend = series.map(s=>{
    const chg = s.data[N-1] - 100;
    return `<span class="lg"><i style="background:${s.color}"></i>${s.name} <b>${chg>=0?'+':''}${chg.toFixed(1)}%</b></span>`;
  }).join('');
  return `<div class="perf"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Illustrative 12-month performance">${g}${paths}</svg>
    <div class="perf-legend">${legend}</div></div>`;
}

/* ---------------- photos (Supabase) ---------------- */
async function uploadImages(tokenAddr, files){
  if(!sb) throw new Error('Photo storage is not configured (set SUPABASE_URL and SUPABASE_ANON_KEY in app.js).');
  const urls = [];
  for(const f of files){
    if(!f.type.startsWith('image/')) continue;
    if(f.size > 5*1024*1024) throw new Error(f.name + ' is larger than 5 MB.');
    const ext  = (f.name.split('.').pop() || 'jpg').toLowerCase();
    const path = `${tokenAddr.toLowerCase()}/${Date.now()}-${Math.random().toString(36).slice(2,8)}.${ext}`;
    const { error } = await sb.storage.from(BUCKET).upload(path, f, { contentType:f.type, upsert:false });
    if(error) throw error;
    urls.push(sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl);
  }
  return urls;
}
async function getMedia(tokenAddr){
  if(!sb) return null;
  const { data, error } = await sb.from('property_media').select('*')
    .eq('token_address', tokenAddr.toLowerCase()).maybeSingle();
  if(error) throw error;
  return data;
}
async function getAllMedia(){
  if(!sb) return {};
  const { data } = await sb.from('property_media').select('token_address,image_urls');
  const map = {};
  (data || []).forEach(r => { map[r.token_address] = r.image_urls || []; });
  return map;
}
async function setImages(tokenAddr, urls){
  const { error } = await sb.from('property_media').upsert({
    token_address: tokenAddr.toLowerCase(), image_urls: urls,
    updated_by: session ? session.address.toLowerCase() : null,
    updated_at: new Date().toISOString()
  }, { onConflict:'token_address' });
  if(error) throw error;
}
function previewPicked(input, targetId){
  const el = document.getElementById(targetId); if(!el) return;
  el.innerHTML = [...input.files].filter(f=>f.type.startsWith('image/'))
    .map(f=>`<div class="photo-tile"><img src="${URL.createObjectURL(f)}" alt=""></div>`).join('');
}
async function handleAddPhotos(tokenAddr){
  const files = [...(document.getElementById('addImages').files || [])];
  if(!files.length){ setSt('photoStatus','Choose at least one photo first.','err'); return; }
  try{
    setSt('photoStatus','Uploading ' + files.length + ' photo(s)\u2026','info');
    const urls = await uploadImages(tokenAddr, files);
    const cur  = ((await getMedia(tokenAddr)) || {}).image_urls || [];
    await setImages(tokenAddr, cur.concat(urls));
    setSt('photoStatus','Photos added.','ok');
    setTimeout(()=>renderPropertyDetail(tokenAddr), 600);
  }catch(e){ console.error('[media]', e); setSt('photoStatus','Upload failed: ' + (e.message || e),'err'); }
}
async function handleRemovePhoto(tokenAddr, url){
  if(!confirm('Remove this photo?')) return;
  try{
    const cur = ((await getMedia(tokenAddr)) || {}).image_urls || [];
    await setImages(tokenAddr, cur.filter(u => u !== url));
    const marker = '/' + BUCKET + '/', i = url.indexOf(marker);
    if(i >= 0) await sb.storage.from(BUCKET).remove([decodeURIComponent(url.slice(i + marker.length))]);
    renderPropertyDetail(tokenAddr);
  }catch(e){ alert('Could not remove photo: ' + (e.message || e)); }
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
    setSt('listStatus','Listed '+amount+' units at '+rupee(price)+' each.','ok');
    setTimeout(()=>renderPropertyDetail(tokenAddr), 800);
  }catch(e){ console.error('[tx] list failed', e); setSt('listStatus', prettyErr(e), 'err'); }
}

async function handleCancel(id, tokenAddr){
  if(!requireLogin()) return;
  try{
    await sendTx('cancelStatus','Cancelling listing','Marketplace',null,'cancel',[id]);
    setSt('cancelStatus','Listing cancelled. Unsold units returned to your wallet.','ok');
    setTimeout(()=>renderPropertyDetail(tokenAddr), 800);
  }catch(e){ console.error('[tx] cancel failed', e); setSt('cancelStatus', prettyErr(e), 'err'); }
}

function openBuy(listingId, remainingStr, priceStr, tokenAddr){
  const remaining = BigInt(remainingStr), price = BigInt(priceStr);
  const defaultQty = remaining < 10n ? remaining : 10n;
  const wrap = document.getElementById('buyPanelWrap');
  wrap.innerHTML = `
    <div class="card" style="border:1.5px solid var(--gold)">
      <div class="section-title">Buy Units &mdash; Listing #${listingId}</div>
      <div class="section-sub">${remaining} units available at ${rupee(price)} each.</div>
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
    await sendTx('buyStatus','Buying units','Marketplace',null,'buy',[listingId, qty]);
    setSt('buyStatus','Done \u2014 '+qty+' units are now in your wallet.','ok');
    setTimeout(()=>renderPropertyDetail(tokenAddr), 1000);
  }catch(e){ console.error('[tx] buy failed', e); setSt('buyStatus', prettyErr(e), 'err'); }
}

async function handleDeposit(tokenAddr){
  if(!requireLogin()) return;
  try{
    const amt = BigInt(document.getElementById('yieldAmt').value || '0');
    if(amt<=0n) throw new Error('Invalid amount');
    await sendTx('yieldStatus','Distributing rent','PropertyToken',tokenAddr,'depositYield',[amt]);
    setSt('yieldStatus','Distributed '+rupee(amt)+' pro-rata across all unit holders.','ok');
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

async function handleClaimDash(tokenAddr){
  if(!requireLogin()) return;
  try{
    await sendTx('dashClaimStatus','Claiming rent','PropertyToken',tokenAddr,'claimYield',[]);
    setSt('dashClaimStatus','Claimed. (Rupee payout happens off-chain; this records the entitlement as settled.)','ok');
    setTimeout(renderDashboard, 900);
  }catch(e){ console.error('[tx] claim failed', e); setSt('dashClaimStatus', prettyErr(e), 'err'); }
}

/* ================= OWNERSHIP HISTORY CSV =================
   One Alchemy request (alchemy_getAssetTransfers) returns every transfer
   for this token — no block-by-block scanning. If the RPC does not
   support it, falls back to a short eth_getLogs scan of recent blocks. */
async function rpc(method, params){
  const res = await fetch(CONFIG.rpc, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ jsonrpc:'2.0', id:1, method, params })
  });
  const json = await res.json();
  if(json.error) throw new Error(json.error.message || 'RPC error');
  return json.result;
}
async function fetchTransfers(tokenAddr, prog){
  const out = [];
  let pageKey, page = 0;
  do{
    const req = {
      fromBlock:'0x0', toBlock:'latest', contractAddresses:[tokenAddr],
      category:['erc20'], excludeZeroValue:false, withMetadata:true,
      order:'asc', maxCount:'0x3e8'
    };
    if(pageKey) req.pageKey = pageKey;
    const r = await rpc('alchemy_getAssetTransfers', [req]);
    out.push(...(r.transfers || []));
    pageKey = r.pageKey;
    if(pageKey) prog('Reading chain\u2026 page ' + (++page + 1));
  } while(pageKey && out.length < 20000);
  return out.map(t => ({
    from: t.from, to: t.to,
    value: BigInt(t.rawContract && t.rawContract.value ? t.rawContract.value : '0x0'),
    block: parseInt(t.blockNum, 16),
    hash: t.hash,
    time: t.metadata && t.metadata.blockTimestamp ? t.metadata.blockTimestamp : ''
  }));
}
async function fetchTransfersByLogs(tokenAddr, prog){
  const pv = new ethers.JsonRpcProvider(CONFIG.rpc, 11155111,
    { staticNetwork:true, batchMaxCount:1, batchStallTime:0 });
  const topic = ethers.id('Transfer(address,address,uint256)');
  const latest = await pv.getBlockNumber();
  const SPAN = 10, LOOKBACK = 50000;
  const start = Math.max(0, latest - LOOKBACK);
  const ranges = [];
  for(let b=start; b<=latest; b+=SPAN) ranges.push([b, Math.min(b+SPAN-1, latest)]);
  const iface = new ethers.Interface(ABIS.PropertyToken);
  const rows = [];
  for(let i=0;i<ranges.length;i+=4){
    prog('Reading chain\u2026 ' + Math.min(99, Math.round(i*100/ranges.length)) + '%');
    const batch = ranges.slice(i, i+4).map(([f,t])=>
      pv.getLogs({ address:tokenAddr, topics:[topic], fromBlock:f, toBlock:t }).catch(()=>[]));
    for(const logs of await Promise.all(batch))
      for(const lg of logs){
        const p = iface.parseLog(lg);
        rows.push({ from:p.args[0], to:p.args[1], value:p.args[2], block:lg.blockNumber, hash:lg.transactionHash, time:'' });
      }
    await sleep(50);
  }
  return rows.sort((a,b)=>a.block-b.block);
}
async function downloadHistory(tokenAddr, name, symbol){
  const btn = document.getElementById('dlBtn');
  const label = btn ? btn.innerHTML : '';
  const prog = t => { if(btn) btn.textContent = t; };
  try{
    if(btn) btn.disabled = true;
    prog('Reading chain\u2026');
    let rows;
    try{ rows = await fetchTransfers(tokenAddr, prog); }
    catch(e){
      console.warn('[history] asset-transfers unavailable, falling back to log scan', e);
      rows = await fetchTransfersByLogs(tokenAddr, prog);
    }
    prog('Building CSV\u2026');

    const ZERO = ethers.ZeroAddress.toLowerCase();
    const csvCell = s => { s = String(s); return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; };
    const tag = a => a && a.toLowerCase()===CONFIG.marketplace.toLowerCase() ? a+' (Marketplace escrow)' : a;
    const body = rows.map((t,i)=>{
      const isMint = t.from && t.from.toLowerCase() === ZERO;
      return [ i+1, isMint ? 'Mint (initial issue)' : 'Transfer',
        isMint ? '(newly minted)' : tag(t.from), tag(t.to),
        t.value.toString(), t.block, t.time, t.hash ];
    });
    const meta = [
      ['Property', name], ['Token Symbol', symbol], ['Token Contract', tokenAddr],
      ['Network', CONFIG.network || 'sepolia'], ['Exported', new Date().toLocaleString()],
      ['Total Records', body.length], [],
    ];
    const header = ['#','Type','From','To','Units','Block','Timestamp (UTC)','Transaction Hash'];
    const csv = [...meta, header, ...body].map(r => r.map(csvCell).join(',')).join('\n');

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
        <p>Tokenise a rent-yielding property into units. You (as the registrant) receive 100% of the units to start.</p>
      </div>
      <div class="card">
        <label>Property name</label><input id="pName" value="Puravankara, Tower A" />
        <label>Symbol</label><input id="pSymbol" value="PRVK-A" />
        <label>Total units</label><input id="pShares" type="number" min="1" value="1000" />
        <div class="field-note">Whole-number units. Holding 50 of 1000 = 5% of the property\u2019s income.</div>
        <label>Document reference</label><input id="pDoc" value="Title deed and khata extract" />
        <div class="field-note">Hashed on-chain (keccak256) so the record is tamper-evident.</div>
        <label>Photos (optional)</label>
        <input id="pImages" type="file" accept="image/*" multiple onchange="previewPicked(this,'pPreview')" />
        <div class="field-note">JPG or PNG, up to 5 MB each. You can add or remove photos later.</div>
        <div id="pPreview" class="photo-grid"></div>
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
    const units = BigInt(document.getElementById('pShares').value || '0');
    if(!name || !symbol || units<=0n) throw new Error('Fill in a name, symbol and a unit count above 0.');
    const docHash = ethers.keccak256(ethers.toUtf8Bytes(document.getElementById('pDoc').value));

    const rc = await sendTx('regStatus','Registering property','PropertyTokenFactory',null,'registerLand',
      [name, symbol, units, docHash, 'demo']);

    const iface = new ethers.Interface(ABIS.PropertyTokenFactory);
    let tokenAddr = null;
    for(const log of rc.logs){
      try{ const p = iface.parseLog(log); if(p && p.name==='LandRegistered') tokenAddr = p.args.tokenAddress; }catch{}
    }

    const files = [...((document.getElementById('pImages') || {}).files || [])];
    if(tokenAddr && files.length && sb){
      try{
        setSt('regStatus','Registered on-chain. Uploading photos\u2026','info');
        await setImages(tokenAddr, await uploadImages(tokenAddr, files));
      }catch(e){
        console.error('[media] upload failed', e);
        setSt('regStatus','Registered on-chain, but the photos failed to upload. You can add them from the property page.','err');
        setTimeout(()=>{ location.hash = '#/properties/' + tokenAddr; }, 2500);
        return;
      }
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
        <td>${h.bal}</td><td>${pct}%</td><td class="rupee">${rupee(h.pending)}</td>
        <td>${h.pending>0n
          ? `<button class="btn small gold" onclick="handleClaimDash('${h.t}')">Claim Rent</button>`
          : '<span style="color:var(--muted);font-size:12.5px">Nothing to claim</span>'}</td></tr>`;
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
          <div class="section-sub">Properties you hold units in. Claim rent for each property here.</div>
          <table>
            <thead><tr><th>Property</th><th>Units</th><th>Share of Property</th><th>Claimable Rent</th><th>Action</th></tr></thead>
            <tbody>${holdingRows || '<tr><td colspan=5 class="empty">No holdings yet. <a href="#/properties" style="color:var(--blue);font-weight:600">Browse properties</a> or <a href="#/list-property" style="color:var(--blue);font-weight:600">register one</a>.</td></tr>'}</tbody>
          </table>
          <div id="dashClaimStatus" class="status"></div>
        </div>
        <div class="card">
          <div class="section-title">Your Active Listings</div>
          <div class="section-sub">Units you currently have for sale (held in escrow).</div>
          <table>
            <thead><tr><th>Property</th><th>Units Left</th><th>Price/Unit</th><th></th></tr></thead>
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
  if(m.includes('could not coalesce')) return 'The network provider rejected a batch of requests. Wait a few seconds and try again.';
  if(/insufficient funds/i.test(m)) return 'Not enough Sepolia test ETH for gas. Top up from a Sepolia faucet (free) and try again.';
  if((e && (e.code === 4001 || e.code === 'ACTION_REJECTED')) || /user (rejected|denied)/i.test(m)) return 'You rejected the request in MetaMask.';
  if(e && e.code === -32002) return 'A MetaMask request is already open. Click the MetaMask icon to finish it.';
  if(m.includes('is not a function') || m.includes('no matching fragment')) return 'The ABI is out of date. Re-copy frontend-config/abis.json into frontend/ and hard-refresh.';
  if(/could not detect network|failed to detect|network error|Failed to fetch/i.test(m)) return 'Cannot reach Sepolia. Check your connection and the rpc URL in addresses.json.';
  return m.length>180 ? m.slice(0,180)+'\u2026' : m;
}

boot();
