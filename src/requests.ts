import {
  DEFAULT_OFFER_WINDOW_MINUTES,
  DEMO_OFFER_WINDOW_MINUTES,
  EXPIRED_MESSAGE,
  type CancelResult,
  type Opening,
  type OpeningStatus,
  type RespondResult,
} from "./types";

export type OpeningRequest = {
  stylist?: unknown;
  service?: unknown;
  date?: unknown;
  time?: unknown;
  durationMinutes?: unknown;
  demoSpeed?: unknown;
};

export function openingIdFor(stylist: string, date: string, time: string): string {
  const slug = stylist.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `opening-${slug}-${date}-${time.replace(":", "")}`;
}

export function parseOpeningRequest(
  body: OpeningRequest,
  now: Date = new Date(),
): { openingId: string; opening: Opening } | { error: string } {
  const stylist = typeof body.stylist === "string" ? body.stylist.trim() : "";
  const service = typeof body.service === "string" ? body.service.trim() : "";
  if (!stylist || !service) return { error: "Choose a stylist and a service." };

  const date = typeof body.date === "string" ? body.date : "";
  const time = typeof body.time === "string" ? body.time : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    return { error: "Enter the appointment date and time." };
  }
  const start = new Date(`${date}T${time}`); // salon-local time
  // Dates like Feb 30 or 24:00 roll over instead of failing, so check they round-trip.
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const roundTrips =
    start.getFullYear() === year &&
    start.getMonth() + 1 === month &&
    start.getDate() === day &&
    start.getHours() === hour &&
    start.getMinutes() === minute;
  if (Number.isNaN(start.getTime()) || !roundTrips) return { error: "That date or time isn't valid." };
  if (start.getTime() <= now.getTime()) return { error: "That appointment time has already passed." };

  const durationMinutes = Number(body.durationMinutes);
  if (!Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 480) {
    return { error: "Length must be between 15 and 480 minutes." };
  }

  return {
    openingId: openingIdFor(stylist, date, time),
    opening: {
      stylist,
      service,
      startsAt: start.toISOString(),
      durationMinutes,
      offerWindowMinutes: body.demoSpeed === true ? DEMO_OFFER_WINDOW_MINUTES : DEFAULT_OFFER_WINDOW_MINUTES,
    },
  };
}

// Answers a reply that reached an opening which has already finished.
export function lateReplyResult(status: OpeningStatus, clientId: string): RespondResult | undefined {
  if (status.bookedClient?.clientId === clientId) {
    return { outcome: "booked", message: "You're already booked for this opening." };
  }
  const wasOffered = status.texts.some((text) => text.clientId === clientId && text.kind === "offer");
  return wasOffered ? { outcome: "expired", message: EXPIRED_MESSAGE } : undefined;
}

// Answers a staff cancel that reached an opening which has already finished.
export function lateCancelResult(status: OpeningStatus): CancelResult {
  if (status.phase === "booked") {
    const name = status.bookedClient?.name ?? "A client";
    return { cancelled: false, message: `Too late to cancel: ${name} already accepted this opening.` };
  }
  return { cancelled: false, message: "This opening has already finished." };
}
