/**
 * What a liveness probe answers.
 *
 * Deliberately one field: this is the load balancer's question — "is this
 * replica still turning its event loop" — and any dependency named here would
 * take every replica out of rotation at once when that dependency wobbled.
 */
export interface HealthStatus {
  /**
   * Always `ok`. The answer is the status code; the body exists so a person
   * curling the endpoint sees something rather than an empty 200.
   */
  status: string;
}
