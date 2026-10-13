import { Button } from "#enums/buttons";
import type { GameManager } from "#test/framework/game-manager";
import { PartyOption, type PartyUiHandler } from "#ui/party-ui-handler";

/**
 * Sends out a party member from the currently open party menu (command switch or forced switch).
 *
 * Replaces the blind input sequence of `GameManager.doSwitchPokemon()` / `doSelectPartyPokemon()`
 * (`setCursor(slot)`, ACTION, ACTION). That sequence assumes the party handler has no open options
 * menu. `PartyUiHandler.clear()` does not reset `optionsMode`/`options`, and the handler lives on the
 * scene across battles, so options left open by an earlier battle survive. `setCursor(slot)` then
 * moves the options cursor instead of the slot cursor and the second ACTION opens SUMMARY; the
 * phase never advances. See docs/pokerogue-headless-test-harness-mechanics.md (main repo), 3.12.
 *
 * Closes stale options, sets and verifies the slot cursor, then selects `PartyOption.SEND_OUT`
 * explicitly. Must be called while `UiMode.PARTY` is active. Returns whether SEND_OUT was selected.
 */
export function sendOutFromPartyUi(game: GameManager, partyIndex: number): boolean {
  const handler = game.scene.ui.getHandler() as PartyUiHandler;
  // optionsMode, options and cursor are private on PartyUiHandler; read them through a narrow view.
  const internals = handler as unknown as { optionsMode: boolean; options: number[]; cursor: number };
  const target = game.scene.getPlayerParty()[partyIndex];
  if (!target || target.isFainted() || target.isOnField()) {
    console.log(`[harness-party-select] slot=${partyIndex} not selectable (fainted, on field or missing)`);
    return false;
  }
  if (internals.optionsMode) {
    console.log(`[harness-party-select] cleared stale party options (options=${internals.options.length})`);
    handler.clearOptions();
  }
  handler.setCursor(partyIndex);
  for (let attempts = 0; attempts < 8 && internals.cursor !== partyIndex; attempts += 1) {
    handler.processInput(internals.cursor < partyIndex ? Button.DOWN : Button.UP);
  }
  if (internals.cursor !== partyIndex) {
    console.log(`[harness-party-select] cursor stuck at ${internals.cursor}, wanted slot ${partyIndex}`);
    return false;
  }
  handler.processInput(Button.ACTION);
  const sendOutIndex = internals.optionsMode ? internals.options.indexOf(PartyOption.SEND_OUT) : -1;
  if (sendOutIndex < 0) {
    console.log(
      `[harness-party-select] no SEND_OUT option for slot ${partyIndex} (optionsMode=${internals.optionsMode})`,
    );
    if (internals.optionsMode) {
      handler.clearOptions();
    }
    return false;
  }
  handler.setCursor(sendOutIndex);
  handler.processInput(Button.ACTION);
  return true;
}
