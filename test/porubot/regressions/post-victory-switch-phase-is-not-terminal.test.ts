import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { Stat } from "#enums/stat";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Regression coverage for a pokeRogueBot RL-collector timeout pattern:
 * a simultaneous KO (recoil finishes off the player's Pokemon on the same
 * turn the enemy faints) forces a SwitchPhase for the fainted lead - but
 * that SwitchPhase is queued *after* the entire victory/reward chain and
 * runs only once NewBattlePhase (the start of the next encounter) has
 * already begun. A harness that treats reaching NewBattlePhase as "safely
 * past the switch, ready for the next CommandPhase" stops servicing input
 * too early and hangs waiting for a CommandPhase that a still-pending
 * SwitchPhase blocks. It must keep answering the party prompt even after
 * NewBattlePhase. See docs/modifier-strategic-fixed-seed-pipeline.md in
 * the main repo.
 */
describe("porubot regression - post-victory SwitchPhase is not terminal", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({
      type: Phaser.HEADLESS,
    });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
  });

  it("defers the forced switch until after NewBattlePhase, and still reaches the next CommandPhase", async () => {
    const moveToUse = MoveId.TAKE_DOWN;
    game.override
      .battleStyle("single")
      .enemySpecies(SpeciesId.RATTATA)
      .startingWave(1)
      .startingLevel(100)
      .moveset([moveToUse])
      .enemyMoveset(MoveId.SPLASH)
      // Guarantees TAKE_DOWN hits (85% base accuracy) so the recoil-driven
      // mutual KO is deterministic instead of flaking on a miss.
      .startingHeldItems([{ name: "TEMP_STAT_STAGE_BOOSTER", type: Stat.ACC }]);

    await game.classicMode.startBattle(SpeciesId.SAWK, SpeciesId.FEEBAS);

    // Set HP low enough that TAKE_DOWN's recoil finishes off the user on
    // the same turn it OHKOs the (weak, wild) enemy - a genuine mutual KO.
    game.field.getPlayerPokemon().hp = 1;

    // move.select() registers its own prompt to answer the FIGHT menu; any
    // prompt registered before it would sit ahead of it in the strictly
    // FIFO prompt queue and block it forever, so it must go first.
    game.move.select(moveToUse);
    await game.phaseInterceptor.to("BattleEndPhase");

    // Prompts are serviced strictly in registration order, so the
    // SelectModifierPhase reward prompt (which comes first in-game) must be
    // registered before the forced-switch prompt that follows it - otherwise
    // the still-unmet switch prompt blocks the queue forever.
    game.doSelectModifier();
    game.doSelectPartyPokemon(1);

    await game.phaseInterceptor.to("CommandPhase");

    const log = game.phaseInterceptor.log;
    expect(log).toContain("BattleEndPhase");
    expect(log).toContain("SwitchPhase");
    expect(log).toContain("NewBattlePhase");

    // The core regression: NewBattlePhase looks like "we're safely at the
    // next encounter", but the forced switch for the fainted lead runs
    // *after* it, not before.
    expect(log.indexOf("SwitchPhase")).toBeGreaterThan(log.indexOf("NewBattlePhase"));
    // ...and the run still reaches a stable, resumable CommandPhase afterward.
    expect(log.indexOf("CommandPhase", log.indexOf("SwitchPhase"))).toBeGreaterThan(log.indexOf("SwitchPhase"));
  });
});
