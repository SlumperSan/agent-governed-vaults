/* ===========================================================================
   apps/app makes no chain calls.

   WHY THIS FILE STILL EXISTS. The page ships script-src 'self' with no
   'unsafe-inline', so index.html cannot carry an inline <script>; any
   behaviour this page has must live in this external file, which is why it
   stays even though it currently does nothing.

   WHY IT DOES NOTHING. This page's whole purpose was reading a deployed
   protocol's state live from chain in the reader's own browser. The
   page reads no deployment record. The protocol is deployed on Arc
   mainnet (contracts/config/deployments/arc-mainnet.json), but this retired page has not been
   pointed at it. The chain this file
   used to call is abandoned and its addresses are not live contracts any
   more; the two vaults that existed there were fully exited on 2026-09-18
   and hold nothing.

   This file will not invent an address to keep a live-reads panel looking
   alive. If live reads belong here again, they read the Arc deployment
   record, not an address copied into this file.
   =========================================================================== */
