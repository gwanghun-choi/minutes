import { describe, expect, it } from "vitest";

import { countLabel, fmtTime, fromLocalInput, toLocalInput } from "../lib/format";
import { FACT_STATUS } from "../lib/labels";

describe("표시 형식", () => {
  it("초를 mm:ss로 쓰고, 없으면 하이픈을 쓴다", () => {
    expect(fmtTime(0)).toBe("00:00");
    expect(fmtTime(65)).toBe("01:05");
    expect(fmtTime(1830)).toBe("30:30");
    expect(fmtTime(null)).toBe("-");
  });

  it("사이드바 개수는 99를 넘으면 99+로만 줄여 쓴다", () => {
    expect(countLabel(0)).toBe("0");
    expect(countLabel(12)).toBe("12");
    expect(countLabel(99)).toBe("99");
    expect(countLabel(100)).toBe("99+");
    expect(countLabel(147)).toBe("99+");
  });

  it("datetime-local 값을 왕복시켜도 같은 시각이다", () => {
    const iso = "2026-08-19T04:30:00+00:00";
    const round = fromLocalInput(toLocalInput(iso));
    expect(new Date(round!).getTime()).toBe(new Date(iso).getTime());
  });

  it("빈 입력은 null이 되어 회의 일시를 지운다", () => {
    expect(fromLocalInput("")).toBeNull();
    expect(toLocalInput(null)).toBe("");
  });

  it("UNKNOWN은 진행 중이 아니라 상태 미확인이다", () => {
    expect(FACT_STATUS.UNKNOWN).toBe("상태 미확인");
    expect(FACT_STATUS.UNKNOWN).not.toBe(FACT_STATUS.OPEN);
  });
});
