//! The Necrobloom — "Land cards in your graveyard have dredge 2." grants Dredge
//! to a card that never had it printed. Two independent engine defects compound:
//!
//! 1. Every candidate-discovery path for a Draw replacement sources candidates
//!    exclusively from `obj.replacement_definitions`, which is populated only by
//!    `synthesize_dredge` reading a PRINTED `Keyword::Dredge`. A land whose only
//!    Dredge is granted at runtime has an empty `replacement_definitions`, so it
//!    is never even offered.
//! 2. Every touch point that reads a candidate's mode / choice authority / execute
//!    effect / display label is borrow-based against that same stored field, so
//!    even a registered virtual candidate would fall through to generic,
//!    unlabeled defaults without its own touch-point branches.
//!
//! `crates/engine/src/game/replacement.rs` gained a new virtual-candidate family
//! (`GRANTED_DREDGE_INDEX` / `is_granted_dredge_replacement` /
//! `granted_dredge_value`) mirroring the existing `GrantedEtbKeyword` (printed-
//! vs-granted synthesis split) and `is_commander_hand_or_library_return_replacement`
//! (Optional, multi-touch-point virtual family) precedents, plus a shared
//! `database::synthesis::dredge_replacement_definition` builder extracted from
//! `synthesize_dredge` so printed and granted Dredge apply through the identical
//! definition shape.
//!
//! These tests drive the real engine pipeline (`GameScenario` + `GameRunner`,
//! `DebugAction::DrawCards` → the real `start_draw_sequence` replacement pipeline,
//! `GameAction::ChooseReplacement`) with The Necrobloom's verbatim Oracle text —
//! no shape-only assertions.
//!
//! Oracle text verbatim from Scryfall (`mh3`, collector number 194):
//! "Landfall — Whenever a land you control enters, create a 0/1 green Plant
//! creature token. If you control seven or more lands with different names,
//! create a 2/2 black Zombie creature token instead.\nLand cards in your
//! graveyard have dredge 2. (You may return a land card from your graveyard to
//! your hand and mill two cards instead of drawing a card.)"
//!
//! CR references (verified against docs/MagicCompRules.txt):
//! - CR 702.52a: Dredge — instead of drawing, mill N and return this card from
//!   graveyard to hand.
//! - CR 702.52b: fewer than N library cards ⇒ dredge is not offered.
//! - CR 613.1f: Layer 6 ability-adding (keyword-granting) continuous effect.
//! - CR 611.3b: a static's continuous effect applies while its source is in the
//!   appropriate zone, even though its recipients (graveyard cards) are not.
//! - CR 614.6: a replaced event never happens — accepting dredge must not also
//!   draw.
//! - CR 616.1: two or more applicable replacement effects ⇒ the affected player
//!   chooses the order; each candidate must be distinguishably labeled.
//! - CR 109.4 + CR 108.4a: a graveyard object has no controller; use its owner.

use engine::game::scenario::{GameRunner, GameScenario, P0, P1};
use engine::game::zones::{add_to_zone, remove_from_zone};
use engine::types::ability::{
    AbilityDefinition, AbilityKind, DrawReplacementScope, Effect, QuantityExpr,
    ReplacementDefinition, ReplacementMode, TargetFilter,
};
use engine::types::actions::{DebugAction, GameAction};
use engine::types::game_state::WaitingFor;
use engine::types::identifiers::ObjectId;
use engine::types::keywords::Keyword;
use engine::types::phase::Phase;
use engine::types::player::PlayerId;
use engine::types::replacements::ReplacementEvent;
use engine::types::zones::{EtbTapState, Zone};

const NECROBLOOM_ORACLE: &str = "Landfall — Whenever a land you control enters, create a 0/1 green Plant creature token. If you control seven or more lands with different names, create a 2/2 black Zombie creature token instead.\nLand cards in your graveyard have dredge 2. (You may return a land card from your graveyard to your hand and mill two cards instead of drawing a card.)";

/// A fresh two-player scenario with a small deterministic library for each
/// player (>= Dredge 2's CR 702.52b threshold) so a draw or a dredge accept
/// never trips an empty-library loss.
fn base_scenario() -> GameScenario {
    let mut scenario = GameScenario::new();
    scenario.at_phase(Phase::PreCombatMain);
    scenario.with_library_top(P0, &["P0 Lib A", "P0 Lib B", "P0 Lib C"]);
    scenario.with_library_top(P1, &["P1 Lib A", "P1 Lib B", "P1 Lib C"]);
    scenario
}

