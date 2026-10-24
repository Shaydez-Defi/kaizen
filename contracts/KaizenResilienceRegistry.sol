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
contract KaizenResilienceRegistry {
    uint32 public constant UNKNOWN_U32 = type(uint32).max;
    uint16 public constant UNKNOWN_U16 = type(uint16).max;

    struct Certificate {
        bytes32 fingerprint;
        bytes32 runHash;
        bytes32 signer;
        uint32 timeToRecoverMs;
        uint16 finalityGapBlocks;
        uint16 blocksMissed;
        uint8 score;
        uint8 evidenceFlags;
        uint64 certifiedAt;
        address submitter;
    }

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

    mapping(bytes32 => Certificate[]) private _certs;
    mapping(bytes32 => bool) public recorded;
    uint64 public totalCertificates;

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
        require(!recorded[fingerprint], "already recorded");
        recorded[fingerprint] = true;
        uint64 ts = uint64(block.timestamp);
        _certs[validator].push(
            Certificate(
                fingerprint,
                runHash,
                signer,
                timeToRecoverMs,
                finalityGapBlocks,
                blocksMissed,
                score,
                evidenceFlags,
                ts,
                msg.sender
            )
        );
        totalCertificates += 1;
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
            ts,
            signature
        );
    }

    function certificateCount(bytes32 validator) external view returns (uint256) {
        return _certs[validator].length;
    }

    /// @notice Latest score for a validator: (score, certifiedAt, count). (0, 0, 0) when none.
    function getScore(bytes32 validator) external view returns (uint8 score, uint64 certifiedAt, uint256 count) {
        Certificate[] storage list = _certs[validator];
        count = list.length;
        if (count == 0) return (0, 0, 0);
        Certificate storage c = list[count - 1];
        return (c.score, c.certifiedAt, count);
    }

    function getLatest(bytes32 validator) external view returns (Certificate memory) {
        Certificate[] storage list = _certs[validator];
        require(list.length > 0, "no certificates");
        return list[list.length - 1];
    }

    function getCertificate(bytes32 validator, uint256 index) external view returns (Certificate memory) {
        return _certs[validator][index];
    }
}
