import { AbilityId } from "#enums/ability-id";
import { BattleType } from "#enums/battle-type";
import { BattlerIndex } from "#enums/battler-index";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { TrainerType } from "#enums/trainer-type";
import { GameManager } from "#test/framework/game-manager";
import { advanceDoubleCombatAfterAction, getCommandFieldIndexSafe } from "#test/porubot/harness/battle-command-advance";
import Phaser from "phaser";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Real-world replay of a recorded pokeRogueBot RL-collector timeout, not a
 * synthetic scenario: reconstructed from
 * data/temp/rl/modifier-strategic-fixed-seed-wave14-seed3-runs3-double-fallback-check-v2.json
 * (main repo), episode 0, `timeout_debug`.
 *
 * Historical incident: seed "modifier-strategic-fixed-seed-wave15-s3",
 * starters BULBASAUR/CHARMANDER/SQUIRTLE (wave_lib_w1_starters_v1), reaching
 * wave 14 as a double battle against trainer "Twins Kiri & Jan" (both sent
 * MAREEP). The collector's `advanceDoubleCombatAfterAction` timed out with
 * `step_timeout:advance_double_combat_after_action:15000` right after field
 * index 0 (Charmander) submitted its command for turn 1 - field index 1
 * (Bulbasaur)'s CommandPhase was stuck at `ui_mode: MESSAGE` instead of
 * advancing to `ui_mode: COMMAND`.
 *
 * The exact biome/trainer-roster path that led to this specific wave-14
 * encounter isn't reproducible from the recorded data alone (wave/trainer
 * generation depends on the arena's branching biome walk from wave 1, which
 * wasn't logged) - see docs/pokerogue-headless-test-harness-mechanics.md.
 * What IS reproducible, and is exactly what this test replays, is the
 * structural trigger: a double TRAINER battle's very first turn, right after
 * both player Pokemon are summoned, with the recorded party's levels and PP
 * state. `randomTrainer`/`enemySpecies` overrides force the same trainer
 * type and enemy species the real run encountered.
 *
 * This exercises the exact production function
 * (`advanceDoubleCombatAfterAction`, imported from
 * test/porubot/harness/battle-command-advance.ts) the live collector
 * imports - not a re-implementation - so a green result here is direct
 * evidence the harness no longer reproduces this historical timeout.
 */
describe("porubot regression replay - wave 14 double-trainer CommandPhase stuck on MESSAGE", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({
      type: Phaser.HEADLESS,
    });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    game.override
      .seed("modifier-strategic-fixed-seed-wave15-s3")
      .startingWave(14)
      .battleType(BattleType.TRAINER)
      .randomTrainer({ trainerType: TrainerType.TWINS })
      .enemySpecies(SpeciesId.MAREEP)
      .enemyLevel(12)
      .enemyAbility(AbilityId.BALL_FETCH)
      .enemyMoveset(MoveId.TACKLE)
      .ability(AbilityId.BLAZE);
  });

  it("lets field index 1's CommandPhase reach a stable COMMAND state after field index 0 submits its action", async () => {
    await game.classicMode.startBattle(SpeciesId.CHARMANDER, SpeciesId.BULBASAUR, SpeciesId.SQUIRTLE);

    const [charmander, bulbasaur, squirtle] = game.scene.getPlayerParty();

    // Recorded party state at the moment of the historical timeout
    // (timeout_debug.party in the JSON referenced above).
    charmander.level = 11;
    game.move.changeMoveset(charmander, [MoveId.SCRATCH, MoveId.GROWL, MoveId.EMBER, MoveId.SMOKESCREEN]);
    charmander.moveset[0].ppUsed = 11; // SCRATCH: 24/35 left
    charmander.moveset[1].ppUsed = 40; // GROWL: 0/40 left
    charmander.moveset[2].ppUsed = 3; // EMBER: 22/25 left
    charmander.moveset[3].ppUsed = 20; // SMOKESCREEN: 0/20 left

    bulbasaur.level = 9;
    game.move.changeMoveset(bulbasaur, [MoveId.TACKLE, MoveId.GROWL, MoveId.VINE_WHIP, MoveId.GROWTH]);
    bulbasaur.moveset[2].ppUsed = 1; // VINE_WHIP: 24/25 left

    squirtle.level = 8;
    game.move.changeMoveset(squirtle, [MoveId.TACKLE, MoveId.TAIL_WHIP, MoveId.WATER_GUN, MoveId.WITHDRAW]);
    squirtle.moveset[2].ppUsed = 2; // WATER_GUN: 23/25 left

    expect(game.scene.currentBattle?.double).toBe(true);
    expect(game.scene.currentBattle?.trainer?.config.trainerType).toBe(TrainerType.TWINS);

    // Field index 0 (Charmander) submits its command for turn 1, exactly as
    // the collector would - this is the point right before the recorded
    // timeout occurred. SCRATCH is single-target but ambiguous here (2 legal
    // enemy candidates, per docs/pokerogue-headless-test-harness-mechanics.md
    // section 3.5), so the engine pushes SelectTargetPhase regardless of the
    // explicit target passed to move.select() - expects_select_target_phase
    // must be true to match what the real collector's own getMoveTargets()
    // check would compute for this action.
    game.move.select(MoveId.SCRATCH, BattlerIndex.PLAYER, BattlerIndex.ENEMY);

    const advanceStatus = await advanceDoubleCombatAfterAction(
      game,
      { action_kind: "move", acting_field_index: 0, expects_select_target_phase: true },
      15000,
    );

    expect(advanceStatus).toBe("ok");
    expect(game.isCurrentPhase("CommandPhase")).toBe(true);
    expect(getCommandFieldIndexSafe(game)).toBe(1);
  });
});
