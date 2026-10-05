import assert from "node:assert/strict";
import { test } from "node:test";
import { ApplicationFailure } from "@temporalio/common";
import { MockActivityEnvironment } from "@temporalio/testing";
import { findEligibleClients, sendText } from "../src/activities";
import { setOutage } from "../src/store";
import type { Client } from "../src/types";

const env = new MockActivityEnvironment();
const client = (overrides: Partial<Client> = {}): Client => ({
  id: "c1", name: "Test Client", phone: "555-0100", joinedAt: "2026-09-01T10:00:00Z",
  services: ["Haircut"], stylist: null, availability: [], ...overrides,
});

test("findEligibleClients reads the seed waitlist in join order", async () => {
  // Monday 12 Oct 2026, 15:00 local: Haircut with Carla.
  const opening = {
    stylist: "Carla", service: "Haircut", startsAt: new Date(2026, 9, 12, 15, 0).toISOString(),
    durationMinutes: 45, offerWindowMinutes: 15,
  };
  const clients = await env.run(findEligibleClients, opening);
  assert.deepEqual(clients.map((c) => c.id), ["maya", "priya", "jordan", "elena"]);
});

test("sendText succeeds for a valid number", async () => {
  await env.run(sendText, { client: client(), body: "Hello" });
});

test("sendText rejects an invalid number without retrying", async () => {
  await assert.rejects(
    env.run(sendText, { client: client({ phoneValid: false }), body: "Hello" }),
    (error) => error instanceof ApplicationFailure && error.type === "InvalidPhoneNumber" && error.nonRetryable,
  );
});

test("sendText fails in a retryable way during an outage", async () => {
  await setOutage(true);
  try {
    await assert.rejects(
      env.run(sendText, { client: client(), body: "Hello" }),
      (error) => error instanceof ApplicationFailure && error.type === "TextServiceUnavailable" && !error.nonRetryable,
    );
  } finally {
    await setOutage(false);
  }
});
