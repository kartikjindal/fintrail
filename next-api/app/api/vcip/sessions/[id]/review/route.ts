import { CHECKLIST } from "../../../../../../lib/vcip-shared";
import { audit, getSession, json, officialFrom, save, view } from "../../../../../../lib/vcip";

// Step 1: the official on the call decides. Step 2: a different official does the concurrent audit
// (RBI s.18(b)(xii): the account is operational only after it).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const s = getSession((await params).id);
  if (!s) return json({ error: "session not found" }, 404);
  const official = officialFrom(req);
  if (!official) return json({ error: "official token required" }, 401);
  const b = await req.json().catch(() => null);
  const decision = b?.decision;
  const remarks = typeof b?.remarks === "string" ? b.remarks.slice(0, 2000) : "";
  const at = new Date().toISOString();

  if (s.status === "IN_CALL") {
    if (official !== s.officialId) return json({ error: "only the official on this call can decide" }, 403);
    if (!["APPROVE", "REJECT", "DROPPED"].includes(decision)) return json({ error: "decision must be APPROVE, REJECT or DROPPED" }, 400);
    const checklist = Object.fromEntries(CHECKLIST.map(([k]) => [k, b.checklist?.[k] === true]));
    const ePan = b.ePan === true;
    if (decision === "APPROVE") {
      const missing = CHECKLIST.map(([k]) => k).filter((k) => !checklist[k]);
      const needEvidence = ["recording", "photo", ...(ePan ? [] : ["pan"])].filter((k) => !s.evidence[k]);
      if (missing.length || needEvidence.length) return json({ error: "cannot approve yet", missing, needEvidence }, 422);
    }
    s.status = decision === "APPROVE" ? "PENDING_AUDIT" : decision === "REJECT" ? "REJECTED" : "DROPPED";
    s.review = { officialId: official, decision, checklist, ePan, remarks, at };
    audit("OFFICIAL_DECISION", s.id, official, s.review);
  } else if (s.status === "PENDING_AUDIT") {
    if (official === s.officialId) return json({ error: "the concurrent audit must be done by a different official" }, 403);
    if (decision !== "APPROVE" && decision !== "REJECT") return json({ error: "decision must be APPROVE or REJECT" }, 400);
    s.status = decision === "APPROVE" ? "APPROVED" : "REJECTED";
    s.audit = { auditorId: official, decision, remarks, at };
    audit("CONCURRENT_AUDIT", s.id, official, s.audit);
  } else {
    return json({ error: `session is ${s.status}` }, 409);
  }
  save(s);
  return json(view(s));
}
