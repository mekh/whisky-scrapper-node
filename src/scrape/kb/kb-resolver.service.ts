import { Injectable } from '@nestjs/common';

import {
  FlavorRuleMatchMode,
  KbFlavorEffect,
  PeatProfile,
  ProducerKind,
} from '~enums';
import {
  ID,
  KbAliasEntry,
  KbFlavorRule,
  KbIndex,
  KbPeatReason,
  KbProducerFacts,
  KbResolution,
  KbResolveInput,
} from '~types';
import { KbAliasUtils, KbKeyUtils } from '~utils';

import type { KbProducerMatch } from './kb.interfaces';

/**
 * Which tags a peat profile implies.
 *
 * `light` yields `smoky` but **not** `peated`, and that distinction is the
 * product decision the whole band exists for: it keeps Johnnie Walker Black
 * out of a "no peat" exclusion while still describing it honestly. `unknown`
 * yields nothing and, at the write stage, actively removes whatever a model
 * had guessed — an unresearched bottling states nothing about peat, and
 * silently keeping a guess is what removed the user's favourite whisky from
 * every result in the first place.
 */
const PEAT_TAGS: Readonly<
  Record<PeatProfile, readonly ('peated' | 'smoky')[]>
> = {
  [PeatProfile.UNKNOWN]: [],
  [PeatProfile.NONE]: [],
  [PeatProfile.LIGHT]: ['smoky'],
  [PeatProfile.MEDIUM]: ['peated', 'smoky'],
  [PeatProfile.HEAVY]: ['peated', 'smoky'],
};

/**
 * Decides, for each bottling, which producer made it and what that means for
 * its peat level and flavor tags.
 *
 * The service exists because the catalogue had no notion of a producer at all:
 * every fact was whatever a store or a model said about one listing, so the
 * same whisky could disagree with itself across shops, and a model asked to
 * recall a distillery's house style answered from the semantic neighbourhood
 * of the name — which is how Tobermory, an unpeated malt, acquired the smoke
 * of Ledaig, its sibling brand from the same site.
 *
 * Nothing here guesses. A name that matches no alias resolves to nothing, and
 * "nothing" is a real answer that removes tags rather than inventing them.
 */
@Injectable()
export class KbResolverService {
  /**
   * The peat tag names a profile implies.
   *
   * @param profile - The resolved peat profile.
   * @returns The tag names, empty for `none` and `unknown`.
   */
  public static peatTags(profile: PeatProfile): readonly string[] {
    return PEAT_TAGS[profile];
  }

  /**
   * Resolves a batch of bottlings against the knowledge base.
   *
   * Callers are expected to pass one entry per **distinct name group** rather
   * than per product, so every bottling sharing a name gets one answer. That
   * grouping is not an optimization: the catalogue holds hundreds of duplicate
   * name groups whose members were classified independently and disagree with
   * each other, and resolving per group is what makes "same name, same facts"
   * structural instead of a thing to be repaired afterwards.
   *
   * @param inputs - The bottlings to resolve.
   * @param index - The loaded knowledge base.
   * @returns One resolution per input, in the same order.
   */
  public resolve(
    inputs: KbResolveInput[],
    index: KbIndex,
  ): KbResolution[] {
    return inputs.map((input) => this.resolveOne(input, index));
  }

  /**
   * Resolves one bottling.
   *
   * @param input - The bottling.
   * @param index - The loaded knowledge base.
   * @returns The resolution.
   */
  private resolveOne(
    input: KbResolveInput,
    index: KbIndex,
  ): KbResolution {
    const nameKey = KbKeyUtils.normalize(input.name ?? '');
    const brandKey = input.brand ? KbKeyUtils.key(input.brand) : null;

    const match = this.matchProducer(nameKey, brandKey, index.aliases);
    const peat = this.resolvePeat(nameKey, match.producer, index.rules);
    const tags = this.resolveTags(nameKey, match.producer, index);

    return {
      productId: input.id,
      producer: match.producer,
      bottler: match.bottler,
      peatProfile: peat.profile,
      peatReason: peat.reason,
      peatRulePattern: peat.pattern,
      ...tags,
    };
  }