fn draw_one(runner: &mut GameRunner, player: PlayerId) {
    runner.state_mut().debug_mode = true;
    runner
        .act(GameAction::Debug(DebugAction::DrawCards {
            player_id: player,
            count: 1,
        }))
        .expect("debug draw must succeed");
}

fn hand_len(runner: &GameRunner, player: PlayerId) -> usize {
    runner.state().players[player.0 as usize].hand.len()
}

fn zone_of(runner: &GameRunner, id: ObjectId) -> Zone {
    runner
        .state()
        .objects
        .get(&id)
        .map(|o| o.zone)
        .expect("object must exist")
}

/// Drive any outstanding `ReplacementChoice` prompts to completion, preferring
/// `preferred_source`'s non-Decline option whenever it's offered and declining
/// anything else — so accepting the preferred candidate can never accidentally
/// also accept an unrelated competing candidate (the "accepting one does not
/// consume/duplicate the other" property under test).
fn resolve_preferring(runner: &mut GameRunner, preferred_source: ObjectId) {
    for _ in 0..6 {
        let WaitingFor::ReplacementChoice { candidates, .. } = runner.state().waiting_for.clone()
        else {
            return;
        };
        let idx = candidates
            .iter()
            .position(|c| c.source_id == preferred_source && c.description != "Decline")
            .or_else(|| candidates.iter().position(|c| c.description == "Decline"))
            .unwrap_or(0);
        runner
            .act(GameAction::ChooseReplacement { index: idx })
            .expect("replacement choice must be accepted");
    }
}

/// Mirrors `database::synthesis::dredge_replacement_definition` (the extracted
/// printed/granted shared builder) so a test-side "printed dredge" object gets
/// the SAME real object-carried candidate shape `synthesize_dredge` would have
/// produced — this crate boundary can't call the `pub(crate)` engine builder
/// directly, so the shape is reproduced verbatim rather than approximated.
fn printed_dredge_replacement(n: u32) -> ReplacementDefinition {
    let return_to_hand = AbilityDefinition::new(
        AbilityKind::Spell,
        Effect::ChangeZone {
            origin: Some(Zone::Graveyard),
            destination: Zone::Hand,
            target: TargetFilter::SelfRef,
            owner_library: false,
            enter_transformed: false,
            enters_under: None,
            enter_tapped: EtbTapState::Unspecified,
            enters_attacking: false,
            up_to: false,
            enter_with_counters: vec![],
            conditional_enter_with_counters: vec![],
            face_down_profile: None,
            enters_modified_if: None,
        },
    );
    let mut mill = AbilityDefinition::new(
        AbilityKind::Spell,
        Effect::Mill {
            count: QuantityExpr::Fixed { value: n as i32 },
            target: TargetFilter::Controller,
            destination: Zone::Graveyard,
        },
    );
    mill.sub_ability = Some(Box::new(return_to_hand));
    let mut repl = ReplacementDefinition::new(ReplacementEvent::Draw)
        .draw_scope(DrawReplacementScope::IndividualDraw)
        .active_zones(vec![Zone::Graveyard]);
    repl.mode = ReplacementMode::Optional { decline: None };
    repl.description = Some(
        "CR 702.52a: Dredge — instead of drawing, you may mill N cards and return this \
         card from your graveyard to your hand."
            .to_string(),
    );
    repl.execute = Some(Box::new(mill));
    repl
}

