import { resolveMx } from "node:dns/promises";

// ponytail: tiny built-in lists; swap for the kickmail list (github.com/noticeable-app/kickmail) when it matters.
const DISPOSABLE = new Set(["mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com", "yopmail.com", "trashmail.com"]);
const FREE = new Set(["gmail.com", "yahoo.com", "yahoo.in", "outlook.com", "hotmail.com", "rediffmail.com", "icloud.com"]);
const SYNTAX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!SYNTAX.test(email) || email.length > 254) {
    return Response.json({ error: "valid email is required" }, { status: 400 });
  }
  const domain = email.split("@")[1];
  // No mailbox-exists (SMTP) test: port 25 is usually blocked.
  const hasMx = await resolveMx(domain).then((r) => r.length > 0).catch(() => false);

  let employerMatch: boolean | null = null;
  if (typeof body?.employer === "string" && body.employer.trim()) {
    const emp = body.employer.toLowerCase().replace(/[^a-z0-9]/g, "");
    const label = domain.split(".")[0];
    employerMatch = label.length >= 3 && (emp.includes(label) || label.includes(emp));
  }

  return Response.json({
    email,
    domain,
    hasMx,
    disposable: DISPOSABLE.has(domain),
    freeProvider: FREE.has(domain),
    employerMatch,
  });
}
