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

/* ================= SHARED UI PIECES ================= */
const PROPERTY_TYPES = ['Commercial office','Retail','Warehousing','Residential','Mixed use'];

/* Illustrated placeholder shown until a property has photos.
   A simple facade drawing, tinted per property so cards differ. */
function placeholderImg(seed){
  const r = seededRand(String(seed||'parcel').toLowerCase());
  const skies = [['#CFE0E8','#EEF4F6'],['#D9E4DC','#F1F5F2'],['#E6DED2','#F6F2EC'],['#D6DCE8','#F0F2F7']];
  const bodies = ['#1E4A3D','#2B3A4A','#5B4636','#3E5A50'];
  const sky = skies[Math.floor(r()*skies.length)], body = bodies[Math.floor(r()*bodies.length)];
  const floors = 5 + Math.floor(r()*4), cols = 4 + Math.floor(r()*3);
  const bw = 300, bx = (800-bw)/2, fh = 34, bh = floors*fh + 30, by = 450 - bh;
  let win = '';
  for(let f=0; f<floors; f++) for(let c=0; c<cols; c++){
    const lit = r() > 0.55;
    const ww = (bw-40)/cols - 10;
    win += `<rect x="${(bx+20+c*((bw-40)/cols)+5).toFixed(1)}" y="${by+20+f*fh}" width="${ww.toFixed(1)}" height="${fh-14}" rx="2" fill="${lit?'#F3D9A6':'#ffffff'}" opacity="${lit?0.95:0.18}"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500" preserveAspectRatio="xMidYMid slice">
    <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky[0]}"/><stop offset="1" stop-color="${sky[1]}"/></linearGradient></defs>
    <rect width="800" height="500" fill="url(#s)"/>
    <rect x="${bx-150}" y="${by+70}" width="120" height="${bh-70}" fill="${body}" opacity="0.25"/>
    <rect x="${bx+bw+40}" y="${by+40}" width="140" height="${bh-40}" fill="${body}" opacity="0.18"/>
    <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="4" fill="${body}"/>
    ${win}
    <rect x="${bx+bw/2-28}" y="${450-42}" width="56" height="42" fill="#F3D9A6" opacity="0.9"/>
    <rect x="0" y="450" width="800" height="50" fill="#C9CFC8"/>
  </svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
function bgStyle(url){ return `background-image:url(&quot;${url}&quot;)`; }

/* Read every marketplace listing once; group active offers by token. */
async function loadOffers(){
  const market = readContract('Marketplace');
  const n = Number(await market.nextListingId());
  const all = await Promise.all(Array.from({length:n}, (_,i)=>market.listings(i)));
  return all.map((l,i)=>({ id:i, seller:l[0], token:l[1], remaining:l[2], price:l[3], active:l[4] }));
}

/* ================= HOME ================= */
function renderHome(){
  document.getElementById('app').innerHTML = `
    <section class="hero">
      <div class="container hero-grid">
        <div class="hero-copy">
          <h1>Real estate for every Indian.</h1>
          <p>Buy units in rent-yielding buildings, earn your share of the rent every quarter, and sell whenever you want.
             Every unit you hold is recorded on a public ledger; you pay and get paid in rupees.</p>
          <div class="hero-actions">
            <a class="btn primary" href="#/properties">Browse properties</a>
            ${session?'':'<button class="btn ghost" onclick="connectWallet(false)">Connect wallet</button>'}
          </div>
        </div>
        <ol class="hero-steps">
          <li><b>Pick a building</b><span>See photos, documents and how it has performed.</span></li>
          <li><b>Buy units</b><span>Start small. Confirm once and the units are yours.</span></li>
          <li><b>Earn the rent</b><span>Income is split by units held. Claim it from your dashboard.</span></li>
        </ol>
      </div>
    </section>
    <section class="container section">
      <div class="section-head">
        <h2>Featured properties</h2>
        <a class="link" href="#/properties">See all properties</a>
      </div>
      <div id="homeProps" class="pgrid"><div class="loading">Loading properties\u2026</div></div>
    </section>`;
  loadPropertyCards('homeProps', 3);
}

/* ================= PROPERTIES (browse) ================= */
let BROWSE = [];
function renderProperties(){
  document.getElementById('app').innerHTML = `
    <div class="page container">
      <div class="browse-head">
        <div>
          <h1>Properties</h1>
          <p class="lede">Rent-yielding buildings you can own a part of. Prices are per unit, paid in rupees.</p>
        </div>
        <div class="browse-tools">
          <input id="q" class="search" type="search" placeholder="Search by name or location" oninput="drawBrowse()" />
          <select id="sort" onchange="drawBrowse()" aria-label="Sort properties">
            <option value="new">Newest first</option>
            <option value="price">Lowest price per unit</option>
            <option value="avail">Most units for sale</option>
          </select>
        </div>
      </div>
      <div id="allProps" class="pgrid"><div class="loading">Loading properties\u2026</div></div>
    </div>`;
  loadPropertyCards('allProps', null);
}

async function loadPropertyCards(targetId, limit){
  const el = document.getElementById(targetId);
  try{
    let all = await withTimeout(readContract('PropertyTokenFactory').getAllTokens(), 15000,
      'Timed out reaching Sepolia. Check the rpc URL in addresses.json.');
    all = [...all].reverse();
    if(!el) return;
    if(all.length===0){
      el.innerHTML = '<div class="empty">No properties yet. <a class="link" href="#/list-property">List the first one</a>.</div>';
      return;
    }
    const [media, offers] = await Promise.all([ getAllMedia().catch(()=>({})), loadOffers().catch(()=>[]) ]);
    const items = await Promise.all(all.map(async (t, order)=>{
      const tk = new ethers.Contract(t, ABIS.PropertyToken, provider);
      let name='Property', supply=0n, symbol='';
      try{ [name, supply, symbol] = await Promise.all([tk.name(), tk.totalSupply(), tk.symbol()]); }catch{}
      const m = media[t.toLowerCase()] || {};
      const open = offers.filter(o=>o.active && o.token.toLowerCase()===t.toLowerCase());
      const minPrice = open.length ? open.reduce((a,o)=>o.price<a?o.price:a, open[0].price) : null;
      const avail = open.reduce((a,o)=>a+o.remaining, 0n);
      return { t, order, name, supply, symbol, img:(m.image_urls||[])[0], location:m.location||'', type:m.property_type||'', minPrice, avail };
    }));
    if(targetId==='allProps'){ BROWSE = items; drawBrowse(); }
    else el.innerHTML = items.slice(0, limit||items.length).map(cardHTML).join('');
  }catch(e){
    if(el) el.innerHTML = '<div class="empty err-text">Could not load properties: '+esc(e.shortMessage||e.message||e)+'</div>';
  }
}
function drawBrowse(){
  const el = document.getElementById('allProps'); if(!el) return;
  const q = ((document.getElementById('q')||{}).value||'').trim().toLowerCase();
  const sort = (document.getElementById('sort')||{}).value || 'new';
  let list = BROWSE.filter(p => !q || (p.name+' '+p.location+' '+p.type+' '+p.symbol).toLowerCase().includes(q));
  if(sort==='price') list.sort((a,b)=> (a.minPrice===null) - (b.minPrice===null) || (a.minPrice!==null && b.minPrice!==null ? (a.minPrice<b.minPrice?-1:a.minPrice>b.minPrice?1:0) : 0));
  else if(sort==='avail') list.sort((a,b)=> b.avail>a.avail?1:b.avail<a.avail?-1:0);
  else list.sort((a,b)=>a.order-b.order);
  el.innerHTML = list.length ? list.map(cardHTML).join('')
    : `<div class="empty">No properties match \u201C${esc(q)}\u201D.</div>`;
}
function cardHTML(p){
  const img = p.img || placeholderImg(p.t);
  return `<a class="pcard" href="#/properties/${p.t}">
    <div class="pcard-img" style="${bgStyle(img)}">
      <span class="pcard-badge ${p.avail>0n?'':'muted'}">${p.avail>0n ? p.avail+' units for sale' : 'No units for sale'}</span>
    </div>
    <div class="pcard-body">
      <h3>${esc(p.name)}</h3>
      <p class="pcard-loc">${esc([p.location, p.type].filter(Boolean).join(', ') || p.symbol)}</p>
      <div class="pcard-foot">
        <span class="pcard-price">${p.minPrice!==null ? rupee(p.minPrice)+'<small> / unit</small>' : '<small>Price on next offer</small>'}</span>
        <span class="pcard-units">${p.supply} units</span>
      </div>
    </div>
  </a>`;
}

/* ================= PROPERTY DETAIL (listing page) ================= */
let LP = null;   // state for the open listing: { tokenAddr, offers, sel, myBalance, ... }

async function renderPropertyDetail(tokenAddr){
  const app = document.getElementById('app');
  app.innerHTML = '<div class="page container"><div class="loading">Loading property\u2026</div></div>';
  try{
    const tk = new ethers.Contract(tokenAddr, ABIS.PropertyToken, provider);
    const [name, symbol, supply, docHash, registrant] = await withTimeout(Promise.all([
      tk.name(), tk.symbol(), tk.totalSupply(), tk.docHash(), tk.registrant()
    ]), 15000, 'Timed out reaching Sepolia.');
    let rentPaid = 0n; try{ rentPaid = await tk.totalYieldDeposited(); }catch{}

    const me = session ? session.address : null;
    const [myBalance, myPending] = me ? await Promise.all([tk.balanceOf(me), tk.pendingYield(me)]) : [0n, 0n];
    const isOwner = !!(me && me.toLowerCase()===registrant.toLowerCase());
    const media = (await getMedia(tokenAddr).catch(()=>null)) || {};
    const imgs = media.image_urls || [];

    const offers = (await loadOffers()).filter(o=>o.token.toLowerCase()===tokenAddr.toLowerCase());
    const open = offers.filter(o=>o.active).sort((a,b)=> a.price<b.price?-1:a.price>b.price?1:0);
    const buyable = open.filter(o=>!me || o.seller.toLowerCase()!==me.toLowerCase());
    const past = offers.filter(o=>!o.active);
    const avail = open.reduce((a,o)=>a+o.remaining, 0n);
    const minPrice = open.length ? open[0].price : null;

    LP = { tokenAddr, name, symbol, buyable, sel: buyable.length ? 0 : -1, myBalance, myPending, supply, isOwner, media };

    const share = supply>0n ? (Number(myBalance)*100/Number(supply)) : 0;
    const safeName = String(name).replace(/['"\\]/g,'');
    const sub = [media.location, media.property_type].filter(Boolean).map(esc).join('<span class="dot-sep" aria-hidden="true"></span>');

    app.innerHTML = `
      <div class="page container listing">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="#/properties">Properties</a><span aria-hidden="true">/</span><span>${esc(name)}</span></nav>
        <header class="listing-head">
          <div>
            <h1>${esc(name)}</h1>
            <p class="listing-sub">${sub || '<span class="muted">Location not added yet</span>'}</p>
          </div>
          <div class="head-tags">
            <span class="tag">${esc(symbol)}</span>
            ${isOwner?'<span class="tag tag-own">You listed this</span>':''}
          </div>
        </header>

        ${carouselHTML(imgs.length ? imgs : [placeholderImg(tokenAddr)], name, !imgs.length)}

        <div class="listing-body">
          <div class="listing-main">
            <section class="facts" aria-label="Key facts">
              <div><span>Price from</span><b>${minPrice!==null ? rupee(minPrice) : '\u2014'}</b><small>${minPrice!==null?'per unit':'no open offers'}</small></div>
              <div><span>For sale now</span><b>${avail}</b><small>units</small></div>
              <div><span>Total units</span><b>${supply}</b><small>1 unit = ${(100/Number(supply||1n)).toFixed(2)}%</small></div>
              <div><span>Rent paid out</span><b>${rupee(rentPaid)}</b><small>to date</small></div>
            </section>

            <section class="sec">
              <h2>About this property</h2>
              <p class="desc">${media.description ? esc(media.description).replace(/\n/g,'<br>') :
                (isOwner ? 'Add a description so investors know what they are buying into \u2014 the building, its tenants and the rent it earns.' :
                 'The owner has not added a description yet.')}</p>
              <dl class="spec">
                <div><dt>Listed by</dt><dd>${esc(nameFor(registrant))}${isOwner?' (you)':''}</dd></div>
                <div><dt>Token</dt><dd>${esc(symbol)} <a class="link" href="https://sepolia.etherscan.io/token/${tokenAddr}" target="_blank" rel="noopener">${short(tokenAddr)}</a></dd></div>
                <div><dt>Title document hash</dt><dd><code>${esc(docHash.slice(0,18))}\u2026</code></dd></div>
                <div><dt>Network</dt><dd>Ethereum Sepolia (test)</dd></div>
              </dl>
            </section>

            <section class="sec" id="offers">
              <h2>Units for sale</h2>
              ${open.length ? `<ul class="offers">${open.map(o=>offerRowHTML(o, me)).join('')}</ul>`
                : `<p class="muted">No one is selling units right now. ${myBalance>0n?'You can list yours from the panel on the right.':'Check back soon.'}</p>`}
              ${past.length ? `<details class="past"><summary>${past.length} earlier offer${past.length>1?'s':''}</summary>
                <ul class="offers past-list">${past.map(o=>`<li class="offer"><span class="who"><i>${esc(initials(nameFor(o.seller)))}</i>${esc(nameFor(o.seller))}</span><span class="what">${rupee(o.price)} per unit</span><span class="state">Closed</span></li>`).join('')}</ul></details>` : ''}
              <div id="cancelStatus" class="status"></div>
            </section>

            <section class="sec">
              <h2>Performance</h2>
              <p class="muted small">Last 12 months, rebased to 100, against the NIFTY 50 and BSE SENSEX.</p>
              ${perfChartHTML(tokenAddr)}
              <p class="sample-note">Illustrative data for the demo. Not live market data or a forecast.</p>
            </section>

            <section class="sec">
              <h2>Documents</h2>
              ${docsHTML(docHash)}
              <p class="sample-note">Sample entries. Documents are published with the live offer.</p>
            </section>

            <section class="sec">
              <h2>Ownership history</h2>
              <p class="muted">Every transfer of these units is on a public ledger. Download the full record for your own checks.</p>
              <button id="dlBtn" class="btn ghost" onclick="downloadHistory('${tokenAddr}', '${esc(safeName)}', '${esc(symbol)}')">Download history (CSV)</button>
            </section>

            ${isOwner ? ownerToolsHTML(tokenAddr, media, imgs) : ''}
          </div>

          <aside class="listing-side">
            <div class="invest-card" id="investCard"></div>
            ${session ? `
            <div class="hold-card">
              <h3>Your holding</h3>
              <div class="hold-row"><span>Units</span><b>${myBalance}</b></div>
              <div class="hold-row"><span>Share of property</span><b>${share ? share.toFixed(2)+'%' : '0%'}</b></div>
              <div class="hold-row"><span>Rent ready to claim</span><b class="${myPending>0n?'pos':''}">${rupee(myPending)}</b></div>
              ${myPending>0n?`<button class="btn primary block" onclick="handleClaim('${tokenAddr}')">Claim ${rupee(myPending)}</button>`:''}
              <div id="claimStatus" class="status"></div>
              ${myBalance>0n ? `
              <details class="sell" ${myBalance>0n && !buyable.length ? 'open':''}>
                <summary>Sell units</summary>
                <label for="listAmt">Units to sell (you hold ${myBalance})</label>
                <input id="listAmt" type="number" min="1" max="${myBalance}" value="${myBalance>10n?10:1}" />
                <label for="listPrice">Price per unit (\u20B9)</label>
                <input id="listPrice" type="number" min="1" value="${minPrice!==null?minPrice:5000}" />
                <button class="btn dark block" onclick="handleList('${tokenAddr}')">List units for sale</button>
                <p class="fine">Listed units are held in escrow until they sell or you cancel.</p>
                <div id="listStatus" class="status"></div>
              </details>` : ''}
            </div>` : ''}
          </aside>
        </div>
      </div>`;
    drawInvestCard();
    initCarousel();
  }catch(e){
    app.innerHTML = '<div class="page container"><div class="status show err">Could not load this property: '+esc(e.shortMessage||e.message||e)+'</div></div>';
  }
}

function offerRowHTML(o, me){
  const mine = me && o.seller.toLowerCase()===me.toLowerCase();
  const idx = LP.buyable.findIndex(b=>b.id===o.id);
  let action;
  if(mine) action = `<button class="btn small ghost" onclick="handleCancel(${o.id}, '${LP.tokenAddr}')">Cancel</button>`;
  else if(!me) action = `<button class="btn small ghost" onclick="connectWallet(false)">Connect to buy</button>`;
  else action = `<button class="btn small primary" onclick="selectOffer(${idx})">Buy</button>`;
  return `<li class="offer">
    <span class="who"><i>${esc(initials(nameFor(o.seller)))}</i>${esc(nameFor(o.seller))}${mine?' <em>you</em>':''}</span>
    <span class="what"><b>${o.remaining} units</b> at ${rupee(o.price)} each</span>
    ${action}
  </li>`;
}

/* ---- sticky invest panel ---- */
function drawInvestCard(){
  const el = document.getElementById('investCard'); if(!el || !LP) return;
  const o = LP.sel >= 0 ? LP.buyable[LP.sel] : null;
  if(!o){
    el.innerHTML = `
      <p class="ic-label">Buy units</p>
      <p class="ic-empty">No units are for sale right now.</p>
      <p class="fine">${LP.myBalance>0n ? 'You hold units in this property. You can list some for sale below.' : 'New offers appear here as soon as a holder lists units.'}</p>`;
    return;
  }
  const max = o.remaining, qty = max < 10n ? max : 10n;
  el.innerHTML = `
    <p class="ic-label">Lowest price${LP.buyable.length>1 && LP.sel>0 ? ' \u2014 you picked another offer' : ''}</p>
    <p class="ic-price">${rupee(o.price)} <small>per unit</small></p>
    <p class="ic-meta">${o.remaining} units from ${esc(nameFor(o.seller))}</p>
    <label for="buyQty">How many units?</label>
    <div class="stepper">
      <button type="button" aria-label="One fewer" onclick="stepQty(-1)">\u2212</button>
      <input id="buyQty" type="number" min="1" max="${max}" value="${qty}" oninput="updateBuyTotal()" />
      <button type="button" aria-label="One more" onclick="stepQty(1)">+</button>
    </div>
    <div class="ic-total"><span>You pay</span><b id="buyTotal">${rupee(qty*o.price)}</b></div>
    <div class="ic-total"><span>Share of property</span><b id="buyShare">${(Number(qty)*100/Number(LP.supply||1n)).toFixed(2)}%</b></div>
    ${session
      ? `<button class="btn primary block lg" id="buyBtn" onclick="confirmBuy()">Buy ${qty} units</button>`
      : `<button class="btn primary block lg" onclick="connectWallet(false)">Connect wallet to buy</button>`}
    <p class="fine">You pay the seller in rupees. Your wallet only signs the record of the transfer.</p>
    <div id="buyStatus" class="status"></div>`;
}
function selectOffer(i){
  if(!LP || i<0) return;
  LP.sel = i; drawInvestCard();
  document.getElementById('investCard').scrollIntoView({behavior:'smooth', block:'center'});
}
function stepQty(d){
  const inp = document.getElementById('buyQty'); if(!inp) return;
  const max = Number(inp.max||1), v = Math.min(max, Math.max(1, (parseInt(inp.value,10)||1) + d));
  inp.value = v; updateBuyTotal();
}
function updateBuyTotal(){
  const o = LP && LP.buyable[LP.sel]; if(!o) return;
  const inp = document.getElementById('buyQty');
  let q = BigInt(Math.max(0, parseInt(inp.value,10) || 0));
  if(q > o.remaining) q = o.remaining;
  document.getElementById('buyTotal').textContent = rupee(q*o.price);
  document.getElementById('buyShare').textContent = (Number(q)*100/Number(LP.supply||1n)).toFixed(2) + '%';
  const b = document.getElementById('buyBtn'); if(b) b.textContent = 'Buy ' + q + ' unit' + (q===1n?'':'s');
}

/* ---- carousel ---- */
function carouselHTML(imgs, name, isPlaceholder){
  return `<div class="carousel" id="carousel" tabindex="0" aria-roledescription="carousel" aria-label="Photos of ${esc(name)}">
    <div class="car-track" id="carTrack">
      ${imgs.map((u,i)=>`<div class="car-slide" role="group" aria-label="Photo ${i+1} of ${imgs.length}"><img src="${esc(u)}" alt="${esc(name)}, photo ${i+1}" ${i?'loading="lazy"':''}></div>`).join('')}
    </div>
    ${imgs.length>1 ? `
      <button class="car-btn prev" aria-label="Previous photo" onclick="carGo(-1)">\u2039</button>
      <button class="car-btn next" aria-label="Next photo" onclick="carGo(1)">\u203A</button>
      <span class="car-count" id="carCount">1 / ${imgs.length}</span>` : ''}
    ${isPlaceholder ? '<span class="car-note">Illustration \u2014 photos not added yet</span>' : ''}
  </div>
  ${imgs.length>1 ? `<div class="car-thumbs" id="carThumbs">${imgs.map((u,i)=>`<button class="${i?'':'on'}" aria-label="Show photo ${i+1}" onclick="carTo(${i})"><img src="${esc(u)}" alt=""></button>`).join('')}</div>` : ''}`;
}
let CAR = { i:0, n:1 };
function initCarousel(){
  const track = document.getElementById('carTrack'); if(!track) return;
  CAR = { i:0, n: track.children.length };
  const box = document.getElementById('carousel');
  box.addEventListener('keydown', e=>{ if(e.key==='ArrowLeft') carGo(-1); if(e.key==='ArrowRight') carGo(1); });
  let x0 = null;
  box.addEventListener('pointerdown', e=>{ x0 = e.clientX; });
  box.addEventListener('pointerup', e=>{ if(x0===null) return; const dx = e.clientX - x0; x0 = null; if(Math.abs(dx) > 40) carGo(dx<0?1:-1); });
}
function carTo(i){
  if(CAR.n < 2) return;
  CAR.i = (i + CAR.n) % CAR.n;
  document.getElementById('carTrack').style.transform = `translateX(-${CAR.i*100}%)`;
  const c = document.getElementById('carCount'); if(c) c.textContent = (CAR.i+1) + ' / ' + CAR.n;
  document.querySelectorAll('#carThumbs button').forEach((b,k)=>b.classList.toggle('on', k===CAR.i));
}
function carGo(d){ carTo(CAR.i + d); }

/* ---- owner tools ---- */
function ownerToolsHTML(tokenAddr, media, imgs){
  return `
  <section class="sec owner">
    <h2>Manage this listing</h2>
    <p class="muted">Only you see this section.</p>
    ${sb ? `
    <details class="tool" open>
      <summary>Details shown to investors</summary>
      <div class="two">
        <div><label for="edLoc">Location</label><input id="edLoc" value="${esc(media.location||'')}" placeholder="e.g. Whitefield, Bengaluru" /></div>
        <div><label for="edType">Property type</label><select id="edType">${PROPERTY_TYPES.map(t=>`<option ${t===(media.property_type||'')?'selected':''}>${t}</option>`).join('')}</select></div>
      </div>
      <label for="edDesc">Description</label>
      <textarea id="edDesc" rows="5" placeholder="The building, its tenants, the lease terms and the rent it earns.">${esc(media.description||'')}</textarea>
      <button class="btn dark" onclick="handleSaveDetails('${tokenAddr}')">Save details</button>
      <div id="detStatus" class="status"></div>
    </details>
    <details class="tool">
      <summary>Photos (${imgs.length})</summary>
      <div class="photo-grid">${imgs.map(u=>`<div class="photo-tile"><img src="${esc(u)}" alt=""><button title="Remove photo" aria-label="Remove photo" onclick="handleRemovePhoto('${tokenAddr}','${esc(u)}')">&times;</button></div>`).join('') || '<p class="muted">No photos yet. The first photo you add becomes the cover.</p>'}</div>
      <input id="addImages" type="file" accept="image/*" multiple onchange="previewPicked(this,'addPreview')" />
      <div id="addPreview" class="photo-grid"></div>
      <button class="btn dark" onclick="handleAddPhotos('${tokenAddr}')">Upload photos</button>
      <div id="photoStatus" class="status"></div>
    </details>` : `<p class="note">Connect Supabase in app.js to add photos and a description.</p>`}
    <details class="tool">
      <summary>Distribute rent</summary>
      <p class="muted">Record a rent payment in rupees. It is split across every unit holder by units held.</p>
      <label for="yieldAmt">Amount to distribute (\u20B9)</label>
      <input id="yieldAmt" type="number" min="1" value="100000" />
      <button class="btn dark" onclick="handleDeposit('${tokenAddr}')">Distribute rent</button>
      <div id="yieldStatus" class="status"></div>
    </details>
  </section>`;
}

/* ---------------- documents (sample list) ---------------- */
const SAMPLE_DOCS = [
  ['Red Herring Prospectus',        'Issue details, pricing and risk factors'],
  ['Scheme offer document',         'Filed with SEBI and the stock exchange'],
  ['Trust deed',                    'Registered trust deed and trustee details'],
  ['Valuation report',              'Independent valuation by a registered valuer'],
  ['Title deed and khata extract',  'Property title, with its hash recorded on-chain'],
  ['Audited financials and rent roll','SPV accounts, occupancy and tenant schedule'],
];
function docsHTML(){
  return `<ul class="docs">${SAMPLE_DOCS.map(([t,d])=>`
    <li><a href="#" onclick="event.preventDefault();sampleDoc('${esc(t)}')">
      <span class="doc-ic" aria-hidden="true">PDF</span>
      <span class="doc-txt"><b>${esc(t)}</b><small>${esc(d)}</small></span>
      <span class="doc-tag">Sample</span>
    </a></li>`).join('')}</ul>`;
}
function sampleDoc(title){
  alert(title + '\n\nThis is a sample entry for the prototype. The document will be published here with the live offer.');
}

/* ---------------- performance chart (illustrative data) ---------------- */
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
  const r = seededRand(tokenAddr.toLowerCase() + ':perf');
  const N = 13;
  const series = [
    { name:'This property', color:'#1E4A3D', w:3, data:makeSeries(r, 0.0085, 0.012, N) },
    { name:'NIFTY 50',      color:'#B5562F', w:2, data:makeSeries(r, 0.0070, 0.050, N) },
    { name:'BSE SENSEX',    color:'#8C9A94', w:2, data:makeSeries(r, 0.0065, 0.048, N) },
  ];
  const W=640, H=240, L=40, R=14, T=12, B=28;
  const vals = series.flatMap(s=>s.data);
  let lo = Math.floor((Math.min(...vals)-2)/5)*5, hi = Math.ceil((Math.max(...vals)+2)/5)*5;
  if(hi - lo < 10) hi = lo + 10;
  const x = i => L + i*(W-L-R)/(N-1);
  const y = v => T + (hi - v)*(H-T-B)/(hi - lo);
  const now = new Date(), months = [];
  for(let i=N-1;i>=0;i--){ const d = new Date(now.getFullYear(), now.getMonth()-i, 1); months.push(d.toLocaleString('en-IN',{month:'short'})); }
  let g = '';
  for(let k=0;k<=4;k++){
    const v = lo + (hi-lo)*k/4, yy = y(v).toFixed(1);
    g += `<line x1="${L}" y1="${yy}" x2="${W-R}" y2="${yy}" stroke="#E3E6E1" stroke-width="1"/>`;
    g += `<text x="${L-8}" y="${(+yy+4).toFixed(1)}" text-anchor="end" font-size="11" fill="#66726D">${Math.round(v)}</text>`;
  }
  months.forEach((m,i)=>{ if(i%3===0 || i===N-1) g += `<text x="${x(i).toFixed(1)}" y="${H-8}" text-anchor="middle" font-size="11" fill="#66726D">${m}</text>`; });
  const paths = series.slice().reverse().map(s=>{
    const d = s.data.map((v,i)=>(i?'L':'M')+x(i).toFixed(1)+' '+y(v).toFixed(1)).join(' ');
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.w}" stroke-linejoin="round" stroke-linecap="round"/>`+
           `<circle cx="${x(N-1).toFixed(1)}" cy="${y(s.data[N-1]).toFixed(1)}" r="3.5" fill="${s.color}"/>`;
  }).join('');
  const legend = series.map(s=>{
    const chg = s.data[N-1] - 100;
    return `<span class="lg"><i style="background:${s.color}"></i>${s.name}<b>${chg>=0?'+':''}${chg.toFixed(1)}%</b></span>`;
  }).join('');
  return `<div class="perf"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Illustrative 12-month performance against NIFTY 50 and BSE SENSEX">${g}${paths}</svg>
    <div class="perf-legend">${legend}</div></div>`;
}

