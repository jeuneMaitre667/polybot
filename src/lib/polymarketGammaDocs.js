/**
 * Références officielles Polymarket (Gamma API + concepts).
 * Utilisé pour aligner les tableaux 1h / 15m sur la doc publique, pas sur des paramètres non documentés.
 *
 * @see https://docs.polymarket.com/market-data/fetching-markets — stratégies slug / events / pagination
 * @see https://docs.polymarket.com/api-reference/events/list-events — GET /events (closed, end_date_min, limit, offset, order)
 * @see https://docs.polymarket.com/api-reference/events/get-event-by-slug — GET /events/slug/{slug}
 * @see https://docs.polymarket.com/api-reference/markets/get-market-by-slug — GET /markets/slug/{slug}
 * @see https://docs.polymarket.com/api-spec/gamma-openapi.yaml — schéma Market (outcomes, outcomePrices, clobTokenIds)
 * @see https://docs.polymarket.com/concepts/resolution — marché résolu, tokens gagnants ~1 $
 * @see https://docs.polymarket.com/concepts/markets-events — event contient des markets
 */

/** Serveur production documenté (OpenAPI Gamma). */
export const GAMMA_API_ORIGIN = 'https://gamma-api.polymarket.com';

/** Seuil implicite « outcome gagnant » : ~1 $ après résolution (voir concept Resolution). */
export const GAMMA_RESOLVED_PRICE_THRESHOLD = 0.98;
