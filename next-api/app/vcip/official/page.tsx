"use client";
import { useEffect, useRef, useState } from "react";
import { API, errorText, gatheredSdp, ICE } from "../../../lib/rtc";
import { CHECKLIST } from "../../../lib/vcip-shared";

type Sess = {
  id: string;
  createdAt: number;
  status: string;
  geo: { lat: number; lng: number; accuracyM: number };
  ip: string;
  ipCheck: string;
  cameraLabel: string;
  virtualCameraSuspected: boolean;
  questions: string[];
  officialId?: string;
  evidence: Record<string, { sha256: string; bytes: number }>;
  review?: { checklist: Record<string, boolean>; remarks: string; ePan: boolean };
};
type Recording = { stop: () => Promise<Blob> };

const MEDIAPIPE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm";
const FACE_MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const box = { border: "1px solid #ccc", borderRadius: 8, padding: 12, marginBottom: 12 } as const;
const vid = { width: "100%", maxWidth: 640, background: "#000", borderRadius: 8 } as const;

// RBI s.18(a)(iv): one recording with live GPS + date-time stamp burned in. Runs in the official's browser.
function startRecording(video: HTMLVideoElement, remote: MediaStream, mine: MediaStream, s: Sess): Recording {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const gps = `GPS ${s.geo.lat.toFixed(5)}, ${s.geo.lng.toFixed(5)} ±${Math.round(s.geo.accuracyM)} m`;
  const draw = setInterval(() => {
    if (!video.videoWidth) return;
    if (canvas.width !== video.videoWidth) [canvas.width, canvas.height] = [video.videoWidth, video.videoHeight];
    const h = canvas.height, fs = Math.max(14, Math.round(h / 32));
    ctx.drawImage(video, 0, 0);
    ctx.fillStyle = "rgba(0,0,0,.6)";
    ctx.fillRect(0, h - fs * 3, canvas.width, fs * 3);
    ctx.fillStyle = "#fff";
    ctx.font = `${fs}px monospace`;
    ctx.fillText(`${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST`, fs, h - fs * 1.7);
    ctx.fillText(`${gps} · session ${s.id.slice(0, 8)}`, fs, h - fs * 0.5);
  }, 100);
  const audio = new AudioContext();
  const mix = audio.createMediaStreamDestination();
  for (const m of [remote, mine]) if (m.getAudioTracks().length) audio.createMediaStreamSource(m).connect(mix);
  const recorder = new MediaRecorder(new MediaStream([...canvas.captureStream(10).getVideoTracks(), ...mix.stream.getAudioTracks()]), {
    mimeType: "video/webm",
  });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.start(1000);
  return {
    stop: () =>
      new Promise<Blob>((done) => {
        recorder.onstop = () => {
          clearInterval(draw);
          audio.close();
          done(new Blob(chunks, { type: "video/webm" }));
        };
        recorder.stop();
      }),
  };
}

function snapshot(video: HTMLVideoElement) {
  const c = document.createElement("canvas");
  [c.width, c.height] = [video.videoWidth, video.videoHeight];
  c.getContext("2d")!.drawImage(video, 0, 0);
  return new Promise<Blob>((done) => c.toBlob((b) => done(b!), "image/jpeg", 0.92));
}

