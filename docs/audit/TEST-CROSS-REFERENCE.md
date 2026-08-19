# Threat-Model → Test Cross-Reference

Every mechanic in [THREAT-MODEL.md](../THREAT-MODEL.md) mapped to the test(s) covering it.
Suite: 119 tests across 16 files (`contracts/test/`), including 6 invariant/fuzz suites
(256 runs × 16k calls). Rows with no dedicated test say so explicitly — traceability includes
the honest gaps.

Test names abbreviated to `File::test`; all files live in `contracts/test/`.

## Entry / exit (EE) & share accounting

| Row / mechanic | Tests |
| --- | --- |
| EE-1 donation defense, pending excluded from NAV | `VaultCore::test_donationDoesNotMoveNav`, `::test_firstDepositEntersWindow_noSharesNoNav`, `VaultCoreInvariant::invariant_pendingEscrowConsistent`, `::invariant_solvency` (adversarial donation) |
| §5 observation window state machine | `VaultCore::test_activateBeforeWindowReverts`, `::test_activateAfterWindowMintsAtActivationNav`, `::test_cancelPendingRefunds`, `::test_skipWindow_immediateActivation_andIrreversible`, `::test_repeatDepositSkipsWindow` |
| SF-3 capacity cap (optional) + min deposit | `VaultCore::test_capacityCapEnforced`, `::test_uncappedVaultAcceptsUnboundedDeposits`, `::test_minDepositEnforced` |
| CM-1/CM-2 creator 5% withdrawal gate | `VaultCore::test_creatorCannotExitBelow5PctWhileMembersRemain`, `::test_creatorCanExitPartiallyDownTo5Pct`, `::test_creatorCanFullyExitWhenNoMembersRemain`, `VaultCoreInvariant::invariant_creatorFloor` |
| EE-7 / §4.6 exit fee: decay, accrual to remainers, sole-holder waiver | `VaultCore::test_exitFeeDecaysWithTenure`, `::test_exitFeeAccruesToRemainingMembers_neverOperator` (also EE-9), `::test_exitFeeWaivedForSoleHolder` (EE-8) |
| C-4 two-mode settlement (Mode I / Mode F) | `VaultCore::test_modeI_instantWhenNoPendingExecution`, `::test_modeF_queuesDuringPendingExecution_settlesAtPostNav`, `::test_modeF_doubleQueueReverts`, `VaultCoreInvariant::invariant_queuedConsistent` |
| VO-8 × K-1 forward-pricing seam; EE-10 queue release | `Governance::test_exitDuringRevealPhaseIsForwardPriced`, `::test_expiredProposalReleasesQueuedExits`, `Execution::test_e2e_governedRebalance_modeFExitSettlesAtPostNav` |
| EE-6 in-kind + escrow isolation | `VaultCore::test_inKindRedemption_proRataAcrossAssets`, `::test_blockedAssetEscrows_redemptionStillCompletes` |
| §4.6 NAVps non-decreasing + conservation + solvency | `VaultCoreInvariant::invariant_sharesConserved`, `::invariant_solvency`; system-level with children: `SystemInvariant::invariant_parentShareConservation`, `::invariant_parentSolvency`, `::invariant_childBacksParent` |
| C-1 indicative 4626 views | `VaultCore::test_indicativeViews` |
| EE-5/E7 latency arb | **Accepted residual** — no test; bounded by oracle ceiling + exit fee (see README §7) |

## Module hardening (MO / S1 review fixes)

| Row / mechanic | Tests |
| --- | --- |
| MO-1/H-1 reverting modules never block exits; governance failure → Mode I | `ModuleHardening::test_h1_revertingFeeEngineAndRegistry_exitStillSettles`, `::test_h1_revertingGovernance_fallsBackToModeI`, `::test_h1_moduleFailureEmitsEvent` |
| MO-2/H-2 malformed-returndata / bomb token degrades to escrow | `ModuleHardening::test_h2_malformedReturnTokenEscrows_exitCompletes` |
| MO-3/M-1 creator gate at queue time, not re-checked at settle | gate-at-queue asserted in `VaultCore::test_modeF_*` paths; settle-time non-recheck verified in S1 review — no dedicated regression test |
| MO-4/M-2 fee withheld uniformly across cash + in-kind legs | `ModuleHardening::test_m2_fullyInvestedVault_feeStillCollected` |

## Fees, carry, registry (CM / SF-4/5)

