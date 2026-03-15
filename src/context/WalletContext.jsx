import { useState, useCallback, useEffect } from 'react';
import { ethers } from 'ethers';
import { WalletContext } from './walletContext.js';

const POLYGON_CHAIN_ID = 137;
const POLYGON_PARAMS = {
  chainId: '0x89',
  chainName: 'Polygon Mainnet',
  nativeCurrency: { name: 'MATIC', symbol: 'MATIC', decimals: 18 },
  rpcUrls: ['https://polygon-rpc.com/'],
  blockExplorerUrls: ['https://polygonscan.com/'],
};

/** Provider Ethereum/Polygon à utiliser : Phantom en priorité, sinon window.ethereum (MetaMask, etc.) */
function getEthereumProvider() {
  if (typeof window === 'undefined') return undefined;
  if (window.phantom?.ethereum?.isPhantom) return window.phantom.ethereum;
  return window.ethereum;
}

export function WalletProvider({ children }) {
  const [address, setAddress] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [signer, setSigner] = useState(null);
  const [status, setStatus] = useState('disconnected'); // disconnected | connecting | connected | error
  const [errorMessage, setErrorMessage] = useState(null);

  const connect = useCallback(async () => {
    setErrorMessage(null);
    const ethereum = getEthereumProvider();
    if (!ethereum) {
      setStatus('error');
      setErrorMessage('Aucun wallet détecté. Installez Phantom, MetaMask ou un wallet compatible (EVM/Polygon).');
      return { error: 'Aucun wallet détecté.' };
    }
    setStatus('connecting');
    try {
      // Connexion via l'API native du wallet (Phantom gère mieux eth_requestAccounts ainsi)
      const accounts = await ethereum.request({ method: 'eth_requestAccounts' });
      if (!accounts?.length) {
        setStatus('error');
        setErrorMessage('Aucun compte sélectionné. Autorisez l\'accès dans le wallet.');
        return { error: 'Aucun compte.' };
      }
      // Ensuite on utilise ethers pour le signer et le réseau
      const provider = new ethers.providers.Web3Provider(ethereum);
      const network = await provider.getNetwork();
      const signerInstance = provider.getSigner();
      setAddress(accounts[0]);
      setChainId(network.chainId);
      setSigner(signerInstance);
      setStatus('connected');
      setErrorMessage(null);
      return { error: null };
    } catch (err) {
      setStatus('error');
      setAddress(null);
      setSigner(null);
      const code = err?.code ?? err?.error?.code;
      const rawMsg = err?.message ?? err?.error?.message ?? err?.data?.message ?? '';
      let msg = rawMsg || 'Connexion refusée.';
      if (code === 4001) {
        msg = 'Connexion refusée dans le wallet.';
      } else if (code === -32603 || String(msg).includes('Unexpected error') || code === 4900) {
        msg = 'Erreur Phantom. Essayez : fermer toute fenêtre Phantom ouverte, rafraîchir la page, ou désactiver temporairement une autre extension wallet (ex. MetaMask).';
      } else if (code === 4100) {
        msg = 'Non autorisé. Déverrouillez Phantom et réessayez.';
      }
      setErrorMessage(msg);
      return { error: msg };
    }
  }, []);

  const switchToPolygon = useCallback(async () => {
    const ethereum = getEthereumProvider();
    if (!ethereum) return { error: 'Aucun wallet.' };
    try {
      await ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: POLYGON_PARAMS.chainId }],
      });
      const provider = new ethers.providers.Web3Provider(ethereum);
      const network = await provider.getNetwork();
      setChainId(network.chainId);
      return { error: null };
    } catch (e) {
      if (e.code === 4902) {
        try {
          await ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [POLYGON_PARAMS],
          });
          const provider = new ethers.providers.Web3Provider(ethereum);
          const network = await provider.getNetwork();
          setChainId(network.chainId);
          return { error: null };
        } catch (addErr) {
          return { error: addErr.message || 'Impossible d\'ajouter Polygon.' };
        }
      }
      return { error: e.message || 'Impossible de changer de réseau.' };
    }
  }, []);

  const disconnect = useCallback(() => {
    setAddress(null);
    setChainId(null);
    setSigner(null);
    setStatus('disconnected');
    setErrorMessage(null);
  }, []);

  useEffect(() => {
    const ethereum = getEthereumProvider();
    if (!ethereum?.on) return;
    const onAccountsChanged = (accounts) => {
      if (!accounts?.length) disconnect();
      else setAddress(accounts[0]);
    };
    const onChainChanged = () => window.location.reload();
    ethereum.on('accountsChanged', onAccountsChanged);
    ethereum.on('chainChanged', onChainChanged);
    return () => {
      ethereum.removeListener?.('accountsChanged', onAccountsChanged);
      ethereum.removeListener?.('chainChanged', onChainChanged);
    };
  }, [disconnect]);

  const value = {
    address,
    chainId: chainId != null ? Number(chainId) : null,
    signer,
    status,
    errorMessage,
    isPolygon: chainId != null && Number(chainId) === POLYGON_CHAIN_ID,
    connect,
    disconnect,
    switchToPolygon,
    POLYGON_CHAIN_ID,
  };

  return (
    <WalletContext.Provider value={value}>
      {children}
    </WalletContext.Provider>
  );
}