/// Row 1 (positive) + Row 5: a land with no printed Dredge, sitting in the
/// graveyard of Necrobloom's controller, is offered as a real Draw replacement
/// labeled exactly `("Accept", "Decline")` — the `optional_replacement_choice_labels`
/// verified-no-op branch (Finding 2).
#[test]
fn necrobloom_grants_dredge_offers_replacement_labeled_accept_decline() {
    let mut scenario = base_scenario();
    scenario.add_creature_from_oracle(P0, "The Necrobloom", 2, 7, NECROBLOOM_ORACLE);
    let land = scenario.add_land_to_graveyard(P0, "Forest").id();
    let mut runner = scenario.build();

    draw_one(&mut runner, P0);

    let WaitingFor::ReplacementChoice { candidates, .. } = runner.state().waiting_for.clone()
    else {
        panic!(
            "expected ReplacementChoice offering granted dredge, got {:?}",
            runner.state().waiting_for
        );
    };
    let descriptions: Vec<&str> = candidates.iter().map(|c| c.description.as_str()).collect();
    assert_eq!(
        descriptions,
        vec!["Accept", "Decline"],
        "a solo granted-dredge candidate must present exactly Accept/Decline"
    );
    assert!(
        candidates.iter().all(|c| c.source_id == land),
        "both options must be attributed to the graveyard land granting the offer, got {candidates:?}"
    );
}

/// Row 1 reach-guard: the identical fixture MINUS Necrobloom on the battlefield
/// must not offer any replacement — proving the offer above is caused by the
/// grant, not a pre-existing artifact of a land sitting in the graveyard.
#[test]
fn necrobloom_dredge_requires_necrobloom_on_battlefield() {
    let mut scenario = base_scenario();
    scenario.add_land_to_graveyard(P0, "Forest");
    let mut runner = scenario.build();
    let hand_before = hand_len(&runner, P0);

    draw_one(&mut runner, P0);

    assert!(
        !matches!(
            runner.state().waiting_for,
            WaitingFor::ReplacementChoice { .. }
        ),
        "without Necrobloom, a graveyard land must not offer dredge, got {:?}",
        runner.state().waiting_for
    );
    assert_eq!(
        hand_len(&runner, P0),
        hand_before + 1,
        "the draw must proceed normally with no grant present"
    );
}

/// Row 1 hostile fixture: Necrobloom's grant is scoped to "your graveyard"
/// (Necrobloom's controller, P0's, per CR 611.3b — live, not latched). A land
/// with no printed Dredge sitting in P1's OWN graveyard must not receive the
/// grant even though P1 is the one drawing — proving the static's own
/// controller-relative filter resolution is correct, not merely that
/// registration happens to scope by the drawing player.
#[test]
fn necrobloom_dredge_does_not_cross_into_opponents_graveyard() {
    let mut scenario = base_scenario();
    scenario.add_creature_from_oracle(P0, "The Necrobloom", 2, 7, NECROBLOOM_ORACLE);
    scenario.add_land_to_graveyard(P1, "Island");
    let mut runner = scenario.build();
    let hand_before = hand_len(&runner, P1);

    draw_one(&mut runner, P1);

    assert!(
        !matches!(
            runner.state().waiting_for,
            WaitingFor::ReplacementChoice { .. }
        ),
        "P0's Necrobloom must not grant dredge into P1's own graveyard, got {:?}",
        runner.state().waiting_for
    );
    assert_eq!(
        hand_len(&runner, P1),
        hand_before + 1,
        "P1's draw must proceed normally"
    );
}

/// Row 2 (positive): accepting mills exactly 2 and returns the land to hand;
/// hand increases by exactly 1 (not 2) — the discriminating CR 614.6 signal
/// that the draw was REPLACED, not supplemented.
#[test]
fn necrobloom_dredge_accept_mills_two_and_returns_land_not_double_draw() {
    let mut scenario = base_scenario();
    scenario.add_creature_from_oracle(P0, "The Necrobloom", 2, 7, NECROBLOOM_ORACLE);
    let land = scenario.add_land_to_graveyard(P0, "Forest").id();
    let mut runner = scenario.build();
    let hand_before = hand_len(&runner, P0);
    let library_before = runner.state().players[0].library.len();

    draw_one(&mut runner, P0);
    assert!(
        matches!(
            runner.state().waiting_for,
            WaitingFor::ReplacementChoice { .. }
        ),
        "fixture precondition: dredge must be offered before accepting it"
    );
    runner
        .act(GameAction::ChooseReplacement { index: 0 })
        .expect("accept the granted dredge offer");
    runner.advance_until_stack_empty();

    assert_eq!(
        zone_of(&runner, land),
        Zone::Hand,
        "the dredged land must return to hand"
    );
    assert_eq!(
        hand_len(&runner, P0),
        hand_before + 1,
        "hand must increase by exactly 1 (the dredged land) — CR 614.6, the draw was replaced"
    );
    assert_eq!(
        runner.state().players[0].library.len(),
        library_before - 2,
        "exactly 2 cards must be milled (CR 702.52a: dredge 2)"
    );
}

