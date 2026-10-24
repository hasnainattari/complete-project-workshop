import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  annualTax,
  computePayslip,
  isLate,
  monthRange,
  rangesOverlap,
  statusForCheckout,
  validateLeave,
  workingDaysBetween,
} from "../server/rules";

const S = DEFAULT_SETTINGS; // 09:00 start, 15 min grace, 5h half day, Sat-Sun weekend, Asia/Karachi

function mkDate(h: number, m: number): Date {
  // 10:05 PKT on a fixed date = 05:05 UTC
  return new Date(`2026-03-02T${String(h - 5).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
}

describe("attendance rules", () => {
  it("marks check-in on time within grace as present", () => {
    expect(isLate(mkDate(9, 10), S)).toBe(false); // 09:10 ≤ 09:15
  });

  it("marks check-in after grace as late", () => {
    expect(isLate(mkDate(9, 16), S)).toBe(true); // 09:16 > 09:15
  });

  it("marks under half-day hours as half_day at checkout", () => {
    const checkIn = mkDate(9, 0);
    const checkOut = mkDate(13, 45); // 4h45m < 5h
    expect(statusForCheckout(checkIn, checkOut, false, S)).toBe("half_day");
  });

  it("keeps late status for a full day that started late", () => {
    const checkIn = mkDate(10, 0);
    const checkOut = mkDate(18, 0); // 8h
    expect(statusForCheckout(checkIn, checkOut, true, S)).toBe("late");
  });
});

describe("working days", () => {
  it("counts working days skipping Sat-Sun", () => {
    // Mar 2026: 1st is Sunday; 2-6 Mon-Fri
    expect(workingDaysBetween("2026-03-02", "2026-03-08", S.weekend_days, new Set())).toBe(5);
  });

  it("excludes public holidays", () => {
    expect(
      workingDaysBetween("2026-03-02", "2026-03-03", S.weekend_days, new Set(["2026-03-02"])),
    ).toBe(1);
  });

  it("returns zero for inverted ranges", () => {
    expect(workingDaysBetween("2026-03-05", "2026-03-02", S.weekend_days, new Set())).toBe(0);
  });
});

describe("leave validation", () => {
  it("counts only working days for a range spanning a weekend", () => {
    // Fri 06 Mar to Mon 09 Mar 2026 -> 2 working days
    const res = validateLeave({
      startKey: "2026-03-06",
      endKey: "2026-03-09",
      weekendDays: S.weekend_days,
      holidays: new Set(),
      quota: 14,
      isUnpaid: false,
      usedApprovedDays: 0,
      pendingDaysSameRange: false,
    });
    expect(res).toEqual({ ok: true, days: 2 });
  });

  it("rejects when balance is exceeded", () => {
    const res = validateLeave({
      startKey: "2026-03-02",
      endKey: "2026-03-06",
      weekendDays: S.weekend_days,
      holidays: new Set(),
      quota: 14,
      isUnpaid: false,
      usedApprovedDays: 12,
      pendingDaysSameRange: false,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Not enough leave balance");
  });

  it("rejects overlapping pending or approved applications", () => {
    const res = validateLeave({
      startKey: "2026-03-02",
      endKey: "2026-03-02",
      weekendDays: S.weekend_days,
      holidays: new Set(),
      quota: 14,
      isUnpaid: false,
      usedApprovedDays: 0,
      pendingDaysSameRange: true,
    });
    expect(res.ok).toBe(false);
  });

  it("skips balance check for unpaid leave but still rejects weekend-only ranges", () => {
    const ok = validateLeave({
      startKey: "2026-03-02",
      endKey: "2026-03-20",
      weekendDays: S.weekend_days,
      holidays: new Set(),
      quota: 0,
      isUnpaid: true,
      usedApprovedDays: 999,
      pendingDaysSameRange: false,
    });
    expect(ok.ok).toBe(true);
    const weekendOnly = validateLeave({
      startKey: "2026-03-07",
      endKey: "2026-03-08",
      weekendDays: S.weekend_days,
      holidays: new Set(),
      quota: 14,
      isUnpaid: false,
      usedApprovedDays: 0,
      pendingDaysSameRange: false,
    });
    expect(weekendOnly.ok).toBe(false);
  });

  it("detects overlapping date ranges", () => {
    expect(rangesOverlap("2026-03-02", "2026-03-04", "2026-03-04", "2026-03-06")).toBe(true);
    expect(rangesOverlap("2026-03-02", "2026-03-04", "2026-03-05", "2026-03-06")).toBe(false);
  });
});

describe("tax slabs", () => {
  it("charges nothing up to 600k", () => {
    expect(annualTax(600_000)).toBe(0);
  });
  it("charges 5% from 600k to 1.2M", () => {
    expect(annualTax(1_200_000)).toBe(30_000);
  });
  it("charges 30k + 15% up to 2.4M", () => {
    expect(annualTax(2_400_000)).toBe(210_000);
  });
  it("charges 210k + 25% up to 3.6M", () => {
    expect(annualTax(3_600_000)).toBe(510_000);
  });
  it("charges 510k + 35% above 3.6M", () => {
    expect(annualTax(4_000_000)).toBe(650_000);
  });
});

describe("payroll", () => {
  const month = monthRange("2026-03"); // Mar 2026: 22 working days
  const base = {
    joinDate: "2026-01-01",
    exitDate: null,
    monthStart: month.start,
    monthEnd: month.end,
    workingDays: 22,
    weekendDays: S.weekend_days,
    holidays: new Set<string>(),
    dayStatuses: {},
    paidLeaveDays: 0,
    unpaidLeaveDays: 0,
  };

  it("computes gross as 1.5x basic with HRA 40% and medical 10%", () => {
    const r = computePayslip({ ...base, basic: 50_000 });
    expect(r.gross).toBe(75_000);
    expect(r.hra).toBe(20_000);
    expect(r.medical).toBe(5_000);
    expect(r.perDay).toBeCloseTo(75_000 / 22, 2);
  });

  it("full attendance with paid leave means no deduction, tax from slabs", () => {
    // 20 working days + 2 paid leave days in March 2026
    const r = computePayslip({ ...base, basic: 50_000, paidLeaveDays: 2 });
    expect(r.absentDays).toBe(0);
    expect(r.deductions).toBe(0);
    expect(r.proratedGross).toBe(75_000);
    // annual 900k -> 15k tax -> 1250/month
    expect(r.monthlyTax).toBe(1250);
    expect(r.net).toBe(75_000 - 1250);
  });

  it("deducts absent days, unpaid leave and half a day per half day", () => {
    const statuses: Record<string, string> = { "2026-03-03": "half_day", "2026-03-04": "present" };
    const r = computePayslip({
      ...base,
      basic: 50_000,
      dayStatuses: statuses,
      unpaidLeaveDays: 1,
    });
    // employed 22, present 1.5 -> absent 19.5 (no paid leave recorded for the rest in this unit test)
    const perDay = 75_000 / 22;
    expect(r.deductionDays).toBeCloseTo(19.5 + 1 + 0.5, 2);
    expect(r.deductions).toBeCloseTo((19.5 + 1 + 0.5) * perDay, 1);
  });

  it("prorates for mid-month joiners", () => {
    const r = computePayslip({ ...base, basic: 50_000, joinDate: "2026-03-16" });
    // Mar 16-31: 16-20 (5), 23-27 (5), 30-31 (2) = 12 working days
    expect(r.employedDays).toBe(12);
    expect(r.proratedGross).toBeCloseTo((75_000 * 12) / 22, 2);
  });

  it("prorates for leavers", () => {
    const r = computePayslip({ ...base, basic: 50_000, exitDate: "2026-03-13" });
    expect(r.employedDays).toBe(10); // 2-6, 9-13
  });
});
