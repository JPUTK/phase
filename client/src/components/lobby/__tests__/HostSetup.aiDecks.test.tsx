import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Same WebStorage shadowing workaround as HostSetup.test.tsx.
const localStorageItems = vi.hoisted(() => {
  const items = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => {
        items.set(key, value);
      },
      removeItem: (key: string) => {
        items.delete(key);
      },
      clear: () => {
        items.clear();
      },
      key: (index: number) => [...items.keys()][index] ?? null,
      get length() {
        return items.size;
      },
    },
  });
  return items;
});

vi.mock("../../../adapter/wasm-adapter", () => ({ getHostAdapter: () => ({}) }));

vi.mock("../../../services/engineRuntime", async () => ({
  ...(await vi.importActual<typeof import("../../../services/engineRuntime")>("../../../services/engineRuntime")),
  bestOfThreeCeilingForFormat: vi.fn(async () => "Bo1"),
  deckSupplyForFormat: vi.fn(async () => "PlayerBuilt"),
}));

const catalogState = vi.hoisted(() => ({ candidates: [] as unknown[] }));
vi.mock("../../../services/aiDeckCatalog", async () => ({
  ...(await vi.importActual<typeof import("../../../services/aiDeckCatalog")>("../../../services/aiDeckCatalog")),
  useAiDeckCatalog: () => ({ candidates: catalogState.candidates, loading: false, error: null }),
}));

import { HostSetup } from "../HostSetup";
import * as serverDirectory from "../../../services/serverDirectory";
import type { AiDeckCandidate } from "../../../services/aiDeckCatalog";
import { expandParsedDeck } from "../../../services/deckParser";
import { FORMAT_DEFAULTS, useMultiplayerStore } from "../../../stores/multiplayerStore";
import { usePreferencesStore } from "../../../stores/preferencesStore";
import { LOBBY_PROTOCOL_VERSION, PROTOCOL_VERSION } from "../../../adapter/ws-adapter";
import { DEFAULT_MULTIPLAYER_SERVER_URL } from "../../../config/multiplayerServer";
import { refuseRealWebSockets } from "../../../test/helpers/refusingWebSocket";

function candidate(
  id: string,
  overrides: Partial<AiDeckCandidate> = {},
): AiDeckCandidate {
  return {
    id,
    name: id,
    source: { type: "precon", deckId: id, code: "TST" },
    deck: { main: [{ name: `${id} Card`, count: 60 }], sideboard: [] },
    coveragePct: 100,
    archetype: null,
    bracket: null,
    ...overrides,
  };
}

const ALPHA = candidate("Alpha");
const BRAVO = candidate("Bravo");
const CHARLIE = candidate("Charlie");

/** A three-player Free-for-All table with seats 2 and 3 set to AI. The seats are
 *  restored without a `deckId`, as a pre-feature remembered config would be. */
function rememberTwoAiSeats() {
  useMultiplayerStore.setState({
    lastHostConfig: {
      format: "FreeForAll",
      formatConfig: FORMAT_DEFAULTS.FreeForAll,
      savedCustomFormatId: null,
      playerCount: 3,
      matchType: "Bo1",
      loopDetection: { type: "Off" },
      isPublic: true,
      startWhenFull: true,
      ranked: false,
      aiSeats: [
        { seatIndex: 1, difficulty: "Medium", deckName: null },
        { seatIndex: 2, difficulty: "Hard", deckName: null },
      ],
    },
  });
}

function renderHostSetup(onHost = vi.fn().mockResolvedValue(false)) {
  render(<HostSetup onHost={onHost} onBack={vi.fn()} connectionMode="server" onConnectionModeChange={vi.fn()} />);
  return onHost;
}

function deckPickers(): HTMLElement[] {
  return screen.getAllByRole("button", { name: "Deck" });
}

