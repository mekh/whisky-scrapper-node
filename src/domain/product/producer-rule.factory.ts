import { Injectable } from '@nestjs/common';

import { CoreFlavorService } from '~core/flavor';
import { FlavorRuleMatchMode } from '~enums';
import { BadRequestError } from '~errors';
import type { ID, ProducerRuleCreateInput, ProducerRuleDraft } from '~types';
import { KbKeyUtils } from '~utils';

/**
 * Default priority of a reviewer's rule — the producer-scoped convention the
 * seeds use. Negations sit at 100 and beat it.
 */
const DEFAULT_RULE_PRIORITY = 60;

/**
 * Turns a rule as a reviewer stated it into the row the database takes.
 *
 * It is its own provider because two writes need it: the rule a reviewer adds
 * to a stored producer, and the rules that arrive with a create — where the
 * producer id only exists after the insert, so the draft it returns carries
 * none.
 */
@Injectable()
export class ProducerRuleFactory {
  private readonly flavors: CoreFlavorService;

  public constructor(flavors: CoreFlavorService) {
    this.flavors = flavors;
  }

  /**
   * Validates and normalizes one rule.
   *
   * @param input - The rule as the reviewer stated it.
   * @returns The rule, less the producer it will be scoped to.
   * @throws {BadRequestError} When the rule states both claims, neither, an
   *   unknown flavour, or a pattern that normalizes to nothing.
   */
  public async build(
    input: ProducerRuleCreateInput,
  ): Promise<ProducerRuleDraft> {
    const isPeatRule = input.peatProfile !== undefined;
    const isTagRule = input.flavorName !== undefined
      || input.effect !== undefined;

    if (isPeatRule === isTagRule) {
      throw new BadRequestError(
        'A rule states either a peat band or a tag claim, exactly one',
      );
    }

    if (isTagRule && (!input.flavorName || !input.effect)) {
      throw new BadRequestError(
        'A tag rule needs both the flavor and the effect',
      );
    }

    const pattern = KbKeyUtils.key(input.pattern);

    if (!pattern) {
      throw new BadRequestError('The pattern contains nothing matchable');
    }

    const flavorId = await this.resolveFlavorId(input.flavorName);

    return {
      pattern,
      matchMode: input.matchMode ?? FlavorRuleMatchMode.WORD,
      peatProfile: input.peatProfile ?? null,
      flavorId,
      effect: input.effect ?? null,
      priority: input.priority ?? DEFAULT_RULE_PRIORITY,
      note: input.note?.trim() ? input.note.trim() : null,
    };
  }

  /**
   * Validates a whole set, so a create refuses before it writes anything.
   *
   * @param inputs - The rules as the reviewer stated them.
   * @returns The rules, less the producer they will be scoped to.
   * @throws {BadRequestError} When any one of them is malformed.
   */
  public async buildMany(
    inputs: ProducerRuleCreateInput[],
  ): Promise<ProducerRuleDraft[]> {
    return Promise.all(inputs.map((input) => this.build(input)));
  }

  /**
   * Resolves a flavour name to its id, refusing an unknown one rather than
   * coining it — the stance `CoreFlavorService.findIdsByName` takes.
   *
   * @param name - The tag name, or undefined for a peat rule.
   * @returns The flavour's id, or null when the rule states no tag.
   * @throws {BadRequestError} When the name names no flavour.
   */
  private async resolveFlavorId(name?: string): Promise<ID | null> {
    if (!name) {
      return null;
    }

    const ids = await this.flavors.findIdsByName([name]);
    const found = ids.get(name);

    if (!found) {
      throw new BadRequestError(`Unknown flavor: ${name}`);
    }

    return found;
  }
}
