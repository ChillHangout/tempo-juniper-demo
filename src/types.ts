export const TASK_QUEUE = "juniper-backfill";
export const CUTOFF_MINUTES = 45;
export const DEFAULT_OFFER_WINDOW_MINUTES = 15;
export const DEMO_OFFER_WINDOW_MINUTES = 0.5;
export const EXPIRED_MESSAGE =
  "Sorry, this offer has expired and the opening may have gone to someone else. You're still on our waitlist.";

export type Weekday = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";

export type AvailabilityWindow = { days: Weekday[]; from: string; to: string };

export type Client = {
  id: string;
  name: string;
  phone: string;
  joinedAt: string;
  services: string[];
  stylist: string | null; // null = any stylist
  availability: AvailabilityWindow[];
  phoneValid?: boolean; // false = simulate an invalid number
};

export type SalonData = {
  stylists: string[];
  services: { name: string; minutes: number }[];
  clients: Client[];
};

export type ClientRef = { clientId: string; name: string };

export type Opening = {
  stylist: string;
  service: string;
  startsAt: string; // absolute ISO instant
  durationMinutes: number;
  offerWindowMinutes: number;
};

export type Phase =
  | "finding"
  | "offering"
  | "booked"
  | "nobody_available"
  | "too_late"
  | "cancelled"
  | "failed";

export const FINAL_PHASES: readonly Phase[] = [
  "booked",
  "nobody_available",
  "too_late",
  "cancelled",
  "failed",
];

export type Notice = {
  at: string;
  kind: "booked" | "expired" | "nobody" | "stopped" | "problem";
  text: string;
};

export type TextMessage = {
  at: string;
  clientId: string;
  from: "salon" | "client";
  kind: "offer" | "reply" | "confirmation" | "withdrawn";
  body: string;
};

export type OpeningStatus = {
  openingId: string;
  opening: Opening;
  phase: Phase;
  headline: string;
  cutoffAt: string;
  currentOffer?: ClientRef & { sentAt: string; expiresAt: string };
  bookedClient?: ClientRef;
  declined: ClientRef[];
  timedOut: ClientRef[];
  couldNotText: ClientRef[];
  stillEligible: ClientRef[];
  notices: Notice[];
  timeline: { at: string; text: string }[];
  texts: TextMessage[];
};

export type RespondInput = { clientId: string; accept: boolean };
export type RespondResult = { outcome: "booked" | "declined" | "expired"; message: string };
export type CancelInput = { reason: string };
export type CancelResult = { cancelled: boolean; message: string };
