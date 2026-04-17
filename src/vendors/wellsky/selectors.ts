import { readFile } from "node:fs/promises";

export interface WellSkySelectors {
  usernameInput: string;
  passwordInput: string;
  loginButton: string;
  postLoginReadyMarker: string;
  dateFromInput: string;
  dateToInput: string;
  disciplineDropdown: string;
  disciplineOptionTemplate: string;
  reportProfileInput: string;
  exportButton: string;
  reportReadyMarker: string;
}

export interface WellSkySelectorProfile {
  profile_id: string;
  version: string;
  selectors: WellSkySelectors;
}

export interface ResolvedWellSkySelectorProfile extends WellSkySelectorProfile {
  source: "base" | "tenant_override";
}

interface SelectorProfileOverride {
  version?: string;
  selectors?: Partial<WellSkySelectors>;
}

type TenantSelectorOverrideMap = Record<string, Record<string, SelectorProfileOverride>>;

const DEFAULT_PROFILE_ID = "default";

const baseSelectorProfiles: Record<string, WellSkySelectorProfile> = {
  default: {
    profile_id: DEFAULT_PROFILE_ID,
    version: "wellsky-base-v1",
    selectors: {
      usernameInput: '[name="username"], input[type="email"]',
      passwordInput: '[name="password"], input[type="password"]',
      loginButton: 'button[type="submit"], button:has-text("Sign In")',
      postLoginReadyMarker: 'nav, [data-testid="app-shell"]',
      dateFromInput: 'input[name="date_from"], input[data-testid="date-from"]',
      dateToInput: 'input[name="date_to"], input[data-testid="date-to"]',
      disciplineDropdown: '[data-testid="discipline-filter"], select[name="discipline"]',
      disciplineOptionTemplate: "text={{discipline}}",
      reportProfileInput: '[data-testid="report-profile"], select[name="report_profile"]',
      exportButton: 'button:has-text("Export"), button:has-text("Run Report")',
      reportReadyMarker: 'form, [data-testid="schedule-report-page"]'
    }
  }
};

function parseJsonObject(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

async function loadTenantOverrides(): Promise<TenantSelectorOverrideMap> {
  const fromEnvJson = parseJsonObject(process.env.WELLSKY_SELECTOR_OVERRIDES_JSON);
  if (fromEnvJson) {
    return fromEnvJson as TenantSelectorOverrideMap;
  }

  const filePath = process.env.WELLSKY_SELECTOR_OVERRIDES_PATH;
  if (!filePath) {
    return {};
  }

  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = parseJsonObject(raw);
    return (parsed || {}) as TenantSelectorOverrideMap;
  } catch {
    return {};
  }
}

function mergeSelectors(base: WellSkySelectors, patch?: Partial<WellSkySelectors>): WellSkySelectors {
  if (!patch) {
    return base;
  }

  return {
    ...base,
    ...patch
  };
}

function overrideFor(
  overrides: TenantSelectorOverrideMap,
  tenantId: string,
  profileId: string
): SelectorProfileOverride | undefined {
  const tenantSpecific = overrides[tenantId]?.[profileId];
  if (tenantSpecific) {
    return tenantSpecific;
  }

  const wildcard = overrides["*"]?.[profileId];
  return wildcard;
}

export function selectorForDiscipline(selectors: WellSkySelectors, discipline: string): string {
  return selectors.disciplineOptionTemplate.replaceAll("{{discipline}}", discipline);
}

export async function resolveWellSkySelectorProfile(
  tenantId: string,
  selectorProfileId?: string
): Promise<ResolvedWellSkySelectorProfile> {
  const resolvedProfileId = selectorProfileId || DEFAULT_PROFILE_ID;
  const baseProfile = baseSelectorProfiles[resolvedProfileId] || baseSelectorProfiles[DEFAULT_PROFILE_ID];

  if (!baseProfile) {
    throw new Error("No WellSky base selector profile configured.");
  }

  const overrides = await loadTenantOverrides();
  const override = overrideFor(overrides, tenantId, resolvedProfileId);

  if (!override) {
    return {
      ...baseProfile,
      profile_id: resolvedProfileId,
      source: "base"
    };
  }

  return {
    profile_id: resolvedProfileId,
    version: override.version || baseProfile.version,
    selectors: mergeSelectors(baseProfile.selectors, override.selectors),
    source: "tenant_override"
  };
}
