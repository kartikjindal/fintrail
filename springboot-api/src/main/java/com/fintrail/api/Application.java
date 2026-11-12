package com.fintrail.api;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Hashtable;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import javax.naming.Context;
import javax.naming.NamingException;
import javax.naming.directory.Attribute;
import javax.naming.directory.InitialDirContext;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@SpringBootApplication
@RestController
@RequestMapping("/api")
public class Application {

    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }

    record PanReq(String pan) {}
    record EmailReq(String email, String employer) {}
    record AddressReq(Double lat, Double lng, String pincode) {}
    record Pincode(String pincode, double lat, double lng) {}

    // Format check only (AAAAA9999A). Whether the PAN exists needs Protean / the IT department.
    private static final Pattern PAN = Pattern.compile("^[A-Z]{5}[0-9]{4}[A-Z]$");
    private static final Pattern EMAIL = Pattern.compile("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$");
    private static final Pattern SIX_DIGITS = Pattern.compile("^\\d{6}$");
    // ponytail: tiny built-in lists; swap for the kickmail list (github.com/noticeable-app/kickmail) when it matters.
    private static final Set<String> DISPOSABLE = Set.of("mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com", "yopmail.com", "trashmail.com");
    private static final Set<String> FREE = Set.of("gmail.com", "yahoo.com", "yahoo.in", "outlook.com", "hotmail.com", "rediffmail.com", "icloud.com");

    // pincodes.csv is a small sample (pincode,lat,lng). Replace with the full
    // All India Pincode Directory from data.gov.in for real use.
    private final List<Pincode> pincodes = loadPincodes();

    @GetMapping("/health")
    Map<String, String> health() {
        return Map.of("status", "ok");
    }

    @PostMapping("/pan")
    ResponseEntity<?> pan(@RequestBody PanReq req) {
        if (req.pan() == null) return bad("pan (string) is required");
        String pan = req.pan().trim().toUpperCase();
        return ResponseEntity.ok(Map.of("pan", pan, "validFormat", PAN.matcher(pan).matches()));
    }

    @PostMapping("/email")
    ResponseEntity<?> email(@RequestBody EmailReq req) {
        String email = req.email() == null ? "" : req.email().trim().toLowerCase();
        if (email.length() > 254 || !EMAIL.matcher(email).matches()) return bad("valid email is required");
        String domain = email.substring(email.indexOf('@') + 1);

        Boolean employerMatch = null;
        if (req.employer() != null && !req.employer().isBlank()) {
            String emp = req.employer().toLowerCase().replaceAll("[^a-z0-9]", "");
            String label = domain.split("\\.")[0];
            employerMatch = label.length() >= 3 && (emp.contains(label) || label.contains(emp));
        }

        var body = new java.util.LinkedHashMap<String, Object>();
        body.put("email", email);
        body.put("domain", domain);
        body.put("hasMx", hasMx(domain)); // No mailbox-exists (SMTP) test: port 25 is usually blocked.
        body.put("disposable", DISPOSABLE.contains(domain));
        body.put("freeProvider", FREE.contains(domain));
        body.put("employerMatch", employerMatch);
        return ResponseEntity.ok(body);
    }

    @PostMapping("/address")
    ResponseEntity<?> address(@RequestBody AddressReq req) {
        if (req.lat() == null || req.lng() == null || Math.abs(req.lat()) > 90 || Math.abs(req.lng()) > 180
                || req.pincode() == null || !SIX_DIGITS.matcher(req.pincode()).matches()) {
            return bad("lat, lng (numbers) and 6-digit pincode are required");
        }
        // ponytail: linear scan over ~19k rows is fine; add a spatial index if it shows up in latency.
        Pincode nearest = pincodes.get(0);
        double best = Double.MAX_VALUE;
        for (Pincode p : pincodes) {
            double d = haversineKm(req.lat(), req.lng(), p.lat(), p.lng());
            if (d < best) { best = d; nearest = p; }
        }
        return ResponseEntity.ok(Map.of(
                "declaredPincode", req.pincode(),
                "nearestPincode", nearest.pincode(),
                "distanceKm", Math.round(best * 10) / 10.0,
                "match", nearest.pincode().equals(req.pincode())));
    }

    private static ResponseEntity<?> bad(String msg) {
        return ResponseEntity.badRequest().body(Map.of("error", msg));
    }

    private static boolean hasMx(String domain) {
        var env = new Hashtable<String, String>();
        env.put(Context.INITIAL_CONTEXT_FACTORY, "com.sun.jndi.dns.DnsContextFactory");
        try {
            Attribute mx = new InitialDirContext(env).getAttributes(domain, new String[] {"MX"}).get("MX");
            return mx != null && mx.size() > 0;
        } catch (NamingException e) {
            return false;
        }
    }

    static double haversineKm(double lat1, double lng1, double lat2, double lng2) {
        double dLat = Math.toRadians(lat2 - lat1), dLng = Math.toRadians(lng2 - lng1);
        double a = Math.pow(Math.sin(dLat / 2), 2)
                + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2)) * Math.pow(Math.sin(dLng / 2), 2);
        return 6371 * 2 * Math.asin(Math.sqrt(a));
    }

    private static List<Pincode> loadPincodes() {
        try (var in = new BufferedReader(new InputStreamReader(
                Application.class.getResourceAsStream("/pincodes.csv"), StandardCharsets.UTF_8))) {
            return in.lines().skip(1).filter(l -> !l.isBlank()).map(l -> {
                String[] f = l.split(",");
                return new Pincode(f[0].trim(), Double.parseDouble(f[1]), Double.parseDouble(f[2]));
            }).toList();
        } catch (Exception e) {
            throw new IllegalStateException("cannot load pincodes.csv", e);
        }
    }
}
