import { AbilityId } from "#enums/ability-id";
import { BattlerIndex } from "#enums/battler-index";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { getMoveTargets } from "#moves/move-utils";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Regression coverage for a pokeRogueBot RL-collector timeout pattern:
 * a collector previously decided whether to expect SelectTargetPhase
 * from a heuristic like `move.isMultiTarget()` alone. That heuristic is
 * wrong: in src/phases/command-phase.ts (handleFightCommand), a move
 * that is NOT multi-target still pushes SelectTargetPhase whenever more
 * than one legal target exists (`getMoveTargets(...).targets.length > 1`,
 * src/data/moves/move-utils.ts) - e.g. a single-target move in a double
 * battle with two live enemies. Only a genuinely resolved single target
 * (exactly one legal candidate) skips it. A harness that assumes
 * "single-target move = never SelectTargetPhase" hangs exactly here. See
 * docs/modifier-strategic-fixed-seed-pipeline.md in the main repo
 * ("Wiederverwendbare Loesung fuer Double-Battle-Timeouts", part 1+2).
 */
describe("porubot regression - double-battle SelectTargetPhase is conditional", () => {
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
      .criticalHits(false)
      .battleStyle("double")
      .enemyLevel(100)
      .startingLevel(100)
      .enemySpecies(SpeciesId.POLIWAG)
      .enemyMoveset(MoveId.SPLASH)
      .enemyAbility(AbilityId.BALL_FETCH)
      .ability(AbilityId.BALL_FETCH);
  });

  it("also produces SelectTargetPhase for a single-target move when two enemies are alive - not just for multi-target moves", async () => {
    game.override.moveset([MoveId.TACKLE, MoveId.SPLASH]);
    await game.classicMode.startBattle(SpeciesId.SAWK, SpeciesId.FEEBAS);

    const sawk = game.field.getPlayerPokemon();
    const moveTargets = getMoveTargets(sawk, MoveId.TACKLE);
    // The naive heuristic (`move.isMultiTarget()`) would say "single
    // target, no SelectTargetPhase needed" here - `multiple` is indeed
    // false, but there are still 2 legal enemy candidates to choose from.
    expect(moveTargets.multiple).toBe(false);
    expect(moveTargets.targets.length).toBeGreaterThan(1);

    game.move.select(MoveId.TACKLE, BattlerIndex.PLAYER, BattlerIndex.ENEMY);
    game.move.select(MoveId.TACKLE, BattlerIndex.PLAYER_2, BattlerIndex.ENEMY_2);
    await game.setTurnOrder([BattlerIndex.PLAYER, BattlerIndex.PLAYER_2, BattlerIndex.ENEMY, BattlerIndex.ENEMY_2]);

    await game.phaseInterceptor.to("MoveEndPhase");

    expect(game.phaseInterceptor.log).toContain("SelectTargetPhase");
  });

  it("produces SelectTargetPhase for a genuine multi-target move too, and still resolves cleanly", async () => {
    game.override.moveset([MoveId.TACKLE, MoveId.DAZZLING_GLEAM]);
    await game.classicMode.startBattle(SpeciesId.SAWK, SpeciesId.FEEBAS);

    const feebas = game.scene.getPlayerField()[BattlerIndex.PLAYER_2];
    const moveTargets = getMoveTargets(feebas, MoveId.DAZZLING_GLEAM);
    expect(moveTargets.multiple).toBe(true);

    game.move.select(MoveId.TACKLE, BattlerIndex.PLAYER, BattlerIndex.ENEMY);
    // DAZZLING_GLEAM hits all adjacent foes - no explicit target passed.
    game.move.select(MoveId.DAZZLING_GLEAM, BattlerIndex.PLAYER_2);
    await game.setTurnOrder([BattlerIndex.PLAYER, BattlerIndex.PLAYER_2, BattlerIndex.ENEMY, BattlerIndex.ENEMY_2]);

    await game.phaseInterceptor.to("MoveEndPhase");

    const log = game.phaseInterceptor.log;
    expect(log).toContain("SelectTargetPhase");
    // The regression: SelectTargetPhase firing (for either slot) must not
    // stop the run from resolving both moves and reaching MoveEndPhase.
    expect(log).toContain("MoveEndPhase");
  });
});
