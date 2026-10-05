import { ApplicationFailure, log } from "@temporalio/activity";
import { eligibleClients } from "./eligibility";
import { isOutageOn, loadSalon } from "./store";
import type { Client, Opening } from "./types";

export async function findEligibleClients(opening: Opening): Promise<Client[]> {
  const salon = await loadSalon();
  return eligibleClients(salon.clients, opening);
}

// Simulated text provider: nothing leaves the machine.
export async function sendText(input: { client: Client; body: string }): Promise<void> {
  const { client, body } = input;
  if (client.phoneValid === false) {
    throw ApplicationFailure.nonRetryable(`${client.phone} is not a valid mobile number`, "InvalidPhoneNumber");
  }
  if (isOutageOn()) {
    throw ApplicationFailure.retryable("The text message service is unavailable", "TextServiceUnavailable");
  }
  log.info("Simulated text sent", { to: client.phone, body });
}
