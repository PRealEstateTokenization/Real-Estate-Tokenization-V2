// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title Whitelist — self-service KYC approval for the demo
contract Whitelist {
    mapping(address => bool) public isApproved;
    address public admin;

    event Registered(address indexed account);

    constructor() {
        admin = msg.sender;
    }

    /// Self-service approval. In production this would be admin/provider gated.
    function register() external {
        require(!isApproved[msg.sender], "Already registered");
        isApproved[msg.sender] = true;
        emit Registered(msg.sender);
    }

    /// Admin can approve an address directly — used to whitelist the
    /// Marketplace contract so it can hold escrowed shares during a sale.
    function approveAddress(address account) external {
        require(msg.sender == admin, "Only admin");
        require(!isApproved[account], "Already approved");
        isApproved[account] = true;
        emit Registered(account);
    }
}

/// @title PropertyToken — one ERC-20 per property; supply = 100% of the parcel
contract PropertyToken is ERC20 {
    Whitelist public immutable whitelist;
    bytes32 public immutable docHash;
    address public immutable registrant;
    string public metadataURI;

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 totalTokens,
        bytes32 docHash_,
        string memory metadataURI_,
        address whitelist_,
        address registrant_
    ) ERC20(name_, symbol_) {
        whitelist = Whitelist(whitelist_);
        docHash = docHash_;
        metadataURI = metadataURI_;
        registrant = registrant_;
        _mint(registrant_, totalTokens); // whole-number shares (see decimals override)
    }

    /// Whole-number shares: 1 token = 1 share, no 18-decimal scaling.
    function decimals() public pure override returns (uint8) {
        return 0;
    }

    // ----------------- YIELD / RENT DISTRIBUTION -----------------
    // Rent is recorded off-chain in rupees, but tracked here as a
    // per-share accumulator so each owner can claim their pro-rata
    // slice. Amounts are plain rupee integers — NOT crypto, NOT ETH.
    // Pull-based: each holder claims; the contract never pushes.

    uint256 public totalYieldDeposited;              // cumulative rupees distributed
    uint256 private accYieldPerShare;                // scaled accumulator
    uint256 private constant ACC = 1e12;             // fixed-point scale
    mapping(address => uint256) private yieldDebt;   // already-accounted per holder
    mapping(address => uint256) public claimableYield; // rupees ready to claim

    event YieldDeposited(uint256 amountRupees, uint256 perShare);
    event YieldClaimed(address indexed holder, uint256 amountRupees);

    /// Owner/admin records a rent distribution (in rupees). Splits pro-rata
    /// across all current shares via the accumulator.
    function depositYield(uint256 amountRupees) external {
        require(msg.sender == registrant, "Only property owner");
        require(totalSupply() > 0, "No shares");
        require(amountRupees > 0, "Zero amount");
        accYieldPerShare += (amountRupees * ACC) / totalSupply();
        totalYieldDeposited += amountRupees;
        emit YieldDeposited(amountRupees, accYieldPerShare);
    }

    /// How much a holder can currently claim (rupees).
    function pendingYield(address holder) public view returns (uint256) {
        uint256 accrued = (balanceOf(holder) * accYieldPerShare) / ACC;
        return claimableYield[holder] + (accrued - yieldDebt[holder]);
    }

    /// Holder claims their accumulated yield (rupees). Records it as claimed.
    function claimYield() external returns (uint256 amount) {
        _harvest(msg.sender);
        amount = claimableYield[msg.sender];
        require(amount > 0, "Nothing to claim");
        claimableYield[msg.sender] = 0;
        emit YieldClaimed(msg.sender, amount);
        // NOTE: actual rupee payout happens off-chain; this records entitlement.
    }

    /// Move accrued-but-unbooked yield into claimable, and reset debt.
    function _harvest(address holder) internal {
        uint256 accrued = (balanceOf(holder) * accYieldPerShare) / ACC;
        claimableYield[holder] += accrued - yieldDebt[holder];
        yieldDebt[holder] = accrued;
    }

    /// KYC gate on every transfer (both sides must be approved).
    /// Mint (from == 0) is exempt so the initial supply can be created.
    /// Also settles yield accounting for both sides before balances change.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0)) {
            require(whitelist.isApproved(from), "Sender not KYC-approved");
            _harvest(from);
        }
        if (to != address(0)) {
            require(whitelist.isApproved(to), "Recipient not KYC-approved");
            _harvest(to);
        }
        super._update(from, to, value);
        // reset debts to new balances so future accrual is correct
        if (from != address(0)) yieldDebt[from] = (balanceOf(from) * accYieldPerShare) / ACC;
        if (to != address(0)) yieldDebt[to] = (balanceOf(to) * accYieldPerShare) / ACC;
    }
}

