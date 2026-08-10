import { describe, expect, test } from "bun:test";
import {
  buildQualityEvaluationReport,
  recommendRetrieval,
  runQualityEvaluation,
  type EvaluationCategoryResult,
} from "./ai-quality-evaluation.ts";

function passingCategory(
  category: EvaluationCategoryResult["category"],
): EvaluationCategoryResult {
  return {
    category,
    passed: 1,
    total: 1,
    rate: 1,
    cases: [{ id: `${category}-case`, passed: true, checks: { correct: true } }],
  };
}

describe("AI quality evaluation", () => {
  test("runs the repository dataset across all stage-two categories", async () => {
    const report = await runQualityEvaluation();
    expect(report.overall.passed).toBe(true);
    expect(report.categories.map((item) => item.category)).toEqual([
      "retrieval",
      "routing",
      "proactive",
      "learning",
    ]);
    expect(
      report.categories
        .find((item) => item.category === "retrieval")
        ?.cases.find((item) => item.id === "incident-contact-alias")
        ?.checks.ftsCovered,
    ).toBe(true);
    expect(report.retrieval.ftsCoverage).toBe(1);
    expect(report.recommendation.decision).toBe("keep_fts");
  });

  test("recommends FTS-native improvements only when FTS coverage is the bottleneck", () => {
    const retrievalGap = recommendRetrieval({
      caseCount: 8,
      pipelineAccuracy: 1,
      citationAccuracy: 1,
      ftsCoverage: 0.75,
    });
    expect(retrievalGap.decision).toBe("improve_fts_retrieval");
    expect(retrievalGap.reasons.join(" ")).toContain("aliases/tags");
    expect(retrievalGap.reasons.join(" ")).toContain("大目录有界路由");
    expect(retrievalGap.reasons.join(" ")).not.toContain("查询改写");
    expect(retrievalGap.reasons.join(" ")).not.toMatch(/embedding|hybrid/iu);
    expect(recommendRetrieval({
      caseCount: 8,
      pipelineAccuracy: 0.75,
      citationAccuracy: 0.75,
      ftsCoverage: 0.5,
    }).decision).toBe("keep_fts");
  });

  test("requires every quality category to pass", () => {
    const categories = [
      passingCategory("retrieval"),
      passingCategory("routing"),
      passingCategory("proactive"),
      {
        category: "learning",
        passed: 0,
        total: 1,
        rate: 0,
        cases: [{ id: "learning-case", passed: false, checks: { correct: false } }],
      },
    ] satisfies EvaluationCategoryResult[];
    const report = buildQualityEvaluationReport(categories, {
      caseCount: 3,
      pipelineAccuracy: 1,
      citationAccuracy: 1,
      ftsCoverage: 1,
    }, 1000);
    expect(report.overall).toEqual({
      passed: false,
      passedCases: 3,
      totalCases: 4,
      rate: 0.75,
    });
    expect(report.generatedAt).toBe(1000);
  });

  test("fails the release gate when FTS coverage is below the fixed threshold", () => {
    const categories = [
      passingCategory("retrieval"),
      passingCategory("routing"),
      passingCategory("proactive"),
      passingCategory("learning"),
    ];

    const report = buildQualityEvaluationReport(categories, {
      caseCount: 4,
      pipelineAccuracy: 1,
      citationAccuracy: 1,
      ftsCoverage: 0.75,
    }, 1000);

    expect(report.overall.passed).toBe(false);
    expect(report.recommendation.decision).toBe("improve_fts_retrieval");
  });
});
