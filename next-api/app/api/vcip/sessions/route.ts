import { CONSENT_VERSION } from "../../../../lib/vcip-shared";
import {
  audit, checkIp, clientIp, inIndia, json, newId, newToken, officialFrom, pickQuestions,
  save, Session, sha, store, sweep, view, WAIT_MS,
} from "../../../../lib/vcip";

// Customer starts a session: consent + live GPS (RBI s.18(a)(ii), (a)(iv)).
export async function POST(req: Request) {
  const b = await req.json().catch(() => null);
  if (b?.consent !== true || b?.consentVersion !== CONSENT_VERSION) return json({ error: "consent to the current V-CIP terms is required" }, 400);
  if (!inIndia(b.lat, b.lng) || typeof b.accuracyM !== "number" || b.accuracyM < 0) {
    return json({ error: "a live GPS location inside India is required" }, 400);
  }
  const ip = clientIp(req);
  const ipCheck = checkIp(ip);
  if (ipCheck === "outside") return json({ error: "video KYC is only available from within India" }, 403);

  sweep();
  const cameraLabel = typeof b.cameraLabel === "string" ? b.cameraLabel.slice(0, 200) : "";
  const token = newToken();
  const now = Date.now();
  const s: Session = {
    id: newId(),
    customerTokenHash: sha(token).toString("hex"),
    createdAt: now,
    expiresAt: now + WAIT_MS,
    status: "WAITING",
    geo: { lat: b.lat, lng: b.lng, accuracyM: b.accuracyM },
    ip,
    ipCheck,
    cameraLabel,
    // Weak signal only: virtual cameras (deepfake injection) often expose their name.
    virtualCameraSuspected: /obs|manycam|virtual|snap camera|droidcam|xsplit/i.test(cameraLabel),
    questions: pickQuestions(),
    evidence: {},
  };
  store.sessions.set(s.id, s);
  save(s);
  audit("SESSION_CREATED", s.id, "customer", {
    consentVersion: CONSENT_VERSION, geo: s.geo, ip, ipCheck, cameraLabel, userAgent: req.headers.get("user-agent") ?? "",
  });
  return json({ id: s.id, customerToken: token, expiresAt: s.expiresAt }, 201);
}

// Official queue: ?status=WAITING (default) or PENDING_AUDIT.
export async function GET(req: Request) {
  if (!officialFrom(req)) return json({ error: "official token required" }, 401);
  const status = new URL(req.url).searchParams.get("status") ?? "WAITING";
  if (status !== "WAITING" && status !== "PENDING_AUDIT") return json({ error: "status must be WAITING or PENDING_AUDIT" }, 400);
  sweep();
  const list = [...store.sessions.values()].filter((s) => s.status === status && (status !== "WAITING" || s.offer));
  return json(list.sort((a, b) => a.createdAt - b.createdAt).map(view));
}
