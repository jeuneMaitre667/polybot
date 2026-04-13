export function LoadingSpinner() {
  return (
    <div className="loading-spinner" role="status" aria-label="Chargement">
      <div className="loading-spinner__disc" aria-hidden />
      <p className="loading-spinner__text">Chargement des marchés…</p>
    </div>
  );
}
