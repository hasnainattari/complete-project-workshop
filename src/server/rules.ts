// Pure business rules for HCM Lite. No DB, no framework — fully unit-testable.
export interface HcmSettings {
  office_start_time: string; // "09:00"
  grace_minutes: number;
  half_day_hours: number;
  weekend_days: number[]; // 0 = Sunday ... 6 = Saturday
  timezone: string; // IANA, e.g. "Asia/Karachi"
}

export const DEFAULT_SETTINGS: HcmSettings = {
  office_start_time: "09:00",
  grace_minutes: 15,
  half_day_hours: 5,
  weekend_days: [0, 6], // Sat-Sun
  timezone: "Asia/Karachi",
};

export type AttendanceStatus =
  | "present"
  | "late"
  | "half_day"
  | "missing_checkout"
  | "absent"
  | "on_leave";

// ---------- date helpers (timezone aware) ----------

export function dateKeyInTz(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date); // YYYY-MM-DD
}

export function weekdayOfKey(key: string): number {
  return parseDateKey(key).getUTCDay();
}

// Calendar date at fixed noon-UTC — safe for key math, never a wall-clock time.
export function parseDateKey(key: string): Date {
  return new Date(key + "T12:00:00Z");
}

export function keyOfCalendarDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDaysKey(key: string, days: number): string {
  const d = parseDateKey(key);
  d.setUTCDate(d.getUTCDate() + days);
  return keyOfCalendarDate(d);
}

export function minutesOfDayInTz(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return h * 60 + m;
}

export function parseHm(hm: string): number {
  const parts = hm.split(":").map(Number);
  const h = Number(parts[0] ?? 0) || 0;
  const m = Number(parts[1] ?? 0) || 0;
  return h * 60 + m;
}

// ---------- attendance rules ----------

export function isLate(checkIn: Date, settings: HcmSettings): boolean {
  return (
    minutesOfDayInTz(checkIn, settings.timezone) >
    parseHm(settings.office_start_time) + settings.grace_minutes
  );
}

export function statusForCheckIn(checkIn: Date, settings: HcmSettings): "present" | "late" {
  return isLate(checkIn, settings) ? "late" : "present";
}

export function statusForCheckout(
  checkIn: Date,
  checkOut: Date,
  wasLate: boolean,
  settings: HcmSettings,
): "present" | "late" | "half_day" {
  const minutes = Math.max(0, Math.round((checkOut.getTime() - checkIn.getTime()) / 60000));
  if (minutes < settings.half_day_hours * 60) return "half_day";
  return wasLate ? "late" : "present";
}

export function minutesWorkedBetween(checkIn: Date, checkOut: Date): number {
  return Math.max(0, Math.round((checkOut.getTime() - checkIn.getTime()) / 60000));
}

// ---------- calendar / working days ----------

export function monthRange(monthKey: string): { start: string; end: string } {
  const [y, m] = monthKey.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1, 12));
  const end = new Date(Date.UTC(y, m, 0, 12));
  return { start: keyOfCalendarDate(start), end: keyOfCalendarDate(end) };
}

export function workingDaysBetween(
  startKey: string,
  endKey: string,
  weekendDays: number[],
  holidays: Set<string>,
): number {
  if (startKey > endKey) return 0;
  let count = 0;
  for (let d = parseDateKey(startKey); d <= parseDateKey(endKey); d.setUTCDate(d.getUTCDate() + 1)) {
    const key = keyOfCalendarDate(d);
    if (weekendDays.includes(d.getUTCDay())) continue;
    if (holidays.has(key)) continue;
    count++;
  }
  return count;
}

export function eachDateKey(startKey: string, endKey: string): string[] {
  const out: string[] = [];
  if (startKey > endKey) return out;
  for (let d = parseDateKey(startKey); d <= parseDateKey(endKey); d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(keyOfCalendarDate(d));
  }
  return out;
}

export function isWorkingDay(key: string, weekendDays: number[], holidays: Set<string>): boolean {
  return !weekendDays.includes(weekdayOfKey(key)) && !holidays.has(key);
}

// ---------- payroll ----------

/** Annual income tax by slab (annualised monthly gross). */
export function annualTax(annual: number): number {
  if (annual <= 600_000) return 0;
  if (annual <= 1_200_000) return (annual - 600_000) * 0.05;
  if (annual <= 2_400_000) return 30_000 + (annual - 1_200_000) * 0.15;
  if (annual <= 3_600_000) return 210_000 + (annual - 2_400_000) * 0.25;
  return 510_000 + (annual - 3_600_000) * 0.35;
}

