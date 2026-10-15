import { afterEach, describe, expect, it, vi } from "vitest";

import type { CommanderBracket } from "../../types/bracket";
import { AI_DECK_RANDOM } from "../../stores/preferencesStore";
import type { AiDeckCandidate } from "../aiDeckCatalog";
import {
  candidatePassesFilters,
  cedhRandomSeatUnservable,
  pickAiSeatDecks,
  restrictAiPoolByBracket,
  type BracketTaggedCandidate,
  type PickAiSeatDecksOptions,
} from "../aiRandomPool";

interface FakeCandidate extends BracketTaggedCandidate {
  id: string;
}

function candidate(id: string, bracket: CommanderBracket | null): FakeCandidate {
  return { id, bracket };
}

function ids(pool: readonly FakeCandidate[]): string[] {
  return pool.map((deck) => deck.id);
}

const MIXED_POOL: FakeCandidate[] = [
  candidate("b1", 1),
  candidate("b2", 2),
  candidate("b3", 3),
  candidate("user-b4", 4),
  candidate("cedh", 5),
  candidate("untagged", null),
];

describe("restrictAiPoolByBracket", () => {
  it("returns the pool unchanged when the filter is off", () => {
    expect(
      ids(restrictAiPoolByBracket(MIXED_POOL, {
        bracketFilter: [],
        cedhMode: false,
        selectedFormat: "Commander",
      })),
    ).toEqual(["b1", "b2", "b3", "user-b4", "cedh", "untagged"]);
  });

  it("keeps only selected tiers and excludes untagged decks", () => {
    // The reported scenario: brackets 1–3 selected, the user's bracket-4
    // deck must not be in the draw.
    expect(
      ids(restrictAiPoolByBracket(MIXED_POOL, {
        bracketFilter: [1, 2, 3],
        cedhMode: false,
        selectedFormat: "Commander",
      })),
    ).toEqual(["b1", "b2", "b3"]);
  });

  it("cEDH mode restricts to bracket 5 even over a manual selection", () => {
    expect(
      ids(restrictAiPoolByBracket(MIXED_POOL, {
        bracketFilter: [1, 2, 3],
        cedhMode: true,
        selectedFormat: "Commander",
      })),
    ).toEqual(["cedh"]);
  });

  it("applies no constraint outside the Commander family", () => {
    const all = ["b1", "b2", "b3", "user-b4", "cedh", "untagged"];
    expect(
      ids(restrictAiPoolByBracket(MIXED_POOL, {
        bracketFilter: [2],
        cedhMode: false,
        selectedFormat: "Standard",
      })),
    ).toEqual(all);
    expect(
      ids(restrictAiPoolByBracket(MIXED_POOL, {
        bracketFilter: [],
        cedhMode: true,
        selectedFormat: "Standard",
      })),
    ).toEqual(all);
    expect(
      ids(restrictAiPoolByBracket(MIXED_POOL, {
        bracketFilter: [2],
        cedhMode: false,
        selectedFormat: null,
      })),
    ).toEqual(all);
    expect(
      ids(restrictAiPoolByBracket(MIXED_POOL, {
        bracketFilter: [2],
        cedhMode: false,
      })),
    ).toEqual(all);
  });
});

function deck(id: string, overrides: Partial<AiDeckCandidate> = {}): AiDeckCandidate {
  return {
    id,
    name: id,
    source: { type: "precon", deckId: id, code: "TST" },
    deck: { main: [], sideboard: [] },
    coveragePct: 100,
    archetype: null,
    bracket: null,
    ...overrides,
  };
}

function pick(
  catalog: AiDeckCandidate[],
  requestedDeckIds: string[],
  overrides: Partial<PickAiSeatDecksOptions> = {},
): string[] {
  return pickAiSeatDecks({
    catalog,
    requestedDeckIds,
    archetypeFilter: "Any",
    coverageFloor: 50,
    bracketFilter: [],
    cedhMode: false,
    selectedFormat: "Standard",
    ...overrides,
  }).map((candidate) => candidate.id);
}

describe("candidatePassesFilters", () => {
  it("excludes decks below the coverage floor but keeps unknown coverage", () => {
    expect(candidatePassesFilters(deck("low", { coveragePct: 60 }), "Any", 70)).toBe(false);
    expect(candidatePassesFilters(deck("ok", { coveragePct: 70 }), "Any", 70)).toBe(true);
    expect(candidatePassesFilters(deck("unknown", { coveragePct: null }), "Any", 100)).toBe(true);
  });

  it("excludes a deck of another archetype but keeps untagged decks", () => {
    expect(candidatePassesFilters(deck("a", { archetype: "Aggro" }), "Control", 50)).toBe(false);
    expect(candidatePassesFilters(deck("c", { archetype: "Control" }), "Control", 50)).toBe(true);
    expect(candidatePassesFilters(deck("n", { archetype: null }), "Control", 50)).toBe(true);
  });
});

