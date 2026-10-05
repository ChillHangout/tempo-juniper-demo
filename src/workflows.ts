import {
  ActivityFailure,
  ApplicationFailure,
  condition,
  defineQuery,
  defineUpdate,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type * as activities from "./activities";
import {
  CUTOFF_MINUTES,
  EXPIRED_MESSAGE,
  FINAL_PHASES,
  type CancelInput,
  type CancelResult,
  type Client,
  type ClientRef,
  type Notice,
  type Opening,
  type OpeningStatus,
  type Phase,
  type RespondInput,
  type RespondResult,
  type TextMessage,
} from "./types";

export const getStatus = defineQuery<OpeningStatus>("getStatus");
export const respondToOffer = defineUpdate<RespondResult, [RespondInput]>("respondToOffer");
export const cancelOpening = defineUpdate<CancelResult, [CancelInput]>("cancelOpening");

const { findEligibleClients } = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 seconds",
  retry: { maximumAttempts: 3 },
});

// Temporary texting outages are retried; an invalid number is a
// non-retryable failure thrown by the Activity itself.
const { sendText } = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 seconds",
  retry: { initialInterval: "1 second", backoffCoefficient: 2, maximumAttempts: 5 },
});

const iso = (ms: number) => new Date(ms).toISOString();
const refOf = (client: Client): ClientRef => ({ clientId: client.id, name: client.name });

function describeSlot(opening: Opening): string {
  const when = new Date(opening.startsAt).toLocaleString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${opening.service} with ${opening.stylist} on ${when}`;
}

function holdLabel(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`;
}

function isInvalidNumber(error: unknown): boolean {
  return (
    error instanceof ActivityFailure &&
    error.cause instanceof ApplicationFailure &&
    error.cause.type === "InvalidPhoneNumber"
  );
}

