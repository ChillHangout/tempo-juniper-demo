import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { WorkflowUpdateFailedError } from "@temporalio/client";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type * as activities from "../src/activities";
import type { Client, Opening, OpeningStatus } from "../src/types";
import { cancelOpening, fillOpening, getStatus, respondToOffer } from "../src/workflows";

const TASK_QUEUE = "juniper-test";
let env: TestWorkflowEnvironment;
let worker: Worker;
let running: Promise<void>;

// Each test reconfigures these; the mock Activities read them.
let waitlist: Client[] = [];
let sent: { clientId: string; body: string }[] = [];
let failSend: (client: Client, body: string) => Error | undefined = () => undefined;

const mockActivities: typeof activities = {
  async findEligibleClients() {
    return waitlist;
  },
  async sendText({ client, body }) {
    const error = failSend(client, body);
    if (error) throw error;
    sent.push({ clientId: client.id, body });
  },
};

const person = (id: string, name: string): Client => ({
  id, name, phone: "555-0100", joinedAt: "2026-09-01T00:00:00Z", services: ["Haircut"], stylist: null, availability: [],
});

before(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
  worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve("../src/workflows"),
    activities: mockActivities,
  });
  running = worker.run();
});

after(async () => {
  worker.shutdown();
  await running;
  await env.teardown();
});

beforeEach(() => {
  waitlist = [person("ana", "Ana"), person("ben", "Ben"), person("cy", "Cy")];
  sent = [];
  failSend = () => undefined;
});

let counter = 0;
async function startOpening(options: { minutesUntilStart?: number } = {}) {
  const nowMs = await env.currentTimeMs();
  const opening: Opening = {
    stylist: "Carla",
    service: "Haircut",
    startsAt: new Date(nowMs + (options.minutesUntilStart ?? 24 * 60) * 60_000).toISOString(),
    durationMinutes: 45,
    offerWindowMinutes: 15,
  };
  const id = `test-opening-${++counter}`;
  return env.client.workflow.start(fillOpening, { workflowId: id, taskQueue: TASK_QUEUE, args: [id, opening] });
}
type Handle = Awaited<ReturnType<typeof startOpening>>;

