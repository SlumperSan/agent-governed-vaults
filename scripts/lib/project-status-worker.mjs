// @ts-check
/**
 * Runs `collect()` off the dashboard's main thread.
 *
 * `collect` shells out to git and gh with `spawnSync`, and a full collection takes several seconds
 * (6-7 s measured on 2026-09-23). Run on the server's own thread, polled every second by the board
 * page, it froze the event loop almost continuously. Every other request, including the Sign
 * queue's live chain reads, then waited behind it until its 8 s RPC timeout fired, and the owner
 * saw "could not read the live nonce … aborted due to timeout" against an RPC that answers in
 * about 100 ms. In a worker, the same synchronous calls block only this thread.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { collect } from './project-status.mjs';

// JSON round-trip: the snapshot crosses a thread boundary by structured clone, and it is served as
// JSON anyway, so anything that would not survive JSON must not survive here either.
parentPort?.postMessage(JSON.parse(JSON.stringify(collect({ gh: Boolean(workerData?.gh) }))));
