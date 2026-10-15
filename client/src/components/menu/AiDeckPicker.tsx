import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { AiDeckCandidate } from "../../services/aiDeckCatalog";
import { AI_DECK_RANDOM, type AiDeckSelection } from "../../stores/preferencesStore";
import { MenuSelect } from "../ui/MenuSelect";

interface AiDeckPickerProps {
  /** The seat's current selection: a catalog id or `AI_DECK_RANDOM`. */
  value: AiDeckSelection;
  /** Every legal catalog deck — the options when a deck is pinned, so the seat
   *  can switch between pinned decks. */
  candidates: AiDeckCandidate[];
  /** The filtered Random pool — the options (and the "Random (N)" count) while
   *  the seat is Random. */
  randomPool: AiDeckCandidate[];
  onChange: (value: AiDeckSelection) => void;
  /** Trigger button classes. */
  className: string;
  /** Wrapper classes around the trigger. */
  wrapperClassName?: string;
}

/**
 * One AI seat's deck dropdown: Random first, then each legal catalog deck
 * labeled `name — source · archetype · coverage%`. Shared by single-player vs-AI
 * setup and Host Game so both present the same list.
 */
export function AiDeckPicker({
  value,
  candidates,
  randomPool,
  onChange,
  className,
  wrapperClassName,
}: AiDeckPickerProps) {
  const { t } = useTranslation("menu");
  const isRandom = value === AI_DECK_RANDOM;
  // When the user has pinned a deck, expose the full list so they can switch
  // to another pinned deck; otherwise scope to the filtered Random pool so
  // the "Random" summary count matches the options shown.
  const deckOptions = isRandom ? randomPool : candidates;
  const selectionValid = isRandom || deckOptions.some((d) => d.id === value);
  const effectiveSelection: AiDeckSelection = selectionValid ? value : AI_DECK_RANDOM;

  const randomDeckLabel = t("aiOpponent.deckRandomCount", { count: randomPool.length });
  const deckMenuItems = useMemo(() => {
    const sourceLabel = (candidate: AiDeckCandidate): string => {
      switch (candidate.source.type) {
        case "saved":
          return candidate.source.feedId ? t("aiOpponent.source.feed") : t("aiOpponent.source.user");
        case "feed":
          return candidate.source.feedId;
        case "precon":
          return t("aiOpponent.source.precon");
      }
    };
    const formatDeckLabel = (candidate: AiDeckCandidate): string => {
      const suffix = [
        sourceLabel(candidate),
        candidate.archetype,
        candidate.coveragePct != null ? `${candidate.coveragePct}%` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      return suffix ? `${candidate.name} — ${suffix}` : candidate.name;
    };
    return [
      { value: AI_DECK_RANDOM, label: randomDeckLabel },
      ...deckOptions.map((d) => ({ value: d.id, label: formatDeckLabel(d) })),
    ];
  }, [deckOptions, randomDeckLabel, t]);
  const selectedDeckLabel =
    effectiveSelection === AI_DECK_RANDOM
      ? randomDeckLabel
      : (deckMenuItems.find((item) => item.value === effectiveSelection)?.label ?? randomDeckLabel);

  return (
    <MenuSelect
      ariaLabel={t("aiOpponent.deck")}
      label={selectedDeckLabel}
      selectedValue={effectiveSelection}
      items={deckMenuItems}
      onSelect={(next) => onChange(next as AiDeckSelection)}
      menuLayout="dropdown"
      fitContainer
      wrapperClassName={wrapperClassName}
      className={className}
    />
  );
}
