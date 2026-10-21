// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title KaizenRunRegistry
/// @notice Append-only registry of Kaizen Failure Lab run hashes (T-8.2).
/// A run hash is the SHA-256 of the canonical JSON of a finished scenario
/// run record; `meta` is a short, secret-free descriptor
/// ("kaizen:v1:<runId>:<scenario>:<state>"). Each hash can be anchored once.
contract KaizenRunRegistry {
    event RunAnchored(bytes32 indexed runHash, address indexed submitter, uint64 anchoredAt, string meta);

    mapping(bytes32 => uint64) public anchoredAt;
    uint64 public totalAnchors;

    function anchor(bytes32 runHash, string calldata meta) external {
        require(runHash != bytes32(0), "zero hash");
        require(bytes(meta).length <= 256, "meta too long");
        require(anchoredAt[runHash] == 0, "already anchored");
        uint64 ts = uint64(block.timestamp);
        anchoredAt[runHash] = ts == 0 ? 1 : ts;
        totalAnchors += 1;
        emit RunAnchored(runHash, msg.sender, ts, meta);
    }
}
