import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SalonData } from "./types";

const SALON_PATH = path.join(process.cwd(), "data", "waitlist.json");
// The API and the Worker are separate processes; a flag file lets the page
// switch the simulated text outage on for the Worker.
const OUTAGE_FLAG_PATH = path.join(process.cwd(), ".runtime", "sms-outage");

export async function loadSalon(): Promise<SalonData> {
  return JSON.parse(await readFile(SALON_PATH, "utf8")) as SalonData;
}

export function isOutageOn(): boolean {
  return existsSync(OUTAGE_FLAG_PATH);
}

export async function setOutage(on: boolean): Promise<void> {
  if (on) {
    await mkdir(path.dirname(OUTAGE_FLAG_PATH), { recursive: true });
    await writeFile(OUTAGE_FLAG_PATH, "on");
  } else {
    await rm(OUTAGE_FLAG_PATH, { force: true });
  }
}