export async function fillOpening(openingId: string, opening: Opening): Promise<OpeningStatus> {
  const slot = describeSlot(opening);
  const cutoffMs = Date.parse(opening.startsAt) - CUTOFF_MINUTES * 60_000;
  const status: OpeningStatus = {
    openingId,
    opening,
    phase: "finding",
    headline: "Looking for clients on the waitlist who fit this opening.",
    cutoffAt: iso(cutoffMs),
    declined: [],
    timedOut: [],
    couldNotText: [],
    stillEligible: [],
    notices: [],
    timeline: [],
    texts: [],
  };
  const offered = new Set<string>();
  let reply: RespondInput | undefined; // the current offer holder's answer
  let cancelReason: string | undefined;

  const now = () => iso(Date.now());
  const record = (text: string) => status.timeline.push({ at: now(), text });
  const notify = (kind: Notice["kind"], text: string) => {
    status.notices.push({ at: now(), kind, text });
    record(text);
  };
  const logText = (clientId: string, from: TextMessage["from"], kind: TextMessage["kind"], body: string) =>
    status.texts.push({ at: now(), clientId, from, kind, body });
  const isBooked = () => reply?.accept === true;

  setHandler(getStatus, () => status);

  // Replies are handled one at a time, so only the current holder of an
  // open offer can ever book: this is what prevents double-booking.
  setHandler(
    respondToOffer,
    ({ clientId, accept }): RespondResult => {
      logText(clientId, "client", "reply", accept ? "YES" : "NO");
      if (isBooked() && reply?.clientId === clientId) {
        return { outcome: "booked", message: `You're already booked for ${slot}.` };
      }
      const offer = status.currentOffer;
      const offerIsOpen =
        offer?.clientId === clientId &&
        reply === undefined &&
        cancelReason === undefined &&
        Date.now() < Date.parse(offer.expiresAt);
      if (!offerIsOpen) {
        logText(clientId, "salon", "reply", EXPIRED_MESSAGE);
        return { outcome: "expired", message: EXPIRED_MESSAGE };
      }
      reply = { clientId, accept };
      if (accept) return { outcome: "booked", message: `You're booked for ${slot}. See you then!` };
      const message = "Thanks for letting us know. You'll stay on our waitlist for future openings.";
      logText(clientId, "salon", "reply", message);
      return { outcome: "declined", message };
    },
    {
      validator: ({ clientId }) => {
        if (!offered.has(clientId)) throw new Error("This client hasn't been offered this opening.");
      },
    },
  );

  setHandler(cancelOpening, ({ reason }): CancelResult => {
    if (isBooked() || status.phase === "booked") {
      const name = status.bookedClient?.name ?? status.currentOffer?.name ?? "A client";
      return { cancelled: false, message: `Too late to cancel: ${name} already accepted this opening.` };
    }
    if (FINAL_PHASES.includes(status.phase)) {
      return { cancelled: false, message: "This opening has already finished." };
    }
    if (cancelReason === undefined) cancelReason = reason.trim() || "no reason given";
    return { cancelled: true, message: "Cancelled. No more offers will be sent for this opening." };
  });

  const finish = (phase: Phase, headline: string, kind: Notice["kind"]): OpeningStatus => {
    status.phase = phase;
    status.headline = headline;
    status.currentOffer = undefined;
    notify(kind, headline);
    return status;
  };

  const textClient = async (client: Client, kind: TextMessage["kind"], body: string) => {
    await sendText({ client, body });
    logText(client.id, "salon", kind, body);
  };

  const stopForCancel = async (holder?: Client): Promise<OpeningStatus> => {
    finish("cancelled", `Cancelled by staff: ${cancelReason}.`, "stopped");
    if (holder) {
      try {
        await textClient(holder, "withdrawn", `Sorry, the ${slot} opening is no longer available. You're still on our waitlist.`);
      } catch {
        notify("problem", `Couldn't tell ${holder.name} the opening was cancelled. Please let them know.`);
      }
    }
    return status;
  };

  let clients: Client[];
  try {
    clients = await findEligibleClients(opening);
  } catch {
    return finish("failed", "Couldn't read the waitlist, so no offers were sent. Please contact clients directly.", "problem");
  }
  status.stillEligible = clients.map(refOf);
  record(clients.length === 1 ? "Found 1 eligible client." : `Found ${clients.length} eligible clients.`);

  for (const client of clients) {
    if (cancelReason !== undefined) return stopForCancel();
    if (Date.now() >= cutoffMs) {
      return finish("too_late", "Stopped offering: it's now too close to the appointment for a client to get ready and arrive.", "stopped");
    }

    status.stillEligible = status.stillEligible.filter((c) => c.clientId !== client.id);
    status.phase = "offering";
    status.headline = `Texting ${client.name}…`;
    const holdMs = Math.min(opening.offerWindowMinutes * 60_000, cutoffMs - Date.now());
    try {
      await textClient(
        client,
        "offer",
        `Hi ${client.name}, Juniper Salon has an opening: ${slot}. Reply YES to book it or NO to pass. We'll hold it for you for ${holdLabel(holdMs)}.`,
      );
    } catch (error) {
      if (isInvalidNumber(error)) {
        status.couldNotText.push(refOf(client));
        notify("problem", `Couldn't text ${client.name}: the phone number on file isn't a valid mobile number. Moving to the next client.`);
        continue;
      }
      return finish("failed", "Texts couldn't be sent, so the process stopped. Please contact clients directly.", "problem");
    }

    offered.add(client.id);
    if (cancelReason !== undefined) return stopForCancel(client);

    const sentAtMs = Date.now();
    const expiresAtMs = Math.min(sentAtMs + holdMs, cutoffMs);
    reply = undefined;
    status.currentOffer = { ...refOf(client), sentAt: iso(sentAtMs), expiresAt: iso(expiresAtMs) };
    status.headline = `Waiting for ${client.name} to reply.`;
    record(`Offered the opening to ${client.name}.`);

    // Durable timer: survives Worker restarts.
    await condition(() => reply !== undefined || cancelReason !== undefined, Math.max(expiresAtMs - sentAtMs, 1));
    status.currentOffer = undefined;
    // The Update handler sets `reply` while we wait; TypeScript can't see that.
    const answer = reply as RespondInput | undefined;

    if (answer?.accept) {
      status.bookedClient = refOf(client);
      finish("booked", `Booked: ${client.name} accepted. Remember to update Square.`, "booked");
      try {
        await textClient(client, "confirmation", `You're booked for ${slot}. See you then!`);
      } catch {
        notify("problem", `${client.name} is booked, but the confirmation text couldn't be sent. Please call them to confirm.`);
      }
      return status;
    }
    if (answer) {
      status.declined.push(refOf(client));
      record(`${client.name} declined.`);
      continue;
    }
    if (cancelReason !== undefined) return stopForCancel(client);
    status.timedOut.push(refOf(client));
    notify("expired", `The offer to ${client.name} expired without a reply.`);
  }

  if (cancelReason !== undefined) return stopForCancel();
  return finish(
    "nobody_available",
    clients.length === 0 ? "Nobody on the waitlist fits this opening." : "Everyone eligible was offered this opening and nobody accepted.",
    "nobody",
  );
}