  /**
   * Decides which producer a bottling belongs to, and which bottler released
   * it.
   *
   * Two candidates are considered: the producer the **brand value** names
   * exactly, and the most specific producer named **inside the product name**.
   * When they disagree, the tie is broken by the recorded relationship between
   * them rather than by which alias happens to be longer — a length comparison
   * gave the right answer for `Bruichladdich Port Charlotte` only by
   * coincidence, and coincidence is what this whole design is removing.
   *
   * @param nameKey - The normalized, space-wrapped product name.
   * @param brandKey - The normalized brand value, or null.
   * @param aliases - The alias index, longest key first.
   * @returns The chosen producer and bottler, either of which may be null.
   */
  private matchProducer(
    nameKey: string,
    brandKey: string | null,
    aliases: KbAliasEntry[],
  ): KbProducerMatch {
    const byBrand = KbAliasUtils.matchByBrand(brandKey, aliases)?.producer
      ?? null;
    const isBottlerBrand = byBrand?.kind === ProducerKind.BOTTLER;
    const inName = KbAliasUtils.matchInName(
      nameKey,
      aliases,
      byBrand?.id ?? null,
    )?.producer ?? null;
    const chosen = isBottlerBrand
      ? inName
      : this.arbitrate(byBrand, inName);

    const bottler = this.bottlerOf(chosen, inName, byBrand);

    /**
     * A bottler never made the whisky it bottles, so it may never end up in
     * the producer slot. Without this guard `Allt-a-Bhainne - Old Malt Cask`
     * resolved its producer to Old Malt Cask and its bottler to nothing: the
     * catalogue's brand value spelled the distillery a way no alias matched,
     * the only alias found inside the name was the bottler's, and arbitration
     * has no reason of its own to refuse it. The facts would then have been
     * read off a company that owns no still.
     */
    if (chosen?.kind === ProducerKind.BOTTLER) {
      return { producer: null, bottler: bottler ?? chosen };
    }

    return { producer: chosen, bottler };
  }

  /**
   * Chooses between a brand match and an in-name match that name different
   * producers.
   *
   * @param byBrand - The producer the brand value names, or null.
   * @param inName - The producer named inside the product name, or null.
   * @returns The chosen producer, or null when neither matched.
   */
  private arbitrate(
    byBrand: KbProducerFacts | null,
    inName: KbProducerFacts | null,
  ): KbProducerFacts | null {
    if (!byBrand || !inName || byBrand.id === inName.id) {
      return byBrand ?? inName;
    }

    /**
     * The name states a specific brand of the distillery the brand field
     * names — `Bruichladdich Port Charlotte`, `Tobermory Ledaig`. The brand is
     * the more precise claim, and it is precisely where the facts differ.
     */
    if (inName.parentId === byBrand.id) {
      return inName;
    }

    /**
     * The mirror image: the brand field holds the specific brand and the name
     * also mentions the distillery behind it.
     */
    if (byBrand.parentId === inName.id) {
      return byBrand;
    }

    return byBrand;
  }

  /**
   * Finds the bottler for a non-bottler brand match.
   *
   * Two ways one is found: the product name names a bottler outright, or the
   * resolved producer is a range a bottler owns — which is how `Big Peat`
   * reports Douglas Laing without the company appearing in the title at all.
   *
   * @param producer - The chosen producer, or null.
   * @param inName - The in-name match, which may itself be a bottler.
   * @param byBrand - The brand match.
   * @returns The bottler as facts, or null. Only the id is knowable here for a
   *   range's owner, so that case returns a minimal record.
   */
  private bottlerOf(
    producer: KbProducerFacts | null,
    inName: KbProducerFacts | null,
    byBrand: KbProducerFacts | null,
  ): KbProducerFacts | null {
    const named = [inName, byBrand]
      .find((candidate) => candidate?.kind === ProducerKind.BOTTLER);

    if (named && named.id !== producer?.id) {
      return named;
    }

    return null;
  }