async function waitFor(handle: Handle, check: (status: OpeningStatus) => boolean): Promise<OpeningStatus> {
  let last: OpeningStatus | undefined;
  for (let i = 0; i < 200; i++) {
    last = await handle.query(getStatus);
    if (check(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Condition never met. Last status: ${JSON.stringify(last)}`);
}

const holder = (clientId: string) => (status: OpeningStatus) => status.currentOffer?.clientId === clientId;
const reply = (handle: Handle, clientId: string, accept: boolean) =>
  handle.executeUpdate(respondToOffer, { args: [{ clientId, accept }] });
const offersSentTo = () => sent.filter((text) => text.body.includes("Reply YES")).map((text) => text.clientId);
const FIFTEEN_MINUTES_AND_A_BIT = 15 * 60_000 + 1_000;

test("offers to the earliest client first, and a yes books them", async () => {
  const handle = await startOpening();
  await waitFor(handle, holder("ana"));
  const result = await reply(handle, "ana", true);
  assert.equal(result.outcome, "booked");
  const final = await handle.result();
  assert.equal(final.phase, "booked");
  assert.equal(final.bookedClient?.clientId, "ana");
  assert.deepEqual(offersSentTo(), ["ana"]);
  assert.ok(sent.some((text) => text.clientId === "ana" && text.body.startsWith("You're booked")));
});

test("after 15 minutes without a reply, the offer moves to the next client", async () => {
  const handle = await startOpening();
  const first = await waitFor(handle, holder("ana"));
  assert.equal(Date.parse(first.currentOffer!.expiresAt) - Date.parse(first.currentOffer!.sentAt), 15 * 60_000);
  await env.sleep(FIFTEEN_MINUTES_AND_A_BIT);
  const second = await waitFor(handle, holder("ben"));
  assert.deepEqual(second.timedOut.map((c) => c.clientId), ["ana"]);
  assert.ok(second.notices.some((n) => n.kind === "expired" && n.text.includes("Ana")));
  await handle.terminate();
});

test("a late yes is refused with the expired message, and only the current holder can book", async () => {
  const handle = await startOpening();
  await waitFor(handle, holder("ana"));
  await env.sleep(FIFTEEN_MINUTES_AND_A_BIT);
  await waitFor(handle, holder("ben"));
  const late = await reply(handle, "ana", true);
  assert.equal(late.outcome, "expired");
  assert.match(late.message, /offer has expired/);
  const stillBen = await handle.query(getStatus);
  assert.equal(stillBen.currentOffer?.clientId, "ben");
  assert.equal((await reply(handle, "ben", true)).outcome, "booked");
  const final = await handle.result();
  assert.equal(final.bookedClient?.clientId, "ben");
});

test("a client who was never offered the opening cannot reply", async () => {
  const handle = await startOpening();
  await waitFor(handle, holder("ana"));
  await assert.rejects(reply(handle, "cy", true), WorkflowUpdateFailedError);
  await handle.terminate();
});

test("a decline moves straight to the next client; if everyone declines, nobody is available", async () => {
  const handle = await startOpening();
  for (const id of ["ana", "ben", "cy"]) {
    await waitFor(handle, holder(id));
    assert.equal((await reply(handle, id, false)).outcome, "declined");
  }
  const final = await handle.result();
  assert.equal(final.phase, "nobody_available");
  assert.deepEqual(final.declined.map((c) => c.clientId), ["ana", "ben", "cy"]);
  assert.ok(final.notices.some((n) => n.kind === "nobody"));
});

test("staff can cancel while an offer is out, and the client is told", async () => {
  const handle = await startOpening();
  await waitFor(handle, holder("ana"));
  const result = await handle.executeUpdate(cancelOpening, { args: [{ reason: "Original client is coming after all" }] });
  assert.equal(result.cancelled, true);
  const final = await handle.result();
  assert.equal(final.phase, "cancelled");
  assert.match(final.headline, /Original client is coming after all/);
  assert.ok(sent.some((text) => text.clientId === "ana" && text.body.includes("no longer available")));
});

test("after a yes, a second tap says already booked and staff can no longer cancel", async () => {
  // Slow down the confirmation text so the opening stays open for the follow-up messages.
  let confirmationAttempts = 0;
  failSend = (_client, body) =>
    body.startsWith("You're booked") && confirmationAttempts++ < 2
      ? ApplicationFailure.retryable("slow network", "TextServiceUnavailable")
      : undefined;
  const handle = await startOpening();
  await waitFor(handle, holder("ana"));
  assert.equal((await reply(handle, "ana", true)).outcome, "booked");
  const again = await reply(handle, "ana", true);
  assert.equal(again.outcome, "booked");
  assert.match(again.message, /already booked/);
  const cancel = await handle.executeUpdate(cancelOpening, { args: [{ reason: "Stylist sick" }] });
  assert.equal(cancel.cancelled, false);
  assert.match(cancel.message, /Too late to cancel/);
  const final = await handle.result();
  assert.equal(final.phase, "booked");
});

test("with nobody eligible, the process stops with a notice and sends nothing", async () => {
  waitlist = [];
  const final = await (await startOpening()).result();
  assert.equal(final.phase, "nobody_available");
  assert.ok(final.notices.some((n) => n.kind === "nobody"));
  assert.equal(sent.length, 0);
});

test("an offer never runs past the cutoff, and no offers are sent after it", async () => {
  const handle = await startOpening({ minutesUntilStart: 50 }); // cutoff in 5 minutes
  const status = await waitFor(handle, holder("ana"));
  const windowMs = Date.parse(status.currentOffer!.expiresAt) - Date.parse(status.currentOffer!.sentAt);
  assert.ok(windowMs <= 5 * 60_000 && windowMs > 4 * 60_000, `window was ${windowMs} ms`);
  const final = await handle.result();
  assert.equal(final.phase, "too_late");
  assert.deepEqual(offersSentTo(), ["ana"]);
  assert.ok(final.notices.some((n) => n.kind === "stopped"));
});

test("an opening logged inside the cutoff sends no offers", async () => {
  const final = await (await startOpening({ minutesUntilStart: 30 })).result();
  assert.equal(final.phase, "too_late");
  assert.equal(sent.length, 0);
});

test("an invalid phone number is skipped and the next client is offered", async () => {
  failSend = (client) =>
    client.id === "ana" ? ApplicationFailure.nonRetryable("bad number", "InvalidPhoneNumber") : undefined;
  const handle = await startOpening();
  const status = await waitFor(handle, holder("ben"));
  assert.deepEqual(status.couldNotText.map((c) => c.clientId), ["ana"]);
  assert.ok(status.notices.some((n) => n.kind === "problem" && n.text.includes("Ana")));
  await handle.terminate();
});

test("a text outage that outlasts the retries stops the process and asks staff to step in", async () => {
  failSend = () => ApplicationFailure.retryable("service down", "TextServiceUnavailable");
  const final = await (await startOpening()).result();
  assert.equal(final.phase, "failed");
  assert.ok(final.notices.some((n) => n.kind === "problem" && /contact clients directly/.test(n.text)));
  assert.equal(sent.length, 0);
});