| Row / mechanic | Tests |
| --- | --- |
| CM-3 crystallization only at redemption; 10% of realized gain | `FeesAndRegistry::test_tenPercentOfRealizedGain`, `VaultCore::test_realizedGainReportedToFeeEngineAndRegistry`, `::test_realizedLossReported_noFee` |
| Hostile-module fee clamp (≤10% of gain) | `VaultCore::test_perfFeeClampedTo10PctOfGain`, `FeeCarryInvariant::invariant_feeNeverExceedsNetGainTenth` |
| §7 cross-vault HWM carry portability | `FeesAndRegistry::test_lossInVaultA_offsetsFeeInVaultB_sameOperator`, `::test_carryFullyConsumedThenFeesResume`, `FeeCarryInvariant::invariant_carryMatchesGhost` |
| CM-4 fresh identity sheds carry, restarts record | `FeesAndRegistry::test_carryIsPerOperator_freshIdentityGetsNoOffset` |
| CM-5 attestation gate (factory-only, canonical) | `FeesAndRegistry::test_factoryAttestsAndAutoRegistersOperator`, `::test_unattestedVaultCannotRecordOrBeFeeAssessed`, `::test_onlyFactoryAttests` |
| SF-4/SF-5 monotone leaderboard, history retained | `FeesAndRegistry::test_statsAreMonotone_closedVaultHistoryRetained`, `FeeCarryInvariant::invariant_lifetimeMonotone`, `FeesAndRegistry::test_operatorClaimsFees` |
| G3/CM-5 carry farming | **Accepted residual** — economic deterrent, no test |
| G5 fee/carry non-atomicity | covered indirectly by `invariant_carryMatchesGhost`; divergence unreachable at current gas params (S6 review) |

## Governance / voting (VO / CM-6/7/8)

| Row / mechanic | Tests |
| --- | --- |
| Lifecycle propose→commit→reveal→finalize→timelock→execute | `Governance::test_fullLifecycle_passAndExecute` |
| VO-2/K-3 quorum floor; defaults tally-only | `Governance::test_quorumFloorDefeats`, `::test_defaultCountsInTallyNeverQuorum` |
| VO-3 default 72h TTL | `Governance::test_defaultExpiresAfter72h` |
| VO-4 defaults structurally Rebalance-only | `Governance::test_defaultOnlyForRebalanceType` |
| G4 default must predate proposal (`setAt < createdAt`) | verified in accepted-rows review (Area 2) — no dedicated regression test |
| VO-5/G1 delegation + concentration cap on received weight only | `Governance::test_delegationCranksOntoDelegateDirection`, `::test_concentrationCapBlocksExcessDelegation`, `::test_ownWeightIsNeverConcentrationCapped`, `::test_selfVoteBeatsDelegation` |
| VO-6 unrevealed commits forfeit | `Governance::test_unrevealedCommitIsForfeit` |
| VO-9 flash-stake zero weight (snapshot at createdAt−1) | `Governance::test_postCreationDepositHasZeroWeight`, `GovernanceInvariant::invariant_revealedNeverExceedsSnapshot` |
| CM-6 proposal threshold + serialization + cooldown | `Governance::test_proposalThresholdEnforced`, `::test_oneActiveProposalPerVault`, `GovernanceInvariant::invariant_atMostOneLiveProposal` |
| CM-7 <5-member signer regime, fixed at creation | `Governance::test_signerRegimeUnder5Members` |
| CM-8/K-2 RuleChange full consensus | `Governance::test_ruleChangeRequiresFullConsensus`, `::test_ruleChangeFullConsensusPassesAndApplies` |
| VO-8 timelock hard cap | `Governance::test_timelockHardCapEnforced` |
| Tally/round bookkeeping | `GovernanceInvariant::invariant_roundAccountingConsistent` |
| GA-2/VO-7 mid-reveal tally visibility | **Accepted residual** — commit-binding is the defense, no test |

## Oracle (SF-1/2, E2/E6)

| Row / mechanic | Tests |
| --- | --- |
| SF-1 median of ≥3, robustness to outliers | `Execution::test_medianOfThree`, `::test_manipulatedOutlierAbsorbedByMedian`, `OracleFuzz::testFuzz_lowerMedianOfFive`, `::testFuzz_medianWithinRange`, `::testFuzz_minorityOutliersCannotMoveMedian` |
| E6 fix: ≥3 sources + strict-majority quorum enforced | `Sprint6Fixes::test_finding6_minSourcesAndMajorityQuorum` |
| One dead source ≠ breaker; below quorum = breaker | `Execution::test_oneDeadSourceStillQuorum`, `::test_belowQuorumTripsBreaker`, `OracleFuzz::testFuzz_belowQuorumTripsBreaker` |
| E2 fix: staleness ceiling + saturating subtraction | `Sprint6Fixes::test_finding2_maxStalenessCeiling`, `::test_finding2_saturatingNoUnderflowPanic` |
| K-4/SF-2 breaker freezes deposits AND exits | `VaultCore::test_staleOracleFreezesDepositsAndExits_whenBasketHeld` |
| SF-2 softening: pending capital never trapped | `VaultCore::test_pendingDepositCancellableDuringOracleFreeze` |
| Chainlink adapter WAD normalization | `Execution::test_chainlinkAdapterNormalizes8Decimals` |

