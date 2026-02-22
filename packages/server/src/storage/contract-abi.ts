// PlugPort Smart Contract ABI
// Auto-generated from PlugPortStore.sol — used by the MonadAdapter

export const PLUGPORT_STORE_ABI = [
    // ---- Write Operations ----
    'function put(bytes32 key, bytes calldata value) external',
    'function del(bytes32 key) external',
    'function batchWrite(bytes32[] calldata putKeys, bytes[] calldata putValues, bytes32[] calldata deleteKeys) external',
    'function transferGasStation(address newGasStation) external',

    // ---- Read Operations ----
    'function get(bytes32 key) external view returns (bytes memory)',
    'function exists(bytes32 key) external view returns (bool)',
    'function getKeys(uint256 offset, uint256 limit) external view returns (bytes32[] memory)',
    'function getRegistryLength() external view returns (uint256)',
    'function keyCount() external view returns (uint256)',
    'function gasStation() external view returns (address)',

    // ---- Events ----
    'event KeyUpdated(bytes32 indexed key, uint256 valueLength)',
    'event KeyDeleted(bytes32 indexed key)',
    'event BatchWritten(uint256 putCount, uint256 deleteCount)',
    'event GasStationTransferred(address indexed previousGasStation, address indexed newGasStation)',
] as const;
