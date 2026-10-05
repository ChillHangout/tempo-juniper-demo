import assert from "node:assert/strict";
import { test } from "node:test";
import { eligibleClients, isEligible } from "../src/eligibility";
import type { Client, Opening } from "../src/types";

// Local time, like the salon. 2026-10-10 is a Saturday.
const at = (year: number, month: number, day: number, hour: number, minute: number) =>
  new Date(year, month - 1, day, hour, minute).toISOString();

const opening = (overrides: Partial<Opening> = {}): Opening => ({
  stylist: "Carla",
  service: "Haircut",
  startsAt: at(2026, 10, 10, 10, 0),
  durationMinutes: 45,
  offerWindowMinutes: 15,
  ...overrides,
});

const client = (overrides: Partial<Client> = {}): Client => ({
  id: "c1",
  name: "Test Client",
  phone: "555-0100",
  joinedAt: "2026-09-01T10:00:00Z",
  services: ["Haircut"],
  stylist: null,
  availability: [{ days: ["Sat"], from: "09:00", to: "12:00" }],
  ...overrides,
});

test("a client who wants the service, any stylist, and is free then is eligible", () => {
  assert.equal(isEligible(client(), opening()), true);
});

test("a client who wants a different service is not eligible", () => {
  assert.equal(isEligible(client({ services: ["Color"] }), opening()), false);
});

test("a client who named a different stylist is not eligible", () => {
  assert.equal(isEligible(client({ stylist: "Lena" }), opening()), false);
  assert.equal(isEligible(client({ stylist: "Carla" }), opening()), true);
});

test("a client who is not free that day is not eligible", () => {
  assert.equal(isEligible(client({ availability: [{ days: ["Sun"], from: "09:00", to: "12:00" }] }), opening()), false);
});

test("the whole appointment must fit inside the client's free time", () => {
  // 11:30 + 45 minutes ends at 12:15, past the 12:00 window end.
  assert.equal(isEligible(client(), opening({ startsAt: at(2026, 10, 10, 11, 30) })), false);
  assert.equal(isEligible(client(), opening({ startsAt: at(2026, 10, 10, 11, 15) })), true);
});

test("stylist and service match regardless of case and extra spaces", () => {
  assert.equal(
    isEligible(client({ services: [" haircut "], stylist: "carla" }), opening({ stylist: "Carla ", service: "HAIRCUT" })),
    true,
  );
});

test("eligible clients are ordered by who joined the waitlist first", () => {
  const clients = [
    client({ id: "late", joinedAt: "2026-09-20T10:00:00Z" }),
    client({ id: "wrong-service", joinedAt: "2026-08-01T10:00:00Z", services: ["Color"] }),
    client({ id: "early", joinedAt: "2026-08-15T10:00:00Z" }),
  ];
  assert.deepEqual(eligibleClients(clients, opening()).map((c) => c.id), ["early", "late"]);
});
