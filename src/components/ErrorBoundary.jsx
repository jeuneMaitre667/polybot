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
            color: '#fecaca',
            background: '#0f172a',
            fontFamily: 'system-ui, sans-serif',
            maxWidth: '48rem',
            margin: '0 auto',
          }}
        >
          <h1 style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>Erreur au chargement du dashboard</h1>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontSize: '0.875rem',
              padding: '1rem',
              background: 'rgb(0 0 0 / 0.35)',
              borderRadius: '0.5rem',
              border: '1px solid rgb(248 113 113 / 0.3)',
            }}
          >
            {msg}
          </pre>
          <p style={{ marginTop: '1rem', fontSize: '0.875rem', color: '#94a3b8' }}>
            Ouvre la console du navigateur (F12) pour la stack complète. Si tu vois « buffer » ou « Buffer », redémarre{' '}
            <code style={{ color: '#e2e8f0' }}>npm run dev</code> après cette mise à jour.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}
