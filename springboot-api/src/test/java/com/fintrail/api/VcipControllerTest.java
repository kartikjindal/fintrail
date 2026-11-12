package com.fintrail.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HexFormat;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

@SpringBootTest(properties = {
        "vcip.officials=alice:alice-token-0123456789,bob:bob-token-0123456789",
        "vcip.data-dir=target/vcip-test"})
@AutoConfigureMockMvc
class VcipControllerTest {

    static final String ALICE = "Bearer alice-token-0123456789", BOB = "Bearer bob-token-0123456789";
    static final String ALL = "{\"faceMatchesAadhaar\":true,\"faceMatchesPan\":true,\"detailsMatch\":true,\"livenessPassed\":true,"
            + "\"noPrompting\":true,\"aadhaarDataFresh\":true,\"addressConfirmed\":true,\"financialProfileConfirmed\":true}";

    @Autowired MockMvc mvc;
    final ObjectMapper json = new ObjectMapper();

    MockHttpServletRequestBuilder j(MockHttpServletRequestBuilder b, String body) {
        return b.contentType(MediaType.APPLICATION_JSON).content(body);
    }

    @Test
    void rejectsOutsideIndiaAndMissingConsent() throws Exception {
        mvc.perform(j(post("/api/vcip/sessions"), "{\"consent\":true,\"consentVersion\":\"2026-11-v1\",\"lat\":51.5,\"lng\":-0.1,\"accuracyM\":10}"))
                .andExpect(status().isBadRequest());
        mvc.perform(j(post("/api/vcip/sessions"), "{\"lat\":28.6,\"lng\":77.2,\"accuracyM\":10}")).andExpect(status().isBadRequest());
        mvc.perform(get("/api/vcip/sessions")).andExpect(status().isUnauthorized());
    }

    @Test
    void fullFlowWithMakerChecker() throws Exception {
        JsonNode created = json.readTree(mvc.perform(j(post("/api/vcip/sessions"),
                        "{\"consent\":true,\"consentVersion\":\"2026-11-v1\",\"lat\":28.6,\"lng\":77.2,\"accuracyM\":12,\"cameraLabel\":\"OBS Virtual Camera\"}"))
                .andExpect(status().isCreated()).andReturn().getResponse().getContentAsString());
        String id = created.get("id").asText(), cust = created.get("customerToken").asText();
        String base = "/api/vcip/sessions/" + id;

        // Customer cannot see the questions.
        mvc.perform(get(base).header("X-Customer-Token", cust)).andExpect(jsonPath("$.questions").doesNotExist());
        mvc.perform(j(post(base + "/signal"), "{\"sdp\":\"offer\"}").header("X-Customer-Token", cust)).andExpect(status().isOk());
        mvc.perform(j(post(base + "/signal"), "{\"sdp\":\"again\"}").header("X-Customer-Token", cust)).andExpect(status().isConflict());
        mvc.perform(get(base + "/signal").header("X-Customer-Token", cust)).andExpect(status().isNoContent());

        mvc.perform(get("/api/vcip/sessions").header("Authorization", ALICE))
                .andExpect(jsonPath("$[0].virtualCameraSuspected").value(true))
                .andExpect(jsonPath("$[0].questions.length()").value(4))
                .andExpect(jsonPath("$[0].customerTokenHash").doesNotExist());
        mvc.perform(get(base + "/signal").header("Authorization", ALICE)).andExpect(jsonPath("$.sdp").value("offer"));
        mvc.perform(j(post(base + "/signal"), "{\"sdp\":\"answer\"}").header("Authorization", ALICE)).andExpect(status().isOk());
        mvc.perform(get(base + "/signal").header("X-Customer-Token", cust)).andExpect(jsonPath("$.sdp").value("answer"));

        byte[] video = new byte[200_000];
        new java.util.Random(1).nextBytes(video);
        mvc.perform(put(base + "/evidence/photo").header("Authorization", BOB).content("x")).andExpect(status().isForbidden());
        mvc.perform(put(base + "/evidence/recording").header("Authorization", ALICE).content(video))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.sha256").value(HexFormat.of().formatHex(VcipController.sha256(video))));
        mvc.perform(put(base + "/evidence/recording").header("Authorization", ALICE).content(video)).andExpect(status().isConflict());
        mvc.perform(put(base + "/evidence/photo").header("Authorization", ALICE).content("jpeg")).andExpect(status().isCreated());

        mvc.perform(j(post(base + "/review"), "{\"decision\":\"APPROVE\",\"checklist\":{\"faceMatchesAadhaar\":true}}").header("Authorization", ALICE))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.needEvidence[0]").value("pan"));
        mvc.perform(j(post(base + "/review"), "{\"decision\":\"APPROVE\",\"ePan\":true,\"checklist\":" + ALL + "}").header("Authorization", ALICE))
                .andExpect(jsonPath("$.status").value("PENDING_AUDIT"));

        // Maker-checker: the official who took the call cannot audit it.
        mvc.perform(j(post(base + "/review"), "{\"decision\":\"APPROVE\"}").header("Authorization", ALICE)).andExpect(status().isForbidden());
        byte[] back = mvc.perform(get(base + "/evidence/recording").header("Authorization", BOB)).andReturn().getResponse().getContentAsByteArray();
        assertEquals(video.length, back.length);
        mvc.perform(j(post(base + "/review"), "{\"decision\":\"APPROVE\",\"remarks\":\"ok\"}").header("Authorization", BOB))
                .andExpect(jsonPath("$.status").value("APPROVED"));

        // Audit log is hash-chained and holds no tokens.
        List<String> lines = Files.readAllLines(Path.of("target/vcip-test/audit.jsonl"));
        String prev = json.readTree(lines.get(0)).get("prev").asText();
        for (String line : lines) {
            var rec = (com.fasterxml.jackson.databind.node.ObjectNode) json.readTree(line);
            assertEquals(prev, rec.get("prev").asText());
            String hash = rec.remove("hash").asText();
            assertEquals(hash, HexFormat.of().formatHex(VcipController.sha(json.writeValueAsString(rec))));
            prev = hash;
            assertEquals(false, line.contains(cust));
        }
    }
}
