#![cfg_attr(not(feature = "std"), no_std, no_main)]

/// Kaizen resilience registry, ink! (Wasm, pallet-contracts) twin of the lite
/// EVM registry. Same layout: certHash -> (score, block) and a per-validator
/// latest (score, block, count). Everything else lives in the event.
#[ink::contract]
mod kaizen_ink_registry {
    use ink::prelude::vec::Vec;
    use ink::storage::Mapping;

    #[ink(event)]
    pub struct CertificateRecorded {
        #[ink(topic)]
        validator: [u8; 32],
        #[ink(topic)]
        fingerprint: [u8; 32],
        #[ink(topic)]
        signer: [u8; 32],
        run_hash: [u8; 32],
        score: u8,
        evidence_flags: u8,
        time_to_recover_ms: u32,
        finality_gap_blocks: u16,
        blocks_missed: u16,
        certified_at: u64,
        signature: Vec<u8>,
    }

    #[derive(Debug, PartialEq, Eq)]
    #[ink::scale_derive(Encode, Decode, TypeInfo)]
    pub enum Error {
        ZeroValidator,
        ZeroFingerprint,
        ZeroSigner,
        ScoreOver100,
        BadSignatureLength,
        AlreadyRecorded,
    }

    #[ink(storage)]
    #[derive(Default)]
    pub struct KaizenRegistry {
        /// fingerprint -> (score, block)
        cert: Mapping<[u8; 32], (u8, u32)>,
        /// validator -> (score, block, count)
        latest: Mapping<[u8; 32], (u8, u32, u64)>,
    }

    impl KaizenRegistry {
        #[ink(constructor)]
        pub fn new() -> Self {
            Self::default()
        }

        #[ink(message)]
        pub fn record(
            &mut self,
            validator: [u8; 32],
            fingerprint: [u8; 32],
            run_hash: [u8; 32],
            signer: [u8; 32],
            time_to_recover_ms: u32,
            finality_gap_blocks: u16,
            blocks_missed: u16,
            score: u8,
            evidence_flags: u8,
            signature: Vec<u8>,
        ) -> Result<(), Error> {
            if validator == [0u8; 32] {
                return Err(Error::ZeroValidator);
            }
            if fingerprint == [0u8; 32] {
                return Err(Error::ZeroFingerprint);
            }
            if signer == [0u8; 32] {
                return Err(Error::ZeroSigner);
            }
            if score > 100 {
                return Err(Error::ScoreOver100);
            }
            if signature.len() != 64 {
                return Err(Error::BadSignatureLength);
            }
            if self.cert.contains(fingerprint) {
                return Err(Error::AlreadyRecorded);
            }
            let blk = self.env().block_number();
            self.cert.insert(fingerprint, &(score, blk));
            let count = self.latest.get(validator).map(|l| l.2).unwrap_or(0);
            self.latest.insert(validator, &(score, blk, count + 1));
            self.env().emit_event(CertificateRecorded {
                validator,
                fingerprint,
                signer,
                run_hash,
                score,
                evidence_flags,
                time_to_recover_ms,
                finality_gap_blocks,
                blocks_missed,
                certified_at: self.env().block_timestamp(),
                signature,
            });
            Ok(())
        }

        /// (score, block) for a fingerprint, None if unknown.
        #[ink(message)]
        pub fn cert_of(&self, fingerprint: [u8; 32]) -> Option<(u8, u32)> {
            self.cert.get(fingerprint)
        }

        /// Latest (score, block, count) for a validator, None if unknown.
        #[ink(message)]
        pub fn get_score(&self, validator: [u8; 32]) -> Option<(u8, u32, u64)> {
            self.latest.get(validator)
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn rec(r: &mut KaizenRegistry, v: u8, f: u8, score: u8) -> Result<(), Error> {
            r.record([v; 32], [f; 32], [9; 32], [7; 32], 100, 2, 0, score, 1, vec![1u8; 64])
        }

        #[ink::test]
        fn records_and_reads_back() {
            let mut r = KaizenRegistry::new();
            assert_eq!(r.cert_of([1; 32]), None);
            assert_eq!(rec(&mut r, 5, 1, 35), Ok(()));
            assert_eq!(r.cert_of([1; 32]).map(|c| c.0), Some(35));
            assert_eq!(r.get_score([5; 32]).map(|l| (l.0, l.2)), Some((35, 1)));
            assert_eq!(rec(&mut r, 5, 2, 60), Ok(()));
            assert_eq!(r.get_score([5; 32]).map(|l| (l.0, l.2)), Some((60, 2)));
        }

        #[ink::test]
        fn rejects_duplicates_and_bad_input() {
            let mut r = KaizenRegistry::new();
            assert_eq!(rec(&mut r, 5, 1, 35), Ok(()));
            assert_eq!(rec(&mut r, 5, 1, 35), Err(Error::AlreadyRecorded));
            assert_eq!(rec(&mut r, 5, 3, 101), Err(Error::ScoreOver100));
            assert_eq!(rec(&mut r, 0, 4, 10), Err(Error::ZeroValidator));
            assert_eq!(
                r.record([5; 32], [6; 32], [9; 32], [7; 32], 0, 0, 0, 10, 0, vec![1u8; 10]),
                Err(Error::BadSignatureLength)
            );
        }
    }
}
