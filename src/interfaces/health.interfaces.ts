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

/**
 * A dependency the deep health check probes, named as the metric labels it
 * and the health-check result key it.
 */
export type HealthDependency =
  | 'postgres'
  | 'valkey_session'
  | 'valkey_cache';
