import { useEffect, useRef, useState } from 'react';

/**
 * PayPal JS SDK v6 button (PLAN B8.1). Loads the sandbox v6 core script, creates an instance with
 * the public client id, checks eligibility and renders `<paypal-button>`. On click the order is
 * created by our server (AUTHORIZE intent); the promise is passed to `session.start` without
 * awaiting it, as the v6 docs require, so the PayPal window opens inside the click.
 * If anything fails, `onUnavailable` fires and the page keeps its redirect button.
 */
const SDK_URL = 'https://www.sandbox.paypal.com/web-sdk/v6/core';
let sdkLoad: Promise<any> | null = null;

function loadSdk(): Promise<any> {
  const w = window as any;
  if (w.paypal?.createInstance) return Promise.resolve(w.paypal);
  sdkLoad ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SDK_URL;
    s.async = true;
    s.onload = () => (w.paypal?.createInstance ? resolve(w.paypal) : reject(new Error('PayPal SDK did not load')));
    s.onerror = () => { sdkLoad = null; reject(new Error('PayPal SDK did not load')); };
    document.head.appendChild(s);
  });
  return sdkLoad;
}

type Props = {
  clientId: string;
  disabled: boolean;
  /** Creates the booking on our server; resolves the PayPal order id and our booking token. */
  createOrder: () => Promise<{ orderId: string; token: string }>;
  onApprove: (token: string) => void;
  onCancel: (token: string) => void;
  onError: (err: Error) => void;
  onUnavailable: (reason: string) => void;
};

export function PayPalSdkButton({ clientId, disabled, createOrder, onApprove, onCancel, onError, onUnavailable }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const session = useRef<any>(null);
  const token = useRef<string>('');
  const [ready, setReady] = useState(false);
  // Keep the latest callbacks without re-creating the PayPal session.
  const cb = useRef({ createOrder, onApprove, onCancel, onError, onUnavailable, disabled });
  cb.current = { createOrder, onApprove, onCancel, onError, onUnavailable, disabled };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const paypal = await loadSdk();
        const sdk = await paypal.createInstance({ clientId, components: ['paypal-payments'], pageType: 'checkout' });
        const eligibility = await sdk.findEligibleMethods({ currencyCode: 'USD' });
        if (!eligibility.isEligible('paypal')) throw new Error('PayPal is not eligible here');
        session.current = sdk.createPayPalOneTimePaymentSession({
          onApprove: () => cb.current.onApprove(token.current),
          onCancel: () => cb.current.onCancel(token.current),
          onError: (e: any) => cb.current.onError(new Error(e?.message ?? 'PayPal reported an error')),
        });
        if (!alive || !host.current) return;
        const btn = document.createElement('paypal-button');
        (btn as HTMLElement).style.display = 'block';
        (btn as HTMLElement).style.width = '100%';
        btn.addEventListener('click', async () => {
          if (cb.current.disabled) return;
          // Not awaited: v6 opens the PayPal window inside the click, then waits for this promise.
          const orderPromise = cb.current.createOrder().then((r) => { token.current = r.token; return { orderId: r.orderId }; });
          try {
            await session.current.start({ presentationMode: 'auto' }, orderPromise);
          } catch (e) {
            cb.current.onError(e as Error);
          }
        });
        host.current.replaceChildren(btn);
        setReady(true);
      } catch (e) {
        if (alive) cb.current.onUnavailable((e as Error).message);
      }
    })();
    return () => { alive = false; };
  }, [clientId]);

  return (
    <div aria-busy={!ready} style={{ opacity: disabled ? 0.45 : 1, pointerEvents: disabled ? 'none' : 'auto', minHeight: ready ? 0 : 48 }}>
      <div ref={host} />
    </div>
  );
}