export interface PayrollInput {
  basic: number;
  joinDate: string;
  exitDate: string | null;
  monthStart: string;
  monthEnd: string;
  workingDays: number;
  weekendDays: number[];
  holidays: Set<string>;
  /** dateKey -> status for recorded attendance in the month */
  dayStatuses: Record<string, string>;
  /** approved paid-leave working days inside the month */
  paidLeaveDays: number;
  /** approved unpaid-leave working days inside the month */
  unpaidLeaveDays: number;
}

export interface PayrollResult {
  employedDays: number;
  presentEq: number;
  halfDays: number;
  absentDays: number;
  paidLeaveDays: number;
  unpaidLeaveDays: number;
  deductionDays: number;
  perDay: number;
  gross: number;
  hra: number;
  medical: number;
  proratedGross: number;
  deductions: number;
  monthlyTax: number;
  net: number;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computePayslip(input: PayrollInput): PayrollResult {
  const rangeStart = input.joinDate > input.monthStart ? input.joinDate : input.monthStart;
  const rawEnd = input.exitDate && input.exitDate < input.monthEnd ? input.exitDate : input.monthEnd;
  const rangeEnd = rawEnd;
  const employedDays =
    rangeStart > rangeEnd
      ? 0
      : workingDaysBetween(rangeStart, rangeEnd, input.weekendDays, input.holidays);

  const gross = input.basic * 1.5; // HRA 40% + medical 10%
  const hra = input.basic * 0.4;
  const medical = input.basic * 0.1;
  const perDay = input.workingDays > 0 ? gross / input.workingDays : 0;

  let presentEq = 0;
  let halfDays = 0;
  for (const [key, status] of Object.entries(input.dayStatuses)) {
    if (key < rangeStart || key > rangeEnd) continue;
    if (status === "present" || status === "late" || status === "missing_checkout") presentEq += 1;
    else if (status === "half_day") {
      presentEq += 0.5;
      halfDays += 1;
    }
  }

  const absentDays = Math.max(
    0,
    employedDays - presentEq - input.paidLeaveDays - input.unpaidLeaveDays,
  );
  const deductionDays = absentDays + input.unpaidLeaveDays + 0.5 * halfDays;

  const proratedGross = input.workingDays > 0 ? (gross * employedDays) / input.workingDays : 0;
  const deductions = deductionDays * perDay;
  const monthlyTax = annualTax(proratedGross * 12) / 12;
  const net = proratedGross - deductions - monthlyTax;

  return {
    employedDays,
    presentEq,
    halfDays,
    absentDays,
    paidLeaveDays: input.paidLeaveDays,
    unpaidLeaveDays: input.unpaidLeaveDays,
    deductionDays: round2(deductionDays),
    perDay: round2(perDay),
    gross: round2(gross),
    hra: round2(hra),
    medical: round2(medical),
    proratedGross: round2(proratedGross),
    deductions: round2(deductions),
    monthlyTax: round2(monthlyTax),
    net: round2(net),
  };
}

// ---------- leave ----------

export function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

export interface LeaveValidationInput {
  startKey: string;
  endKey: string;
  weekendDays: number[];
  holidays: Set<string>;
  quota: number; // annual_quota of the type (Infinity not supported: use null)
  isUnpaid: boolean;
  usedApprovedDays: number; // approved days of this type in the same year
  pendingDaysSameRange: boolean; // any overlapping pending/approved application exists
}

export function validateLeave(input: LeaveValidationInput): { ok: true; days: number } | { ok: false; error: string } {
  if (input.startKey > input.endKey) return { ok: false, error: "Leave start date must be before end date." };
  if (input.pendingDaysSameRange)
    return { ok: false, error: "You already have a pending or approved leave overlapping these dates." };
  const days = workingDaysBetween(input.startKey, input.endKey, input.weekendDays, input.holidays);
  if (days <= 0)
    return { ok: false, error: "Selected range has no working days (weekend or holiday only)." };
  if (!input.isUnpaid && input.usedApprovedDays + days > input.quota) {
    const left = Math.max(0, input.quota - input.usedApprovedDays);
    return {
      ok: false,
      error: `Not enough leave balance: ${left} day(s) left but you requested ${days}.`,
    };
  }
  return { ok: true, days };
}
