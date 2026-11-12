/*
 * Rancho El Principio — diseño v1.
 * "Comprar ahora": agrega la variante del formulario al carrito y abre el pago.
 */

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-rep-buy-now]');
  if (!button || button.disabled) return;

  const form = button.form || button.closest('form');
  if (!form) return;

  const error = button.parentElement.querySelector('.rep-buy-now__error');
  const root = window.Shopify?.routes?.root || '/';

  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  if (error) error.hidden = true;

  try {
    const response = await fetch(`${root}cart/add.js`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: new FormData(form),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.description || data.message || 'No se pudo agregar al carrito.');
    }

    window.location.assign(`${root}checkout`);
  } catch (err) {
    if (error) {
      error.textContent = err.message;
      error.hidden = false;
    }
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
});
