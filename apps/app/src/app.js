/* ===========================================================================
   apps/app makes no chain calls.

   WHY THIS FILE STILL EXISTS. The page ships script-src 'self' with no
   'unsafe-inline', so index.html cannot carry an inline <script>; any
   behaviour this page has must live in this external file, which is why it
   stays even though it currently does nothing.

   WHY IT DOES NOTHING. This page's whole purpose was reading a deployed
   protocol's state live from chain in the reader's own browser. The
   protocol is not deployed on Arc, or on any mainnet: there is no
   VaultFactory address, no oracle address, no vault. The chain this file
   used to call is abandoned and its addresses are not live contracts any
   more; the two vaults that existed there were fully exited on 2026-09-18
   and hold nothing.

   There is no Arc address for this protocol to read, and this file will not
   invent one to keep a live-reads panel looking alive. When the protocol
   deploys to Arc, the live reads belong here again, reading the deployment
   record that will exist at that point, not before.
   =========================================================================== */
