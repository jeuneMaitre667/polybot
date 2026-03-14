export function LoadingSpinner() {
  return (
    <div className="flex flex-col items-center justify-center py-24" role="status" aria-label="Chargement">
      <div className="h-12 w-12 rounded-full border-2 border-slate-600 border-t-emerald-500 animate-spin" />
      <p className="mt-4 text-sm text-slate-500">Chargement des marchés…</p>
    </div>
  );
}
