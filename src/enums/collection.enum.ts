/**
 * Bucket width for the collection's "bottles added over time" series.
 *
 * A personal collection spans years but fills a handful of bottles a month, so
 * the two granularities answer different questions: months show the buying
 * rhythm, years show how the shelf grew. There is no day bucket — a purchase
 * date is user-entered and often remembered only to the month.
 */
export enum CollectionTimelineGranularity {
  MONTH = 'month',
  YEAR = 'year',
}