/* ---------------- listing details + photos (Supabase) ---------------- */
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
  const { data } = await sb.from('property_media').select('token_address,image_urls,location,property_type');
  const map = {};
  (data || []).forEach(r => { map[r.token_address] = r; });
  return map;
}
async function saveMedia(tokenAddr, patch){
  const { error } = await sb.from('property_media').upsert(Object.assign({
    token_address: tokenAddr.toLowerCase(),
    updated_by: session ? session.address.toLowerCase() : null,
    updated_at: new Date().toISOString()
  }, patch), { onConflict:'token_address' });
  if(error) throw error;
}
function setImages(tokenAddr, urls){ return saveMedia(tokenAddr, { image_urls: urls }); }
function previewPicked(input, targetId){
  const el = document.getElementById(targetId); if(!el) return;
  el.innerHTML = [...input.files].filter(f=>f.type.startsWith('image/'))
    .map(f=>`<div class="photo-tile"><img src="${URL.createObjectURL(f)}" alt=""></div>`).join('');
}
async function handleSaveDetails(tokenAddr){
  try{
    setSt('detStatus','Saving\u2026','info');
    await saveMedia(tokenAddr, {
      location: document.getElementById('edLoc').value.trim(),
      property_type: document.getElementById('edType').value,
      description: document.getElementById('edDesc').value.trim()
    });
    setSt('detStatus','Details saved.','ok');
    setTimeout(()=>renderPropertyDetail(tokenAddr), 600);
  }catch(e){ console.error('[media]', e); setSt('detStatus','Could not save: ' + (e.message || e),'err'); }
}
async function handleAddPhotos(tokenAddr){
  const files = [...(document.getElementById('addImages').files || [])];
  if(!files.length){ setSt('photoStatus','Choose at least one photo first.','err'); return; }
  try{
    setSt('photoStatus','Uploading ' + files.length + ' photo' + (files.length>1?'s':'') + '\u2026','info');
    const urls = await uploadImages(tokenAddr, files);
    const cur  = ((await getMedia(tokenAddr)) || {}).image_urls || [];
    await setImages(tokenAddr, cur.concat(urls));
    setSt('photoStatus','Photos uploaded.','ok');
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
      await sendTx('listStatus','Step 1 of 2: approving escrow','PropertyToken',tokenAddr,'approve',[CONFIG.marketplace, amount]);
    }
    await sendTx('listStatus','Step 2 of 2: listing units','Marketplace',null,'list',[tokenAddr, amount, price]);
    setSt('listStatus','Listed '+amount+' units at '+rupee(price)+' each.','ok');
    setTimeout(()=>renderPropertyDetail(tokenAddr), 800);
  }catch(e){ console.error('[tx] list failed', e); setSt('listStatus', prettyErr(e), 'err'); }
}
async function handleCancel(id, tokenAddr){
  if(!requireLogin()) return;
  try{
    await sendTx('cancelStatus','Cancelling your offer','Marketplace',null,'cancel',[id]);
    setSt('cancelStatus','Offer cancelled. Unsold units are back in your wallet.','ok');
    setTimeout(()=>renderPropertyDetail(tokenAddr), 800);
  }catch(e){ console.error('[tx] cancel failed', e); setSt('cancelStatus', prettyErr(e), 'err'); }
}
async function confirmBuy(){
  if(!requireLogin() || !LP) return;
  const o = LP.buyable[LP.sel]; if(!o) return;
  const btn = document.getElementById('buyBtn');
  try{
    const qty = BigInt(document.getElementById('buyQty').value || '0');
    if(qty<=0n || qty>o.remaining) throw new Error('Invalid amount');
    if(btn) btn.disabled = true;
    await sendTx('buyStatus','Buying '+qty+' units','Marketplace',null,'buy',[o.id, qty]);
    setSt('buyStatus','Done. '+qty+' units are now in your wallet.','ok');
    setTimeout(()=>renderPropertyDetail(LP.tokenAddr), 1000);
  }catch(e){ console.error('[tx] buy failed', e); setSt('buyStatus', prettyErr(e), 'err'); }
  finally{ if(btn) btn.disabled = false; }
}
async function handleDeposit(tokenAddr){
  if(!requireLogin()) return;
  try{
    const amt = BigInt(document.getElementById('yieldAmt').value || '0');
    if(amt<=0n) throw new Error('Invalid amount');
    await sendTx('yieldStatus','Distributing rent','PropertyToken',tokenAddr,'depositYield',[amt]);
    setSt('yieldStatus','Distributed '+rupee(amt)+' across all unit holders.','ok');
    setTimeout(()=>renderPropertyDetail(tokenAddr), 800);
  }catch(e){ console.error('[tx] deposit failed', e); setSt('yieldStatus', prettyErr(e), 'err'); }
}
async function handleClaim(tokenAddr){
  if(!requireLogin()) return;
  try{
    await sendTx('claimStatus','Claiming rent','PropertyToken',tokenAddr,'claimYield',[]);
    setSt('claimStatus','Rent claimed. The rupee payout is made off-chain.','ok');
    setTimeout(()=>renderPropertyDetail(tokenAddr), 900);
  }catch(e){ console.error('[tx] claim failed', e); setSt('claimStatus', prettyErr(e), 'err'); }
}
async function handleClaimDash(tokenAddr){
  if(!requireLogin()) return;
  try{
    await sendTx('dashClaimStatus','Claiming rent','PropertyToken',tokenAddr,'claimYield',[]);
    setSt('dashClaimStatus','Rent claimed. The rupee payout is made off-chain.','ok');
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
      <div class="page container narrow">
        <h1>List a property</h1>
        <p class="lede">Connect your wallet to register a building and issue its units.</p>
        <button class="btn primary" onclick="connectWallet(false)">Connect wallet</button>
      </div>`;
    return;
  }
  document.getElementById('app').innerHTML = `
    <div class="page container narrow">
      <h1>List a property</h1>
      <p class="lede">Register a rent-yielding building and split it into units. You receive all the units to start, and can sell them to investors.</p>
      <form class="form-card" onsubmit="event.preventDefault();handleRegister()">
        <fieldset>
          <legend>The building</legend>
          <label for="pName">Property name</label><input id="pName" value="Puravankara, Tower A" required />
          <div class="two">
            <div><label for="pLoc">Location</label><input id="pLoc" value="Whitefield, Bengaluru" /></div>
            <div><label for="pType">Property type</label><select id="pType">${PROPERTY_TYPES.map(t=>`<option>${t}</option>`).join('')}</select></div>
          </div>
          <label for="pDesc">Description</label>
          <textarea id="pDesc" rows="4" placeholder="The building, its tenants, the lease terms and the rent it earns."></textarea>
          <label for="pImages">Photos</label>
          <input id="pImages" type="file" accept="image/*" multiple onchange="previewPicked(this,'pPreview')" />
          <p class="fine">JPG or PNG, up to 5 MB each. The first photo becomes the cover. You can change photos later.</p>
          <div id="pPreview" class="photo-grid"></div>
        </fieldset>
        <fieldset>
          <legend>Units</legend>
          <div class="two">
            <div><label for="pSymbol">Token symbol</label><input id="pSymbol" value="PRVK-A" required /></div>
            <div><label for="pShares">Number of units</label><input id="pShares" type="number" min="1" value="1000" required /></div>
          </div>
          <p class="fine">Whole units only. Holding 50 of 1,000 units means a 5% share of the rent.</p>
          <label for="pDoc">Title document reference</label><input id="pDoc" value="Title deed and khata extract" />
          <p class="fine">Stored as a fingerprint (hash) on the ledger, so the record can be checked later.</p>
        </fieldset>
        <button id="regBtn" class="btn primary block lg" type="submit">Register property</button>
        <div id="regStatus" class="status"></div>
      </form>
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
    if(!name || !symbol || units<=0n) throw new Error('Fill in a name, a symbol and a number of units above 0.');
    const docHash = ethers.keccak256(ethers.toUtf8Bytes(document.getElementById('pDoc').value));

    const rc = await sendTx('regStatus','Registering property','PropertyTokenFactory',null,'registerLand',
      [name, symbol, units, docHash, 'demo']);

    const iface = new ethers.Interface(ABIS.PropertyTokenFactory);
    let tokenAddr = null;
    for(const log of rc.logs){
      try{ const p = iface.parseLog(log); if(p && p.name==='LandRegistered') tokenAddr = p.args.tokenAddress; }catch{}
    }

    if(tokenAddr && sb){
      try{
        const files = [...((document.getElementById('pImages') || {}).files || [])];
        setSt('regStatus','Registered on-chain. Saving details' + (files.length?' and photos':'') + '…','info');
        const urls = files.length ? await uploadImages(tokenAddr, files) : [];
        await saveMedia(tokenAddr, {
          image_urls: urls,
          location: document.getElementById('pLoc').value.trim(),
          property_type: document.getElementById('pType').value,
          description: document.getElementById('pDesc').value.trim()
        });
      }catch(e){
        console.error('[media] save failed', e);
        setSt('regStatus','Registered on-chain, but the details or photos did not save. You can add them from the property page.','err');
        setTimeout(()=>{ location.hash = '#/properties/' + tokenAddr; }, 2500);
        return;
      }
    }
    setSt('regStatus','Registered. Opening your property…','ok');
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
    app.innerHTML = `<div class="page container narrow"><h1>Your dashboard</h1>
      <p class="lede">Connect your wallet to see the units you hold and the rent you can claim.</p>
      <button class="btn primary" onclick="connectWallet(false)">Connect wallet</button></div>`;
    return;
  }
  app.innerHTML = '<div class="page container"><div class="loading">Loading your dashboard…</div></div>';
  try{
    const me = session.address;
    const all = await withTimeout(readContract('PropertyTokenFactory').getAllTokens(), 15000, 'Timed out reaching Sepolia.');
    const [media, offers] = await Promise.all([ getAllMedia().catch(()=>({})), loadOffers().catch(()=>[]) ]);

    const holdings = (await Promise.all(all.map(async t=>{
      const tk = new ethers.Contract(t, ABIS.PropertyToken, provider);
      const bal = await tk.balanceOf(me);
      if(bal===0n) return null;
      const [name, supply, pending] = await Promise.all([tk.name(), tk.totalSupply(), tk.pendingYield(me)]);
      return { t, name, supply, pending, bal };
    }))).filter(Boolean);

    const totalPending = holdings.reduce((a,h)=>a+h.pending, 0n);
    const mine = offers.filter(o=>o.active && o.seller.toLowerCase()===me.toLowerCase());
    const names = {};
    await Promise.all([...new Set(mine.map(o=>o.token))].map(async t=>{
      try{ names[t] = await new ethers.Contract(t, ABIS.PropertyToken, provider).name(); }catch{ names[t]='Property'; }
    }));

    const thumb = t => { const m = media[t.toLowerCase()] || {}; return (m.image_urls||[])[0] || placeholderImg(t); };

    app.innerHTML = `
      <div class="page container">
        <div class="dash-head">
          <div>
            <h1>Your dashboard</h1>
            <p class="lede">${esc(session.name)} <span class="muted">· ${short(session.address)}</span></p>
          </div>
        </div>
        <div class="summary">
          <div><span>Properties</span><b>${holdings.length}</b></div>
          <div><span>Rent ready to claim</span><b class="${totalPending>0n?'pos':''}">${rupee(totalPending)}</b></div>
          <div><span>Your open offers</span><b>${mine.length}</b></div>
        </div>

        <section class="sec">
          <h2>Holdings</h2>
          ${holdings.length ? `<ul class="hold-list">${holdings.map(h=>{
            const pct = h.supply>0n ? (Number(h.bal)*100/Number(h.supply)).toFixed(2) : '0';
            const m = media[h.t.toLowerCase()] || {};
            return `<li>
              <a class="hl-img" href="#/properties/${h.t}" style="${bgStyle(thumb(h.t))}" aria-label="${esc(h.name)}"></a>
              <div class="hl-main"><a class="hl-name" href="#/properties/${h.t}">${esc(h.name)}</a><span class="muted">${esc(m.location || '')}</span></div>
              <div class="hl-num"><span>Units</span><b>${h.bal}</b></div>
              <div class="hl-num"><span>Share</span><b>${pct}%</b></div>
              <div class="hl-num"><span>Rent to claim</span><b class="${h.pending>0n?'pos':''}">${rupee(h.pending)}</b></div>
              <div class="hl-act">${h.pending>0n
                ? `<button class="btn small primary" onclick="handleClaimDash('${h.t}')">Claim rent</button>`
                : '<span class="muted small">Nothing to claim</span>'}</div>
            </li>`; }).join('')}</ul>`
          : `<div class="empty">You don’t hold any units yet. <a class="link" href="#/properties">Browse properties</a> to buy your first.</div>`}
          <div id="dashClaimStatus" class="status"></div>
        </section>

        <section class="sec">
          <h2>Your open offers</h2>
          ${mine.length ? `<ul class="offers">${mine.map(o=>`
            <li class="offer">
              <span class="who"><a class="link" href="#/properties/${o.token}">${esc(names[o.token]||'Property')}</a></span>
              <span class="what"><b>${o.remaining} units</b> at ${rupee(o.price)} each</span>
              <a class="btn small ghost" href="#/properties/${o.token}">Manage</a>
            </li>`).join('')}</ul>`
          : '<p class="muted">You have no units listed for sale.</p>'}
        </section>
      </div>`;
  }catch(e){
    app.innerHTML = '<div class="page container"><div class="status show err">Could not load your dashboard: '+esc(e.shortMessage||e.message||e)+'</div></div>';
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