/// @title PropertyTokenFactory — deploys one PropertyToken per registered parcel
contract PropertyTokenFactory {
    Whitelist public immutable whitelist;
    address[] public allTokens;
    mapping(address => address[]) public tokensByOwner;

    event LandRegistered(
        address indexed owner,
        address indexed tokenAddress,
        bytes32 docHash,
        uint256 totalTokens
    );

    constructor(address whitelist_) {
        whitelist = Whitelist(whitelist_);
    }

    function registerLand(
        string memory name_,
        string memory symbol_,
        uint256 totalTokens,
        bytes32 docHash,
        string memory metadataURI
    ) external returns (address tokenAddress) {
        require(whitelist.isApproved(msg.sender), "Caller not KYC-approved");
        require(totalTokens > 0, "Token count must be > 0");

        PropertyToken token = new PropertyToken(
            name_, symbol_, totalTokens, docHash, metadataURI,
            address(whitelist), msg.sender
        );
        tokenAddress = address(token);

        allTokens.push(tokenAddress);
        tokensByOwner[msg.sender].push(tokenAddress);

        emit LandRegistered(msg.sender, tokenAddress, docHash, totalTokens);
    }

    function getAllTokens() external view returns (address[] memory) {
        return allTokens;
    }

    function getTokensByOwner(address owner) external view returns (address[] memory) {
        return tokensByOwner[owner];
    }

    function totalProperties() external view returns (uint256) {
        return allTokens.length;
    }
}

/// @title Marketplace — list and settle share transfers. NO money on-chain.
/// Payment happens off-chain in rupees; the seller confirms the transfer here
/// once they have received payment. The chain records ownership only.
contract Marketplace {
    Whitelist public immutable whitelist;

    struct Listing {
        address seller;
        address token;
        uint256 amount;          // remaining shares
        uint256 priceInRupees;   // per-share asking price — DISPLAY ONLY, not enforced
        bool active;
    }

    Listing[] public listings;

    event Listed(uint256 indexed id, address indexed seller, address indexed token, uint256 amount, uint256 priceInRupees);
    event Settled(uint256 indexed id, address indexed buyer, uint256 amount, uint256 remaining);
    event Cancelled(uint256 indexed id, uint256 amountReturned);

    constructor(address whitelist_) {
        whitelist = Whitelist(whitelist_);
    }

    function nextListingId() external view returns (uint256) {
        return listings.length;
    }

    /// Seller must approve() this contract for `amount` first.
    function list(address token, uint256 amount, uint256 priceInRupees) external returns (uint256 id) {
        require(whitelist.isApproved(msg.sender), "Seller not KYC-approved");
        require(amount > 0, "Amount must be > 0");
        require(priceInRupees > 0, "Price must be > 0");

        require(PropertyToken(token).transferFrom(msg.sender, address(this), amount), "Transfer failed");

        id = listings.length;
        listings.push(Listing(msg.sender, token, amount, priceInRupees, true));
        emit Listed(id, msg.sender, token, amount, priceInRupees);
    }

    /// Seller confirms a settled sale (payment received off-chain in rupees)
    /// and releases `amount` shares to `buyer`. No money moves on-chain.
    function settlePurchase(uint256 id, address buyer, uint256 amount) external {
        Listing storage l = listings[id];
        require(l.active, "Listing not active");
        require(msg.sender == l.seller, "Only seller can settle");
        require(whitelist.isApproved(buyer), "Buyer not KYC-approved");
        require(amount > 0 && amount <= l.amount, "Invalid amount");

        l.amount -= amount;
        if (l.amount == 0) l.active = false;

        require(PropertyToken(l.token).transfer(buyer, amount), "Transfer failed");
        emit Settled(id, buyer, amount, l.amount);
    }

    /// Real-time buy: any KYC-approved wallet pulls escrowed shares directly.
    /// No on-chain payment — rupee payment is off-chain and assumed complete
    /// for the demo. The seller already permitted the sale by listing (escrow),
    /// so no seller signature is needed here — this is what makes it real-time.
    function buy(uint256 id, uint256 amount) external {
        Listing storage l = listings[id];
        require(l.active, "Listing not active");
        require(whitelist.isApproved(msg.sender), "Buyer not KYC-approved");
        require(amount > 0 && amount <= l.amount, "Invalid amount");
        require(msg.sender != l.seller, "Seller cannot buy own listing");

        l.amount -= amount;
        if (l.amount == 0) l.active = false;

        require(PropertyToken(l.token).transfer(msg.sender, amount), "Transfer failed");
        emit Settled(id, msg.sender, amount, l.amount);
    }

    function cancel(uint256 id) external {
        Listing storage l = listings[id];
        require(l.seller == msg.sender, "Not seller");
        require(l.active, "Listing not active");

        uint256 remaining = l.amount;
        l.amount = 0;
        l.active = false;

        require(PropertyToken(l.token).transfer(msg.sender, remaining), "Return failed");
        emit Cancelled(id, remaining);
    }
}