## Execution / adapters (EX-1..3, E3)

| Row / mechanic | Tests |
| --- | --- |
| EX-1 selector allowlist; adapter allowlist; governance-only | `Execution::test_adapterRejectsUnknownSelector`, `::test_rebalanceRejectsUnlistedAdapter`, `::test_rebalanceOnlyThroughGovernance`, `SubVaults::test_childFlowsAreGovernanceOnly` |
| EX-3 measured-delta minOut, never router's word | `Execution::test_adapterEnforcesMinOutOnMeasuredDelta`, `::test_adapterRequiresMinOut`, `::test_rebalanceRejectsRogueOutputToken`, `DirectPoolAdapter::test_directAdapterEnforcesMinOutOnMeasuredDelta` |
| Deadline enforcement | `Execution::test_adapterEnforcesDeadline` |
| C-2 venue abstraction (2 structurally different adapters) | `DirectPoolAdapter::test_governedRebalanceThroughDirectPoolAdapter`, `::test_directAdapterRejectsTokenNotInPair` |
| E3 fix: leftover sweep from per-swap delta | fix verified in S6 review; escrow non-absorption covered indirectly by `SystemInvariant::invariant_parentSolvency` / `VaultCoreInvariant::invariant_solvency` — no dedicated regression test |
| End-to-end governed rebalance + Mode-F settle | `Execution::test_e2e_governedRebalance_modeFExitSettlesAtPostNav` |

## Sub-vaults (SV-1..7, E1/E4/E5/E8, GA-1)

| Row / mechanic | Tests |
| --- | --- |
| SV-2 depth cap 3 | `SubVaults::test_depthCapAtThreeLevels` |
| SV-3 edges creation-only, deposits only along edges | `SubVaults::test_allocationOnlyAlongRegisteredEdges`, `SystemInvariant::invariant_childHasOnlyParent` |
| Child basket ⊆ parent basket | `SubVaults::test_basketMustBeSubsetOfParent` |
| SV-4 fee-stack cap + display views | `SubVaults::test_exitFeeStackCapEnforced`, `::test_stackedFeeViews` |
| SV-6 quorum floor inheritance (registration + RuleChange, G2) | `SubVaults::test_childQuorumFloorInheritsFromParent` |
| SV-7/E1 look-through pricing incl. grandchildren | `SubVaults::test_allocatePreservesParentNav`, `::test_lookThroughTracksChildAssets`, `Sprint6Fixes::test_finding1_grandchildValueInRootNav` |
| SV-5 idle-first exit, shortfall unwind | `SubVaults::test_exitDrawsIdleFirst_childUntouched`, `::test_exitShortfallUnwindsChild`, `::test_governanceRedeemsFromChild` |
| E4 fix: mid-rebalance child skipped when idle covers | `Sprint6Fixes::test_finding4_pendingChildDoesNotBlockWhenIdleCovers` |
| E5 fix: shortfall decremented by measured value | asserted inside `SubVaults::test_exitShortfallUnwindsChild` value accounting; the escrowing-child residual itself is **accepted** (README §7) |
| E8 fix: basket cap + bounded navWad gas | `Sprint6Fixes::test_finding8_basketCapEnforced`, `NavGas::test_navWadGasBoundedAtDepthThree` |
| GA-1 fix: parent excluded from child voting stake | `SubVaults::test_childRuleChangePassesAfterParentAllocates` |

## Deployment / wiring

| Row / mechanic | Tests |
| --- | --- |
| One-shot wiring, locked back-references, valid order | `Deploy::test_deployWiresAndLocks` |

## Known coverage gaps (candidates for the audit, not oversights)

1. **MO-3 settle-time non-recheck** and **G4 lower-bound** have review-verified fixes but no
   dedicated regression tests.
2. **E3 sweep** is covered only indirectly through solvency invariants.
3. Accepted residuals (EE-5/E7 latency arb, G3 carry farming, K-4 induced staleness cost,
   VO-7 tally visibility) are deliberately untested — they are economic/design bounds, not
   code properties.
