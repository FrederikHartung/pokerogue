import { BiomeId } from "#enums/biome-id";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Regression coverage for a pokeRogueBot RL-collector timeout pattern:
 * on boss waves (waveIndex % 10 === 0), VictoryPhase does not push a
 * SelectModifierPhase at all - a harness that unconditionally waits for
 * BattleEndPhase -> SelectModifierPhase after a win hangs forever on
 * these waves. See docs/modifier-dqn-migration-plan.md and AGENTS.md
 * in the main repo.
 */
describe("porubot regression - boss wave skips SelectModifierPhase", () => {
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

  it("does not push SelectModifierPhase after winning a classic boss wave", async () => {
    game.override
      .startingWave(10)
      .startingBiome(BiomeId.ICE_CAVE)
      .battleStyle("single")
      .startingLevel(100)
      .disableTrainerWaves()
      .moveset([MoveId.SPLASH])
      .enemyMoveset(MoveId.SPLASH);

    await game.classicMode.startBattle(SpeciesId.FEEBAS);

    game.move.select(MoveId.SPLASH);
    await game.doKillOpponents();
    await game.toNextWave();

    expect(game.phaseInterceptor.log).not.toContain("SelectModifierPhase");
    expect(game.phaseInterceptor.log).toContain("NewBattlePhase");
  });
});
