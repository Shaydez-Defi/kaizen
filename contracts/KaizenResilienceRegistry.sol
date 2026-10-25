// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title KaizenResilienceRegistry
/// @notice Per-validator store of Kaizen resilience certificates (T-9.4).
/// A certificate is the SHA-256 fingerprint of a chain-bound Failure Lab run
/// record, signed off-chain by the operator's sr25519 key (`signer` is the
/// 32-byte public key). The EVM cannot verify sr25519, so the signature is
/// emitted in `CertificateRecorded` (not stored) and verified off-chain;
/// `score` is the operator-computed v1 score (docs/RESILIENCE_SCORE.md),
/// stored next to its inputs so anyone can recompute it.
/// Metrics use type(uintN).max as "unknown". Fingerprints are recorded once.
///
/// LITE LAYOUT (RSK-30): the v1 layout kept a 7-slot struct per certificate
/// (~31 tPOT held deposit each). Here only two storage slots change per
/// anchor: certHash -> (score, block) and the validator's latest
/// (score, block, count). Every other field lives in the event, which
/// indexers and the explorer read.
contract KaizenResilienceRegistry {
    uint32 public constant UNKNOWN_U32 = type(uint32).max;
    uint16 public constant UNKNOWN_U16 = type(uint16).max;

    event CertificateRecorded(
        bytes32 indexed validator,
        bytes32 indexed fingerprint,
        bytes32 indexed signer,
        bytes32 runHash,
        uint8 score,
        uint8 evidenceFlags,
        uint32 timeToRecoverMs,
        uint16 finalityGapBlocks,
        uint16 blocksMissed,
        uint64 certifiedAt,
        bytes signature
    );

    // packed: score (bits 0-7) | block (bits 8-71) ; 0 = unset
    mapping(bytes32 => uint256) private _cert;
    // packed: score (0-7) | block (8-71) | count (72-135)
    mapping(bytes32 => uint256) private _latest;

    function record(
        bytes32 validator,
        bytes32 fingerprint,
        bytes32 runHash,
        bytes32 signer,
        uint32 timeToRecoverMs,
        uint16 finalityGapBlocks,
        uint16 blocksMissed,
        uint8 score,
        uint8 evidenceFlags,
        bytes calldata signature
    ) external {
        require(validator != bytes32(0), "zero validator");
        require(fingerprint != bytes32(0), "zero fingerprint");
        require(signer != bytes32(0), "zero signer");
        require(score <= 100, "score > 100");
        require(signature.length == 64, "bad signature length");
        require(_cert[fingerprint] == 0, "already recorded");
        _store(validator, fingerprint, score);
        emit CertificateRecorded(
            validator,
            fingerprint,
            signer,
            runHash,
            score,
            evidenceFlags,
            timeToRecoverMs,
            finalityGapBlocks,
            blocksMissed,
            uint64(block.timestamp),
            signature
        );
    }

    function _store(bytes32 validator, bytes32 fingerprint, uint8 score) private {
        uint256 blk = block.number;
        // bit 200 marker keeps a (score 0, block 0) record non-zero
        _cert[fingerprint] = (uint256(1) << 200) | (blk << 8) | score;
        uint256 count = (_latest[validator] >> 72) & type(uint64).max;
        _latest[validator] = ((count + 1) << 72) | (blk << 8) | score;
    }

    function recorded(bytes32 fingerprint) external view returns (bool) {
        return _cert[fingerprint] != 0;
    }

    /// @notice Stored (score, block) for a certificate hash. (0, 0) when unknown.
    function certOf(bytes32 fingerprint) external view returns (uint8 score, uint64 blockNumber) {
        uint256 v = _cert[fingerprint];
        return (uint8(v), uint64(v >> 8));
    }

    /// @notice Latest score for a validator: (score, block, count). (0, 0, 0) when none.
    function getScore(bytes32 validator) external view returns (uint8 score, uint64 blockNumber, uint256 count) {
        uint256 v = _latest[validator];
        return (uint8(v), uint64(v >> 8), (v >> 72) & type(uint64).max);
    }
}
