# 402cap API/MCP

Read-only FastAPI + MCP server over `../x402_index.db`. No payment gating yet.

## Files
- `db.py` — read-only connection (`mode=ro` URI) + `LATEST_CATALOG_CTE`, the fix for the
  `is_complete` bug (backlog #11): `v_latest_catalog`/`v_builder_codes` in the .db file
  itself don't filter partial snapshots. We never ALTER the stored views (no write lock,
  ever) — every "current state" query here uses the corrected CTE instead.
- `queries.py` — all query logic, shared by both wrappers so the fix lives in one place.
- `main.py` — FastAPI app (`GET /health`, `/resources`, `/resources/{url}`,
  `/resources/{url}/history`, `/changes`, `/mismatches`, `/builder-codes`).
- `mcp_server.py` — same 7 operations as MCP tools (stdio or `--http`).

## Run headless (no window, ever)

```powershell
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "<path>\pythonw.exe"
$psi.Arguments = "-u -m uvicorn main:app --host 127.0.0.1 --port 8420"
$psi.WorkingDirectory = "C:\Users\Micha\Desktop\x402\api"
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true
[System.Diagnostics.Process]::Start($psi)
```

MCP server: `pythonw.exe mcp_server.py` (stdio) or `pythonw.exe mcp_server.py --http --port 8421`.

## Not done yet
- x402 payment gating (Michael's pricing decision pending). Routes are plain GETs so a
  paywall can wrap them later without a rewrite.
- Pydantic response models (currently plain dicts from `sqlite3.Row` — fine for now,
  would want typed schemas before a public API contract).
- MCP server verified via direct `list_tools()`/`call_tool()`, not over a live stdio/http
  transport end-to-end (no MCP client available in this environment to drive one).
