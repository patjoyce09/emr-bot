export interface WellSkySelectors {
  usernameInput: string;
  passwordInput: string;
  loginButton: string;
  postLoginReadyMarker: string;
  dateFromInput: string;
  dateToInput: string;
  disciplineDropdown: string;
  disciplineOption: (discipline: string) => string;
  reportProfileInput: string;
  exportButton: string;
  reportReadyMarker: string;
}

export const wellSkySelectors: WellSkySelectors = {
  usernameInput: '[name="username"], input[type="email"]',
  passwordInput: '[name="password"], input[type="password"]',
  loginButton: 'button[type="submit"], button:has-text("Sign In")',
  postLoginReadyMarker: 'nav, [data-testid="app-shell"]',
  dateFromInput: 'input[name="date_from"], input[data-testid="date-from"]',
  dateToInput: 'input[name="date_to"], input[data-testid="date-to"]',
  disciplineDropdown: '[data-testid="discipline-filter"], select[name="discipline"]',
  disciplineOption: (discipline: string) => `text=${discipline}`,
  reportProfileInput: '[data-testid="report-profile"], select[name="report_profile"]',
  exportButton: 'button:has-text("Export"), button:has-text("Run Report")',
  reportReadyMarker: 'form, [data-testid="schedule-report-page"]'
};
