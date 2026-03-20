import { Component } from 'react';

/**
 * Affiche l’erreur à l’écran au lieu d’une page vide si un composant plante au rendu.
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (error) {
      const msg = error?.message || String(error);
      return (
        <div
          style={{
            minHeight: '100vh',
            padding: '2rem',
            color: 'var(--red)',
            background: 'var(--bg-base)',
            fontFamily: "'Syne', sans-serif",
            maxWidth: '48rem',
            margin: '0 auto',
          }}
        >
          <h1 style={{ fontSize: '1.25rem', marginBottom: '1rem', color: 'var(--text-1)' }}>
            Erreur au chargement du dashboard
          </h1>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '0.875rem',
              padding: '1rem',
              background: 'var(--bg-card)',
              borderRadius: '8px',
              border: '1px solid var(--border)',
              color: 'var(--text-1)',
            }}
          >
            {msg}
          </pre>
          <p style={{ marginTop: '1rem', fontSize: '0.875rem', color: 'var(--text-2)' }}>
            Ouvre la console du navigateur (F12) pour la stack complète. Si tu vois « buffer » ou « Buffer », redémarre{' '}
            <code style={{ color: 'var(--text-1)', fontFamily: "'JetBrains Mono', monospace" }}>npm run dev</code> après cette mise à jour.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}
