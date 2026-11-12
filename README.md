# Fintrail — DhanBoost in-house check APIs

The "Build in-house" checks from the DhanBoost vendor API research, as one basic API in two stacks.
Both expose the same endpoints.

| Endpoint | Body | Returns |
|---|---|---|
| `GET /api/health` | — | `{status}` |
| `POST /api/pan` | `{"pan":"ABCDE1234F"}` | format check only (`AAAAA9999A`) |
| `POST /api/email` | `{"email":"a@b.com","employer":"B Ltd"}` | MX lookup, disposable / free domain, employer match |
| `POST /api/address` | `{"lat":28.63,"lng":77.22,"pincode":"110001"}` | nearest pincode, distance, match |

## Run

```bash
# Next.js  -> http://localhost:3000
cd next-api && npm install && npm run dev

# Spring Boot (Java 21) -> http://localhost:8080
cd springboot-api && mvn spring-boot:run
mvn test   # runs the PAN + address checks
```

## Video KYC (V-CIP)

Live video KYC between the customer and a trained official, built to RBI KYC Master Direction s.18.

- Customer: `http://localhost:3000/vcip`
- Official / auditor desk: `http://localhost:3000/vcip/official`

```bash
# both stacks read the same settings (Spring: vcip.officials etc., or the env vars below)
export VCIP_OFFICIALS="alice:<16+ char token>,bob:<16+ char token>"   # id:token pairs
export VCIP_INDIA_IP_RANGES=/path/to/dbip-country-lite.csv              # start,end,country; required in production
# optional: VCIP_DATA_DIR (default ./vcip-data), NEXT_PUBLIC_ICE_SERVERS (JSON, add TURN)
# to use the Spring backend from the Next pages: NEXT_PUBLIC_VCIP_API=http://localhost:8080
```

Flow: customer gives consent and live GPS → waits → official joins (WebRTC, peer to peer) → asks the
server-picked random questions → captures photo + PAN → ends call (recording uploads) → approves →
a **different** official does the concurrent audit → `APPROVED`.

API (`/api/vcip`, same in both stacks): `POST /sessions`, `GET /sessions?status=WAITING|PENDING_AUDIT`,
`GET /sessions/{id}`, `POST|GET /sessions/{id}/signal`, `PUT|GET /sessions/{id}/evidence/{recording|photo|pan}`,
`POST /sessions/{id}/review`. Officials send `Authorization: Bearer <token>`; the customer sends `X-Customer-Token`.

### Why the backend is cheap

- Audio/video never touch the server: WebRTC is peer to peer (DTLS-SRTP, end-to-end encrypted).
- Signalling is exactly one offer + one answer (non-trickle ICE). There are no sockets and no media servers.
- Recording, the date-time/GPS overlay and the liveness assist (MediaPipe) run in the official's browser.
- Uploads stream to disk through SHA-256, so memory stays constant for a 500 MB video.
- Sessions sit in an O(1) map, cleaned up lazily on each request with no timers. The IP check is a binary search.
  Every request is a few microseconds of CPU apart from the disk write.

### RBI s.18 checklist

| Requirement | Where |
|---|---|
| (a)(ii) end-to-end encryption, auditable consent | WebRTC DTLS-SRTP; consent version in hash-chained `audit.jsonl` |
| (a)(iii) block IPs outside India / spoofed | `VCIP_INDIA_IP_RANGES` check (403); proxy must set `X-Forwarded-For` |
| (a)(iv) live GPS + date-time stamp on video | GPS required inside India; IST time + GPS burned into the recording |
| (a)(v) liveness / face match | Official + server-random prompts + MediaPipe assist (blink, turns, smile, face count). **High-accuracy face match / passive anti-spoof: still a vendor call (Digitap/Signzy), not built** |
| (b)(ii) no multiple video files; restart after a drop | One recording per session (409 on a 2nd); a dropped call means a new session |
| (b)(iii) varying questions | 4 random from a pool, shown only to the official |
| (b)(vi), (viii) record, photo, PAN image (or e-PAN) | Evidence uploads; approval blocked until present |
| (b)(x) photo/details match | Mandatory checklist |
| (b)(xii) concurrent audit before account goes live | `PENDING_AUDIT` → a different official approves (maker-checker enforced) |
| (c)(ii) activity log + official credentials | `audit.jsonl`, every action with official id, hash-chained |
| Process / deployment, **not code** | Trained officials (b)(i), RE premises / own network (a)(i), data in India (c)(i) (e.g. AWS Mumbai), CERT-In VAPT (a)(vii), retention period, Aadhaar redaction, negative-list checks (b)(v), special-needs fallback (b)(i) |

Confirm with compliance before going live. The live two-browser call was not tested end to end here; the
API flow was (curl on Next, MockMvc on Spring).

Gotchas: camera and GPS need HTTPS (localhost is fine, a phone on your LAN IP is not). Keep the
official's tab in front, because background tabs throttle the recording. Add a TURN server for strict mobile
NATs. In-memory sessions mean one instance per stack; only `PENDING_AUDIT` sessions are reloaded from
disk after a restart. Move sessions to Postgres or Redis before scaling out.

## Notes

- `pincodes.csv` is an 8-row sample. Replace it with the full
  [All India Pincode Directory](https://ndp.ckan.civicdatalab.in/dataset/all-india-pincode-directory)
  (columns `pincode,lat,lng`) for real use.
- Disposable / free email lists are tiny built-ins; swap in
  [kickmail](https://github.com/noticeable-app/kickmail) for production.
- PAN existence and mailbox-exists checks are deliberately not done (need Protean / port 25).
