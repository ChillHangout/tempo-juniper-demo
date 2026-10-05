import type { Client, Opening, Weekday } from "./types";

const WEEKDAYS: Weekday[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function minutesOf(hhmm: string): number {
  const [hours, minutes] = hhmm.split(":").map(Number);
  return hours * 60 + minutes;
}

export function isEligible(client: Client, opening: Opening): boolean {
  if (!client.services.some((service) => sameName(service, opening.service))) return false;
  if (client.stylist !== null && !sameName(client.stylist, opening.stylist)) return false;

  const start = new Date(opening.startsAt);
  const day = WEEKDAYS[start.getDay()];
  const startMinute = start.getHours() * 60 + start.getMinutes();
  const endMinute = startMinute + opening.durationMinutes;
  return client.availability.some(
    (window) =>
      window.days.includes(day) && minutesOf(window.from) <= startMinute && endMinute <= minutesOf(window.to),
  );
}

export function eligibleClients(clients: Client[], opening: Opening): Client[] {
  return clients
    .filter((client) => isEligible(client, opening))
    .sort((a, b) => Date.parse(a.joinedAt) - Date.parse(b.joinedAt));
}