describe("HostSetup — per-seat AI decks", () => {
  beforeEach(() => {
    refuseRealWebSockets();
    vi.spyOn(serverDirectory, "refreshServerDirectory").mockResolvedValue(undefined);
    vi.spyOn(useMultiplayerStore.getState(), "ensureSubscriptionSocket").mockResolvedValue(null);
    localStorageItems.clear();
    catalogState.candidates = [ALPHA, BRAVO, CHARLIE];
    usePreferencesStore.getState().setAiArchetypeFilter("Any");
    usePreferencesStore.getState().setAiCoverageFloor(50);
    usePreferencesStore.getState().setAiBracketFilter([]);
    useMultiplayerStore.setState({
      displayName: "",
      formatConfig: null,
      lastHostConfig: null,
      userLobbySources: [],
      sourceStatus: new Map([[DEFAULT_MULTIPLAYER_SERVER_URL, {
        state: "open", playerCount: 0,
        serverInfo: {
          version: "test", buildCommit: "test", mode: "Full",
          protocolVersion: PROTOCOL_VERSION, lobbyProtocolVersion: LOBBY_PROTOCOL_VERSION,
        },
      }]]),
      directorySources: [],
      disabledDirectorySources: [],
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows a deck picker per AI seat defaulting to Random", async () => {
    rememberTwoAiSeats();
    renderHostSetup();

    await waitFor(() => expect(deckPickers()).toHaveLength(2));
    for (const picker of deckPickers()) {
      expect(picker).toHaveTextContent("Random (3)");
    }
  });

  it("gives a newly toggled AI seat a Random deck picker", async () => {
    const user = userEvent.setup();
    renderHostSetup();

    expect(screen.queryByRole("button", { name: "Deck" })).toBeNull();
    await user.click(screen.getAllByRole("button", { name: "Human" })[0]);

    expect(await screen.findByRole("button", { name: "Deck" })).toHaveTextContent("Random (3)");
  });

  it("lists Random first, then each catalog deck with its source and coverage", async () => {
    const user = userEvent.setup();
    rememberTwoAiSeats();
    catalogState.candidates = [candidate("Alpha", { archetype: "Aggro", coveragePct: 87 }), BRAVO];
    renderHostSetup();

    await user.click((await waitFor(() => deckPickers()))[0]);
    const options = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Random (2)",
      "Alpha — Precon · Aggro · 87%",
      "Bravo — Precon · 100%",
    ]);
  });

  it("submits each seat's own pinned deck", async () => {
    const user = userEvent.setup();
    rememberTwoAiSeats();
    const onHost = renderHostSetup();

    await waitFor(() => expect(deckPickers()).toHaveLength(2));
    await user.click(deckPickers()[0]);
    await user.click(screen.getByRole("option", { name: /^Alpha/ }));
    await user.click(deckPickers()[1]);
    await user.click(screen.getByRole("option", { name: /^Bravo/ }));
    await user.click(screen.getByRole("button", { name: "Host Game" }));

    expect(onHost).toHaveBeenCalledTimes(1);
    const { aiSeats } = onHost.mock.calls[0][0];
    expect(aiSeats).toEqual([
      expect.objectContaining({
        seatIndex: 1,
        difficulty: "Medium",
        deckId: "Alpha",
        deck: { type: "DeckList", data: expandParsedDeck(ALPHA.deck) },
      }),
      expect.objectContaining({
        seatIndex: 2,
        difficulty: "Hard",
        deckId: "Bravo",
        deck: { type: "DeckList", data: expandParsedDeck(BRAVO.deck) },
      }),
    ]);
  });

  it("resolves Random seats to distinct concrete decklists", async () => {
    const user = userEvent.setup();
    rememberTwoAiSeats();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const onHost = renderHostSetup();

    await waitFor(() => expect(deckPickers()).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: "Host Game" }));

    const { aiSeats } = onHost.mock.calls[0][0];
    const decks = aiSeats.map((seat: { deck: { type: string; data: unknown } }) => seat.deck);
    for (const deck of decks) expect(deck.type).toBe("DeckList");
    expect(decks[0].data).not.toEqual(decks[1].data);
    const catalogDecks = [ALPHA, BRAVO, CHARLIE].map((c) => expandParsedDeck(c.deck));
    for (const deck of decks) expect(catalogDecks).toContainEqual(deck.data);
  });

  it("draws Random seats from the single-player pool preferences", async () => {
    const user = userEvent.setup();
    rememberTwoAiSeats();
    catalogState.candidates = [
      candidate("Alpha", { coveragePct: 60 }),
      candidate("Bravo", { coveragePct: 95 }),
      candidate("Charlie", { coveragePct: 95 }),
    ];
    usePreferencesStore.getState().setAiCoverageFloor(90);
    const onHost = renderHostSetup();

    await waitFor(() => expect(deckPickers()[0]).toHaveTextContent("Random (2)"));
    await user.click(screen.getByRole("button", { name: "Host Game" }));

    const { aiSeats } = onHost.mock.calls[0][0];
    expect(aiSeats.map((seat: { deckId: string }) => seat.deckId).sort()).toEqual(["Bravo", "Charlie"]);
  });

  it("remembers the selection, not the resolved deck, so Random stays Random", async () => {
    const user = userEvent.setup();
    rememberTwoAiSeats();
    renderHostSetup();

    await waitFor(() => expect(deckPickers()).toHaveLength(2));
    await user.click(deckPickers()[1]);
    await user.click(screen.getByRole("option", { name: /^Charlie/ }));
    await user.click(screen.getByRole("button", { name: "Host Game" }));

    const remembered = useMultiplayerStore.getState().lastHostConfig?.aiSeats;
    expect(remembered?.map((seat) => seat.deckId)).toEqual([undefined, "Charlie"]);
  });

  it("blocks hosting while the catalog has no decks for an AI seat", async () => {
    rememberTwoAiSeats();
    catalogState.candidates = [];
    renderHostSetup();

    await waitFor(() => expect(deckPickers()).toHaveLength(2));
    expect(screen.getByRole("button", { name: "Host Game" })).toBeDisabled();
  });
});
