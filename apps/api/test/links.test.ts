import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPreviewFetch } from "../src/modules/automations/links";
import { isMapsHost, parseMapText } from "../src/modules/automations/places";

describe("tracked link taps", () => {
  const phone =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  it("counts a phone's browser, not previews, crawlers or HEAD", () => {
    assert.equal(isPreviewFetch("GET", phone), false);
    assert.equal(isPreviewFetch("HEAD", phone), true);
    assert.equal(isPreviewFetch("GET", "WhatsApp/2.24.1 A"), true);
    assert.equal(isPreviewFetch("GET", "facebookexternalhit/1.1"), true);
    assert.equal(isPreviewFetch("GET", "Mozilla/5.0 (compatible; Googlebot/2.1)"), true);
    assert.equal(isPreviewFetch("GET", ""), true);
  });
});

describe("map links", () => {
  it("reads coordinates typed or pasted from Google Maps", () => {
    assert.deepEqual(parseMapText("25.0806, 55.1403"), { latitude: 25.0806, longitude: 55.1403, name: "" });
    assert.deepEqual(
      parseMapText(
        "https://www.google.com/maps/place/Dubai+Marina+Mall/@25.0763,55.1376,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d25.0767!4d55.1402!16s",
      ),
      { latitude: 25.0767, longitude: 55.1402, name: "Dubai Marina Mall" },
    );
    assert.deepEqual(parseMapText("https://maps.google.com/?q=25.2,55.27"), {
      latitude: 25.2,
      longitude: 55.27,
      name: "",
    });
    assert.deepEqual(parseMapText("https://www.google.com/maps/search/25.2,+55.27?entry=tts"), {
      latitude: 25.2,
      longitude: 55.27,
      name: "",
    });
    assert.equal(parseMapText("Dubai Marina"), null);
    assert.equal(parseMapText("0, 0"), null);
    assert.equal(parseMapText("95, 10"), null);
  });
  it("follows only Google Maps hosts", () => {
    assert.equal(isMapsHost(new URL("https://maps.app.goo.gl/abc")), true);
    assert.equal(isMapsHost(new URL("https://www.google.com/maps/place/x")), true);
    assert.equal(isMapsHost(new URL("https://maps.google.co.in/?q=1,2")), true);
    assert.equal(isMapsHost(new URL("https://www.google.com/search?q=x")), false);
    assert.equal(isMapsHost(new URL("http://maps.app.goo.gl/abc")), false);
    assert.equal(isMapsHost(new URL("https://maps.app.goo.gl.evil.com/abc")), false);
    assert.equal(isMapsHost(new URL("https://169.254.169.254/maps")), false);
  });
});
