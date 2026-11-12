package com.fintrail.api;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigInteger;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.FileSystemResource;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * V-CIP (RBI KYC Master Direction s.18). Same API as next-api/app/api/vcip.
 * The backend never touches audio/video: media is peer-to-peer WebRTC, signalling is one offer + one answer,
 * uploads are streamed to disk while hashing.
 */
@RestController
@RequestMapping("/api/vcip")
class VcipController {

    // Keep in sync with next-api/lib/vcip-shared.ts
    static final String CONSENT_VERSION = "2026-11-v1";
    static final List<String> CHECKLIST = List.of("faceMatchesAadhaar", "faceMatchesPan", "detailsMatch", "livenessPassed",
            "noPrompting", "aadhaarDataFresh", "addressConfirmed", "financialProfileConfirmed");
    // RBI s.18(b)(iii): question sequence and type must vary. Picked here, shown only to the official.
    static final List<String> QUESTIONS = List.of("Turn your head slowly to your left", "Turn your head slowly to your right",
            "Blink twice", "Smile", "Look up, then back at the camera", "Raise your right hand", "Say your date of birth",
            "Say the city you live in", "Say your employer's name", "Say your monthly take-home salary", "Say today's date",
            "Read out the last 4 digits of your mobile number");

    record Spec(String ext, String type, long max) {}
    static final long MB = 1024 * 1024;
    static final Map<String, Spec> EVIDENCE = Map.of(
            "recording", new Spec("webm", "video/webm", 500 * MB),
            "photo", new Spec("jpg", "image/jpeg", 5 * MB),
            "pan", new Spec("jpg", "image/jpeg", 5 * MB));

    static final long WAIT_MS = 15 * 60_000, CALL_MS = 45 * 60_000, KEEP_MS = 24 * 3600_000;
    static final Pattern UUID_RE = Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
    static final Pattern VIRTUAL_CAM = Pattern.compile("(?i)obs|manycam|virtual|snap camera|droidcam|xsplit");
    static final Pattern IPV4 = Pattern.compile("^\\d{1,3}(\\.\\d{1,3}){3}$");

    public record Geo(double lat, double lng, double accuracyM) {}
    public record Evidence(String sha256, long bytes, String at) {}

    public static final class Session {
        public String id;
        @JsonIgnore public String customerTokenHash;
        public long createdAt, expiresAt;
        public String status;
        public Geo geo;
        public String ip, ipCheck, cameraLabel;
        public boolean virtualCameraSuspected;
        public List<String> questions;
        public String officialId;
        @JsonIgnore public String offer, answer;
        public Map<String, Evidence> evidence = new ConcurrentHashMap<>();
        public Map<String, Object> review, audit;

        boolean live() { return "WAITING".equals(status) || "IN_CALL".equals(status); }
    }

    record CreateReq(Boolean consent, String consentVersion, Double lat, Double lng, Double accuracyM, String cameraLabel) {}
    record SignalReq(String sdp) {}
    record ReviewReq(String decision, Map<String, Boolean> checklist, Boolean ePan, String remarks) {}
    record Official(String id, byte[] hash) {}

