// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract Whitelist {
    mapping(address => bool) public isApproved;
    address public admin;
    event Registered(address indexed account);
    constructor() { admin = msg.sender; }
    function register() external {
        require(!isApproved[msg.sender], "Already registered");
        isApproved[msg.sender] = true;
        emit Registered(msg.sender);
    }
    function approveAddress(address account) external {
        require(msg.sender == admin, "Only admin");
        require(!isApproved[account], "Already approved");
        isApproved[account] = true;
        emit Registered(account);
    }
}

contract PropertyToken is ERC20 {
    Whitelist public immutable whitelist;
    bytes32 public immutable docHash;
    address public immutable registrant;
    string public metadataURI;

    constructor(
        string memory name_, string memory symbol_, uint256 totalTokens,
        bytes32 docHash_, string memory metadataURI_, address whitelist_, address registrant_
    ) ERC20(name_, symbol_) {
        whitelist = Whitelist(whitelist_);
        docHash = docHash_;
        metadataURI = metadataURI_;
        registrant = registrant_;
        _mint(registrant_, totalTokens);
    }

    function decimals() public pure override returns (uint8) { return 0; }

    uint256 public totalYieldDeposited;
    uint256 private accYieldPerShare;
    uint256 private constant ACC = 1e12;
    mapping(address => uint256) private yieldDebt;
    mapping(address => uint256) public claimableYield;

    event YieldDeposited(uint256 amountRupees, uint256 perShare);
    event YieldClaimed(address indexed holder, uint256 amountRupees);

    function depositYield(uint256 amountRupees) external {
        require(msg.sender == registrant, "Only property owner");
        require(totalSupply() > 0, "No shares");
        require(amountRupees > 0, "Zero amount");
        accYieldPerShare += (amountRupees * ACC) / totalSupply();
        totalYieldDeposited += amountRupees;
        emit YieldDeposited(amountRupees, accYieldPerShare);
    }

    function pendingYield(address holder) public view returns (uint256) {
        uint256 accrued = (balanceOf(holder) * accYieldPerShare) / ACC;
        return claimableYield[holder] + (accrued - yieldDebt[holder]);
    }

    function claimYield() external returns (uint256 amount) {
        _harvest(msg.sender);
        amount = claimableYield[msg.sender];
        require(amount > 0, "Nothing to claim");
        claimableYield[msg.sender] = 0;
        emit YieldClaimed(msg.sender, amount);
    }

    function _harvest(address holder) internal {
        uint256 accrued = (balanceOf(holder) * accYieldPerShare) / ACC;
        claimableYield[holder] += accrued - yieldDebt[holder];
        yieldDebt[holder] = accrued;
    }

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
        if (from != address(0)) yieldDebt[from] = (balanceOf(from) * accYieldPerShare) / ACC;
        if (to != address(0)) yieldDebt[to] = (balanceOf(to) * accYieldPerShare) / ACC;
    }
}

contract PropertyTokenFactory {
    Whitelist public immutable whitelist;
    address[] public allTokens;
    mapping(address => address[]) public tokensByOwner;

    event LandRegistered(address indexed owner, address indexed tokenAddress, bytes32 docHash, uint256 totalTokens);

    constructor(address whitelist_) { whitelist = Whitelist(whitelist_); }

    function registerLand(
        string memory name_, string memory symbol_, uint256 totalTokens,
        bytes32 docHash, string memory metadataURI
    ) external returns (address tokenAddress) {
        require(whitelist.isApproved(msg.sender), "Caller not KYC-approved");
        require(totalTokens > 0, "Token count must be > 0");
        PropertyToken token = new PropertyToken(
            name_, symbol_, totalTokens, docHash, metadataURI, address(whitelist), msg.sender
        );
        tokenAddress = address(token);
        allTokens.push(tokenAddress);
        tokensByOwner[msg.sender].push(tokenAddress);
        emit LandRegistered(msg.sender, tokenAddress, docHash, totalTokens);
    }

    function getAllTokens() external view returns (address[] memory) { return allTokens; }
    function getTokensByOwner(address owner) external view returns (address[] memory) { return tokensByOwner[owner]; }
    function totalProperties() external view returns (uint256) { return allTokens.length; }
}

contract Marketplace {
    Whitelist public immutable whitelist;

    struct Listing {
        address seller;
        address token;
        uint256 amount;
        uint256 priceInRupees;
        bool active;
    }

    Listing[] public listings;

    event Listed(uint256 indexed id, address indexed seller, address indexed token, uint256 amount, uint256 priceInRupees);
    event Settled(uint256 indexed id, address indexed buyer, uint256 amount, uint256 remaining);
    event Cancelled(uint256 indexed id, uint256 amountReturned);

    constructor(address whitelist_) { whitelist = Whitelist(whitelist_); }

    function nextListingId() external view returns (uint256) { return listings.length; }

    function list(address token, uint256 amount, uint256 priceInRupees) external returns (uint256 id) {
        require(whitelist.isApproved(msg.sender), "Seller not KYC-approved");
        require(amount > 0, "Amount must be > 0");
        require(priceInRupees > 0, "Price must be > 0");
        require(PropertyToken(token).transferFrom(msg.sender, address(this), amount), "Transfer failed");
        id = listings.length;
        listings.push(Listing(msg.sender, token, amount, priceInRupees, true));
        emit Listed(id, msg.sender, token, amount, priceInRupees);
    }

    // Real-time buy: any approved wallet pulls escrowed shares directly.
    // No on-chain payment — rupee payment is off-chain (assumed complete for demo).
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