  /**
   * Decides a bottling's peat level.
   *
   * Rules win over the producer's house profile, because a rule reads the
   * bottling's own name: `Benromach Unpeated` says outright what Benromach's
   * light house profile would otherwise imply, and `Bunnahabhain Mòine` says
   * the opposite of its unpeated core range. Everything else falls back to the
   * producer, and an unresolved bottling stays `unknown` rather than being
   * assumed unpeated.
   *
   * @param nameKey - The normalized, space-wrapped product name.
   * @param producer - The resolved producer, or null.
   * @param rules - Every rule, already ordered best-first.
   * @returns The profile, why it was chosen, and the deciding pattern.
   */
  private resolvePeat(
    nameKey: string,
    producer: KbProducerFacts | null,
    rules: KbFlavorRule[],
  ): { profile: PeatProfile; reason: KbPeatReason; pattern: string | null } {
    const rule = rules.find((candidate) =>
      candidate.peatProfile !== null
      && (candidate.producerId === null
        || candidate.producerId === producer?.id)
      && this.matches(nameKey, candidate)
    );

    if (rule?.peatProfile) {
      return {
        profile: rule.peatProfile,
        reason: rule.producerId
          ? KbPeatReason.RULE_PRODUCER
          : KbPeatReason.RULE_GLOBAL,
        pattern: rule.pattern,
      };
    }

    if (producer && producer.peatProfile !== PeatProfile.UNKNOWN) {
      return {
        profile: producer.peatProfile,
        reason: KbPeatReason.PRODUCER,
        pattern: null,
      };
    }

    return {
      profile: PeatProfile.UNKNOWN,
      reason: producer ? KbPeatReason.PRODUCER : KbPeatReason.UNRESOLVED,
      pattern: null,
    };
  }

  /**
   * Collects the tag decisions for a bottling, for the thirteen tags peat does
   * not cover.
   *
   * Precedence, strongest first: a name rule, then the producer's house style.
   * A rule wins because the name is evidence about **this** bottling — a title
   * saying "Sherry Cask" outranks a house style that usually is not — while a
   * house-style exclusion outranks a house-style inclusion, an exclusion being
   * the stronger claim.
   *
   * @param nameKey - The normalized, space-wrapped product name.
   * @param producer - The resolved producer, or null.
   * @param index - The loaded knowledge base.
   * @returns The required, forbidden and baseline tag ids.
   */
  private resolveTags(
    nameKey: string,
    producer: KbProducerFacts | null,
    index: KbIndex,
  ): Pick<
    KbResolution,
    'requiredFlavorIds' | 'forbiddenFlavorIds' | 'baselineFlavorIds'
  > {
    const required = new Set<ID>();
    const forbidden = new Set<ID>();
    const baseline = new Set<ID>();

    const house = producer
      ? index.producerFlavors.get(producer.id) ?? []
      : [];

    house.forEach((row) => {
      if (row.effect === KbFlavorEffect.FORBID) {
        forbidden.add(row.flavorId);
      }

      if (row.effect === KbFlavorEffect.REQUIRE) {
        required.add(row.flavorId);
      }

      if (row.effect === KbFlavorEffect.BASELINE) {
        baseline.add(row.flavorId);
      }
    });

    const matched = index.rules.filter((rule) =>
      rule.flavorId !== null
      && (rule.producerId === null || rule.producerId === producer?.id)
      && this.matches(nameKey, rule)
    );

    matched.forEach((rule) => {
      if (!rule.flavorId) {
        return;
      }

      if (rule.effect === KbFlavorEffect.REQUIRE) {
        required.add(rule.flavorId);
        forbidden.delete(rule.flavorId);
      }

      if (rule.effect === KbFlavorEffect.FORBID) {
        forbidden.add(rule.flavorId);
        required.delete(rule.flavorId);
      }
    });

    return {
      requiredFlavorIds: [...required],
      forbiddenFlavorIds: [...forbidden],
      baselineFlavorIds: [...baseline].filter((id) => !forbidden.has(id)),
    };
  }

  /**
   * Whether a rule's pattern is present in a name.
   *
   * @param nameKey - The normalized, space-wrapped product name.
   * @param rule - The rule.
   * @returns True when the pattern matches in the rule's own mode.
   */
  private matches(nameKey: string, rule: KbFlavorRule): boolean {
    if (rule.matchMode === FlavorRuleMatchMode.PREFIX) {
      return KbKeyUtils.matchesPrefix(nameKey, rule.pattern);
    }

    return KbKeyUtils.matchesWord(nameKey, rule.pattern);
  }
}
