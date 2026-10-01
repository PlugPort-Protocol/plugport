// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "./PlugPortPrivateStore.sol";

/**
 * @title PlugPortPrivateStoreFactory
 * @notice Factory contract for deploying isolated PlugPortPrivateStore instances.
 *         Each private collection gets its own contract for clean security isolation.
 *
 * @dev Usage flow:
 *   1. User calls createPrivateStore(plugportWriter) from the PlugPort dashboard
 *   2. Factory deploys a new PlugPortPrivateStore owned by the user, with
 *      PlugPort's writer as its gas station; the factory itself holds no role
 *   3. Factory records the deployment in an on-chain registry
 *   4. The user registers the store with the PlugPort server, which verifies it
 *      here (storeOwner) and on the store (owner, gasStation) before using it
 *   5. The user can cut PlugPort off at any time with transferGasStation()
 *
 * On-chain registry enables:
 *   - Enumerating all private stores owned by an address
 *   - Verifying that a store was deployed by this factory (not a rogue contract)
 *   - Dashboard displaying deployment history and gas station balances
 */
contract PlugPortPrivateStoreFactory {
    // ---- State ----

    /// @dev Deployer / admin of the factory
    address public admin;

    /// @dev Owner → array of deployed PrivateStore addresses
    mapping(address => address[]) private storesByOwner;

    /// @dev PrivateStore address → owner (reverse lookup + existence check)
    mapping(address => address) public storeOwner;

    /// @dev Total number of private stores deployed via this factory
    uint256 public totalStoresDeployed;

    // ---- Events ----

    event PrivateStoreCreated(
        address indexed owner,
        address indexed store,
        uint256 indexed storeIndex,
        address gasStation
    );

    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    // ---- Constructor ----

    constructor() {
        admin = msg.sender;
    }

    // ---- Factory Functions ----

    /**
     * @notice Deploy a new PlugPortPrivateStore for the caller.
     *         The caller becomes the owner and can configure ACLs.
     *
     * @param _gasStation Address authorized for gas-subsidized writes.
     *                    Pass address(0) to use msg.sender as gas station.
     * @return storeAddress The address of the newly deployed private store
     */
    function createPrivateStore(address _gasStation) external returns (address storeAddress) {
        // Owned by the caller from the start, so the factory never holds a role.
        PlugPortPrivateStore newStore = new PlugPortPrivateStore(msg.sender, _gasStation);
        storeAddress = address(newStore);

        // Register in the on-chain registry
        uint256 index = storesByOwner[msg.sender].length;
        storesByOwner[msg.sender].push(storeAddress);
        storeOwner[storeAddress] = msg.sender;
        totalStoresDeployed++;

        emit PrivateStoreCreated(msg.sender, storeAddress, index, newStore.gasStation());

        return storeAddress;
    }

    // ---- Registry Queries ----

    /**
     * @notice Get all private stores deployed by an owner.
     * @param owner The address to query
     * @return Array of PlugPortPrivateStore contract addresses
     */
    function getStoresByOwner(address owner) external view returns (address[] memory) {
        return storesByOwner[owner];
    }

    /**
     * @notice Get the number of private stores deployed by an owner.
     */
    function getStoreCount(address owner) external view returns (uint256) {
        return storesByOwner[owner].length;
    }

    /**
     * @notice Check if a private store was deployed via this factory.
     * @param store The contract address to verify
     * @return True if the store was deployed by this factory
     */
    function isFactoryDeployed(address store) external view returns (bool) {
        return storeOwner[store] != address(0);
    }

    // ---- Admin ----

    /**
     * @notice Transfer factory admin to a new address.
     */
    function transferAdmin(address newAdmin) external {
        require(msg.sender == admin, "Factory: not admin");
        require(newAdmin != address(0), "Factory: zero address");
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }
}
