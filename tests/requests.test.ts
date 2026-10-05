import assert from "node:assert/strict";
import { test } from "node:test";
import { lateReplyResult, openingIdFor, parseOpeningRequest } from "../src/requests";
import { EXPIRED_MESSAGE, type OpeningStatus } from "../src/types";

const now = new Date(2026, 9, 5, 9, 0); // Mon 5 Oct 2026, 9:00 local
const valid = { stylist: "Carla", service: "Haircut", date: "2026-10-10", time: "10:00", durationMinutes: 45 };

test("a valid form becomes an opening with a slot-based ID", () => {
  const parsed = parseOpeningRequest(valid, now);
  assert.ok(!("error" in parsed));
  assert.equal(parsed.openingId, "opening-carla-2026-10-10-1000");
  assert.equal(parsed.opening.startsAt, new Date(2026, 9, 10, 10, 0).toISOString());
  assert.equal(parsed.opening.offerWindowMinutes, 15);
  assert.equal(parsed.opening.durationMinutes, 45);
});

test("demo speed shortens offers to 30 seconds", () => {
  const parsed = parseOpeningRequest({ ...valid, demoSpeed: true }, now);
  assert.ok(!("error" in parsed));
  assert.equal(parsed.opening.offerWindowMinutes, 0.5);
});

test("bad input gets a plain explanation", () => {
  assert.deepEqual(parseOpeningRequest({ ...valid, stylist: "  " }, now), { error: "Choose a stylist and a service." });
  assert.deepEqual(parseOpeningRequest({ ...valid, time: "" }, now), { error: "Enter the appointment date and time." });
  assert.deepEqual(parseOpeningRequest({ ...valid, date: "2026-13-01" }, now), { error: "That date or time isn't valid." });
  assert.deepEqual(parseOpeningRequest({ ...valid, date: "2026-10-01" }, now), { error: "That appointment time has already passed." });
  assert.deepEqual(parseOpeningRequest({ ...valid, durationMinutes: 5 }, now), { error: "Length must be between 15 and 480 minutes." });
});

test("opening IDs are safe slugs", () => {
  assert.equal(openingIdFor("Carla Ruiz", "2026-10-10", "09:30"), "opening-carla-ruiz-2026-10-10-0930");
});

const finished = (overrides: Partial<OpeningStatus> = {}): OpeningStatus => ({
  openingId: "opening-carla-2026-10-10-1000",
  opening: { stylist: "Carla", service: "Haircut", startsAt: "2026-10-10T14:00:00.000Z", durationMinutes: 45, offerWindowMinutes: 15 },
  phase: "nobody_available",
  headline: "",
  cutoffAt: "2026-10-10T13:15:00.000Z",
  declined: [],
  timedOut: [],
  couldNotText: [],
  stillEligible: [],
  notices: [],
  timeline: [],
  texts: [{ at: "2026-10-10T09:00:00.000Z", clientId: "maya", from: "salon", kind: "offer", body: "offer" }],
  ...overrides,
});

test("a late reply to a finished opening gets the expired message", () => {
  assert.deepEqual(lateReplyResult(finished(), "maya"), { outcome: "expired", message: EXPIRED_MESSAGE });
});

test("someone never offered the opening gets no late-reply answer", () => {
  assert.equal(lateReplyResult(finished(), "jordan"), undefined);
});

test("the booked client replying again is told they're already booked", () => {
  const result = lateReplyResult(finished({ phase: "booked", bookedClient: { clientId: "maya", name: "Maya Chen" } }), "maya");
  assert.equal(result?.outcome, "booked");
});