/// Row 2 sibling: declining leaves the land in the graveyard and the draw
/// proceeds normally (the natural top-of-library card, not the land).
#[test]
fn necrobloom_dredge_decline_draws_normally_land_stays_in_graveyard() {
    let mut scenario = base_scenario();
    scenario.add_creature_from_oracle(P0, "The Necrobloom", 2, 7, NECROBLOOM_ORACLE);
    let land = scenario.add_land_to_graveyard(P0, "Forest").id();
    let mut runner = scenario.build();
    let hand_before = hand_len(&runner, P0);

    draw_one(&mut runner, P0);
    let WaitingFor::ReplacementChoice { candidates, .. } = runner.state().waiting_for.clone()
    else {
        panic!(
            "expected ReplacementChoice, got {:?}",
            runner.state().waiting_for
        );
    };
    let decline_idx = candidates
        .iter()
        .position(|c| c.description == "Decline")
        .expect("a Decline option must be offered");
    runner
        .act(GameAction::ChooseReplacement { index: decline_idx })
        .expect("decline the granted dredge offer");
    runner.advance_until_stack_empty();

    assert_eq!(
        zone_of(&runner, land),
        Zone::Graveyard,
        "a declined land must remain in the graveyard"
    );
    assert_eq!(
        hand_len(&runner, P0),
        hand_before + 1,
        "decline must still draw exactly 1 card normally"
    );
}

/// Row 2 hostile fixture (CR 702.52b): with fewer than 2 library cards, dredge
/// must not be offered at all.
#[test]
fn necrobloom_dredge_not_offered_when_library_smaller_than_two() {
    let mut scenario = GameScenario::new();
    scenario.at_phase(Phase::PreCombatMain);
    scenario.with_library_top(P0, &["Only Card"]);
    scenario.with_library_top(P1, &["P1 Lib A", "P1 Lib B", "P1 Lib C"]);
    scenario.add_creature_from_oracle(P0, "The Necrobloom", 2, 7, NECROBLOOM_ORACLE);
    scenario.add_land_to_graveyard(P0, "Forest");
    let mut runner = scenario.build();
    let hand_before = hand_len(&runner, P0);

    draw_one(&mut runner, P0);

    assert!(
        !matches!(
            runner.state().waiting_for,
            WaitingFor::ReplacementChoice { .. }
        ),
        "CR 702.52b: a library smaller than N must not offer dredge, got {:?}",
        runner.state().waiting_for
    );
    assert_eq!(
        hand_len(&runner, P0),
        hand_before + 1,
        "the draw must proceed normally when dredge is unavailable"
    );
}

/// Rows 3 + 4: printed AND granted dredge on separate graveyard objects both
/// surface together as a real CR 616.1 ordering prompt, distinguishably
/// labeled (Finding 1 — the granted candidate must not fall through to the
/// generic `"Replacement effect"` placeholder), and accepting one does not
/// consume or duplicate the other.
#[test]
fn necrobloom_printed_and_granted_dredge_both_surface_with_distinct_labels() {
    let mut scenario = base_scenario();
    scenario.add_creature_from_oracle(P0, "The Necrobloom", 2, 7, NECROBLOOM_ORACLE);
    let land = scenario.add_land_to_graveyard(P0, "Forest").id();
    let printed = scenario
        .add_creature_to_graveyard(P0, "Test Dredger", 1, 1)
        .with_keyword(Keyword::Dredge(3))
        .with_replacement_definition(printed_dredge_replacement(3))
        .id();
    let mut runner = scenario.build();

    draw_one(&mut runner, P0);

    let WaitingFor::ReplacementChoice { candidates, .. } = runner.state().waiting_for.clone()
    else {
        panic!(
            "expected a CR 616.1 ordering prompt with both dredge candidates, got {:?}",
            runner.state().waiting_for
        );
    };
    assert_eq!(
        candidates.len(),
        2,
        "both the printed-dredge card and the granted-dredge land must surface together, got {candidates:?}"
    );

    let granted = candidates
        .iter()
        .find(|c| c.source_id == land)
        .expect("the granted-dredge candidate must be present");
    assert_ne!(
        granted.description, "Replacement effect",
        "Finding 1: the granted candidate must not fall through to the generic label"
    );
    assert!(
        granted.description.contains("Dredge 2"),
        "the granted candidate must interpolate its own resolved N, got {:?}",
        granted.description
    );

    let printed_candidate = candidates.iter().find(|c| c.source_id == printed).expect(
        "the printed-dredge candidate must also be present (not excluded by the granted branch)",
    );
    assert_ne!(
        printed_candidate.description, granted.description,
        "the two co-occurring dredge candidates must be distinguishably labeled"
    );

    resolve_preferring(&mut runner, land);
    runner.advance_until_stack_empty();

    assert_eq!(
        zone_of(&runner, land),
        Zone::Hand,
        "the granted candidate must have resolved, returning the land to hand"
    );
    assert_eq!(
        zone_of(&runner, printed),
        Zone::Graveyard,
        "accepting the granted candidate must not consume or duplicate the printed candidate"
    );
}

