import { useWallet } from '@/context/useWallet';

export function HeaderWalletBar() {
  const {
    address,
    status,
    errorMessage,
    isPolygon,
    connect,
    disconnect,
    switchToPolygon,
    address2,
    status2,
    errorMessage2,
    connect2,
    disconnect2,
  } = useWallet();

  return (
    <div className="header-wallets" aria-label="Connexion wallets">
      <div className="header-wallet-slot" title={errorMessage || undefined}>
        <span className="header-wallet-label">Wallet 1</span>
        {!address ? (
          <button
            type="button"
            className="btn btn--xs btn--header-connect"
            disabled={status === 'connecting'}
            onClick={(e) => {
              e.preventDefault();
              connect();
            }}
          >
            {status === 'connecting' ? 'Connexion…' : 'Connecter'}
          </button>
        ) : (
          <>
            <span className="header-wallet-addr">
              {address.slice(0, 6)}…{address.slice(-4)}
            </span>
            {!isPolygon && (
              <button
                type="button"
                className="btn btn--xs header-wallet-polygon"
                onClick={() => switchToPolygon()}
              >
                Polygon
              </button>
            )}
            <button type="button" className="btn btn--xs btn--outline" onClick={disconnect}>
              Déco
            </button>
          </>
        )}
      </div>

      <div className="header-wallet-slot" title={errorMessage2 || undefined}>
        <span className="header-wallet-label">Wallet 2</span>
        {!address2 ? (
          <button
            type="button"
            className="btn btn--xs btn--header-connect"
            disabled={status2 === 'connecting'}
            onClick={(e) => {
              e.preventDefault();
              connect2();
            }}
          >
            {status2 === 'connecting' ? 'Connexion…' : 'Connecter'}
          </button>
        ) : (
          <>
            <span className="header-wallet-addr">
              {address2.slice(0, 6)}…{address2.slice(-4)}
            </span>
            <button type="button" className="btn btn--xs btn--outline" onClick={disconnect2}>
              Déco
            </button>
          </>
        )}
      </div>
    </div>
  );
}
