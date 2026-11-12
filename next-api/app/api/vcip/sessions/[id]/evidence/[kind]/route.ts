import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebStream } from "node:stream/web";
import { audit, DATA_DIR, EVIDENCE, getSession, json, officialFrom, save, store } from "../../../../../../../lib/vcip";

type Ctx = { params: Promise<{ id: string; kind: string }> };

// Raw body, streamed to disk through SHA-256: constant memory whatever the file size.
export async function PUT(req: Request, { params }: Ctx) {
  const { id, kind } = await params;
  const spec = EVIDENCE[kind];
  const s = spec ? getSession(id) : null;
  if (!s) return json({ error: "not found" }, 404);
  const official = officialFrom(req);
  if (!official || official !== s.officialId) return json({ error: "only the official on this call can upload" }, 403);
  if (s.status !== "IN_CALL") return json({ error: `session is ${s.status}` }, 409);
  const key = `${s.id}/${kind}`;
  // One file per kind: RBI s.18(b)(ii) says pauses must not create multiple video files.
  if (s.evidence[kind] || store.uploading.has(key)) return json({ error: `${kind} already stored` }, 409);
  if (Number(req.headers.get("content-length") ?? 0) > spec.max) return json({ error: `${kind} is larger than ${spec.max} bytes` }, 413);
  if (!req.body) return json({ error: "empty body" }, 400);

  store.uploading.add(key);
  const file = join(DATA_DIR, s.id, `${kind}.${spec.ext}`);
  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > spec.max) return cb(new Error("too large"));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(req.body as unknown as WebStream), meter, createWriteStream(file));
  } catch {
    rmSync(file, { force: true });
    return json({ error: `upload failed or ${kind} is larger than ${spec.max} bytes` }, 413);
  } finally {
    store.uploading.delete(key);
  }
  if (bytes === 0) {
    rmSync(file, { force: true });
    return json({ error: "empty body" }, 400);
  }
  s.evidence[kind] = { sha256: hash.digest("hex"), bytes, at: new Date().toISOString() };
  save(s);
  audit("EVIDENCE_STORED", s.id, official, { kind, ...s.evidence[kind] });
  return json(s.evidence[kind], 201);
}

// Any official (the concurrent auditor) can stream evidence back.
export async function GET(req: Request, { params }: Ctx) {
  const { id, kind } = await params;
  const spec = EVIDENCE[kind];
  const s = spec ? getSession(id) : null;
  if (!s || !s.evidence[kind]) return json({ error: "not found" }, 404);
  const official = officialFrom(req);
  if (!official) return json({ error: "official token required" }, 401);
  const file = join(DATA_DIR, s.id, `${kind}.${spec.ext}`);
  audit("EVIDENCE_VIEWED", s.id, official, { kind });
  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
    headers: { "content-type": spec.type, "content-length": String(statSync(file).size), "cache-control": "no-store" },
  });
}