describe("pickAiSeatDecks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("gives a pinned seat its deck even when the filters exclude it", () => {
    const catalog = [
      deck("pinned", { coveragePct: 10, archetype: "Aggro" }),
      deck("other", { coveragePct: 100, archetype: "Control" }),
    ];
    expect(
      pick(catalog, ["pinned"], { archetypeFilter: "Control", coverageFloor: 90 }),
    ).toEqual(["pinned"]);
  });

  it("returns one deck per requested seat, in seat order", () => {
    const catalog = [deck("a"), deck("b"), deck("c")];
    expect(pick(catalog, ["c", "a", "b"])).toEqual(["c", "a", "b"]);
  });

  it("does not repeat a deck across Random seats or an excluded id when alternatives exist", () => {
    const catalog = [deck("a"), deck("b"), deck("c")];
    for (const roll of [0, 0.34, 0.67, 0.99]) {
      vi.spyOn(Math, "random").mockReturnValue(roll);
      const picks = pick(catalog, [AI_DECK_RANDOM, AI_DECK_RANDOM], { excludeIds: ["a"] });
      expect(picks).not.toContain("a");
      expect(new Set(picks).size).toBe(2);
    }
  });

  it("keeps a Random seat off the deck a pinned seat already took", () => {
    const catalog = [deck("a"), deck("b")];
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(pick(catalog, ["a", AI_DECK_RANDOM])).toEqual(["a", "b"]);
  });

  it("draws Random seats from the archetype and coverage filtered pool", () => {
    const catalog = [
      deck("fit", { archetype: "Control", coveragePct: 95 }),
      deck("wrong-archetype", { archetype: "Aggro", coveragePct: 95 }),
      deck("low-coverage", { archetype: "Control", coveragePct: 55 }),
    ];
    for (const roll of [0, 0.5, 0.99]) {
      vi.spyOn(Math, "random").mockReturnValue(roll);
      expect(
        pick(catalog, [AI_DECK_RANDOM], { archetypeFilter: "Control", coverageFloor: 90 }),
      ).toEqual(["fit"]);
    }
  });

  it("falls back to the whole pool when the filters empty it", () => {
    const catalog = [deck("only", { archetype: "Aggro", coveragePct: 55 })];
    expect(
      pick(catalog, [AI_DECK_RANDOM], { archetypeFilter: "Control", coverageFloor: 90 }),
    ).toEqual(["only"]);
  });

  it("restricts Random seats to the bracket pool in Commander and falls back when it is empty", () => {
    const catalog = [deck("b2", { bracket: 2 }), deck("b4", { bracket: 4 })];
    for (const roll of [0, 0.99]) {
      vi.spyOn(Math, "random").mockReturnValue(roll);
      expect(
        pick(catalog, [AI_DECK_RANDOM], { bracketFilter: [2], selectedFormat: "Commander" }),
      ).toEqual(["b2"]);
    }
    // No deck matches bracket 5: the full legal catalog is the pool.
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(
      pick(catalog, [AI_DECK_RANDOM], { bracketFilter: [5], selectedFormat: "Commander" }),
    ).toEqual(["b2"]);
  });

  it("restricts Random seats to bracket 5 in cEDH mode but not a pinned seat", () => {
    const catalog = [deck("b2", { bracket: 2 }), deck("cedh", { bracket: 5 })];
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(
      pick(catalog, [AI_DECK_RANDOM, "b2"], { cedhMode: true, selectedFormat: "Commander" }),
    ).toEqual(["cedh", "b2"]);
  });

  it("treats an unknown pinned id as Random", () => {
    const catalog = [deck("a", { coveragePct: 95 }), deck("b", { coveragePct: 55 })];
    expect(pick(catalog, ["gone"], { coverageFloor: 90 })).toEqual(["a"]);
  });
});

describe("cedhRandomSeatUnservable", () => {
  const noBracketFive = [deck("b2", { bracket: 2 }), deck("b4", { bracket: 4 })];

  function unservable(
    catalog: AiDeckCandidate[],
    requestedDeckIds: string[],
    overrides: Partial<Parameters<typeof cedhRandomSeatUnservable>[0]> = {},
  ): boolean {
    return cedhRandomSeatUnservable({
      catalog,
      requestedDeckIds,
      bracketFilter: [],
      cedhMode: true,
      selectedFormat: "Commander",
      ...overrides,
    });
  }

  it("is true for a Random seat at a cEDH table with no bracket-5 deck", () => {
    expect(unservable(noBracketFive, [AI_DECK_RANDOM])).toBe(true);
    expect(unservable(noBracketFive, ["b2", AI_DECK_RANDOM])).toBe(true);
  });

  it("treats a pinned id missing from the catalog like Random", () => {
    expect(unservable(noBracketFive, ["gone"])).toBe(true);
  });

  it("is false when every seat is pinned to a catalog deck", () => {
    expect(unservable(noBracketFive, ["b2", "b4"])).toBe(false);
  });

  it("is false when the bracket-5 pool is non-empty", () => {
    const catalog = [...noBracketFive, deck("cedh", { bracket: 5 })];
    expect(unservable(catalog, [AI_DECK_RANDOM])).toBe(false);
  });

  it("is false outside cEDH mode and outside the Commander family", () => {
    expect(unservable(noBracketFive, [AI_DECK_RANDOM], { cedhMode: false })).toBe(false);
    expect(unservable(noBracketFive, [AI_DECK_RANDOM], { selectedFormat: "Standard" })).toBe(false);
    expect(unservable(noBracketFive, [AI_DECK_RANDOM], { selectedFormat: null })).toBe(false);
  });

  it("ignores the manual bracket selection, which cEDH mode overrides", () => {
    expect(unservable(noBracketFive, [AI_DECK_RANDOM], { bracketFilter: [2] })).toBe(true);
  });

  it("is unaffected by archetype and coverage, which the predicate does not take", () => {
    // A bracket-5 deck that the soft archetype/coverage filters would exclude
    // still keeps the bracket pool non-empty.
    const catalog = [deck("cedh", { bracket: 5, coveragePct: 1, archetype: "Aggro" })];
    expect(unservable(catalog, [AI_DECK_RANDOM])).toBe(false);
  });
});
