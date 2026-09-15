import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spanColor } from "../app/src/utils/colors";

function hueDistance(a: number, b: number) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

describe("trajectory span colours", () => {
  test("no tool colour can be mistaken for the error colour", () => {
    const css = readFileSync(new URL("../app/src/index.css", import.meta.url), "utf8");
    const danger = css.match(/--rp-danger:\s*#[0-9A-Fa-f]{6};\s*\/\*\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/);
    expect(danger, "--rp-danger must keep its oklch provenance comment").not.toBeNull();
    const dangerHue = Number(danger![3]);

    const map = new Map<string, string>();
    const colours = new Set<string>();
    for (let i = 0; i < 64; i++) colours.add(spanColor(`tool_${i}`, map));

    for (const colour of colours) {
      const match = colour.match(/^oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)$/);
      expect(match, `unparseable span colour ${colour}`).not.toBeNull();
      const chroma = Number(match![2]);
      const hue = Number(match![3]);
      // A saturated bar within 45 degrees of the danger hue reads as a failed span.
      if (chroma >= 0.08) {
        expect(hueDistance(hue, dangerHue), `${colour} is too close to the error colour`).toBeGreaterThanOrEqual(45);
      }
    }
  });
});