    private final ObjectMapper json = new ObjectMapper().configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);
    private final SecureRandom random = new SecureRandom();
    private final Map<String, Session> sessions = new ConcurrentHashMap<>();
    private final Set<String> uploading = ConcurrentHashMap.newKeySet();
    private final List<Official> officials = new ArrayList<>();
    private final List<BigInteger[]> inRanges; // null = IP check not configured
    private final Path dataDir, auditFile;
    private String lastHash;

    VcipController(@Value("${vcip.officials:}") String officialsCsv,
                   @Value("${vcip.data-dir:vcip-data}") String dataDir,
                   @Value("${vcip.india-ip-ranges:}") String ipRanges) throws IOException {
        this.dataDir = Path.of(dataDir).toAbsolutePath();
        this.auditFile = this.dataDir.resolve("audit.jsonl");
        Files.createDirectories(this.dataDir);
        // ponytail: reads the whole audit log once at boot to recover the hash chain; read only the tail if it grows huge.
        List<String> lines = Files.exists(auditFile) ? Files.readAllLines(auditFile) : List.of();
        lastHash = lines.isEmpty() ? "0".repeat(64) : json.readTree(lines.get(lines.size() - 1)).get("hash").asText();
        try (Stream<Path> dirs = Files.list(this.dataDir)) {
            for (Path d : dirs.toList()) {
                Path f = d.resolve("session.json");
                if (!UUID_RE.matcher(d.getFileName().toString()).matches() || !Files.exists(f)) continue;
                Session s = json.readValue(f.toFile(), Session.class);
                if ("PENDING_AUDIT".equals(s.status)) sessions.put(s.id, s); // the only state worth resuming
            }
        }
        for (String pair : officialsCsv.split(",")) {
            int i = pair.indexOf(':');
            if (i < 1) continue;
            String id = pair.substring(0, i).trim(), tok = pair.substring(i + 1).trim();
            if (tok.length() >= 16) officials.add(new Official(id, sha(tok)));
            else System.err.println("[vcip] token for official \"" + id + "\" ignored: needs 16+ characters");
        }
        inRanges = ipRanges.isBlank() ? null : loadRanges(Path.of(ipRanges));
    }

    // ---- endpoints -------------------------------------------------------------------------------------

    // Customer starts a session: consent + live GPS (RBI s.18(a)(ii), (a)(iv)).
    @PostMapping("/sessions")
    ResponseEntity<?> create(@RequestBody CreateReq b, HttpServletRequest req) {
        if (!Boolean.TRUE.equals(b.consent()) || !CONSENT_VERSION.equals(b.consentVersion()))
            return err(400, "consent to the current V-CIP terms is required");
        if (!inIndia(b.lat(), b.lng()) || b.accuracyM() == null || b.accuracyM() < 0)
            return err(400, "a live GPS location inside India is required");
        String ip = req.getRemoteAddr(); // behind a proxy set server.forward-headers-strategy=native
        String ipCheck = checkIp(ip);
        if ("outside".equals(ipCheck)) return err(403, "video KYC is only available from within India");

        sweep();
        String label = b.cameraLabel() == null ? "" : b.cameraLabel().substring(0, Math.min(200, b.cameraLabel().length()));
        byte[] raw = new byte[32];
        random.nextBytes(raw);
        String token = Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
        Session s = new Session();
        s.id = UUID.randomUUID().toString();
        s.customerTokenHash = HexFormat.of().formatHex(sha(token));
        s.createdAt = System.currentTimeMillis();
        s.expiresAt = s.createdAt + WAIT_MS;
        s.status = "WAITING";
        s.geo = new Geo(b.lat(), b.lng(), b.accuracyM());
        s.ip = ip;
        s.ipCheck = ipCheck;
        s.cameraLabel = label;
        s.virtualCameraSuspected = VIRTUAL_CAM.matcher(label).find(); // weak signal only
        s.questions = pickQuestions(4);
        sessions.put(s.id, s);
        save(s);
        audit("SESSION_CREATED", s.id, "customer", Map.of("consentVersion", CONSENT_VERSION, "geo", s.geo, "ip", ip,
                "ipCheck", ipCheck, "cameraLabel", label, "userAgent", String.valueOf(req.getHeader("User-Agent"))));
        return ResponseEntity.status(201).body(Map.of("id", s.id, "customerToken", token, "expiresAt", s.expiresAt));
    }

    // Official queue: ?status=WAITING (default) or PENDING_AUDIT.
    @GetMapping("/sessions")
    ResponseEntity<?> list(@RequestHeader(value = "Authorization", required = false) String auth,
                           @RequestParam(defaultValue = "WAITING") String status) {
        if (official(auth) == null) return err(401, "official token required");
        if (!status.equals("WAITING") && !status.equals("PENDING_AUDIT")) return err(400, "status must be WAITING or PENDING_AUDIT");
        sweep();
        return ResponseEntity.ok(sessions.values().stream()
                .filter(s -> s.status.equals(status) && (!status.equals("WAITING") || s.offer != null))
                .sorted((a, c) -> Long.compare(a.createdAt, c.createdAt)).toList());
    }

    @GetMapping("/sessions/{id}")
    ResponseEntity<?> get(@PathVariable String id, @RequestHeader(value = "Authorization", required = false) String auth,
                          @RequestHeader(value = "X-Customer-Token", required = false) String customer) {
        Session s = find(id);
        if (s == null) return err(404, "session not found");
        if (official(auth) != null) return ResponseEntity.ok(s);
        // The customer never sees the questions: they must not be known in advance.
        if (isCustomer(customer, s)) return ResponseEntity.ok(Map.of("id", s.id, "status", s.status, "expiresAt", s.expiresAt));
        return err(401, "unauthorised");
    }

    // Non-trickle WebRTC: the whole signalling is one offer (customer) and one answer (official).
    @PostMapping("/sessions/{id}/signal")
    ResponseEntity<?> postSignal(@PathVariable String id, @RequestBody SignalReq b,
                                 @RequestHeader(value = "Authorization", required = false) String auth,
                                 @RequestHeader(value = "X-Customer-Token", required = false) String customer) {
        Session s = find(id);
        if (s == null) return err(404, "session not found");
        if (b.sdp() == null || b.sdp().isEmpty() || b.sdp().length() > 20_000) return err(400, "sdp (string) is required");
        String off = official(auth);
        synchronized (s) {
            if (off != null) {
                if (!"WAITING".equals(s.status) || s.offer == null) return err(409, "session is not waiting for an official");
                s.answer = b.sdp();
                s.officialId = off;
                s.status = "IN_CALL";
                s.expiresAt = System.currentTimeMillis() + CALL_MS;
                save(s);
                audit("CALL_STARTED", s.id, off, Map.of());
                return ResponseEntity.ok(Map.of("ok", true));
            }
            if (!isCustomer(customer, s)) return err(401, "unauthorised");
            // One offer per session: after a call drop RBI s.18(b)(ii) needs a fresh session.
            if (!"WAITING".equals(s.status) || s.offer != null) return err(409, "offer already sent; start a new session");
            s.offer = b.sdp();
            return ResponseEntity.ok(Map.of("ok", true));
        }
    }

    // Official fetches the offer; customer polls for the answer. 204 = not there yet.
    @GetMapping("/sessions/{id}/signal")
    ResponseEntity<?> getSignal(@PathVariable String id, @RequestHeader(value = "Authorization", required = false) String auth,
                                @RequestHeader(value = "X-Customer-Token", required = false) String customer) {
        Session s = find(id);
        if (s == null) return err(404, "session not found");
        if (!s.live()) return err(410, "session is " + s.status);
        String sdp;
        if (official(auth) != null) sdp = s.offer;
        else if (isCustomer(customer, s)) sdp = s.answer;
        else return err(401, "unauthorised");
        return sdp == null ? ResponseEntity.noContent().build() : ResponseEntity.ok(Map.of("sdp", sdp));
    }

    // Raw body, streamed to disk through SHA-256: constant memory whatever the file size.
    @PutMapping("/sessions/{id}/evidence/{kind}")
    ResponseEntity<?> putEvidence(@PathVariable String id, @PathVariable String kind, HttpServletRequest req,
                                  @RequestHeader(value = "Authorization", required = false) String auth) throws Exception {
        Spec spec = EVIDENCE.get(kind);
        Session s = spec == null ? null : find(id);
        if (s == null) return err(404, "not found");
        String off = official(auth);
        if (off == null || !off.equals(s.officialId)) return err(403, "only the official on this call can upload");
        if (!"IN_CALL".equals(s.status)) return err(409, "session is " + s.status);
        if (req.getContentLengthLong() > spec.max()) return err(413, kind + " is larger than " + spec.max() + " bytes");
        String key = s.id + "/" + kind;
        // One file per kind: RBI s.18(b)(ii) says pauses must not create multiple video files.
        if (s.evidence.containsKey(kind) || !uploading.add(key)) return err(409, kind + " already stored");

        Path file = dataDir.resolve(s.id).resolve(kind + "." + spec.ext());
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        long bytes = 0;
        try (InputStream in = req.getInputStream(); OutputStream out = Files.newOutputStream(file)) {
            byte[] buf = new byte[64 * 1024];
            for (int n; (n = in.read(buf)) > 0; ) {
                bytes += n;
                if (bytes > spec.max()) throw new IOException("too large");
                md.update(buf, 0, n);
                out.write(buf, 0, n);
            }
        } catch (IOException e) {
            Files.deleteIfExists(file);
            return err(413, "upload failed or " + kind + " is larger than " + spec.max() + " bytes");
        } finally {
            uploading.remove(key);
        }
        if (bytes == 0) {
            Files.deleteIfExists(file);
            return err(400, "empty body");
        }
        Evidence ev = new Evidence(HexFormat.of().formatHex(md.digest()), bytes, Instant.now().toString());
        s.evidence.put(kind, ev);
        save(s);
        audit("EVIDENCE_STORED", s.id, off, Map.of("kind", kind, "sha256", ev.sha256(), "bytes", ev.bytes(), "at", ev.at()));
        return ResponseEntity.status(201).body(ev);
    }

    // Any official (the concurrent auditor) can stream evidence back. FileSystemResource also handles Range requests.
    @GetMapping("/sessions/{id}/evidence/{kind}")
    ResponseEntity<?> getEvidence(@PathVariable String id, @PathVariable String kind,
                                  @RequestHeader(value = "Authorization", required = false) String auth) {
        Spec spec = EVIDENCE.get(kind);
        Session s = spec == null ? null : find(id);
        if (s == null || !s.evidence.containsKey(kind)) return err(404, "not found");
        String off = official(auth);
        if (off == null) return err(401, "official token required");
        audit("EVIDENCE_VIEWED", s.id, off, Map.of("kind", kind));
        return ResponseEntity.ok().contentType(MediaType.parseMediaType(spec.type())).header("Cache-Control", "no-store")
                .body(new FileSystemResource(dataDir.resolve(s.id).resolve(kind + "." + spec.ext())));
    }

    // Step 1: the official on the call decides. Step 2: a different official does the concurrent audit
    // (RBI s.18(b)(xii): the account is operational only after it).
    @PostMapping("/sessions/{id}/review")
    ResponseEntity<?> review(@PathVariable String id, @RequestBody ReviewReq b,
                             @RequestHeader(value = "Authorization", required = false) String auth) {
        Session s = find(id);
        if (s == null) return err(404, "session not found");
        String off = official(auth);
        if (off == null) return err(401, "official token required");
        String decision = b.decision() == null ? "" : b.decision();
        String remarks = b.remarks() == null ? "" : b.remarks().substring(0, Math.min(2000, b.remarks().length()));
        String at = Instant.now().toString();
        synchronized (s) {
            if ("IN_CALL".equals(s.status)) {
                if (!off.equals(s.officialId)) return err(403, "only the official on this call can decide");
                if (!List.of("APPROVE", "REJECT", "DROPPED").contains(decision)) return err(400, "decision must be APPROVE, REJECT or DROPPED");
                Map<String, Boolean> checklist = new LinkedHashMap<>();
                for (String k : CHECKLIST) checklist.put(k, b.checklist() != null && Boolean.TRUE.equals(b.checklist().get(k)));
                boolean ePan = Boolean.TRUE.equals(b.ePan());
                if (decision.equals("APPROVE")) {
                    List<String> missing = CHECKLIST.stream().filter(k -> !checklist.get(k)).toList();
                    List<String> need = Stream.of("recording", "photo", "pan")
                            .filter(k -> !(ePan && k.equals("pan")) && !s.evidence.containsKey(k)).toList();
                    if (!missing.isEmpty() || !need.isEmpty())
                        return ResponseEntity.unprocessableEntity().body(Map.of("error", "cannot approve yet", "missing", missing, "needEvidence", need));
                }
                s.status = switch (decision) { case "APPROVE" -> "PENDING_AUDIT"; case "REJECT" -> "REJECTED"; default -> "DROPPED"; };
                s.review = new LinkedHashMap<>(Map.of("officialId", off, "decision", decision, "checklist", checklist,
                        "ePan", ePan, "remarks", remarks, "at", at));
                audit("OFFICIAL_DECISION", s.id, off, s.review);
            } else if ("PENDING_AUDIT".equals(s.status)) {
                if (off.equals(s.officialId)) return err(403, "the concurrent audit must be done by a different official");
                if (!decision.equals("APPROVE") && !decision.equals("REJECT")) return err(400, "decision must be APPROVE or REJECT");
                s.status = decision.equals("APPROVE") ? "APPROVED" : "REJECTED";
                s.audit = new LinkedHashMap<>(Map.of("auditorId", off, "decision", decision, "remarks", remarks, "at", at));
                audit("CONCURRENT_AUDIT", s.id, off, s.audit);
            } else {
                return err(409, "session is " + s.status);
            }
            save(s);
            return ResponseEntity.ok(s);
        }
    }

    // ---- helpers ---------------------------------------------------------------------------------------

    private static ResponseEntity<?> err(int status, String msg) {
        return ResponseEntity.status(status).body(Map.of("error", msg));
    }

    static byte[] sha(String s) {
        return sha256(s.getBytes(StandardCharsets.UTF_8));
    }

    static byte[] sha256(byte[] b) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(b);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private String official(String auth) {
        if (auth == null || !auth.startsWith("Bearer ")) return null;
        byte[] h = sha(auth.substring(7));
        for (Official o : officials) if (MessageDigest.isEqual(o.hash(), h)) return o.id(); // constant-time compare
        return null;
    }

    private static boolean isCustomer(String token, Session s) {
        return token != null && s.customerTokenHash != null
                && MessageDigest.isEqual(sha(token), HexFormat.of().parseHex(s.customerTokenHash));
    }

    // ponytail: bounding box (also covers slivers of neighbouring countries); swap for India's boundary polygon if that matters.
    static boolean inIndia(Double lat, Double lng) {
        return lat != null && lng != null && lat >= 6.4 && lat <= 37.6 && lng >= 68 && lng <= 97.5;
    }

    private List<String> pickQuestions(int n) {
        List<String> a = new ArrayList<>(QUESTIONS);
        for (int i = 0; i < n; i++) java.util.Collections.swap(a, i, i + random.nextInt(a.size() - i));
        return List.copyOf(a.subList(0, n));
    }

    private Session find(String id) {
        if (id == null || !UUID_RE.matcher(id).matches()) return null; // also guards the id before it becomes a directory name
        Session s = sessions.computeIfAbsent(id, k -> {
            Path f = dataDir.resolve(k).resolve("session.json");
            try {
                return Files.exists(f) ? json.readValue(f.toFile(), Session.class) : null;
            } catch (IOException e) {
                return null;
            }
        });
        if (s != null) expireIfDue(s);
        return s;
    }

    private void expireIfDue(Session s) {
        synchronized (s) {
            if (s.live() && System.currentTimeMillis() > s.expiresAt) {
                s.status = "EXPIRED";
                audit("SESSION_EXPIRED", s.id, "system", Map.of());
                save(s);
            }
        }
    }

    // Lazy cleanup on create/list instead of timers. ponytail: O(active sessions) scan; fine below ~10k concurrent.
    private void sweep() {
        long now = System.currentTimeMillis();
        for (Session s : sessions.values()) {
            expireIfDue(s);
            if (!s.live() && !"PENDING_AUDIT".equals(s.status) && now - s.createdAt > KEEP_MS) sessions.remove(s.id);
        }
    }

    private void save(Session s) {
        try {
            Files.createDirectories(dataDir.resolve(s.id));
            json.writeValue(dataDir.resolve(s.id).resolve("session.json").toFile(), s);
        } catch (IOException e) {
            throw new IllegalStateException("cannot save session " + s.id, e);
        }
    }

    // RBI s.18(a)(ii) + (c)(ii): append-only activity log, hash-chained so any edit breaks the chain.
    private synchronized void audit(String event, String sessionId, String actor, Object data) {
        try {
            Map<String, Object> rec = new LinkedHashMap<>();
            rec.put("at", Instant.now().toString());
            rec.put("event", event);
            rec.put("sessionId", sessionId);
            rec.put("actor", actor);
            rec.put("data", data);
            rec.put("prev", lastHash);
            String hash = HexFormat.of().formatHex(sha(json.writeValueAsString(rec)));
            rec.put("hash", hash);
            Files.writeString(auditFile, json.writeValueAsString(rec) + "\n", StandardOpenOption.CREATE, StandardOpenOption.APPEND);
            lastHash = hash;
        } catch (IOException e) {
            throw new IllegalStateException("cannot write audit log", e);
        }
    }

    // ---- RBI s.18(a)(iii): block IPs outside India ----------------------------------------------------

    // Parses IP literals only (never a hostname, so no DNS lookup).
    static BigInteger ipToBig(String ip) {
        ip = ip.trim();
        if (!IPV4.matcher(ip).matches() && !ip.contains(":")) return null;
        try {
            return new BigInteger(1, InetAddress.getByName(ip).getAddress());
        } catch (Exception e) {
            return null;
        }
    }

    // Expects a "start,end,country" CSV (e.g. DB-IP IP-to-Country Lite).
    private static List<BigInteger[]> loadRanges(Path f) throws IOException {
        List<BigInteger[]> out = new ArrayList<>();
        for (String line : Files.readAllLines(f)) {
            String[] c = line.replace("\"", "").split(",");
            if (c.length < 3 || !c[2].trim().equals("IN")) continue;
            BigInteger s = ipToBig(c[0]), e = ipToBig(c[1]);
            if (s != null && e != null) out.add(new BigInteger[] {s, e});
        }
        out.sort((x, y) -> x[0].compareTo(y[0]));
        return out;
    }

    String checkIp(String ip) {
        try {
            if (ip != null && (IPV4.matcher(ip).matches() || ip.contains(":"))) {
                InetAddress a = InetAddress.getByName(ip);
                byte[] b = a.getAddress();
                if (a.isLoopbackAddress() || a.isSiteLocalAddress() || a.isLinkLocalAddress() || (b.length == 16 && (b[0] & 0xfe) == 0xfc))
                    return "private";
            }
        } catch (Exception ignored) {
            // fall through
        }
        if (inRanges == null) return "not_configured";
        BigInteger n = ip == null ? null : ipToBig(ip);
        if (n == null) return "outside";
        int lo = 0, hi = inRanges.size() - 1; // binary search: O(log n) per check
        while (lo <= hi) {
            int m = (lo + hi) >>> 1;
            BigInteger[] r = inRanges.get(m);
            if (n.compareTo(r[0]) < 0) hi = m - 1;
            else if (n.compareTo(r[1]) > 0) lo = m + 1;
            else return "in";
        }
        return "outside";
    }
}
