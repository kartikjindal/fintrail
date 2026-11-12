// V-CIP server side. The backend never touches audio/video: media is peer-to-peer WebRTC,
// signalling is one offer + one answer, uploads are streamed to disk while hashing.
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Status = "WAITING" | "IN_CALL" | "PENDING_AUDIT" | "APPROVED" | "REJECTED" | "DROPPED" | "EXPIRED";
export type Session = {
  id: string;
  customerTokenHash?: string;
  createdAt: number;
  expiresAt: number;
  status: Status;
  geo: { lat: number; lng: number; accuracyM: number };
  ip: string;
  ipCheck: string;
  cameraLabel: string;
  virtualCameraSuspected: boolean;
  questions: string[];
  officialId?: string;
  offer?: string;
  answer?: string;
  evidence: Record<string, { sha256: string; bytes: number; at: string }>;
  review?: object;
  audit?: object;
};

const MB = 1024 * 1024;
export const EVIDENCE: Record<string, { ext: string; type: string; max: number }> = {
  recording: { ext: "webm", type: "video/webm", max: 500 * MB },
  photo: { ext: "jpg", type: "image/jpeg", max: 5 * MB },
  pan: { ext: "jpg", type: "image/jpeg", max: 5 * MB },
};

// RBI s.18(b)(iii): question sequence and type must vary. Picked here, shown only to the official.
const QUESTIONS = [
  "Turn your head slowly to your left",
  "Turn your head slowly to your right",
  "Blink twice",
  "Smile",
  "Look up, then back at the camera",
  "Raise your right hand",
  "Say your date of birth",
  "Say the city you live in",
  "Say your employer's name",
  "Say your monthly take-home salary",
  "Say today's date",
  "Read out the last 4 digits of your mobile number",
];

export const WAIT_MS = 15 * 60_000;
export const CALL_MS = 45 * 60_000;
const KEEP_MS = 24 * 3600_000;
const LIVE: Status[] = ["WAITING", "IN_CALL"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const DATA_DIR = process.env.VCIP_DATA_DIR || join(process.cwd(), "vcip-data");
const AUDIT_FILE = join(DATA_DIR, "audit.jsonl");

export const sha = (s: string) => createHash("sha256").update(s).digest();
export const json = (body: unknown, status = 200) => Response.json(body, { status });

type Store = {
  sessions: Map<string, Session>;
  uploading: Set<string>;
  lastHash: string;
  officials: { id: string; hash: Buffer }[];
  inRanges: [bigint, bigint][] | null;
};
// globalThis so every route bundle (and dev HMR) shares one store.
const g = globalThis as { __vcip?: Store };
export const store: Store = (g.__vcip ??= boot());

function boot(): Store {
  mkdirSync(DATA_DIR, { recursive: true });
  // ponytail: reads the whole audit log once at boot to recover the hash chain; read only the tail if it grows huge.
  const last = existsSync(AUDIT_FILE) ? readFileSync(AUDIT_FILE, "utf8").trim().split("\n").at(-1) : "";
  const sessions = new Map<string, Session>();
  for (const id of readdirSync(DATA_DIR)) {
    const f = join(DATA_DIR, id, "session.json");
    if (!UUID.test(id) || !existsSync(f)) continue;
    const s: Session = JSON.parse(readFileSync(f, "utf8"));
    if (s.status === "PENDING_AUDIT") sessions.set(id, s); // the only state worth resuming after a restart
  }
  const officials = (process.env.VCIP_OFFICIALS ?? "")
    .split(",")
    .map((p) => [p.slice(0, p.indexOf(":")).trim(), p.slice(p.indexOf(":") + 1).trim()])
    .filter(([id, tok]) => {
      if (id && tok.length < 16) console.warn(`[vcip] token for official "${id}" ignored: needs 16+ characters`);
      return id && tok.length >= 16;
    })
    .map(([id, tok]) => ({ id, hash: sha(tok) }));
  return { sessions, uploading: new Set(), lastHash: last ? JSON.parse(last).hash : "0".repeat(64), officials, inRanges: loadRanges() };
}

// RBI s.18(a)(iii): block IPs outside India. Expects a "start,end,country" CSV (e.g. DB-IP IP-to-Country Lite).
function loadRanges(): [bigint, bigint][] | null {
  const f = process.env.VCIP_INDIA_IP_RANGES;
  if (!f) return null;
  const out: [bigint, bigint][] = [];
  for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
    const [a, b, cc] = line.split(",").map((x) => x.trim().replace(/"/g, ""));
    const s = cc === "IN" ? ipToBig(a) : null;
    const e = s === null ? null : ipToBig(b);
    if (s !== null && e !== null) out.push([s, e]);
  }
  return out.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
}

export function ipToBig(raw: string): bigint | null {
  const ip = raw.trim().replace(/^::ffff:(?=\d+\.)/i, "");
  if (ip.includes(".")) {
    const p = ip.split(".");
    if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || +x > 255)) return null;
    return p.reduce((acc, x) => (acc << 8n) + BigInt(x), 0n);
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const parts = [...head, ...Array(fill).fill("0"), ...tail];
  if (parts.length !== 8 || parts.some((x) => !/^[0-9a-f]{1,4}$/i.test(x))) return null;
  return parts.reduce((acc, x) => (acc << 16n) + BigInt(parseInt(x, 16)), 0n);
}

const PRIVATE = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{2}:|fe80:)/i;