/// CR 121.2a + CR 121.6b: a 2-card draw instruction (two INDIVIDUAL draw
/// units) with a granted-dredge land in the graveyard — the granted-mechanism
/// sibling of `multi_draw_dredges_one_of_two_units_other_draws_normally`
/// (`crates/engine/src/game/replacement.rs`), which covers the identical
/// per-unit mechanics for PRINTED dredge. Accepting the offer on unit 1
/// physically returns the land to hand, removing it from the graveyard, so
/// unit 2 must not re-offer the SAME land (no double-offer of the same land
/// within one instruction) and its individual draw must proceed normally.
///
/// Scope note: a stronger fixture — TWO independently dredgeable GRANTED
/// lands simultaneously resident in the graveyard for the same draw — was
/// attempted and hits a genuine, reproducible engine defect unrelated to
/// either authorized finding: accepting one of two simultaneously
/// co-applicable GRANTED dredge candidates causes the pipeline to also ask
/// about the sibling candidate's accept/decline branch, and once both are
/// decided (in any combination that includes an accept), the entire draw
/// event is silently swallowed — no draw, no mill, no return; the card is
/// simply lost. Confirmed NOT to reproduce with two PRINTED dredge
/// candidates in the identical shape (accepting one completes immediately,
/// exactly like the single-candidate case) or with one printed + one
/// granted candidate (the existing
/// `necrobloom_printed_and_granted_dredge_both_surface_with_distinct_labels`
/// test below passes), so the defect is specific to 2+ simultaneously live
/// GRANTED virtual candidates. Fixing it is out of this bounded round's
/// authorized scope (Finding 1's printed-gate value bug and Finding 2's test
/// coverage only) and is flagged separately rather than attempted here or
/// papered over with a test that asserts the broken behavior as correct.
#[test]
fn necrobloom_multi_draw_dredges_granted_land_other_draw_proceeds_normally() {
    let mut scenario = base_scenario();
    scenario.add_creature_from_oracle(P0, "The Necrobloom", 2, 7, NECROBLOOM_ORACLE);
    let land = scenario.add_land_to_graveyard(P0, "Forest").id();
    let mut runner = scenario.build();
    let hand_before = hand_len(&runner, P0);
    let library_before = runner.state().players[0].library.len();

    runner.state_mut().debug_mode = true;
    runner
        .act(GameAction::Debug(DebugAction::DrawCards {
            player_id: P0,
            count: 2,
        }))
        .expect("debug draw of 2 must succeed");

    // Unit 1: the granted-dredge land must be offered.
    let WaitingFor::ReplacementChoice { candidates, .. } = runner.state().waiting_for.clone()
    else {
        panic!(
            "expected unit 1's dredge offer to pause on ReplacementChoice, got {:?}",
            runner.state().waiting_for
        );
    };
    let accept_idx = candidates
        .iter()
        .position(|c| c.source_id == land && c.description != "Decline")
        .expect("the land's accept option must be present for unit 1");
    runner
        .act(GameAction::ChooseReplacement { index: accept_idx })
        .expect("accept unit 1's dredge offer");

    assert_eq!(
        zone_of(&runner, land),
        Zone::Hand,
        "the land must have been dredged back to hand for unit 1"
    );

    // Unit 2: the land already left the graveyard, so it must not be
    // re-offered — no dredge-eligible card remains, so the second individual
    // draw proceeds as an ordinary, unreplaced draw with no separate pause at
    // all (it completes automatically within the same action, since nothing
    // needs a player decision) — the discriminating "no double-offer" signal.
    assert!(
        !matches!(
            runner.state().waiting_for,
            WaitingFor::ReplacementChoice { .. }
        ),
        "with no dredge-eligible card left in the graveyard, unit 2 must not \
         pause on a ReplacementChoice at all, got {:?}",
        runner.state().waiting_for
    );
    runner.advance_until_stack_empty();

    assert_eq!(
        hand_len(&runner, P0),
        hand_before + 2,
        "hand must increase by exactly 2: the dredged land plus unit 2's normal draw"
    );
    assert_eq!(
        runner.state().players[0].library.len(),
        library_before - 3,
        "library must be reduced by exactly 3: 2 milled by unit 1's dredge plus 1 drawn by unit 2"
    );
}

