# Licence history

This file records which licence has applied to this repository and when. It exists so that anyone
holding an older copy can tell which terms they received it under, and so that the change below is
a matter of record rather than of inference from a diff.

## Business Source License 1.1 (until 2026-09-05)

From the first commit until 2026-09-05 the repository was licensed under the Business Source
License 1.1, with these parameters:

| Parameter | Value |
| --- | --- |
| Licensor | Michael Huynh |
| Additional Use Grant | None |
| Change Date | 2030-09-02 |
| Change License | GPL-2.0-or-later |

BUSL-1.1 is source-available and is not an open source licence. Every copy distributed before
2026-09-05 was distributed under those terms, and this relicence does not retroactively withdraw
them: a recipient of an older copy keeps the BUSL-1.1 grant they were given, and may also rely on
the MIT grant below, because the copyright holder has granted it for the work as a whole.

## MIT (from 2026-09-05)

On 2026-09-05 the owner decided to relicense the repository under the MIT licence, with copyright
held by SlumperSan. The full text is in [LICENSE](LICENSE).

The owner holds the copyright in the original work in this repository, and a copyright holder may
release their own work under further terms at any time. No third party's permission was required
for this change, and none was sought.

## What did not change

Three vendored paths were never covered by BUSL-1.1 and are not covered by MIT either. They are
redistributed under their own terms, each declared by the SPDX header on the file itself:

  - `contracts/lib/forge-std/` (Apache-2.0 OR MIT)
  - `contracts/test/retired/vendor/FullMath.sol` (MIT)
  - `contracts/test/retired/vendor/TickMath.sol` (GPL-2.0-or-later)

The SPDX headers on the repository's own Solidity sources were changed from `BUSL-1.1` to `MIT` in
the same commit as this file. That change is to the repository, not to any deployed contract: the
bytecode on chain 4663 was compiled from commit `b1cde122`, whose sources carry the BUSL-1.1
header, and nothing in this repository can alter bytes already on a chain. Source verification of
those deployed contracts is performed against `b1cde122`, not against the current tree.
