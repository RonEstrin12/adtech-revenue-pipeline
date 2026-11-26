/**
 * Stage 6: QA thresholds and alert settings from the environment (documented in .env.example).
 */

export interface QaConfig {
  /** Partners that must report every day. */
  expectedPartners: string[];
  /** Reject share (fraction of rows received, 0.25 = 25%) above which a partner-day warns / fails. */
  warnRejectShare: number;
  maxRejectShare: number;
  /** Absolute day-over-day revenue change, in percent, above which a partner-day warns / fails. */
  warnDodChangePct: number;
  maxDodChangePct: number;
}

export const QA_DEFAULTS: QaConfig = {
  expectedPartners: ["a", "b"],
  // The seeded mock data rejects 20% (partner A) and 30% (partner B) every day by design.
  // 0.25 makes partner B's 30% visible as a warning; 0.4 fails only when a partner's file is
  // clearly broken (two rows in five unusable), so a normal day does not page anyone.
  warnRejectShare: 0.25,
  maxRejectShare: 0.4,
  // Seeded days move between -20% and +10%. A 25% move is worth a look; 50% (revenue halved,
  // or up by half) usually means a missing site, a wrong currency or a partner-side outage.
  warnDodChangePct: 25,
  maxDodChangePct: 50,
};

function number(env: NodeJS.ProcessEnv, name: string, fallback: number, max = Infinity): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`${name} must be a number between 0 and ${max}, got "${raw}"`);
  return n;
}

export function loadQaConfig(env: NodeJS.ProcessEnv = process.env): QaConfig {
  const partners = (env.QA_EXPECTED_PARTNERS ?? "")
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const config: QaConfig = {
    expectedPartners: partners.length > 0 ? [...new Set(partners)] : QA_DEFAULTS.expectedPartners,
    warnRejectShare: number(env, "QA_WARN_REJECT_SHARE", QA_DEFAULTS.warnRejectShare, 1),
    maxRejectShare: number(env, "QA_MAX_REJECT_SHARE", QA_DEFAULTS.maxRejectShare, 1),
    warnDodChangePct: number(env, "QA_WARN_DOD_CHANGE_PCT", QA_DEFAULTS.warnDodChangePct),
    maxDodChangePct: number(env, "QA_MAX_DOD_CHANGE_PCT", QA_DEFAULTS.maxDodChangePct),
  };
  // A warn level above the fail level would never be reached; clamp it instead of failing the run.
  config.warnRejectShare = Math.min(config.warnRejectShare, config.maxRejectShare);
  config.warnDodChangePct = Math.min(config.warnDodChangePct, config.maxDodChangePct);
  return config;
}

export type AlertMode = "dry-run" | "github";

/** Real GitHub calls only when QA_ALERTS=github; anything else is a dry run that only prints. */
export function alertMode(env: NodeJS.ProcessEnv = process.env): AlertMode {
  return env.QA_ALERTS?.trim().toLowerCase() === "github" ? "github" : "dry-run";
}