export default function OfficialVcip() {
  const [token, setToken] = useState("");
  const [queue, setQueue] = useState<Sess[]>([]);
  const [audits, setAudits] = useState<Sess[]>([]);
  const [s, setS] = useState<Sess | null>(null);
  const [msg, setMsg] = useState("");
  const [uploaded, setUploaded] = useState<Record<string, boolean>>({});
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [ePan, setEPan] = useState(false);
  const [remarks, setRemarks] = useState("");
  const [live, setLive] = useState({ faces: 0, yaw: 0, blink: false, smile: false });
  const [seen, setSeen] = useState({ left: false, right: false, blink: false, smile: false });
  const [aadhaarUrl, setAadhaarUrl] = useState("");
  const [hidden, setHidden] = useState(false);
  const [inCall, setInCall] = useState(false);
  const [preview, setPreview] = useState<Record<string, string>>({});
  const remote = useRef<HTMLVideoElement>(null);
  const self = useRef<HTMLVideoElement>(null);
  const rec = useRef<Recording | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const mineRef = useRef<MediaStream | null>(null);

  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${API}/api/vcip${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });

  // Queues refresh every 5 s while not on a call.
  useEffect(() => {
    if (!token || s) return;
    const load = async () => {
      const [q, a] = await Promise.all([call("/sessions?status=WAITING"), call("/sessions?status=PENDING_AUDIT")]);
      if (!q.ok) return setMsg(await errorText(q));
      setMsg("");
      setQueue(await q.json());
      if (a.ok) setAudits(await a.json());
    };
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [token, s]); // eslint-disable-line react-hooks/exhaustive-deps

  // Canvas recording is throttled in background tabs, so warn.
  useEffect(() => {
    const f = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", f);
    return () => document.removeEventListener("visibilitychange", f);
  }, []);

  // Liveness assist (RBI s.18(a)(v)): MediaPipe on the customer's stream, in this (trusted) browser.
  // The official still decides; this only shows what the camera saw.
  useEffect(() => {
    if (!inCall) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    let close = () => {};
    (async () => {
      const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
      const fl = await FaceLandmarker.createFromOptions(await FilesetResolver.forVisionTasks(MEDIAPIPE), {
        baseOptions: { modelAssetPath: FACE_MODEL, delegate: "GPU" },
        runningMode: "VIDEO",
        numFaces: 2,
        outputFaceBlendshapes: true,
      });
      close = () => fl.close();
      const tick = () => {
        if (stop) return;
        const v = remote.current;
        if (v && v.readyState >= 2) {
          const r = fl.detectForVideo(v, performance.now());
          const b = Object.fromEntries((r.faceBlendshapes[0]?.categories ?? []).map((c) => [c.categoryName, c.score]));
          const lm = r.faceLandmarks[0];
          // Nose tip (1) between the outer eye corners (33, 263): > 0 = turned to the customer's left.
          const yaw = lm ? ((lm[1].x - lm[33].x) / (lm[263].x - lm[33].x)) * 2 - 1 : 0;
          const blink = (b.eyeBlinkLeft ?? 0) > 0.5 && (b.eyeBlinkRight ?? 0) > 0.5;
          const smile = ((b.mouthSmileLeft ?? 0) + (b.mouthSmileRight ?? 0)) / 2 > 0.5;
          setLive({ faces: r.faceLandmarks.length, yaw, blink, smile });
          setSeen((p) => ({ left: p.left || yaw > 0.35, right: p.right || yaw < -0.35, blink: p.blink || blink, smile: p.smile || smile }));
        }
        timer = setTimeout(tick, 200);
      };
      tick();
    })().catch((e) => setMsg(`Liveness assist unavailable: ${e}`));
    return () => {
      stop = true;
      clearTimeout(timer);
      close();
    };
  }, [inCall]);

  async function join(id: string) {
    try {
      const [sr, or] = await Promise.all([call(`/sessions/${id}`), call(`/sessions/${id}/signal`)]);
      if (!sr.ok || or.status !== 200) throw new Error("Session is not ready (the customer may have left).");
      const session: Sess = await sr.json();
      const { sdp } = await or.json();
      const mine = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      mineRef.current = mine;
      self.current!.srcObject = mine;
      const pc = new RTCPeerConnection({ iceServers: ICE });
      pcRef.current = pc;
      mine.getTracks().forEach((t) => pc.addTrack(t, mine));
      let remoteStream: MediaStream | null = null;
      pc.ontrack = (e) => (remote.current!.srcObject = remoteStream = e.streams[0]);
      pc.onconnectionstatechange = () => {
        // Start once connected, when all of the customer's tracks are present. Never restarted: one file per session.
        if (pc.connectionState === "connected" && !rec.current && remoteStream) rec.current = startRecording(remote.current!, remoteStream, mine, session);
        if (pc.connectionState === "failed") setMsg("Call dropped. End the call (uploads what was recorded) and mark it DROPPED.");
      };
      await pc.setRemoteDescription({ type: "offer", sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      const ar = await call(`/sessions/${id}/signal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sdp: await gatheredSdp(pc) }),
      });
      if (!ar.ok) throw new Error(await errorText(ar));
      setS(session);
      setInCall(true);
      setUploaded({});
      setChecks({});
      setEPan(false);
      setRemarks("");
      setSeen({ left: false, right: false, blink: false, smile: false });
      setMsg("");
    } catch (e) {
      hangUp();
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }

  async function upload(kind: string, blob: Blob) {
    const r = await call(`/sessions/${s!.id}/evidence/${kind}`, { method: "PUT", headers: { "Content-Type": blob.type }, body: blob });
    if (r.ok) setUploaded((u) => ({ ...u, [kind]: true }));
    else setMsg(`${kind}: ${await errorText(r)}`);
  }

  function hangUp() {
    pcRef.current?.close();
    mineRef.current?.getTracks().forEach((t) => t.stop());
    pcRef.current = null;
    setInCall(false);
  }

  async function endCall() {
    const r = rec.current;
    rec.current = null;
    hangUp();
    if (r) await upload("recording", await r.stop());
  }

  async function decide(decision: "APPROVE" | "REJECT" | "DROPPED") {
    if (inCall) await endCall();
    const r = await call(`/sessions/${s!.id}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, checklist: checks, ePan, remarks }),
    });
    if (!r.ok) return setMsg(await errorText(r));
    setMsg(`Session ${s!.id.slice(0, 8)} is now ${(await r.json()).status}.`);
    setS(null);
  }

  async function auditDecide(id: string, decision: "APPROVE" | "REJECT", note: string) {
    const r = await call(`/sessions/${id}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision, remarks: note }) });
    setMsg(r.ok ? `Audit saved: ${(await r.json()).status}` : await errorText(r));
    setAudits((a) => a.filter((x) => x.id !== id || !r.ok));
  }

  async function view(id: string, kind: string) {
    const r = await call(`/sessions/${id}/evidence/${kind}`);
    if (!r.ok) return setMsg(await errorText(r));
    const url = URL.createObjectURL(await r.blob());
    setPreview((p) => ({ ...p, [`${id}/${kind}`]: url }));
  }

  const flag = (x: Sess) =>
    [x.ipCheck !== "in" && `IP check: ${x.ipCheck}`, x.virtualCameraSuspected && `virtual camera? "${x.cameraLabel}"`].filter(Boolean).join(" · ");

  return (
    <main>
      <h1>V-CIP officer desk</h1>
      <p>
        <label>
          Officer token{" "}
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" style={{ width: 280 }} />
        </label>
      </p>
      {msg && <p role="alert" style={{ color: "#b00" }}>{msg}</p>}
      {hidden && inCall && <p role="alert" style={{ color: "#b00" }}>Keep this tab in front: the recording slows down in a background tab.</p>}

      <section style={{ ...box, display: s ? "block" : "none" }}>
        <h2>Call {s?.id.slice(0, 8)}</h2>
        <p>
          GPS {s?.geo.lat.toFixed(5)}, {s?.geo.lng.toFixed(5)} (±{Math.round(s?.geo.accuracyM ?? 0)} m) · IP {s?.ip || "?"} ({s?.ipCheck})
          {s && flag(s) && <b style={{ color: "#b00" }}> · {flag(s)}</b>}
        </p>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <video ref={remote} autoPlay playsInline style={vid} aria-label="Customer" />
          <div>
            <video ref={self} autoPlay playsInline muted style={{ ...vid, maxWidth: 200 }} aria-label="You" />
            <p>
              <label>
                Aadhaar / OVD photo (from DigiLocker){" "}
                <input type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && setAadhaarUrl(URL.createObjectURL(e.target.files[0]))} />
              </label>
            </p>
            {aadhaarUrl && <img src={aadhaarUrl} alt="Aadhaar photo for comparison" style={{ maxWidth: 200, borderRadius: 8 }} />}
          </div>
        </div>

        <h3>Ask in this order</h3>
        <ol>{s?.questions.map((q) => <li key={q}>{q}</li>)}</ol>
        <p>
          Camera saw: faces {live.faces} {live.faces > 1 && <b style={{ color: "#b00" }}>(more than one person!)</b>} · turn left {seen.left ? "✓" : "–"} · turn
          right {seen.right ? "✓" : "–"} · blink {seen.blink ? "✓" : "–"} · smile {seen.smile ? "✓" : "–"}
        </p>

        <p style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button disabled={!inCall || uploaded.photo} onClick={async () => upload("photo", await snapshot(remote.current!))}>
            Capture photo {uploaded.photo && "✓"}
          </button>
          <button disabled={!inCall || uploaded.pan || ePan} onClick={async () => upload("pan", await snapshot(remote.current!))}>
            Capture PAN card {uploaded.pan && "✓"}
          </button>
          <label>
            <input type="checkbox" checked={ePan} onChange={(e) => setEPan(e.target.checked)} /> Customer gave e-PAN instead
          </label>
          <button disabled={!inCall} onClick={endCall}>End call {uploaded.recording && "✓ recording saved"}</button>
        </p>

        <fieldset>
          <legend>Checklist (all required to approve)</legend>
          {CHECKLIST.map(([k, label]) => (
            <label key={k} style={{ display: "block" }}>
              <input type="checkbox" checked={!!checks[k]} onChange={(e) => setChecks((c) => ({ ...c, [k]: e.target.checked }))} /> {label}
            </label>
          ))}
        </fieldset>
        <p>
          <textarea placeholder="Remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={2} style={{ width: "100%" }} />
        </p>
        <p style={{ display: "flex", gap: 8 }}>
          <button onClick={() => decide("APPROVE")}>Approve (sends to audit)</button>
          <button onClick={() => decide("REJECT")}>Reject</button>
          <button onClick={() => decide("DROPPED")}>Call dropped</button>
        </p>
      </section>

      {!s && (
        <>
          <section style={box}>
            <h2>Waiting customers ({queue.length})</h2>
            {queue.map((x) => (
              <p key={x.id}>
                <button onClick={() => join(x.id)}>Join</button> {x.id.slice(0, 8)} · waiting since {new Date(x.createdAt).toLocaleTimeString("en-IN")}
                {flag(x) && <b style={{ color: "#b00" }}> · {flag(x)}</b>}
              </p>
            ))}
          </section>
          <section style={box}>
            <h2>Concurrent audit ({audits.length})</h2>
            <p>You cannot audit a call you took.</p>
            {audits.map((x) => (
              <AuditRow key={x.id} s={x} preview={preview} onView={view} onDecide={auditDecide} />
            ))}
          </section>
        </>
      )}
    </main>
  );
}

function AuditRow(props: {
  s: Sess;
  preview: Record<string, string>;
  onView: (id: string, kind: string) => void;
  onDecide: (id: string, d: "APPROVE" | "REJECT", note: string) => void;
}) {
  const { s, preview } = props;
  const [note, setNote] = useState("");
  return (
    <div style={{ borderTop: "1px solid #eee", paddingTop: 8 }}>
      <p>
        <b>{s.id.slice(0, 8)}</b> · officer {s.officialId} · GPS {s.geo.lat.toFixed(4)}, {s.geo.lng.toFixed(4)} · IP {s.ipCheck} · remarks: {s.review?.remarks || "—"}
      </p>
      <p style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {Object.entries(s.evidence).map(([k, e]) => (
          <button key={k} onClick={() => props.onView(s.id, k)} title={`sha256 ${e.sha256}`}>
            View {k} ({Math.round(e.bytes / 1024)} KB)
          </button>
        ))}
      </p>
      {preview[`${s.id}/recording`] && <video src={preview[`${s.id}/recording`]} controls style={vid} />}
      {["photo", "pan"].map((k) => preview[`${s.id}/${k}`] && <img key={k} src={preview[`${s.id}/${k}`]} alt={k} style={{ maxWidth: 240, marginRight: 8 }} />)}
      <p style={{ display: "flex", gap: 8 }}>
        <input placeholder="Audit remarks" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1 }} />
        <button onClick={() => props.onDecide(s.id, "APPROVE", note)}>Audit OK</button>
        <button onClick={() => props.onDecide(s.id, "REJECT", note)}>Audit reject</button>
      </p>
    </div>
  );
}