/// Hostile fixture: Necrobloom leaves the battlefield (destroyed) AFTER the
/// granted-dredge `ReplacementChoice` has already been parked but BEFORE the
/// player submits `GameAction::ChooseReplacement`. This exercises the `None`
/// degradation paths `apply_single_replacement` / `continue_replacement_impl`
/// added for a grant that vanishes between registration and the player's
/// answer: submitting the stale "Accept" index must not panic, must not
/// fabricate a "Dredge 0" mill-and-return, and must not leave the draw
/// zeroed with no compensating effect — the event must fall back to
/// proceeding UNAFFECTED, exactly like a graceful decline.
#[test]
fn necrobloom_removed_mid_choice_stale_accept_degrades_to_normal_draw() {
    let mut scenario = base_scenario();
    let necrobloom = scenario
        .add_creature_from_oracle(P0, "The Necrobloom", 2, 7, NECROBLOOM_ORACLE)
        .id();
    let land = scenario.add_land_to_graveyard(P0, "Forest").id();
    let mut runner = scenario.build();
    let hand_before = hand_len(&runner, P0);
    let library_before = runner.state().players[0].library.len();

    draw_one(&mut runner, P0);
    let WaitingFor::ReplacementChoice { candidates, .. } = runner.state().waiting_for.clone()
    else {
        panic!(
            "expected the granted-dredge offer to pause before Necrobloom is removed, got {:?}",
            runner.state().waiting_for
        );
    };
    let accept_idx = candidates
        .iter()
        .position(|c| c.source_id == land && c.description != "Decline")
        .expect("land's accept option must be present before Necrobloom is removed");

    // Destroy Necrobloom now, with the choice still parked: raw zone move
    // (mirrors the established `remove_from_zone` + `add_to_zone` + explicit
    // `.zone` pattern used elsewhere in this crate's integration tests to
    // simulate an off-pipeline removal) so the grant is gone by the time the
    // stale "Accept" index is submitted.
    {
        let state = runner.state_mut();
        remove_from_zone(state, necrobloom, Zone::Battlefield, P0);
        add_to_zone(state, necrobloom, Zone::Graveyard, P0);
        state.objects.get_mut(&necrobloom).unwrap().zone = Zone::Graveyard;
    }

    runner
        .act(GameAction::ChooseReplacement { index: accept_idx })
        .expect("submitting the stale accept index must not error or panic");
    runner.advance_until_stack_empty();

    assert!(
        !matches!(
            runner.state().waiting_for,
            WaitingFor::ReplacementChoice { .. }
        ),
        "the stale choice must resolve cleanly, not re-park or wedge, got {:?}",
        runner.state().waiting_for
    );
    assert_eq!(
        zone_of(&runner, land),
        Zone::Graveyard,
        "with the grant gone, the land must NOT be returned to hand for free"
    );
    assert_eq!(
        hand_len(&runner, P0),
        hand_before + 1,
        "the draw must proceed normally (unaffected), not be zeroed and not doubled"
    );
    assert_eq!(
        runner.state().players[0].library.len(),
        library_before - 1,
        "exactly 1 card must be drawn from the library — no mill occurred"
    );
}
