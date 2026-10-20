/**
 * Single seam to the pure search domain. Imported through the public @outlet/domain entry
 * (namespace `search`), re-exported flat so the module code is unchanged. Only this file does that.
 */
import { search } from "@outlet/domain";

export const CONCEPTS = search.CONCEPTS;
export const CONDITIONS = search.CONDITIONS;
export const DEPARTMENTS = search.DEPARTMENTS;
export const departmentMatches = search.departmentMatches;
export const DEFAULT_PAGE_SIZE = search.DEFAULT_PAGE_SIZE;
export const MAX_FACETS = search.MAX_FACETS;
export const MAX_PAGE_SIZE = search.MAX_PAGE_SIZE;
export const MAX_QUERY_LENGTH = search.MAX_QUERY_LENGTH;
export const MAX_RELAXATION_STEPS = search.MAX_RELAXATION_STEPS;
export const RELAXATION_ORDER = search.RELAXATION_ORDER;
export const SPONSORED_MAX_IN_WINDOW = search.SPONSORED_MAX_IN_WINDOW;
export const SPONSORED_WINDOW = search.SPONSORED_WINDOW;
export const WORLDS = search.WORLDS;
export const canonicalizeFilter = search.canonicalizeFilter;
export const capSponsored = search.capSponsored;
export const conceptById = search.conceptById;
export const countFacets = search.countFacets;
export const didYouMean = search.didYouMean;
export const expandKeyword = search.expandKeyword;
export const expandTerm = search.expandTerm;
export const foldLatin = search.foldLatin;
export const isArrayKey = search.isArrayKey;
export const isEmptyFilter = search.isEmptyFilter;
export const levenshtein = search.levenshtein;
export const lexiconKey = search.lexiconKey;
export const lookupConcept = search.lookupConcept;
export const normalizeDigits = search.normalizeDigits;
export const normalizeSearchText = search.normalizeSearchText;
export const parseEgpAmount = search.parseEgpAmount;
export const parseSearchQuery = search.parseSearchQuery;
export const relaxOnce = search.relaxOnce;
export const sponsoredInTop = search.sponsoredInTop;
export const SponsoredRanker = search.SponsoredRanker;
export const SPONSORED_MAX_DEFERRED = search.SPONSORED_MAX_DEFERRED;
export const tokenize = search.tokenize;
export const vocabulary = search.vocabulary;
export type Concept = search.Concept;
export type ConceptKind = search.ConceptKind;
export type Condition = search.Condition;
export type Department = search.Department;
export type FilterKey = search.FilterKey;
export type ParsedQuery = search.ParsedQuery;
export type RelaxableKey = search.RelaxableKey;
export type Relaxed = search.Relaxed;
export type SearchFilter = search.SearchFilter;
export type Sponsorable = search.Sponsorable;
export type SponsoredRankState = search.SponsoredRankState;
export type World = search.World;

export { money, type Money } from "@outlet/domain";
