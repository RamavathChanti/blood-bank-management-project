/** Official public list prices checked 2026-10-29. USD; no exchange-rate assumption. */
export const COST_LIMITS = {
  checkedOn: "2026-10-29", currency: "USD",
  inngest: { freeExecutions: 50_000, freeConcurrentSteps: 5, freeEvents: 500_000, freeQueueDepth: 100_000, proMonthly: 99, proExecutions: 1_000_000, source: "https://www.inngest.com/pricing" },
  atlas: { freeOpsPerSecond: 100, freeConnections: 500, freeStorageMB: 512, dedicatedStartingMonthly: 56.94, source: "https://www.mongodb.com/pricing", limitsSource: "https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/" },
  vercel: { hobbyInvocations: 1_000_000, hobbyCpuHours: 4, hobbyMemoryGBHours: 360, proSeatMonthly: 20, cpuStartingHourly: .128, memoryStartingGBHourly: .0106, invocationPerMillion: .60, source: "https://vercel.com/pricing", eligibilitySource: "https://vercel.com/docs/plans/hobby" },
  ably: { implemented: false, freeConnections: 200, freeMessages: 6_000_000, standardMonthly: 29, perMillionMessages: 2.5, perMillionConnectionMinutes: 1, perMillionChannelMinutes: 1, source: "https://ably.com/pricing" },
  clerk: { freeRetainedUsers: 50_000, freeRetainedOrganizations: 100, source: "https://clerk.com/pricing" },
  assumptions: { banks: 300, requestsPerDay: 1000, days: 30, executionsPerRequest: 30, invocationsPerRequest: 35, dbCommandsPerRequest: 200, cpuMsPerInvocation: 20, wallMsPerInvocation: 200, memoryGB: 1, bankPollSeconds: 30, bankActiveHoursPerDay: 8, developers: 1 }
} as const;
export type CostAssumptions = { [K in keyof typeof COST_LIMITS.assumptions]: number };
export function costProjection(input: CostAssumptions = COST_LIMITS.assumptions) {
  if (Object.values(input).some(n => !Number.isFinite(n) || n < 0) || input.bankPollSeconds <= 0 || input.days <= 0 || input.wallMsPerInvocation < input.cpuMsPerInvocation) throw new Error("Invalid cost assumptions");
  const requests = input.requestsPerDay * input.days;
  const polling = input.banks * input.bankActiveHoursPerDay * 3600 / input.bankPollSeconds * input.days;
  const invocations = requests * input.invocationsPerRequest + polling;
  const executions = requests * input.executionsPerRequest;
  const cpuHours = invocations * input.cpuMsPerInvocation / 3600000;
  const memoryGBHours = invocations * input.wallMsPerInvocation / 3600000 * input.memoryGB;
  return { requests, polling, invocations, executions, cpuHours, memoryGBHours,
    estimatedDbCommands: requests * input.dbCommandsPerRequest + polling,
    freeExecutionDays: input.requestsPerDay * input.executionsPerRequest ? COST_LIMITS.inngest.freeExecutions / (input.requestsPerDay * input.executionsPerRequest) : null,
    paidBaseFloorUSD: input.developers * COST_LIMITS.vercel.proSeatMonthly + COST_LIMITS.atlas.dedicatedStartingMonthly + COST_LIMITS.inngest.proMonthly,
    optionalAblyBaseUSD: COST_LIMITS.ably.standardMonthly,
    grossComputeListEstimateUSD: cpuHours * COST_LIMITS.vercel.cpuStartingHourly + memoryGBHours * COST_LIMITS.vercel.memoryStartingGBHourly + invocations / 1_000_000 * COST_LIMITS.vercel.invocationPerMillion };
}