export function checkIp(raw: string): "in" | "outside" | "private" | "not_configured" {
  const ip = raw.replace(/^::ffff:(?=\d+\.)/i, "");
  if (PRIVATE.test(ip)) return "private";
  if (!store.inRanges) return "not_configured";
  const n = ipToBig(ip);
  if (n === null) return "outside";
  let lo = 0, hi = store.inRanges.length - 1; // binary search: O(log n) per check
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    const [s, e] = store.inRanges[m];
    if (n < s) hi = m - 1;
    else if (n > e) lo = m + 1;
    else return "in";
  }
  return "outside";
}

// The deployment proxy must overwrite X-Forwarded-For (Vercel, or nginx `$remote_addr`), or it can be spoofed.
export const clientIp = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "";

// ponytail: bounding box (also covers slivers of neighbouring countries); swap for India's boundary polygon if that matters.
export const inIndia = (lat: unknown, lng: unknown) =>
  typeof lat === "number" && typeof lng === "number" && lat >= 6.4 && lat <= 37.6 && lng >= 68 && lng <= 97.5;

export function pickQuestions(n = 4) {
  const a = [...QUESTIONS];
  for (let i = 0; i < n; i++) {
    const j = randomInt(i, a.length);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

export const newToken = () => randomBytes(32).toString("base64url");
export const newId = () => randomUUID();

export function officialFrom(req: Request): string | null {
  const m = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
  if (!m) return null;
  const h = sha(m[1]);
  return store.officials.find((o) => timingSafeEqual(o.hash, h))?.id ?? null;
}

export function isCustomer(req: Request, s: Session) {
  const t = req.headers.get("x-customer-token");
  return !!t && !!s.customerTokenHash && timingSafeEqual(sha(t), Buffer.from(s.customerTokenHash, "hex"));
}

// What officials (and the on-disk snapshot) see: never the token hash or SDP.
export function view(s: Session) {
  const { customerTokenHash, offer, answer, ...rest } = s;
  return rest;
}

export function save(s: Session) {
  mkdirSync(join(DATA_DIR, s.id), { recursive: true });
  writeFileSync(join(DATA_DIR, s.id, "session.json"), JSON.stringify(view(s)));
}

// RBI s.18(a)(ii) + (c)(ii): append-only activity log, hash-chained so any edit breaks the chain.
export function audit(event: string, sessionId: string, actor: string, data: object = {}) {
  const rec = { at: new Date().toISOString(), event, sessionId, actor, data, prev: store.lastHash };
  const hash = sha(JSON.stringify(rec)).toString("hex");
  appendFileSync(AUDIT_FILE, JSON.stringify({ ...rec, hash }) + "\n");
  store.lastHash = hash;
}

function expireIfDue(s: Session) {
  if (LIVE.includes(s.status) && Date.now() > s.expiresAt) {
    s.status = "EXPIRED";
    audit("SESSION_EXPIRED", s.id, "system");
    save(s);
  }
}

export function getSession(id: string): Session | null {
  if (!UUID.test(id)) return null; // also guards the id before it becomes a directory name
  let s = store.sessions.get(id);
  if (!s) {
    const f = join(DATA_DIR, id, "session.json");
    if (!existsSync(f)) return null;
    s = JSON.parse(readFileSync(f, "utf8")) as Session;
    store.sessions.set(id, s);
  }
  expireIfDue(s);
  return s;
}

// Lazy cleanup on create/list instead of timers. ponytail: O(active sessions) scan; fine below ~10k concurrent.
export function sweep() {
  for (const s of store.sessions.values()) {
    expireIfDue(s);
    if (!LIVE.includes(s.status) && s.status !== "PENDING_AUDIT" && Date.now() - s.createdAt > KEEP_MS) store.sessions.delete(s.id);
  }
}
