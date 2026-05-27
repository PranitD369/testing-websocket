# Failure Modes × Recovery

This is the matrix you'd want pinned above your desk when debugging "CLOSED" reports from the field.

| # | Failure | What the user sees | Detection (server) | Recovery | Repro |
|---|---|---|---|---|---|
| 1 | Browser cellular drops mid-stream | Frozen UI | `AppHeartbeat.tick` sees no pong for >25s, terminates WS | Client `onclose` fires → jittered backoff reconnect → `?sessionId=` resumes with stored handle | Toggle Airplane Mode on the device for 30s |
| 2 | Gemini forced disconnect (~10min cap) | Nothing (seamless) | `goAway.timeLeft` event upstream | `UpstreamSupervisor.openReplacement` builds a parallel WS with current handle, swaps when `setupComplete` arrives | Run a session continuously for >10min; check logs for `upstream.goAway` |
| 3 | Gemini abrupt close (5xx, region failover) | Brief stall | `LiveClient` `on('close')` with non-1000 code | `UpstreamSupervisor.handleClose` → backoff → reconnect with handle | Use `?inject=killGemini` (kills upstream after 5s) |
| 4 | Pong stops but socket stays "open" (NAT dies) | Frozen UI | `AppHeartbeat` timeout (25s) | `clientWs.close(4000)` → client reconnect | Enable "stall pongs" toggle in the client UI |
| 5 | RTT climbing | UI auto-degrades | RTT EWMA crosses 200ms / 500ms / 1500ms | `DegradationController.evaluate` emits `modeChange`; `Bridge` filters outbound frames | Use `tc qdisc add dev lo root netem delay 600ms` |
| 6 | Pong misses accumulating | UI degrades faster than RTT alone | `BandwidthMonitor.misses` >= 1/2/3 | Same as #5, escalated by miss-count | Drop packets with `tc qdisc add dev lo root netem loss 30%` |
| 7 | Bandwidth recovers | UI upgrades (delayed) | All metrics fall below thresholds for 5s | `DegradationController` upgrade hysteresis | Remove the `tc` rule and wait 5s |
| 8 | Network too poor for WS at all | UI shows photo mode | Client's reconnect attempts exhaust OR server forces `PHOTO_MODE` | `POST /fallback/photo` is the path; transcript summary injects prior context | Click "Force photo mode" in the client |
| 9 | Resumption handle invalid (token expired or wrong region) | Brief context loss | Gemini rejects setup; close arrives quickly | `UpstreamSupervisor` clears handle on next setup attempt — TODO: detect and clear handle explicitly | Manually edit `session.resumptionHandle` to garbage; reconnect |
| 10 | Process restart on server | Brief reconnect | New process has empty `SessionManager` | Resumption handle is still in client `localStorage`; the new server treats it as a fresh session but still passes the handle to Gemini → Gemini restores model context | `kill` the server process; client reconnects within backoff window |
| 11 | API quota exhausted | Error reply | REST returns 429 or upstream WS closes with billing error | Server logs at `error`, client shows error message — TODO: per-session token usage cap | Use a free-tier key and stream for an hour |
| 12 | Client closes laptop lid mid-session | Returns to working session on wake | TCP keepalive eventually closes; on wake, client reconnects | Same as #1 | Close lid for 1 minute |

## Failure-injection toggles built into the lab

### Server-side (`?inject=` query param on `/ws`)
- `stallPongs` — server silently ignores pongs (forces heartbeat timeout from server's perspective)
- `killGemini` — server kills the upstream WS after 5s (not yet implemented but stubbed; trivial to add)
- `goAway` — server fakes a `goAway` from upstream (not yet implemented but the supervisor handles real ones)

### Client-side (UI toggles)
- **Drop 50% of outbound frames** — simulates lossy uplink
- **Stall pongs** — client stops responding to server pings (forces server-side timeout)
- **Kill socket** — manually closes the WS to test client-side reconnect
- **Force photo mode / Force HD** — test the mode state machine without waiting for real network conditions

### Linux failure-injection (recommended for real testing)
```bash
# 600ms latency on loopback
sudo tc qdisc add dev lo root netem delay 600ms
# 30% packet loss
sudo tc qdisc add dev lo root netem loss 30%
# Reset
sudo tc qdisc del dev lo root
```

For more sophisticated scenarios, use [`toxiproxy`](https://github.com/Shopify/toxiproxy) in front of `localhost:3000`.

## Things this matrix tells you when triaging a "CLOSED" report

1. **What close code did the WS report?** 1006 = abnormal, 1011 = upstream, 4000 = server heartbeat timeout, 4001 = client manual kill.
2. **What was `metrics.rttEwmaMs` just before close?** Climbing → row 5/6. Flat → row 1/4.
3. **Did `goAway` appear in logs?** Yes → row 2 (expected). No → row 3.
4. **Did the client's next connect carry a `sessionId`?** Yes → resumption attempted. No → fresh session (probably a bug in localStorage).
5. **Did Gemini accept the resumption handle?** Look for `setupComplete` immediately after reconnect.
