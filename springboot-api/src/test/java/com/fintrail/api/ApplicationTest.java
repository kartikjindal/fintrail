package com.fintrail.api;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest
@AutoConfigureMockMvc
class ApplicationTest {

    @Autowired MockMvc mvc;

    @Test
    void panFormat() throws Exception {
        call("/api/pan", "{\"pan\":\"abcde1234f\"}").andExpect(jsonPath("$.validFormat").value(true));
        call("/api/pan", "{\"pan\":\"ABCD1234F\"}").andExpect(jsonPath("$.validFormat").value(false));
    }

    @Test
    void addressNearestPincode() throws Exception {
        // Connaught Place, Delhi -> 110001
        call("/api/address", "{\"lat\":28.63,\"lng\":77.22,\"pincode\":\"110001\"}")
                .andExpect(jsonPath("$.match").value(true));
        call("/api/address", "{\"lat\":28.63,\"lng\":77.22,\"pincode\":\"400001\"}")
                .andExpect(jsonPath("$.match").value(false))
                .andExpect(jsonPath("$.nearestPincode").value("110001"));
        call("/api/address", "{\"lat\":999,\"lng\":77.22,\"pincode\":\"110001\"}").andExpect(status().isBadRequest());
    }

    private org.springframework.test.web.servlet.ResultActions call(String url, String json) throws Exception {
        return mvc.perform(post(url).contentType(MediaType.APPLICATION_JSON).content(json));
    }
}
