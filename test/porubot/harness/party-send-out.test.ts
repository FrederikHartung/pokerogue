import { AbilityId } from "#enums/ability-id";
import { Button } from "#enums/buttons";
import { MoveId } from "#enums/move-id";
import { PartyUiMode } from "#enums/party-ui-mode";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import { GameManager } from "#test/framework/game-manager";
import type { CommandUiHandler } from "#ui/command-ui-handler";
import type { PartyUiHandler } from "#ui/party-ui-handler";
import Phaser from "phaser";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { advanceCombatAfterAction } from "./battle-command-advance";
import { sendOutFromPartyUi } from "./party-send-out";
import { installSingleDriverPhaseInterceptor } from "./single-driver-phase-interceptor";

/**
 * Party selection with options left open in the party handler (signature E in the main repo's
 * collector replays). `PartyUiHandler.clear()` keeps `optionsMode`, so an options menu opened and
 * not closed survives a mode change; this helper recreates that state through the real UI.
 */
async function leavePartyOptionsOpen(game: GameManager): Promise<boolean> {
  const ui = game.scene.ui;
  await ui.setMode(UiMode.PARTY, PartyUiMode.SWITCH, 0);
  const handler = ui.getHandler() as PartyUiHandler;
  handler.setCursor(1);
  handler.processInput(Button.ACTION);
  await ui.setMode(UiMode.COMMAND, 0);
  return (handler as unknown as { optionsMode: boolean }).optionsMode === true;
}

function queueCommandSwitch(game: GameManager, partyIndex: number): void {
  game.onNextPrompt("CommandPhase", UiMode.COMMAND, () => {
    const commandHandler = game.scene.ui.getHandler() as CommandUiHandler;
    commandHandler.setCursor(2);
    commandHandler.processInput(Button.ACTION);
  });
  game.onNextPrompt("CommandPhase", UiMode.PARTY, () => {
    sendOutFromPartyUi(game, partyIndex);
  });
}

describe("porubot harness - party send-out with stale party options", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({
      type: Phaser.HEADLESS,
    });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    installSingleDriverPhaseInterceptor(game);
    game.override
      .battleStyle("single")
      .moveset([MoveId.SPLASH])
      .ability(AbilityId.BALL_FETCH)
      .enemySpecies(SpeciesId.MAGIKARP)
      .enemyAbility(AbilityId.BALL_FETCH)
      .enemyMoveset(MoveId.SPLASH);
  });

  it("mechanism: GameManager.doSwitchPokemon opens SUMMARY instead of switching", async () => {
    await game.classicMode.startBattle(SpeciesId.FEEBAS, SpeciesId.SQUIRTLE);
    expect(await leavePartyOptionsOpen(game)).toBe(true);

    game.doSwitchPokemon(1);
    const status = await advanceCombatAfterAction(game, 3000);

    expect(status).toBe("timeout");
    expect(game.scene.ui.getMode()).toBe(UiMode.SUMMARY);
  });

  it("sendOutFromPartyUi still switches on a command switch", async () => {
    await game.classicMode.startBattle(SpeciesId.FEEBAS, SpeciesId.SQUIRTLE);
    expect(await leavePartyOptionsOpen(game)).toBe(true);

    queueCommandSwitch(game, 1);
    const status = await advanceCombatAfterAction(game, 8000);

    expect(status).toBe("ok");
    expect(game.isCurrentPhase("CommandPhase")).toBe(true);
    expect(game.scene.getPlayerPokemon()?.species.speciesId).toBe(SpeciesId.SQUIRTLE);
  });

  it("forced switch after a faint still sends out the next party member", async () => {
    game.override.startingLevel(1).enemyLevel(100).enemyMoveset(MoveId.TACKLE);
    await game.classicMode.startBattle(SpeciesId.FEEBAS, SpeciesId.SQUIRTLE, SpeciesId.BULBASAUR);
    expect(await leavePartyOptionsOpen(game)).toBe(true);

    // Feebas (level 1) faints to the level-100 enemy's TACKLE, forcing a switch to Squirtle.
    game.move.select(MoveId.SPLASH);
    const status = await advanceCombatAfterAction(game, 8000);

    expect(status).toBe("ok");
    expect(game.isCurrentPhase("CommandPhase")).toBe(true);
    expect(game.scene.getPlayerPokemon()?.species.speciesId).toBe(SpeciesId.SQUIRTLE);
  });
});
