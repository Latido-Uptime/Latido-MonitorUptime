/* Página de latidouptime.com/errores que explica el fallo de una comprobación. Script clásico:
   lo usan el panel (window.Errores) y los emails del comprobador (require). Cada nombre debe tener
   su página, generada por scripts/paginas-errores.mjs (lo comprueba monitor/test.mjs). */
(function (root) {
  'use strict';

  /** Nombre de la página para ese fallo (p. ej. 'error-503'), o null si no hay ninguna. */
  function errorPage(status, error) {
    const e = error || '';
    if (status >= 500) return [502, 503, 504].includes(status) ? `error-${status}` : 'error-500';
    if (status === 401 || status === 403 || status === 429) return 'error-403';
    if (/SSL/.test(e)) return 'certificado-ssl';
    if (/dominio/i.test(e)) return 'dominio-no-resuelve';
    if (/rechazada|cortó/.test(e)) return 'conexion-rechazada';
    if (/Sin respuesta/.test(e)) return 'sin-respuesta';
    if (/redirecci/i.test(e)) return 'demasiadas-redirecciones';
    return null;
  }

  const api = { errorPage };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Errores = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
